package wiki

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Following (contracts/wiki.md "Following"): who hears about new comments on a page. The
// page's creator and everyone who comments on it follow it, unless they unfollowed it:
// an explicit unfollow is kept, so commenting again doesn't undo it.

// autoFollow makes the caller follow the page unless they chose already.
func autoFollow(ctx context.Context, tx pgx.Tx, p *auth.Principal, page uuid.UUID) error {
	me := p.ActorUserID()
	if me == nil {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO wiki_follows (workspace_id, page_id, user_id, following) VALUES ($1, $2, $3, true)
		ON CONFLICT (page_id, user_id) DO NOTHING`, p.WorkspaceID, page, *me)
	return err
}

// onlyPerson is the caller of a route that is a person's own doing: commenting, reacting,
// following. An API key may read comments, never write as someone.
func onlyPerson(ctx context.Context, role auth.Role, scope string) (*auth.Principal, error) {
	p, err := auth.RequireWorkspace(ctx, role, scope)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if p.Kind != auth.KindUser {
		return nil, httpx.E(http.StatusForbidden, "forbidden", "Only a person comments on, reacts in and follows wiki pages.")
	}
	return p, nil
}

// following reports whether the caller follows the page.
func following(ctx context.Context, q db.Querier, p *auth.Principal, page uuid.UUID) (bool, error) {
	me := p.ActorUserID()
	if me == nil {
		return false, nil
	}
	var on bool
	err := q.QueryRow(ctx, `SELECT following FROM wiki_follows WHERE workspace_id = $1 AND page_id = $2 AND user_id = $3`, p.WorkspaceID, page, *me).Scan(&on)
	if db.IsNotFound(err) {
		return false, nil
	}
	return on, err
}

type followBody struct {
	Following bool `json:"following" doc:"Whether you hear about new comments on the page"`
}

func registerFollows(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "follow-wiki-page", Method: http.MethodPut, Path: "/v1/wiki/pages/{id}/follow",
		Summary: "Follow or unfollow a wiki page", Tags: tags,
		Description: "Followers hear about every new comment on the page. Creating a page or commenting on it follows it, unless you unfollowed it. Mentions reach you either way."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body followBody
		}) (*struct{ Body followBody }, error) {
			p, err := onlyPerson(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, err
			}
			id, err := hd.ParseID(in.ID, "Page")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := mustSee(ctx, tx, v, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err := tx.Exec(ctx, `INSERT INTO wiki_follows (workspace_id, page_id, user_id, following) VALUES ($1, $2, $3, $4)
					ON CONFLICT (page_id, user_id) DO UPDATE SET following = EXCLUDED.following`, p.WorkspaceID, id, p.UserID, in.Body.Following)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body followBody }{followBody{Following: in.Body.Following}}, nil
		})
}
