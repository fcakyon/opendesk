package wiki

import (
	"context"
	"html"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// DbRow is a database's row as its views read it: the page without its body, its values,
// who made and last edited it, its cover and how its text starts (gallery cards).
type DbRow struct {
	WikiNode
	Props     map[string]any  `json:"props"`
	Cover     string          `json:"cover"`
	CoverY    int             `json:"cover_y"`
	Excerpt   string          `json:"excerpt" doc:"The first 280 characters of its text"`
	CreatedAt time.Time       `json:"created_at"`
	Creator   *domain.UserRef `json:"created_by"`
	Editor    *domain.UserRef `json:"updated_by"`
}

// DbRows is a database's rows and its templates.
type DbRows struct {
	Data      []DbRow    `json:"data"`
	Templates []WikiNode `json:"templates" doc:"The database's own templates: a new row starts as a copy of one"`
}

func registerRows(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-wiki-database-rows", Method: http.MethodGet, Path: "/v1/wiki/databases/{id}/rows",
		Summary: "List a wiki database's rows", Tags: tags,
		Description: "Every row of the database (its pages in the tree, in their order) with their values. Filters, sorts and groups are the views' to apply."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body DbRows }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Database")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := mustSee(ctx, d.DB.Pool, v, p.WorkspaceID, id); err != nil {
				return nil, httpx.Wrap(err)
			}
			var kind string
			if err := d.DB.Pool.QueryRow(ctx, `SELECT kind FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id).Scan(&kind); err != nil {
				return nil, httpx.Wrap(err)
			}
			if kind != "database" {
				return nil, httpx.NotFound("Database")
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT `+nodeCols+`, p.props, p.cover, p.cover_y,
					left(regexp_replace(regexp_replace(p.body_html, '<[^>]+>', ' ', 'g'), '\s+', ' ', 'g'), 400), p.created_at,
					c.id, c.name, c.email, c.avatar_url, u.id, u.name, u.email, u.avatar_url
				FROM wiki_pages p LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users u ON u.id = p.updated_by
				WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.deleted_at IS NULL AND NOT p.template
				ORDER BY p.position, p.id`, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := DbRows{Data: []DbRow{}}
			defer rows.Close()
			for rows.Next() {
				var r DbRow
				var c, u userCols
				if err := rows.Scan(&r.ID, &r.ParentID, &r.Title, &r.Icon, &r.Position, &r.Version, &r.UpdatedAt, &r.CreatedBy, &r.Tags,
					&r.Private, &r.TeamID, &r.Journal, &r.DailyDate, &r.Template, &r.Verified, &r.Kind, &r.Area,
					&r.Props, &r.Cover, &r.CoverY, &r.Excerpt, &r.CreatedAt,
					&c.id, &c.name, &c.email, &c.avatar, &u.id, &u.name, &u.email, &u.avatar); err != nil {
					return nil, httpx.Wrap(err)
				}
				r.Excerpt = hd.Excerpt(html.UnescapeString(r.Excerpt), 280)
				r.Creator, r.Editor = c.ref(), u.ref()
				if r.Props == nil {
					r.Props = map[string]any{}
				}
				out.Data = append(out.Data, r)
			}
			if err := rows.Err(); err != nil {
				return nil, httpx.Wrap(err)
			}
			if out.Templates, err = collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.template AND p.deleted_at IS NULL
				ORDER BY p.position, p.id`, p.WorkspaceID, id)); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body DbRows }{out}, nil
		})
}
