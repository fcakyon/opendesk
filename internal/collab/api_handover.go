package collab

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/email"
	"github.com/useopendesk/opendesk/internal/httpx"
)

type handoverInput struct {
	ID   string `path:"id"`
	Body struct {
		Name             string     `json:"name,omitempty" maxLength:"200" doc:"The ticket mailbox's name; the account's when empty"`
		TeamID           *uuid.UUID `json:"team_id,omitempty" doc:"The team its new tickets go to; none when left out"`
		BrandID          *uuid.UUID `json:"brand_id,omitempty" doc:"The brand the address belongs to; the default brand when left out"`
		SignatureHTML    string     `json:"signature_html,omitempty" maxLength:"65536"`
		AutoReplyEnabled bool       `json:"auto_reply_enabled,omitempty"`
		AutoReplySubject string     `json:"auto_reply_subject,omitempty" maxLength:"300"`
		AutoReplyHTML    string     `json:"auto_reply_html,omitempty" maxLength:"65536"`
		KeepAccount      bool       `json:"keep_account,omitempty" doc:"Keep the Collab account as well; by default it is removed so the mail is not in both places"`
	}
}

type handoverOutput struct {
	Body struct {
		MailboxID      uuid.UUID `json:"mailbox_id"`
		AccountRemoved bool      `json:"account_removed"`
	}
}

// registerHandoverRoutes adds POST /v1/collab/accounts/{id}/use-for-tickets (contracts/collab.md
// "Using an account for tickets"): an admin makes a ticket mailbox of an account they connected.
func (s *service) registerHandoverRoutes(api huma.API) {
	collabOp(api, huma.Operation{OperationID: "use-collab-account-for-tickets", Method: http.MethodPost,
		Path: "/v1/collab/accounts/{id}/use-for-tickets", Summary: "Use a mail account for tickets", DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *handoverInput) (*handoverOutput, error) {
			p, err := s.require(ctx, auth.RoleAdmin)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := parseID(in.ID, "Account")
			if err != nil {
				return nil, err
			}
			// Only the member who connected it hands it over: their sign-in is what the
			// mailbox goes on using. Anyone else's account is not found, shared or not.
			a, err := loadAccount(ctx, s.d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, notFound(err, "Account")
			}
			if a.OwnerID == nil || *a.OwnerID != p.UserID {
				return nil, httpx.NotFound("Account")
			}
			if a.Config.Demo {
				return nil, httpx.Validation("A sample account cannot be used for tickets.")
			}
			creds, err := s.openCreds(a)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			pm, err := s.handover.Prepare(ctx, p, email.HandoverConnection{
				Provider: a.Provider, Email: a.Email, Name: a.Name, DisplayName: a.DisplayName,
				RefreshToken: creds.RefreshToken, AccessToken: creds.AccessToken, Expiry: creds.Expiry,
				IMAPHost: a.Config.IMAPHost, IMAPPort: a.Config.IMAPPort, IMAPTLS: a.Config.IMAPTLS, IMAPUsername: a.Config.IMAPUsername,
				SMTPHost: a.Config.SMTPHost, SMTPPort: a.Config.SMTPPort, SMTPTLS: a.Config.SMTPTLS, SMTPUsername: a.Config.SMTPUsername,
				Password: creds.Password, SMTPPassword: creds.SMTPPassword,
			}, email.HandoverMailbox{Name: b.Name, TeamID: b.TeamID, BrandID: b.BrandID, SignatureHTML: b.SignatureHTML,
				AutoReplyEnabled: b.AutoReplyEnabled, AutoReplySubject: b.AutoReplySubject, AutoReplyHTML: b.AutoReplyHTML})
			if err != nil {
				return nil, err
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := s.handover.Insert(ctx, tx, p, pm); err != nil {
					return err
				}
				mid := pm.ID()
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "mailbox.created_from_collab", "mailbox", &mid, map[string]any{
					"account_id": a.ID, "provider": a.Provider, "email": a.Email, "account_removed": !b.KeepAccount}); err != nil {
					return err
				}
				if b.KeepAccount {
					return nil
				}
				// The mailbox reads the address now; the account goes, its connection kept.
				before, err := accountAudience(ctx, tx, p.WorkspaceID, a.ID)
				if err != nil {
					return err
				}
				if err := dropAccount(ctx, tx, a); err != nil {
					return err
				}
				return s.publishAccounts(ctx, tx, p.WorkspaceID, a.ID, before)
			})
			if err != nil {
				return nil, s.handover.WrapError(err)
			}
			out := &handoverOutput{}
			out.Body.MailboxID, out.Body.AccountRemoved = pm.ID(), !b.KeepAccount
			return out, nil
		})
}
