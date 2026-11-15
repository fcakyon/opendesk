package wiki

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

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

var tags = []string{"Wiki"}

type pageCreate struct {
	ParentID *string  `json:"parent_id,omitempty" required:"false" nullable:"true" doc:"The page to put it under; null or empty for the top level"`
	Space    string   `json:"space,omitempty" enum:"workspace,private,team" doc:"Where a top-level page lives; a subpage lives where its parent does. Default workspace"`
	TeamID   *string  `json:"team_id,omitempty" doc:"The teamspace, with space team"`
	Title    string   `json:"title,omitempty" maxLength:"200"`
	Icon     string   `json:"icon,omitempty" maxLength:"64" doc:"One emoji, or empty"`
	BodyHTML string   `json:"body_html,omitempty" doc:"Rich text, sanitized like an article's; up to 512 KB"`
	Position *int     `json:"position,omitempty" minimum:"0" doc:"Where among its siblings, from 0; the end when left out"`
	Aliases  []string `json:"aliases,omitempty" maxItems:"10" doc:"Other names the page goes by: up to 10 of 100 characters"`
	Area     string   `json:"area,omitempty" enum:"wiki,pages" doc:"Whose tree a top-level page goes in: the wiki's (default) or Pages' (contracts/pages.md); a subpage goes in its parent's"`
	Template bool     `json:"template,omitempty" doc:"A new template at the top level of space, or a database's own template under it (contracts/wiki.md \"Templates\"); a subpage is a template when its parent is"`
	Kind     string   `json:"kind,omitempty" enum:"page,database,canvas" doc:"database makes a database (contracts/wiki.md \"Databases\"), canvas a canvas (\"Canvas\"); default page"`
	// A database's properties and views; left out, a title and tags in a table.
	Database json.RawMessage `json:"database,omitempty"`
	// A row's values, by property id, when the parent is a database.
	Props json.RawMessage `json:"props,omitempty"`
	// A canvas's cards and connections; left out, an empty canvas.
	Canvas json.RawMessage `json:"canvas,omitempty"`
}

type pagePatch struct {
	Title    *string `json:"title,omitempty" maxLength:"200"`
	Icon     *string `json:"icon,omitempty" maxLength:"64" doc:"One emoji; empty removes it"`
	BodyHTML *string `json:"body_html,omitempty" doc:"Replaces the body; up to 512 KB"`
	Version  *int    `json:"version,omitempty" minimum:"1" doc:"The version this edit started from; a page changed since answers 409 page_changed"`
	// The page's look (contracts/wiki.md "Page settings"): never needs the version.
	Cover     *string `json:"cover,omitempty" maxLength:"2000" doc:"\"\" removes it"`
	CoverY    *int    `json:"cover_y,omitempty" minimum:"0" maximum:"100"`
	FullWidth *bool   `json:"full_width,omitempty"`
	SmallText *bool   `json:"small_text,omitempty"`
	Font      *string `json:"font,omitempty" enum:"default,serif,mono"`
	Locked    *bool   `json:"locked,omitempty"`
	// Verification (contracts/wiki.md "Verified pages"): never needs the version either.
	Verified *bool `json:"verified,omitempty" doc:"true verifies the page as you; false takes the verification away"`
	// A database's properties and views, replaced whole (a database only).
	Database json.RawMessage `json:"database,omitempty"`
	// A row's values to change, by property id; null takes one away (a database row only).
	Props json.RawMessage `json:"props,omitempty"`
	// A canvas's cards and connections, replaced whole (a canvas only).
	Canvas       json.RawMessage `json:"canvas,omitempty"`
	VerifiedDays *int            `json:"verified_days,omitempty" minimum:"1" maximum:"3650" doc:"With verified: for how many days; left out, until someone changes it"`
	// Other names the page goes by, replaced whole (contracts/wiki.md "Aliases"): never needs the version.
	Aliases *[]string `json:"aliases,omitempty" maxItems:"10" doc:"Up to 10 of 100 characters; [] removes them"`
}

