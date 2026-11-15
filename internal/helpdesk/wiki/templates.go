package wiki

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

type pageCopy struct {
	ParentID *string `json:"parent_id,omitempty" required:"false" nullable:"true" doc:"Where the copy goes; null for the top level of space"`
	Space    string  `json:"space,omitempty" enum:"workspace,private,team" doc:"At the top level, the copy's space; left out, the page's own"`
	TeamID   *string `json:"team_id,omitempty"`
	Template *bool   `json:"template,omitempty" doc:"true makes the copy a template, false a page of the tree; left out, as the page is (a copy of a template under a page is a page)"`
	Title    *string `json:"title,omitempty" maxLength:"200" doc:"The copy's title; left out, the page's"`
	Position *int    `json:"position,omitempty" minimum:"0"`
	Area     string  `json:"area,omitempty" enum:"wiki,pages" doc:"At the top level, the copy's area (contracts/pages.md); left out, the page's own. Under a parent, the parent's"`
}

func registerTemplates(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-wiki-templates", Method: http.MethodGet, Path: "/v1/wiki/templates",
		Summary: "List the wiki's templates", Tags: tags,
		Description: "The templates the caller may see (contracts/wiki.md \"Templates\"): pages copied into new pages, kept out of the tree. Their own subpages are copied with them and are not listed. The wiki and Pages share them."},
		func(ctx context.Context, _ *struct{}) (*struct{ Body httpx.Page[WikiNode] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` WHERE p.workspace_id = $1 AND p.template AND p.deleted_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM wiki_pages a WHERE a.workspace_id = p.workspace_id AND a.id = p.parent_id AND a.template)
				AND `+seesSQL("p", 2, 3)+` ORDER BY p.title, p.id`, p.WorkspaceID, me, hidden))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[WikiNode] }{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "duplicate-wiki-page", Method: http.MethodPost, Path: "/v1/wiki/pages/{id}/duplicate",
		Summary: "Copy a wiki page with its subpages", Tags: tags, DefaultStatus: http.StatusCreated,
		Description: "Duplicates a page and the pages under it: their text, icons and look. Links between the copied pages point at the copies. Starting a page from a template, saving a page as a template and Duplicate are all this."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body pageCopy
		}) (*pageOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Page")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			var pg WikiPage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
					return err
				}
				if err := mustSee(ctx, tx, v, p.WorkspaceID, id); err != nil {
					return err
				}
				src, err := loadPage(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if src.DeletedAt != nil {
					return inTrash()
				}
				pages, height, err := subtree(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if err := roomFor(ctx, tx, p.WorkspaceID, len(pages)); err != nil {
					return err
				}
				par, err := parentRef(ctx, tx, v, p.WorkspaceID, b.ParentID)
				if err != nil {
					return err
				}
				owner, team, template, area := src.owner, src.TeamID, src.Template, src.Area
				if par != nil {
					owner, team, template, area = par.owner, par.team, par.template, par.area
					if par.template && b.Template != nil && !*b.Template {
						return httpx.Validation("a page under a template is part of the template")
					}
					for _, x := range pages {
						if x == par.id {
							return cycle()
						}
					}
					if len(par.up)+1+height > maxDepth {
						return tooDeep()
					}
				} else {
					if b.Space != "" {
						if owner, team, err = spaceRef(ctx, tx, v, p.WorkspaceID, b.Space, b.TeamID); err != nil {
							return err
						}
					} else if src.owner != nil && (v.Me == nil || *src.owner != *v.Me) {
						return httpx.NotFound("Page")
					}
					if b.Template != nil {
						template = *b.Template
					}
					if b.Area != "" {
						area = b.Area
					}
					if err := requireArea(ctx, tx, p.WorkspaceID, area); err != nil {
						return err
					}
				}
				if height > maxDepth {
					return tooDeep()
				}
				// Copies of the pages, ids mapped so links inside the copy point at the copy.
				fresh := make(map[uuid.UUID]uuid.UUID, len(pages))
				for _, x := range pages {
					fresh[x] = ids.New()
				}
				remap := func(body string) string {
					for old, now := range fresh {
						body = strings.ReplaceAll(body, old.String(), now.String())
					}
					return body
				}
				// A copy's reminders are its own: new ids, set by whoever copies it.
				reminders := map[string]string{}
				newReminders := func(body string) string {
					return reminderAttr.ReplaceAllStringFunc(body, func(m string) string {
						old := reminderAttr.FindStringSubmatch(m)[1]
						if reminders[old] == "" {
							reminders[old] = ids.New().String()
						}
						return `data-reminder="` + reminders[old] + `"`
					})
				}
				for _, x := range pages {
					var row struct {
						parent                   *uuid.UUID
						title, icon, body        string
						position                 int
						cover, font, kind        string
						coverY                   int
						fullWidth, small, locked bool
						database, props, canvas  []byte
					}
					if err := tx.QueryRow(ctx, `SELECT parent_id, title, icon, body_html, position, cover, cover_y, full_width, small_text, font, locked, kind, database, props, canvas
						FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, x).Scan(&row.parent, &row.title, &row.icon, &row.body, &row.position,
						&row.cover, &row.coverY, &row.fullWidth, &row.small, &row.font, &row.locked, &row.kind, &row.database, &row.props, &row.canvas); err != nil {
						return err
					}
					// A row copied into a database keeps its values; one copied anywhere else is
					// a page and leaves them behind.
					if x == id && (par == nil || par.database == nil) {
						row.props = []byte("{}")
					}
					newParent := parentID(par)
					if x != id && row.parent != nil {
						np := fresh[*row.parent]
						newParent = &np
					}
					title := row.title
					if x == id && b.Title != nil {
						title = cleanTitle(*b.Title)
					}
					body := newReminders(remap(row.body))
					nid := fresh[x]
					var database any
					if row.database != nil {
						database = json.RawMessage(remap(string(row.database)))
					}
					// A canvas's cards that show pages of the copy show the copies.
					var canvas any
					if row.canvas != nil {
						canvas = json.RawMessage(remap(string(row.canvas)))
					}
					if _, err := tx.Exec(ctx, `INSERT INTO wiki_pages (id, workspace_id, parent_id, title, icon, body_html, position, created_by, updated_by,
							private_to, team_id, template, cover, cover_y, full_width, small_text, font, locked, kind, database, props, canvas, area)
						VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
						nid, p.WorkspaceID, newParent, title, row.icon, body, row.position, p.ActorUserID(), owner, team, template,
						row.cover, row.coverY, row.fullWidth, row.small, row.font, row.locked, row.kind, database, json.RawMessage(remap(string(row.props))), canvas, area); err != nil {
						return err
					}
					// A row copied into a database is a new row: it gets its own unique id.
					if x == id && par != nil && par.database != nil && !template {
						props := map[string]any{}
						if err := json.Unmarshal(row.props, &props); err != nil {
							return err
						}
						if err := nextRowNumbers(ctx, tx, p.WorkspaceID, par.id, par.database, props); err != nil {
							return err
						}
						if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET props = $3 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, nid, props); err != nil {
							return err
						}
					}
					if err := recordRevision(ctx, tx, p, nid, title, row.icon, body, false); err != nil {
						return err
					}
					if err := indexBody(ctx, tx, p.WorkspaceID, nid, body); err != nil {
						return err
					}
					if err := autoFollow(ctx, tx, p, nid); err != nil {
						return err
					}
					if err := bodySaved(ctx, tx, p, nid, "", body); err != nil {
						return err
					}
				}
				root := fresh[id]
				if err := place(ctx, tx, p.WorkspaceID, area, parentID(par), owner, team, template, &root, b.Position); err != nil {
					return err
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, root); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.created", "wiki_page", &root,
					map[string]any{"title": pg.Title, "parent_id": parentID(par), "copied_from": id, "subpages": len(pages) - 1}); err != nil {
					return err
				}
				all := make([]uuid.UUID, 0, len(pages))
				for _, x := range pages {
					all = append(all, fresh[x])
				}
				data := eventPage(pg)
				data["wiki_page_ids"] = all
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.created", data)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})
}
