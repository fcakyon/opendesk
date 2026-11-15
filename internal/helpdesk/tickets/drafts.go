package tickets

import (
	"context"
	"net/http"
	"strings"
	"time"

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

// A ticket's shared draft (contracts/api.md "Drafts"): one pending reply body on the
// ticket, staged by a teammate or an API client (an AI agent over MCP) for whoever opens
// the ticket next. Every teammate who can see the ticket sees the same text in their
// composer, edits it and sends it as their own reply through the normal reply path, which
// clears the draft (domain.AddMessage). Staging again replaces it. The draft is the ticket's, never the
// staging credential's.

// TicketDraft is a ticket's pending reply body.
type TicketDraft struct {
	TicketID  uuid.UUID     `json:"ticket_id"`
	BodyHTML  string        `json:"body_html"`
	BodyText  string        `json:"body_text"`
	By        TicketDraftBy `json:"by"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// TicketDraftBy is who staged the draft: a teammate, or an API key by its name.
type TicketDraftBy struct {
	Type string          `json:"type" enum:"user,api"`
	Name string          `json:"name"`
	User *domain.UserRef `json:"user,omitempty"`
}

// TicketDraftInput is PUT /v1/tickets/{id}/draft.
type TicketDraftInput struct {
	BodyHTML string `json:"body_html" minLength:"1" maxLength:"500000"`
}

const draftSelect = `SELECT d.ticket_id, d.body_html, d.body_text, d.updated_at, u.id, u.name, u.email, u.avatar_url, k.name
FROM ticket_drafts d LEFT JOIN users u ON u.id = d.author_id LEFT JOIN api_keys k ON k.id = d.api_key_id
WHERE d.workspace_id = $1 AND d.ticket_id = $2`

func scanDraft(row pgx.Row) (TicketDraft, error) {
	var d TicketDraft
	var uID *uuid.UUID
	var uName, uEmail, uAvatar, keyName *string
	if err := row.Scan(&d.TicketID, &d.BodyHTML, &d.BodyText, &d.UpdatedAt, &uID, &uName, &uEmail, &uAvatar, &keyName); err != nil {
		return d, err
	}
	switch {
	case uID != nil:
		d.By = TicketDraftBy{Type: "user", Name: str(uName), User: &domain.UserRef{ID: *uID, Name: str(uName), Email: str(uEmail), AvatarURL: domain.Avatar(str(uAvatar))}}
	case keyName != nil:
		d.By = TicketDraftBy{Type: "api", Name: *keyName}
	default:
		d.By = TicketDraftBy{Type: "api", Name: "API"}
	}
	return d, nil
}

// loadDraft returns the ticket's draft, or nil when it has none.
func loadDraft(ctx context.Context, q db.Querier, wid, tid uuid.UUID) (*TicketDraft, error) {
	d, err := scanDraft(q.QueryRow(ctx, draftSelect, wid, tid))
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func publishDraft(ctx context.Context, tx pgx.Tx, wid, tid uuid.UUID, d *TicketDraft) error {
	_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "ticket_draft.updated", TicketID: &tid,
		Data: map[string]any{"ticket_id": tid, "draft": d}})
	return err
}

func registerDrafts(d *deps.Deps, api huma.API) {
	tags := []string{"Tickets"}
	type input struct {
		ID string `path:"id"`
	}

	huma.Register(api, huma.Operation{OperationID: "get-ticket-draft", Method: http.MethodGet, Path: "/v1/tickets/{id}/draft",
		Summary: "Get the shared draft", Description: "The reply staged on the ticket for a teammate to review and send, or null.", Tags: tags},
		func(ctx context.Context, in *input) (*struct {
			Body struct {
				TicketDraft *TicketDraft `json:"draft"`
			}
		}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tid, err := domain.ResolveVisibleTicket(ctx, d.DB.Pool, p, in.ID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct {
				Body struct {
					TicketDraft *TicketDraft `json:"draft"`
				}
			}{}
			if out.Body.TicketDraft, err = loadDraft(ctx, d.DB.Pool, p.WorkspaceID, tid); err != nil {
				return nil, httpx.Wrap(err)
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "put-ticket-draft", Method: http.MethodPut, Path: "/v1/tickets/{id}/draft",
		Summary: "Stage the shared draft", Description: "Stages a reply on the ticket without sending it. Every teammate who opens the ticket " +
			"sees it in their composer, edits it and sends it as their own reply. Staging again replaces it; a reply going out clears it.", Tags: tags},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body TicketDraftInput
		}) (*struct{ Body TicketDraft }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			html := hd.SanitizeRich(in.Body.BodyHTML)
			text := hd.HTMLToText(html)
			if text == "" && !strings.Contains(html, "<img") {
				return nil, httpx.Validation("the draft is empty")
			}
			var out TicketDraft
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				tid, err := domain.ResolveVisibleTicket(ctx, tx, p, in.ID)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO ticket_drafts (ticket_id, workspace_id, body_html, body_text, author_id, api_key_id)
					VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (ticket_id) DO UPDATE SET body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text,
						author_id = EXCLUDED.author_id, api_key_id = EXCLUDED.api_key_id, updated_at = now()`,
					tid, p.WorkspaceID, html, text, p.ActorUserID(), p.ActorAPIKeyID()); err != nil {
					return err
				}
				dr, err := loadDraft(ctx, tx, p.WorkspaceID, tid)
				if err != nil {
					return err
				}
				out = *dr
				return publishDraft(ctx, tx, p.WorkspaceID, tid, dr)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body TicketDraft }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-ticket-draft", Method: http.MethodDelete, Path: "/v1/tickets/{id}/draft",
		Summary: "Discard the shared draft", Description: "Nothing is sent. Idempotent.", Tags: tags, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *input) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				tid, err := domain.ResolveVisibleTicket(ctx, tx, p, in.ID)
				if err != nil {
					return err
				}
				return domain.ClearTicketDraft(ctx, tx, p.WorkspaceID, tid)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}