// settings applies the patch's look to cur.
func (b pagePatch) settings(cur PageSettings) (PageSettings, error) {
	next := cur
	if b.Cover != nil {
		c, err := cleanCover(*b.Cover)
		if err != nil {
			return cur, err
		}
		next.Cover = c
	}
	if b.CoverY != nil {
		next.CoverY = *b.CoverY
	}
	if b.FullWidth != nil {
		next.FullWidth = *b.FullWidth
	}
	if b.SmallText != nil {
		next.SmallText = *b.SmallText
	}
	if b.Font != nil {
		next.Font = *b.Font
	}
	if b.Locked != nil {
		next.Locked = *b.Locked
	}
	return next, nil
}

type pageMove struct {
	ParentID *string `json:"parent_id" required:"false" nullable:"true" doc:"The new parent page; null or empty for the top level"`
	Position int     `json:"position" minimum:"0" doc:"Where among the new siblings, from 0; past the end puts it last"`
	Space    string  `json:"space,omitempty" enum:"workspace,private,team" doc:"At the top level, the space to move it to; left out, it stays in its own"`
	TeamID   *string `json:"team_id,omitempty" doc:"The teamspace, with space team"`
	Area     string  `json:"area,omitempty" enum:"wiki,pages" doc:"At the top level, the tree to move it to with its subpages (contracts/pages.md); left out, it stays in its own. Under a parent it goes in the parent's"`
}

type pageOut struct{ Body WikiPage }

// eventPage is what wiki_page.created, .updated and .moved carry: the page without its
// body (bodies are large and autosaved often), and who changed it.
func eventPage(pg WikiPage) map[string]any {
	return map[string]any{"wiki_page": pg.node(), "updated_by": pg.UpdatedBy}
}

// viewerFor is the caller's view of the wiki, for a handler.
func viewerFor(ctx context.Context, d *deps.Deps, p *auth.Principal) (Viewer, error) {
	return ViewerOf(ctx, d.DB.Pool, p)
}

