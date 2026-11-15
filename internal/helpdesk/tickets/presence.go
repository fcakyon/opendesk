package tickets

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// registerVisitorPresence adds the route that tells whether a chat's visitor is on the page
// (contracts/api.md "Visitor presence").
func registerVisitorPresence(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "ticket-visitor-presence", Method: http.MethodGet, Path: "/v1/tickets/{id}/visitor-presence",
		Summary: "Whether a chat's visitor is on the page", Tags: []string{"Tickets"},
		Description: "The signal the chat follow-up uses to decide whether an agent's reply is also emailed: the visitor is " +
			"present while their widget made a request within away_after_seconds. Agents on the ticket get \"customer_presence\" " +
			"on the realtime gateway when the visitor comes back; going away sends nothing, so read it again after " +
			"last_seen_at + away_after_seconds. For a ticket that is not a chat, chat is false."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body domain.VisitorPresence }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := uuid.Parse(in.ID)
			if err != nil {
				return nil, httpx.NotFound("Ticket")
			}
			var team, assignee *uuid.UUID
			err = d.DB.Pool.QueryRow(ctx, `SELECT team_id, assignee_id FROM tickets WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
				p.WorkspaceID, id).Scan(&team, &assignee)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Ticket")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			ok, err := domain.CanSee(ctx, d.DB.Pool, p, team, assignee)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if !ok {
				return nil, httpx.NotFound("Ticket")
			}
			out, err := domain.LoadVisitorPresence(ctx, d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body domain.VisitorPresence }{out}, nil
		})
}
