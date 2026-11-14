package resources

import (
	"context"
	"net/http"
	"regexp"
	"slices"
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
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/templates"
)

type idPath struct {
	ID string `path:"id"`
}

func lockKind(ctx context.Context, tx pgx.Tx, wid uuid.UUID, kind string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2))`, wid, kind)
	return err
}

// SavedReply is the contract shape.
type SavedReply struct {
	ID       uuid.UUID `json:"id"`
	Title    string    `json:"title"`
	Shortcut string    `json:"shortcut"`
	BodyHTML string    `json:"body_html"`
	// TeamID offers the reply only on that team's tickets; nil offers it everywhere.
	TeamID *uuid.UUID `json:"team_id" doc:"Offered only on this team's tickets; null for everyone"`
	// Actions apply to the ticket when a message using the reply is sent (saved_reply_ids).
	Actions   hd.SavedReplyActions `json:"actions"`
	CreatedAt time.Time            `json:"created_at"`
	UpdatedAt time.Time            `json:"updated_at"`
}

const savedReplySelect = `SELECT id, title, shortcut, body_html, team_id, actions, created_at, updated_at FROM saved_replies`

type savedReplyWriteBody struct {
	Title    *string               `json:"title,omitempty" maxLength:"200"`
	Shortcut *string               `json:"shortcut,omitempty" maxLength:"64"`
	BodyHTML *string               `json:"body_html,omitempty" maxLength:"100000"`
	TeamID   Nullable[string]      `json:"team_id,omitempty" doc:"A team the caller is on (admins: any team), or null for everyone"`
	Actions  *hd.SavedReplyActions `json:"actions,omitempty" doc:"Replaces the reply's actions; {} clears them"`
}

// applyTeam sets the reply's team. Admins (and API keys with settings:write) pick any team
// of the workspace; agents only a team they lead or are a member of.
func (b *savedReplyWriteBody) applyTeam(ctx context.Context, q db.Querier, p *auth.Principal, r *SavedReply) error {
	if !b.TeamID.Set {
		return nil
	}
	if b.TeamID.Null || strings.TrimSpace(b.TeamID.Value) == "" {
		r.TeamID = nil
		return nil
	}
	id, err := hd.ParseRef(b.TeamID.Value, "team_id")
	if err != nil {
		return err
	}
	if err := hd.CheckRef(ctx, q, p.WorkspaceID, "team", id); err != nil {
		return err
	}
	r.TeamID = &id
	return canWriteTeamReply(ctx, q, p, r.TeamID)
}

// canWriteTeamReply allows changing a team's saved reply to admins, keys with
// settings:write, and the team's leads and members.
func canWriteTeamReply(ctx context.Context, q db.Querier, p *auth.Principal, team *uuid.UUID) error {
	if team == nil || teamManager(p) {
		return nil
	}
	if p.Kind != auth.KindUser {
		return httpx.Forbidden()
	}
	role, err := hd.TeamRole(ctx, q, p.WorkspaceID, *team, p.UserID)
	if err != nil {
		return err
	}
	if role != hd.TeamLead && role != hd.TeamMember {
		return httpx.E(403, "forbidden", "Only the team's members can change its saved replies.")
	}
	return nil
}

// teamManager reports an admin, or an API key with settings:write.
func teamManager(p *auth.Principal) bool {
	return (p.Kind == auth.KindUser && p.Role.AtLeast(auth.RoleAdmin)) || (p.Kind == auth.KindAPIKey && p.HasScope(auth.ScopeSettingsWrite))
}

// privateTeam returns team when it is private: events about its rows go to its topic.
func privateTeam(ctx context.Context, q db.Querier, wid uuid.UUID, team *uuid.UUID) (*uuid.UUID, error) {
	private, err := hd.TeamPrivate(ctx, q, wid, team)
	if err != nil || !private {
		return nil, err
	}
	return team, nil
}

// replyHidden reports a saved reply of a private team the caller may not see.
func replyHidden(ctx context.Context, q db.Querier, p *auth.Principal, r SavedReply) (bool, error) {
	if r.TeamID == nil {
		return false, nil
	}
	hidden, err := domain.HiddenTeams(ctx, q, p)
	if err != nil {
		return false, err
	}
	return slices.Contains(hidden, *r.TeamID), nil
}

var shortcutRe = regexp.MustCompile(`^[a-z0-9_-]{0,32}$`)

func (b *savedReplyWriteBody) apply(r *SavedReply) error {
	if b.Title != nil {
		s, err := cleanName("title", *b.Title, 200)
		if err != nil {
			return err
		}
		r.Title = s
	}
	if r.Title == "" {
		return httpx.Validation("title is required")
	}
	if b.Shortcut != nil {
		s := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(*b.Shortcut), "/"))
		if !shortcutRe.MatchString(s) {
			return httpx.Validation("shortcut may use up to 32 lowercase letters, digits, - and _")
		}
		r.Shortcut = s
	}
	if b.BodyHTML != nil {
		r.BodyHTML = hd.SanitizeRichTemplate(*b.BodyHTML)
	}
	if b.Actions != nil {
		r.Actions = *b.Actions
	}
	if strings.TrimSpace(r.BodyHTML) == "" {
		return httpx.Validation("body_html is required")
	}
	return nil
}

func saveSavedReply(ctx context.Context, tx pgx.Tx, wid uuid.UUID, r *SavedReply, createdBy *uuid.UUID, create bool) error {
	if templates.HasTags(r.BodyHTML) {
		fields, err := templates.FieldVariables(ctx, tx, wid)
		if err != nil {
			return err
		}
		if err := templates.CheckSaved("body_html", r.BodyHTML, templates.KindReply, fields); err != nil {
			return err
		}
	}
	if err := r.Actions.Clean(ctx, tx, wid); err != nil {
		return err
	}
	if err := lockKind(ctx, tx, wid, "saved_reply"); err != nil {
		return err
	}
	if r.Shortcut != "" {
		var taken bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM saved_replies WHERE workspace_id = $1 AND shortcut = $2 AND id <> $3)`,
			wid, r.Shortcut, r.ID).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return httpx.Conflict("Another saved reply uses this shortcut.")
		}
	}
	var err error
	if create {
		err = tx.QueryRow(ctx, `INSERT INTO saved_replies (id, workspace_id, title, shortcut, body_html, created_by, team_id, actions)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at, updated_at`, r.ID, wid, r.Title, r.Shortcut, r.BodyHTML, createdBy, r.TeamID, r.Actions).
			Scan(&r.CreatedAt, &r.UpdatedAt)
	} else {
		err = tx.QueryRow(ctx, `UPDATE saved_replies SET title = $3, shortcut = $4, body_html = $5, team_id = $6, actions = $7, updated_at = now()
			WHERE workspace_id = $1 AND id = $2 RETURNING created_at, updated_at`, wid, r.ID, r.Title, r.Shortcut, r.BodyHTML, r.TeamID, r.Actions).
			Scan(&r.CreatedAt, &r.UpdatedAt)
	}
	if err != nil {
		return err
	}
	typ := "saved_reply.updated"
	if create {
		typ = "saved_reply.created"
	}
	scope, err := privateTeam(ctx, tx, wid, r.TeamID)
	if err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: typ, TeamID: scope, Data: map[string]any{"saved_reply": r}})
	return err
}