func registerPages(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-wiki-pages", Method: http.MethodGet, Path: "/v1/wiki/pages",
		Summary: "List the wiki's pages", Description: "Every page of the tree the caller may see, without bodies, ordered by parent and position: the workspace's, the caller's own private pages and the teamspaces they may see. Not the trash, not templates. One area at a time: the wiki's, or Pages' with area=pages.", Tags: tags},
		func(ctx context.Context, in *areaIn) (*struct{ Body httpx.Page[WikiNode] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := requireArea(ctx, d.DB.Pool, p.WorkspaceID, in.Area); err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` WHERE p.workspace_id = $1 AND p.area = $4 AND `+liveSQL("p", 2, 3)+`
				ORDER BY p.parent_id NULLS FIRST, p.position, p.id`, p.WorkspaceID, me, hidden, in.Area))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[WikiNode] }{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-wiki-page", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}",
		Summary: "Get a wiki page", Tags: tags, Description: "A page the caller may see, also in the trash (deleted_at) or a template. A person's read counts as a visit (recent pages, the page's readers)."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*pageOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
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
			pg, err := loadVisible(ctx, d.DB.Pool, v, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind == auth.KindUser && pg.DeletedAt == nil {
				recordVisit(ctx, d, p.WorkspaceID, p.UserID, id)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-wiki-page", Method: http.MethodPost, Path: "/v1/wiki/pages",
		Summary: "Create a wiki page", Tags: tags, DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body pageCreate }) (*pageOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			title := cleanTitle(b.Title)
			icon, err := cleanIcon(b.Icon)
			if err != nil {
				return nil, err
			}
			body, err := cleanBody(b.BodyHTML)
			if err != nil {
				return nil, err
			}
			aliases, err := cleanAliases(b.Aliases)
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var pg WikiPage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
					return err
				}
				if err := roomFor(ctx, tx, p.WorkspaceID, 1); err != nil {
					return err
				}
				par, err := parentRef(ctx, tx, v, p.WorkspaceID, b.ParentID)
				if err != nil {
					return err
				}
				var owner, team *uuid.UUID
				template := false
				area := AreaWiki
				if par != nil {
					if len(par.up)+2 > maxDepth {
						return tooDeep()
					}
					// A template under a database is that database's own (a new row starts as a copy).
					owner, team, template = par.owner, par.team, par.template || (b.Template && par.database != nil)
					area = par.area
				} else {
					if owner, team, err = spaceRef(ctx, tx, v, p.WorkspaceID, b.Space, b.TeamID); err != nil {
						return err
					}
					template = b.Template
					if b.Area == AreaPages {
						area = AreaPages
					}
					if err := requireArea(ctx, tx, p.WorkspaceID, area); err != nil {
						return err
					}
				}
				id := ids.New()
				kind := "page"
				var database any
				if b.Kind == "database" {
					kind = "database"
					db := defaultDatabase()
					if len(b.Database) > 0 {
						if db, err = cleanDatabase(b.Database, nil); err != nil {
							return err
						}
					}
					database = db
				} else if len(b.Database) > 0 {
					return dbInvalid("database goes with kind database.")
				}
				var canvas any
				if b.Kind == "canvas" {
					kind = "canvas"
					c := emptyCanvas()
					if len(b.Canvas) > 0 {
						if c, err = cleanCanvas(b.Canvas); err != nil {
							return err
						}
						if err := checkCanvasRefs(ctx, tx, v, p.WorkspaceID, c, nil); err != nil {
							return err
						}
					}
					canvas = c
				} else if len(b.Canvas) > 0 {
					return canvasInvalid("canvas goes with kind canvas.")
				}
				props := map[string]any{}
				if par != nil && par.database != nil {
					var refs propRefs
					if len(b.Props) > 0 {
						if props, refs, err = cleanProps(b.Props, *par.database, props); err != nil {
							return err
						}
					}
					if err := checkRefs(ctx, tx, v, p.WorkspaceID, refs); err != nil {
						return err
					}
					if !template {
						if err := nextRowNumbers(ctx, tx, p.WorkspaceID, par.id, par.database, props); err != nil {
							return err
						}
					}
				} else if len(b.Props) > 0 {
					return dbInvalid("props go with a page in a database.")
				}
				if _, err := tx.Exec(ctx, `INSERT INTO wiki_pages (id, workspace_id, parent_id, title, icon, body_html, position, created_by, updated_by, private_to, team_id, template, kind, database, props, canvas, aliases, area)
					VALUES ($1, $2, $3, $4, $5, $6, 2147483647, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, id, p.WorkspaceID, parentID(par), title, icon, body, p.ActorUserID(), owner, team, template,
					kind, database, props, canvas, aliases, area); err != nil {
					return err
				}
				if err := place(ctx, tx, p.WorkspaceID, area, parentID(par), owner, team, template, &id, b.Position); err != nil {
					return err
				}
				if err := recordRevision(ctx, tx, p, id, title, icon, body, false); err != nil {
					return err
				}
				if err := indexBody(ctx, tx, p.WorkspaceID, id, body); err != nil {
					return err
				}
				if err := autoFollow(ctx, tx, p, id); err != nil {
					return err
				}
				if err := bodySaved(ctx, tx, p, id, "", body); err != nil {
					return err
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.created", "wiki_page", &id, map[string]any{"title": title, "parent_id": parentID(par)}); err != nil {
					return err
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.created", eventPage(pg))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-wiki-page", Method: http.MethodPatch, Path: "/v1/wiki/pages/{id}",
		Summary: "Update a wiki page", Tags: tags,
		Description: "Send the `version` the edit started from: when someone changed the page since, it answers `409 page_changed` and changes nothing. A page in the trash is `422 page_in_trash`."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body pagePatch
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
				if err := mustSee(ctx, tx, v, p.WorkspaceID, id); err != nil {
					return err
				}
				var title, icon, body string
				var version int
				var cur PageSettings
				var deleted, verifiedAt *time.Time
				err := tx.QueryRow(ctx, `SELECT title, icon, body_html, version, cover, cover_y, full_width, small_text, font, locked, deleted_at, verified_at
					FROM wiki_pages WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
					p.WorkspaceID, id).Scan(&title, &icon, &body, &version, &cur.Cover, &cur.CoverY, &cur.FullWidth, &cur.SmallText, &cur.Font, &cur.Locked, &deleted, &verifiedAt)
				if err != nil {
					return err
				}
				if deleted != nil {
					return inTrash()
				}
				if b.Version != nil && *b.Version != version {
					return pageChanged()
				}
				next := struct{ title, icon, body string }{title, icon, body}
				if b.Title != nil {
					next.title = cleanTitle(*b.Title)
				}
				if b.Icon != nil {
					if next.icon, err = cleanIcon(*b.Icon); err != nil {
						return err
					}
				}
				if b.BodyHTML != nil {
					if next.body, err = cleanBody(*b.BodyHTML); err != nil {
						return err
					}
				}
				if next.title != title || next.icon != icon || next.body != body {
					if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET title = $3, icon = $4, body_html = $5, version = version + 1,
						updated_by = $6, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
						p.WorkspaceID, id, next.title, next.icon, next.body, p.ActorUserID()); err != nil {
						return err
					}
					if err := recordRevision(ctx, tx, p, id, next.title, next.icon, next.body, true); err != nil {
						return err
					}
					if next.body != body {
						if err := indexBody(ctx, tx, p.WorkspaceID, id, next.body); err != nil {
							return err
						}
						if err := bodySaved(ctx, tx, p, id, body, next.body); err != nil {
							return err
						}
					}
				}
				settings, err := b.settings(cur)
				if err != nil {
					return err
				}
				if settings != cur {
					if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET cover = $3, cover_y = $4, full_width = $5, small_text = $6, font = $7, locked = $8
						WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, settings.Cover, settings.CoverY, settings.FullWidth, settings.SmallText, settings.Font, settings.Locked); err != nil {
						return err
					}
				}
				verifyChanged, err := applyVerification(ctx, tx, p, id, b, verifiedAt)
				if err != nil {
					return err
				}
				dataChanged, err := applyData(ctx, tx, v, p, id, b)
				if err != nil {
					return err
				}
				canvasChanged, err := applyCanvas(ctx, tx, v, p, id, b.Canvas)
				if err != nil {
					return err
				}
				aliasesChanged, err := applyAliases(ctx, tx, p.WorkspaceID, id, b.Aliases)
				if err != nil {
					return err
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				if pg.Version == version && settings == cur && !verifyChanged && !dataChanged && !canvasChanged && !aliasesChanged {
					return nil
				}
				data := eventPage(pg)
				if settings != cur {
					// Readers of the page take the new look as it comes: it has no version to compare.
					data["settings"] = pg.PageSettings
				}
				if verifyChanged {
					data["verification"] = pg.Verification
				}
				if dataChanged {
					// A row's values and a database's schema have no version either: taken as they come.
					if pg.Database != nil {
						data["database"] = pg.Database
					} else {
						data["props"] = pg.Props
					}
				}
				if canvasChanged {
					// A canvas has no version either: viewers take it as it comes.
					canvasEventData(data, pg.Canvas)
				}
				if aliasesChanged {
					// Nor do aliases.
					data["aliases"] = pg.Aliases
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.updated", data)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "move-wiki-page", Method: http.MethodPost, Path: "/v1/wiki/pages/{id}/move",
		Summary: "Move a wiki page", Tags: tags,
		Description: "Puts the page, with its subpages, under another page (or at the top level of a space) at a position. A page can't move under itself or one of its subpages; moving between spaces takes its subpages along."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body pageMove
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
			var pg WikiPage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
					return err
				}
				if err := mustSee(ctx, tx, v, p.WorkspaceID, id); err != nil {
					return err
				}
				var old, oldOwner, oldTeam *uuid.UUID
				var deleted *time.Time
				var template, journal bool
				var oldArea string
				err := tx.QueryRow(ctx, `SELECT parent_id, private_to, team_id, deleted_at, template, journal, area FROM wiki_pages WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
					p.WorkspaceID, id).Scan(&old, &oldOwner, &oldTeam, &deleted, &template, &journal, &oldArea)
				if err != nil {
					return err
				}
				if deleted != nil {
					return inTrash()
				}
				if journal {
					return httpx.E(http.StatusUnprocessableEntity, "journal_fixed", "A journal stays at the top of your private pages.")
				}
				par, err := parentRef(ctx, tx, v, p.WorkspaceID, in.Body.ParentID)
				if err != nil {
					return err
				}
				owner, team, nextTemplate, area := oldOwner, oldTeam, template, oldArea
				if par != nil {
					if par.id == id {
						return cycle()
					}
					for _, a := range par.up {
						if a.ID == id {
							return cycle()
						}
					}
					owner, team, nextTemplate, area = par.owner, par.team, par.template, par.area
				} else {
					if in.Body.Space != "" {
						if owner, team, err = spaceRef(ctx, tx, v, p.WorkspaceID, in.Body.Space, in.Body.TeamID); err != nil {
							return err
						}
					}
					if in.Body.Area != "" {
						area = in.Body.Area
					}
					if err := requireArea(ctx, tx, p.WorkspaceID, area); err != nil {
						return err
					}
				}
				gone, height, err := subtree(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				depth := 0
				if par != nil {
					depth = len(par.up) + 1
				}
				if depth+height > maxDepth {
					return tooDeep()
				}
				// Only the person a private page belongs to moves it out of their own.
				if oldOwner != nil && !samePtr(oldOwner, owner) && (v.Me == nil || *oldOwner != *v.Me) {
					return httpx.NotFound("Page")
				}
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET parent_id = $3 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, parentID(par)); err != nil {
					return err
				}
				// The pages under it live where it does now; a daily note out of its journal (or its
				// area) is a page.
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET private_to = $3, team_id = $4, template = $5, area = $7,
					daily_date = CASE WHEN $6::boolean AND area = $7 THEN daily_date END
					WHERE workspace_id = $1 AND id = ANY($2)`, p.WorkspaceID, gone, owner, team, nextTemplate, par != nil && par.journal, area); err != nil {
					return err
				}
				pos := in.Body.Position
				if err := place(ctx, tx, p.WorkspaceID, area, parentID(par), owner, team, nextTemplate, &id, &pos); err != nil {
					return err
				}
				if !samePtr(old, parentID(par)) || !samePtr(oldOwner, owner) || !samePtr(oldTeam, team) || oldArea != area {
					if err := place(ctx, tx, p.WorkspaceID, oldArea, old, oldOwner, oldTeam, template, nil, nil); err != nil {
						return err
					}
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				if oldArea != area {
					if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.moved_area", "wiki_page", &id, map[string]any{"from": oldArea, "to": area}); err != nil {
						return err
					}
				}
				if !samePtr(oldOwner, owner) || !samePtr(oldTeam, team) || oldArea != area {
					// Readers of the old space drop it; readers of the new one fetch the tree again.
					before := pg
					before.owner, before.TeamID = oldOwner, oldTeam
					if err := pageEvent(ctx, tx, p.WorkspaceID, before, "wiki_page.deleted", map[string]any{"wiki_page_id": id, "wiki_page_ids": gone, "moved": true}); err != nil {
						return err
					}
					if err := dropHiddenNotifications(ctx, tx, p.WorkspaceID, gone); err != nil {
						return err
					}
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.moved", eventPage(pg))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-wiki-page", Method: http.MethodDelete, Path: "/v1/wiki/pages/{id}",
		Summary: "Delete a wiki page for good", Tags: tags, DefaultStatus: http.StatusNoContent,
		Description: "Removes the page, its subpages and their history for good, from the tree or the trash. Admins delete any page; agents a page when they created it and every subpage under it. `POST /v1/wiki/pages/{id}/trash` moves it to the trash instead."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*hd.Empty, error) {
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
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
					return err
				}
				if err := mustSee(ctx, tx, v, p.WorkspaceID, id); err != nil {
					return err
				}
				pg, err := loadPage(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				var all []uuid.UUID
				// Everything under it goes, whether in the tree or in the trash.
				rows, err := tx.Query(ctx, `WITH RECURSIVE down(id) AS (
						SELECT id FROM wiki_pages WHERE workspace_id = $1 AND id = $2
						UNION ALL SELECT p.id FROM wiki_pages p JOIN down ON p.parent_id = down.id WHERE p.workspace_id = $1
					) SELECT id FROM down`, p.WorkspaceID, id)
				if all, err = collectIDs(rows, err); err != nil {
					return err
				}
				if err := canDelete(ctx, tx, p, all); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
					return err
				}
				if pg.DeletedAt == nil {
					if err := place(ctx, tx, p.WorkspaceID, pg.Area, pg.ParentID, pg.owner, pg.TeamID, pg.Template, nil, nil); err != nil {
						return err
					}
				}
				if err := dropHiddenNotifications(ctx, tx, p.WorkspaceID, all); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.deleted", "wiki_page", &id, map[string]any{"title": pg.Title, "subpages": len(all) - 1}); err != nil {
					return err
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.deleted", map[string]any{"wiki_page_id": id, "wiki_page_ids": all})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}

func collectIDs(rows pgx.Rows, err error) ([]uuid.UUID, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// roomFor refuses n more pages in a full wiki (the trash and templates count).
func roomFor(ctx context.Context, tx pgx.Tx, wid uuid.UUID, n int) error {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE workspace_id = $1`, wid).Scan(&count); err != nil {
		return err
	}
	if count+n > maxPages {
		return httpx.E(http.StatusUnprocessableEntity, "wiki_full", "A workspace's wiki holds up to 5,000 pages, the trash included. Delete pages you no longer need first.")
	}
	return nil
}

func parentID(par *parent) *uuid.UUID {
	if par == nil {
		return nil
	}
	return &par.id
}

// canDelete checks a delete of pages (the page first, then everything under it): admins
// and owners delete any page; agents a page when they created it and every page under it,
// so moving pages under one's own never makes them deletable; an API key with wiki:write
// any (contracts/wiki.md "Access").
func canDelete(ctx context.Context, tx pgx.Tx, p *auth.Principal, pages []uuid.UUID) error {
	if p.Kind != auth.KindUser || p.Role.AtLeast(auth.RoleAdmin) {
		return nil
	}
	var page, under bool
	if err := tx.QueryRow(ctx, `SELECT coalesce(bool_or(id = $4), false), coalesce(bool_or(id <> $4), false) FROM wiki_pages
		WHERE workspace_id = $1 AND id = ANY($2) AND created_by IS DISTINCT FROM $3 AND private_to IS DISTINCT FROM $3`,
		p.WorkspaceID, pages, p.UserID, pages[0]).Scan(&page, &under); err != nil {
		return err
	}
	switch {
	case page:
		return httpx.E(http.StatusForbidden, "forbidden", "Someone else created this page, so only an admin can delete it.")
	case under:
		return httpx.E(http.StatusForbidden, "forbidden", "Someone else created pages under this one, so only an admin can delete it.")
	}
	return nil
}

func samePtr(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func pageChanged() error {
	return httpx.E(http.StatusConflict, "page_changed", "Someone else changed this page since you opened it. Reload it to see their changes.")
}

func cycle() error {
	return httpx.E(http.StatusUnprocessableEntity, "page_cycle", "A page can't move under itself or one of its subpages.")
}

func tooDeep() error {
	return httpx.E(http.StatusUnprocessableEntity, "page_too_deep", "Pages nest up to 10 levels deep.")
}

// applyVerification verifies or unverifies the page as the patch asks; it reports whether
// anything changed. Only a person verifies, as themselves.
func applyVerification(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID, b pagePatch, at *time.Time) (bool, error) {
	if b.Verified == nil {
		if b.VerifiedDays != nil {
			return false, httpx.Validation("verified_days goes with verified: true")
		}
		return false, nil
	}
	if !*b.Verified {
		if at == nil {
			return false, nil
		}
		_, err := tx.Exec(ctx, `UPDATE wiki_pages SET verified_by = NULL, verified_at = NULL, verified_until = NULL WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
		return true, err
	}
	me := p.ActorUserID()
	if me == nil {
		return false, httpx.E(http.StatusForbidden, "forbidden", "Only a person can verify a page.")
	}
	var until *time.Time
	if b.VerifiedDays != nil {
		u := time.Now().Add(time.Duration(*b.VerifiedDays) * 24 * time.Hour)
		until = &u
	}
	_, err := tx.Exec(ctx, `UPDATE wiki_pages SET verified_by = $3, verified_at = now(), verified_until = $4 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, me, until)
	return true, err
}

// applyData replaces a database's schema or changes a row's values, as the patch asks; it
// reports whether anything changed. Neither moves the version nor adds a revision; a row's
// values do move its last edit.
func applyData(ctx context.Context, tx pgx.Tx, v Viewer, p *auth.Principal, id uuid.UUID, b pagePatch) (bool, error) {
	if len(b.Database) == 0 && len(b.Props) == 0 {
		return false, nil
	}
	var kind string
	var raw []byte
	var parentDB []byte
	var props map[string]any
	var parentID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT p.kind, p.database, p.props, p.parent_id, a.database FROM wiki_pages p
		LEFT JOIN wiki_pages a ON a.workspace_id = p.workspace_id AND a.id = p.parent_id
		WHERE p.workspace_id = $1 AND p.id = $2`, p.WorkspaceID, id).Scan(&kind, &raw, &props, &parentID, &parentDB); err != nil {
		return false, err
	}
	changed := false
	if len(b.Database) > 0 {
		if kind != "database" {
			return false, dbInvalid("Only a database has properties and views.")
		}
		var prev Database
		if err := json.Unmarshal(raw, &prev); err != nil {
			return false, err
		}
		next, err := cleanDatabase(b.Database, &prev)
		if err != nil {
			return false, err
		}
		// A unique id property added now numbers the rows already there.
		var added []string
		for _, np := range next.Properties {
			if np.Type == "unique_id" && !slices.ContainsFunc(prev.Properties, func(x DbProperty) bool { return x.ID == np.ID && x.Type == "unique_id" }) {
				added = append(added, np.ID)
			}
		}
		if err := numberRows(ctx, tx, p.WorkspaceID, id, &next, added); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET database = $3 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, next); err != nil {
			return false, err
		}
		changed = true
	}
	if len(b.Props) > 0 {
		if parentDB == nil {
			return false, dbInvalid("Only a database's rows have values.")
		}
		var db Database
		if err := json.Unmarshal(parentDB, &db); err != nil {
			return false, err
		}
		if props == nil {
			props = map[string]any{}
		}
		next, refs, err := cleanProps(b.Props, db, props)
		if err != nil {
			return false, err
		}
		if err := checkRefs(ctx, tx, v, p.WorkspaceID, refs); err != nil {
			return false, err
		}
		before, _ := json.Marshal(props)
		after, _ := json.Marshal(next)
		if string(before) != string(after) {
			if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET props = $3, updated_by = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
				p.WorkspaceID, id, next, p.ActorUserID()); err != nil {
				return false, err
			}
			changed = true
		}
	}
	return changed, nil
}
