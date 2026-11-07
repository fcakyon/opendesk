package email

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Handover makes a ticket mailbox of a Collab mail account (contracts/collab.md "Using an
// account for tickets"): the same address, read and sent with the account's own connection.
// Collab owns the account and its permission rules; this side builds and stores the mailbox.
type Handover struct{ s *service }

func NewHandover(d *deps.Deps) *Handover { return &Handover{s: newService(d)} }

// HandoverConnection is what a Collab account brings: how it connects and its secrets.
// Provider is google, microsoft or imap. For google and microsoft the tokens belong to the
// Collab OAuth client, as an api mailbox's do; AccessToken is a Graph token for microsoft.
type HandoverConnection struct {
	Provider     string
	Email        string
	Name         string
	DisplayName  string
	RefreshToken string
	AccessToken  string
	Expiry       time.Time

	IMAPHost, IMAPTLS, IMAPUsername string
	IMAPPort                        int
	SMTPHost, SMTPTLS, SMTPUsername string
	SMTPPort                        int
	Password, SMTPPassword          string
}

// HandoverMailbox is how the new mailbox starts: a name, its team and brand, and its replies.
type HandoverMailbox struct {
	Name             string
	TeamID, BrandID  *uuid.UUID
	SignatureHTML    string
	AutoReplyEnabled bool
	AutoReplySubject string
	AutoReplyHTML    string
}

// PreparedMailbox is a checked mailbox with its sealed secrets, ready to store.
type PreparedMailbox struct {
	m      *mailboxRow
	sealed []byte
}

// ID is the new mailbox's id.
func (pm *PreparedMailbox) ID() uuid.UUID { return pm.m.ID }

// Prepare checks the mailbox the connection makes, outside any transaction. A Google or
// Microsoft account reads its inbox through the provider's API, which the workspace must be
// able to do (Collab and the provider's Collab client); an IMAP account receives over IMAP
// and sends over its SMTP. The first sync starts from new mail: what the account already
// holds stays in Collab and never becomes tickets.
func (h *Handover) Prepare(ctx context.Context, p *auth.Principal, c HandoverConnection, in HandoverMailbox) (*PreparedMailbox, error) {
	s := h.s
	a, err := s.access(ctx, s.d.DB.Pool, p.WorkspaceID)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	m := &mailboxRow{WorkspaceID: p.WorkspaceID}
	m.ID = ids.New()
	m.Name, m.Email, m.DisplayName, m.TeamID = in.Name, c.Email, c.DisplayName, in.TeamID
	m.SignatureHTML, m.AutoReplyEnabled, m.AutoReplySubject, m.AutoReplyHTML = in.SignatureHTML, in.AutoReplyEnabled, in.AutoReplySubject, in.AutoReplyHTML
	if in.BrandID != nil {
		m.BrandID = *in.BrandID
	}
	m.Status = "active"
	m.Config.SyncStart = SyncStartNew
	var creds credentials
	switch c.Provider {
	case KindGoogle, KindMicrosoft:
		if !s.apiReceives(c.Provider, a) {
			return nil, apiSyncUnavailable(c.Provider, a)
		}
		if c.RefreshToken == "" {
			return nil, httpx.E(422, "reconnect_needed", "This account needs to be connected again before it can be used for tickets.")
		}
		m.InboundKind, m.OutboundKind = c.Provider, c.Provider
		m.Config.OAuthEmail, m.Config.OAuthGrant, m.Config.OAuthClient = c.Email, GrantAPI, ClientCollab
		creds.RefreshToken = c.RefreshToken
		if c.Provider == KindMicrosoft {
			creds.GraphAccessToken, creds.GraphExpiry = c.AccessToken, c.Expiry
		} else {
			creds.AccessToken, creds.Expiry = c.AccessToken, c.Expiry
		}
	case InboundIMAP:
		if err := s.checkReceive(InboundIMAP, a); err != nil {
			return nil, err
		}
		m.InboundKind, m.OutboundKind = InboundIMAP, OutboundSMTP
		m.Config.IMAPHost, m.Config.IMAPPort, m.Config.IMAPTLS, m.Config.IMAPUsername = c.IMAPHost, c.IMAPPort, c.IMAPTLS, c.IMAPUsername
		m.Config.SMTPHost, m.Config.SMTPPort, m.Config.SMTPTLS, m.Config.SMTPUsername = c.SMTPHost, c.SMTPPort, c.SMTPTLS, c.SMTPUsername
		creds.Password, creds.SMTPPassword = c.Password, c.SMTPPassword
	default:
		return nil, httpx.Validation("This account cannot be used for tickets.")
	}
	// A name is never an address (internal/displayname): the account's name, else its kind's.
	if m.Name == "" {
		m.Name = c.Name
	}
	if m.Name == "" || strings.Contains(m.Name, "@") {
		m.Name = providerLabel(c.Provider) + " mailbox"
	}
	if err := s.validateMailbox(m, creds); err != nil {
		return nil, err
	}
	prepareMailbox(m, &creds, m.InboundKind == InboundIMAP)
	sealed, err := s.sealCreds(creds)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	return &PreparedMailbox{m: m, sealed: sealed}, nil
}

// Insert stores a prepared mailbox in tx: the team, brand, address and plan checks of any new
// mailbox, then mailbox.created and its first sync. The caller audits.
func (h *Handover) Insert(ctx context.Context, tx pgx.Tx, p *auth.Principal, pm *PreparedMailbox) error {
	s, m := h.s, pm.m
	if err := lockWorkspaceForMailboxWrite(ctx, tx, p.WorkspaceID); err != nil {
		return err
	}
	if err := checkTeam(ctx, tx, p.WorkspaceID, m.TeamID); err != nil {
		return err
	}
	// The brand is checked to be the workspace's with the address.
	if err := checkAddressing(ctx, tx, m); err != nil {
		return err
	}
	if err := s.d.Plan.CheckMailbox(ctx, tx, p.WorkspaceID); err != nil {
		return err
	}
	var slug string
	if err := tx.QueryRow(ctx, `SELECT slug FROM workspaces WHERE id = $1`, p.WorkspaceID).Scan(&slug); err != nil {
		return err
	}
	if err := s.insertMailbox(ctx, tx, m, slug, pm.sealed); err != nil {
		return err
	}
	if err := s.publishMailbox(ctx, tx, p.WorkspaceID, m.ID, "mailbox.created"); err != nil {
		return err
	}
	stored, err := loadMailbox(ctx, tx, p.WorkspaceID, m.ID)
	if err != nil {
		return err
	}
	return s.enqueueSync(ctx, tx, stored)
}

// WrapError turns a store error of Insert into the answer a client reads.
func (h *Handover) WrapError(err error) error { return wrapMailboxErr(err) }