type savedReplyOut struct{ Body SavedReply }

type titleCursor struct {
	Title string    `json:"t"`
	ID    uuid.UUID `json:"id"`
}

func registerSavedReplies(d *deps.Deps, api huma.API) {
	scan := func(r pgx.Row) (SavedReply, error) {
		var s SavedReply
		err := r.Scan(&s.ID, &s.Title, &s.Shortcut, &s.BodyHTML, &s.TeamID, &s.Actions, &s.CreatedAt, &s.UpdatedAt)
		return s, err
	}

	huma.Register(api, op("list-saved-replies", http.MethodGet, "/v1/saved-replies", "List saved replies", "Saved replies", 0),
		func(ctx context.Context, in *struct {
			httpx.ListParams
			Q        string `query:"q" maxLength:"200" doc:"Search title and shortcut"`
			TicketID string `query:"ticket_id" doc:"Only the replies offered on this ticket: those of no team and of its team"`
			TeamID   string `query:"team_id" doc:"Only this team's replies, or none for replies of no team"`
		}) (*struct{ Body httpx.Page[SavedReply] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			// A private team's replies are listed only to those who see the team.
			hidden, err := domain.HiddenTeams(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			scope, team := "", (*uuid.UUID)(nil)
			switch {
			case strings.TrimSpace(in.TicketID) != "":
				tid, err := hd.ParseRef(in.TicketID, "ticket_id")
				if err != nil {
					return nil, err
				}
				t, err := domain.LoadVisibleTicket(ctx, d.DB.Pool, p, tid)
				if db.IsNotFound(err) {
					return nil, httpx.NotFound("Ticket")
				}
				if err != nil {
					return nil, httpx.Wrap(err)
				}
				scope, team = "ticket", t.TeamID
			case strings.TrimSpace(in.TeamID) == hd.TeamNone:
				scope = "none"
			case strings.TrimSpace(in.TeamID) != "":
				id, err := hd.ParseRef(in.TeamID, "team_id")
				if err != nil {
					return nil, err
				}
				scope, team = "team", &id
			}
			var cur titleCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			q := strings.TrimSpace(in.Q)
			like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
			rows, err := d.DB.Pool.Query(ctx, savedReplySelect+` WHERE workspace_id = $1
				AND ($2 = '' OR title ILIKE $3 OR shortcut ILIKE $3)
				AND (NOT $4 OR (lower(title), id) > (lower($5), $6))
				AND (team_id IS NULL OR NOT team_id = ANY($8::uuid[]))
				AND CASE $9 WHEN 'ticket' THEN team_id IS NULL OR team_id = $10
					WHEN 'none' THEN team_id IS NULL WHEN 'team' THEN team_id = $10 ELSE true END
				ORDER BY lower(title), id LIMIT $7`, p.WorkspaceID, q, like, in.Cursor != "", cur.Title, cur.ID, in.Limit+1,
				hidden, scope, team)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (SavedReply, error) { return scan(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(out, in.Limit, func(s SavedReply) any { return titleCursor{Title: s.Title, ID: s.ID} })
			return &struct{ Body httpx.Page[SavedReply] }{page}, nil
		})

	huma.Register(api, op("create-saved-reply", http.MethodPost, "/v1/saved-replies", "Create a saved reply", "Saved replies", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body savedReplyWriteBody }) (*savedReplyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			r := SavedReply{ID: ids.New()}
			if err := in.Body.apply(&r); err != nil {
				return nil, err
			}
			if err := d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := in.Body.applyTeam(ctx, tx, p, &r); err != nil {
					return err
				}
				return saveSavedReply(ctx, tx, p.WorkspaceID, &r, p.ActorUserID(), true)
			}); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &savedReplyOut{r}, nil
		})

	huma.Register(api, op("get-saved-reply", http.MethodGet, "/v1/saved-replies/{id}", "Get a saved reply", "Saved replies", 0),
		func(ctx context.Context, in *idPath) (*savedReplyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Saved reply")
			if err != nil {
				return nil, err
			}
			r, err := scan(d.DB.Pool.QueryRow(ctx, savedReplySelect+` WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id))
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Saved reply")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if hidden, err := replyHidden(ctx, d.DB.Pool, p, r); err != nil {
				return nil, httpx.Wrap(err)
			} else if hidden {
				return nil, httpx.NotFound("Saved reply")
			}
			return &savedReplyOut{r}, nil
		})

	huma.Register(api, op("update-saved-reply", http.MethodPatch, "/v1/saved-replies/{id}", "Update a saved reply", "Saved replies", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body savedReplyWriteBody
		}) (*savedReplyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Saved reply")
			if err != nil {
				return nil, err
			}
			var r SavedReply
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var err error
				r, err = scan(tx.QueryRow(ctx, savedReplySelect+` WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id))
				if db.IsNotFound(err) {
					return httpx.NotFound("Saved reply")
				}
				if err != nil {
					return err
				}
				if hidden, err := replyHidden(ctx, tx, p, r); err != nil {
					return err
				} else if hidden {
					return httpx.NotFound("Saved reply")
				}
				if err := canWriteTeamReply(ctx, tx, p, r.TeamID); err != nil {
					return err
				}
				if err := in.Body.apply(&r); err != nil {
					return err
				}
				if err := in.Body.applyTeam(ctx, tx, p, &r); err != nil {
					return err
				}
				return saveSavedReply(ctx, tx, p.WorkspaceID, &r, nil, false)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &savedReplyOut{r}, nil
		})

	huma.Register(api, op("delete-saved-reply", http.MethodDelete, "/v1/saved-replies/{id}", "Delete a saved reply", "Saved replies", http.StatusNoContent),
		func(ctx context.Context, in *idPath) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Saved reply")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				r, err := scan(tx.QueryRow(ctx, savedReplySelect+` WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id))
				if db.IsNotFound(err) {
					return httpx.NotFound("Saved reply")
				}
				if err != nil {
					return err
				}
				if hidden, err := replyHidden(ctx, tx, p, r); err != nil {
					return err
				} else if hidden {
					return httpx.NotFound("Saved reply")
				}
				if err := canWriteTeamReply(ctx, tx, p, r.TeamID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM saved_replies WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
					return err
				}
				scope, err := privateTeam(ctx, tx, p.WorkspaceID, r.TeamID)
				if err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "saved_reply.deleted", TeamID: scope,
					Data: map[string]any{"saved_reply_id": id}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}
