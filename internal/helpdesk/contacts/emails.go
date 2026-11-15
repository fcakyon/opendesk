package contacts

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// A contact's extra email addresses (contracts/api.md "Contact emails"): mail from any of them
// lands on the contact. email on the contact is the primary; these sit beside it.

// writeEmails runs fn on a contact in one transaction and answers with the contact as it is
// after, announcing the change.
func writeEmails(ctx context.Context, d *deps.Deps, rawID string, fn func(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID) error) (*contactOut, error) {
	p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	id, err := hd.ParseID(rawID, "Contact")
	if err != nil {
		return nil, err
	}
	var c domain.Contact
	err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var one int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).Scan(&one); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("Contact")
			}
			return err
		}
		if err := fn(ctx, tx, p, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE contacts SET updated_at = now() WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
			return err
		}
		var err error
		if c, err = domain.LoadContact(ctx, tx, p.WorkspaceID, id); err != nil {
			return err
		}
		_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.updated", Data: map[string]any{"contact": c}})
		return err
	})
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	return &contactOut{c}, nil
}

func registerEmails(d *deps.Deps, api huma.API) {
	huma.Register(api, op("add-contact-email", http.MethodPost, "/v1/contacts/{id}/emails", "Add an email address to a contact", "Contacts", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Email string `json:"email" maxLength:"254" doc:"Another address of this contact. One that belongs to any contact already, this one included, is a 409"`
			}
		}) (*contactOut, error) {
			email, err := domain.CleanContactEmail(in.Body.Email)
			if err != nil {
				return nil, err
			}
			return writeEmails(ctx, d, in.ID, func(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID) error {
				return domain.AddContactEmail(ctx, tx, p.WorkspaceID, id, email)
			})
		})

	huma.Register(api, op("remove-contact-email", http.MethodDelete, "/v1/contacts/{id}/emails/{email}", "Remove an extra email address from a contact", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID    string `path:"id"`
			Email string `path:"email"`
		}) (*contactOut, error) {
			email, err := domain.CleanContactEmail(in.Email)
			if err != nil {
				return nil, err
			}
			return writeEmails(ctx, d, in.ID, func(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID) error {
				ok, err := domain.RemoveContactEmail(ctx, tx, p.WorkspaceID, id, email)
				if err != nil {
					return err
				}
				if !ok {
					return httpx.NotFound("Email")
				}
				return nil
			})
		})

	huma.Register(api, op("make-contact-email-primary", http.MethodPost, "/v1/contacts/{id}/emails/{email}/make-primary", "Make an extra address the contact's primary one", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID    string `path:"id"`
			Email string `path:"email"`
		}) (*contactOut, error) {
			email, err := domain.CleanContactEmail(in.Email)
			if err != nil {
				return nil, err
			}
			return writeEmails(ctx, d, in.ID, func(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID) error {
				ok, err := domain.MakeContactEmailPrimary(ctx, tx, p.WorkspaceID, id, email)
				if err != nil {
					return err
				}
				if !ok {
					return httpx.NotFound("Email")
				}
				// A new primary address may have a different Gravatar picture.
				_, err = tx.Exec(ctx, `UPDATE contacts SET avatar_retry_at = now(), avatar_failures = 0
					WHERE workspace_id = $1 AND id = $2 AND avatar_source IS DISTINCT FROM 'upload'`, p.WorkspaceID, id)
				return err
			})
		})
}
