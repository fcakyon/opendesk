// Package products resolves workspace product availability for API and background work.
package products

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/plan"
)

const (
	Tickets           = "tickets"
	Mail              = "mail"
	Pages             = "pages"
	InstanceDisabled  = "instance_disabled"
	Plan              = "plan"
	WorkspaceDisabled = "workspace_disabled"
)

// Settings are the product flags in workspaces.settings. Missing flags default to enabled.
type Settings struct {
	TicketsEnabled *bool `json:"tickets_enabled"`
	MailEnabled    *bool `json:"mail_enabled"`
	PagesEnabled   *bool `json:"pages_enabled"`
}

// State is effective availability, after instance configuration and entitlements.
type State struct {
	Tickets            bool
	Mail               bool
	MailDisabledReason string
	// Pages is the workspace's own flag: no instance option or plan turns it off.
	Pages bool
}

// DisabledError means a direct operation needs a product that is unavailable.
type DisabledError struct {
	Product string
	Reason  string
}

func (e *DisabledError) Error() string { return e.Product + " is disabled for this workspace" }

func (s State) RequireTickets() error {
	if !s.Tickets {
		return &DisabledError{Product: Tickets, Reason: WorkspaceDisabled}
	}
	return nil
}

func (s State) RequirePages() error {
	if !s.Pages {
		return &DisabledError{Product: Pages, Reason: WorkspaceDisabled}
	}
	return nil
}

func (s State) RequireMail() error {
	if !s.Mail {
		return &DisabledError{Product: Mail, Reason: s.MailDisabledReason}
	}
	return nil
}

// Evaluate applies instance, entitlement, then workspace precedence.
func Evaluate(settings Settings, instanceCollab, entitled bool) State {
	state := State{Tickets: settings.TicketsEnabled == nil || *settings.TicketsEnabled,
		Pages: settings.PagesEnabled == nil || *settings.PagesEnabled}
	switch {
	case !instanceCollab:
		state.MailDisabledReason = InstanceDisabled
	case !entitled:
		state.MailDisabledReason = Plan
	case settings.MailEnabled != nil && !*settings.MailEnabled:
		state.MailDisabledReason = WorkspaceDisabled
	default:
		state.Mail = true
	}
	return state
}

// Resolve applies effective availability to already-loaded workspace settings.
func Resolve(ctx context.Context, q db.Querier, service *plan.Service, instanceCollab bool, wid uuid.UUID, settings Settings) (State, error) {
	if !instanceCollab || (service != nil && service.CollabOff) {
		return Evaluate(settings, false, false), nil
	}
	ent, err := service.Entitlements(ctx, q, wid)
	if err != nil {
		return State{}, err
	}
	return Evaluate(settings, true, ent.Collab), nil
}

// Load reads the current flags on every check so changes apply to queued jobs too.
func Load(ctx context.Context, q db.Querier, service *plan.Service, instanceCollab bool, wid uuid.UUID) (State, error) {
	var raw json.RawMessage
	if err := q.QueryRow(ctx, `SELECT settings FROM workspaces WHERE id = $1`, wid).Scan(&raw); err != nil {
		return State{}, err
	}
	var settings Settings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return State{}, err
	}
	return Resolve(ctx, q, service, instanceCollab, wid, settings)
}

// RequireMail checks current effective Mail availability for a direct operation.
func RequireMail(ctx context.Context, q db.Querier, service *plan.Service, instanceCollab bool, wid uuid.UUID) error {
	state, err := Load(ctx, q, service, instanceCollab, wid)
	if err != nil {
		return err
	}
	return state.RequireMail()
}

// RequireTickets checks the current workspace flag without requiring Mail entitlement.
func RequireTickets(ctx context.Context, q db.Querier, wid uuid.UUID) error {
	settings, err := loadSettings(ctx, q, wid)
	if err != nil {
		return err
	}
	return Evaluate(settings, false, false).RequireTickets()
}

// RequirePages checks the workspace's Pages flag (contracts/pages.md).
func RequirePages(ctx context.Context, q db.Querier, wid uuid.UUID) error {
	settings, err := loadSettings(ctx, q, wid)
	if err != nil {
		return err
	}
	return Evaluate(settings, false, false).RequirePages()
}

func loadSettings(ctx context.Context, q db.Querier, wid uuid.UUID) (Settings, error) {
	var raw json.RawMessage
	if err := q.QueryRow(ctx, `SELECT settings FROM workspaces WHERE id = $1`, wid).Scan(&raw); err != nil {
		return Settings{}, err
	}
	var settings Settings
	err := json.Unmarshal(raw, &settings)
	return settings, err
}
