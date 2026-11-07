package wiki

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// A member's own wiki (contracts/wiki.md "Favorites, recent pages and readers", "Journal"):
// their favorites in their order, the pages they opened lately, who reads a page, and their
// journal of daily notes. People only: an API key has none of these.

const maxFavorites = 100

// PageReader is someone who opened a page.
type PageReader struct {
	User   domain.UserRef `json:"user"`
	Visits int            `json:"visits"`
	LastAt time.Time      `json:"last_at"`
}

// PageViews is how much a page is read.
type PageViews struct {
	Views   int          `json:"views" doc:"Every time someone opened it"`
	People  int          `json:"people" doc:"How many people opened it"`
	Readers []PageReader `json:"readers" doc:"Who opened it, last first (at most 20)"`
}

// DailyNote is a day of the member's journal that has a note.
type DailyNote struct {
	Date string    `json:"date" doc:"YYYY-MM-DD"`
	ID   uuid.UUID `json:"id"`
}

func person(ctx context.Context) (*auth.Principal, error) {
	p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if p.Kind != auth.KindUser {
		return nil, httpx.E(http.StatusForbidden, "forbidden", "Only a person has favorites, recent pages and a journal.")
	}
	return p, nil
}

func registerPersonal(d *deps.Deps, api huma.API) {
	type nodesOut struct {
		Body httpx.Page[WikiNode]
	}

	huma.Register(api, huma.Operation{OperationID: "list-wiki-favorites", Method: http.MethodGet, Path: "/v1/wiki/favorites",
		Summary: "List your favorite wiki pages", Tags: tags,
		Description: "Favorites of both areas, the wiki's and Pages' (contracts/pages.md), in your order; Pages' only while the workspace has Pages on."},
		func(ctx context.Context, _ *struct{}) (*nodesOut, error) {
			p, err := person(ctx)
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			areas, err := areasOn(ctx, d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` JOIN wiki_favorites f ON f.workspace_id = p.workspace_id AND f.page_id = p.id
				WHERE p.workspace_id = $1 AND f.user_id = $4 AND p.area = ANY($5) AND `+liveSQL("p", 2, 3)+` ORDER BY f.position, p.title`, p.WorkspaceID, me, hidden, p.UserID, areas))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &nodesOut{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "set-wiki-favorites", Method: http.MethodPut, Path: "/v1/wiki/favorites",
		Summary: "Set your favorite wiki pages", Tags: tags,
		Description: "Replaces your favorites with these pages, in this order (at most 100). Pages you may not see, or in the trash, are left out. " +
			"Favorites in Pages stay as they are while the workspace has Pages off."},
		func(ctx context.Context, in *struct {
			Body struct {
				PageIDs []string `json:"page_ids" maxItems:"100"`
			}
		}) (*nodesOut, error) {
			p, err := person(ctx)
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var list []uuid.UUID
			for _, raw := range in.Body.PageIDs {
				id, err := hd.ParseRef(raw, "page_ids")
				if err != nil {
					return nil, err
				}
				list = append(list, id)
			}
			if len(list) > maxFavorites {
				return nil, httpx.Validation("at most 100 favorites")
			}
			// Only the areas that are on are replaced: the list a client sends while Pages is
			// off cannot name Pages' favorites, and they come back when Pages does.
			areas, err := areasOn(ctx, d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `DELETE FROM wiki_favorites f USING wiki_pages p
					WHERE f.workspace_id = $1 AND f.user_id = $2 AND p.workspace_id = f.workspace_id AND p.id = f.page_id AND p.area = ANY($3)`,
					p.WorkspaceID, p.UserID, areas); err != nil {
					return err
				}
				_, err := tx.Exec(ctx, `INSERT INTO wiki_favorites (workspace_id, user_id, page_id, position)
					SELECT $1, $2, o.id, min(o.n) FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, n)
					JOIN wiki_pages p ON p.workspace_id = $1 AND p.id = o.id
					WHERE p.area = ANY($6) AND `+liveSQL("p", 4, 5)+` GROUP BY o.id`, p.WorkspaceID, p.UserID, list, me, hidden, areas)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` JOIN wiki_favorites f ON f.workspace_id = p.workspace_id AND f.page_id = p.id
				WHERE p.workspace_id = $1 AND f.user_id = $2 AND p.area = ANY($3) ORDER BY f.position`, p.WorkspaceID, p.UserID, areas))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &nodesOut{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-wiki-recent", Method: http.MethodGet, Path: "/v1/wiki/recent",
		Summary: "List the wiki pages you opened lately", Tags: tags},
		func(ctx context.Context, in *struct {
			Limit int    `query:"limit" minimum:"0" maximum:"50" doc:"Default 15"`
			Area  string `query:"area" enum:"wiki,pages" default:"wiki" doc:"Whose pages: the wiki's or Pages' (contracts/pages.md)"`
		}) (*nodesOut, error) {
			p, err := person(ctx)
			if err != nil {
				return nil, err
			}
			if err := requireArea(ctx, d.DB.Pool, p.WorkspaceID, in.Area); err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			limit := in.Limit
			if limit <= 0 {
				limit = 15
			}
			me, hidden := v.args()
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` JOIN wiki_visits w ON w.workspace_id = p.workspace_id AND w.page_id = p.id
				WHERE p.workspace_id = $1 AND w.user_id = $4 AND p.area = $6 AND `+liveSQL("p", 2, 3)+` ORDER BY w.last_at DESC LIMIT $5`, p.WorkspaceID, me, hidden, p.UserID, limit, in.Area))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &nodesOut{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-wiki-page-views", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/views",
		Summary: "See who reads a wiki page", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body PageViews }, error) {
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
			if err := mustSee(ctx, d.DB.Pool, v, p.WorkspaceID, id); err != nil {
				return nil, httpx.Wrap(err)
			}
			out := PageViews{Readers: []PageReader{}}
			if err := d.DB.Pool.QueryRow(ctx, `SELECT coalesce(sum(visits), 0), count(*) FROM wiki_visits WHERE workspace_id = $1 AND page_id = $2`,
				p.WorkspaceID, id).Scan(&out.Views, &out.People); err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT u.id, u.name, u.email, u.avatar_url, w.visits, w.last_at
				FROM wiki_visits w JOIN users u ON u.id = w.user_id
				WHERE w.workspace_id = $1 AND w.page_id = $2 ORDER BY w.last_at DESC LIMIT 20`, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			defer rows.Close()
			for rows.Next() {
				var r PageReader
				var avatar string
				if err := rows.Scan(&r.User.ID, &r.User.Name, &r.User.Email, &avatar, &r.Visits, &r.LastAt); err != nil {
					return nil, httpx.Wrap(err)
				}
				r.User.AvatarURL = domain.Avatar(avatar)
				out.Readers = append(out.Readers, r)
			}
			if err := rows.Err(); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body PageViews }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-wiki-daily-notes", Method: http.MethodGet, Path: "/v1/wiki/daily",
		Summary: "List the days of your journal that have a note", Tags: tags},
		func(ctx context.Context, in *struct {
			From string `query:"from" pattern:"^\\d{4}-\\d{2}-\\d{2}$" doc:"YYYY-MM-DD, default 60 days ago"`
			To   string `query:"to" pattern:"^\\d{4}-\\d{2}-\\d{2}$" doc:"YYYY-MM-DD, default 60 days ahead"`
			Area string `query:"area" enum:"wiki,pages" default:"wiki" doc:"Whose pages: the wiki's or Pages' (contracts/pages.md)"`
		}) (*struct{ Body httpx.Page[DailyNote] }, error) {
			p, err := person(ctx)
			if err != nil {
				return nil, err
			}
			if err := requireArea(ctx, d.DB.Pool, p.WorkspaceID, in.Area); err != nil {
				return nil, httpx.Wrap(err)
			}
			from, to := in.From, in.To
			if from == "" {
				from = time.Now().AddDate(0, 0, -60).Format(time.DateOnly)
			}
			if to == "" {
				to = time.Now().AddDate(0, 0, 60).Format(time.DateOnly)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT to_char(daily_date, 'YYYY-MM-DD'), id FROM wiki_pages
				WHERE workspace_id = $1 AND private_to = $2 AND area = $5 AND daily_date BETWEEN $3::date AND $4::date AND deleted_at IS NULL ORDER BY daily_date`,
				p.WorkspaceID, p.UserID, from, to, in.Area)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (DailyNote, error) {
				var n DailyNote
				err := r.Scan(&n.Date, &n.ID)
				return n, err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if out == nil {
				out = []DailyNote{}
			}
			return &struct{ Body httpx.Page[DailyNote] }{httpx.Page[DailyNote]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "open-wiki-daily-note", Method: http.MethodPost, Path: "/v1/wiki/daily",
		Summary: "Open your daily note of a day", Tags: tags,
		Description: "Your note of that day in your journal, made (with the journal, the first time) when there is none yet. Both are your private pages. The title is the app's, in your language."},
		func(ctx context.Context, in *struct {
			Body struct {
				Date         string `json:"date" pattern:"^\\d{4}-\\d{2}-\\d{2}$"`
				Title        string `json:"title" maxLength:"200" doc:"The day as you read it, e.g. Friday, 6 November 2026"`
				JournalTitle string `json:"journal_title,omitempty" maxLength:"200" doc:"The journal's title when it is made; default Journal"`
				BodyHTML     string `json:"body_html,omitempty" doc:"The new note's text"`
				Area         string `json:"area,omitempty" enum:"wiki,pages" doc:"Whose journal: the wiki's (default) or Pages' (contracts/pages.md)"`
			}
		}) (*pageOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind != auth.KindUser {
				return nil, httpx.E(http.StatusForbidden, "forbidden", "Only a person has a journal.")
			}
			day, err := time.Parse(time.DateOnly, in.Body.Date)
			if err != nil {
				return nil, httpx.Validation("date must be YYYY-MM-DD")
			}
			body, err := cleanBody(in.Body.BodyHTML)
			if err != nil {
				return nil, err
			}
			area := AreaWiki
			if in.Body.Area == AreaPages {
				area = AreaPages
			}
			var pg WikiPage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
					return err
				}
				if err := requireArea(ctx, tx, p.WorkspaceID, area); err != nil {
					return err
				}
				var existing uuid.UUID
				err := tx.QueryRow(ctx, `SELECT id FROM wiki_pages WHERE workspace_id = $1 AND private_to = $2 AND daily_date = $3 AND area = $4 AND deleted_at IS NULL`,
					p.WorkspaceID, p.UserID, day, area).Scan(&existing)
				if err == nil {
					pg, err = loadPage(ctx, tx, p.WorkspaceID, existing)
					return err
				}
				if !db.IsNotFound(err) {
					return err
				}
				var journal uuid.UUID
				err = tx.QueryRow(ctx, `SELECT id FROM wiki_pages WHERE workspace_id = $1 AND private_to = $2 AND journal AND area = $3 AND deleted_at IS NULL`, p.WorkspaceID, p.UserID, area).Scan(&journal)
				if db.IsNotFound(err) {
					if err := roomFor(ctx, tx, p.WorkspaceID, 2); err != nil {
						return err
					}
					journal = ids.New()
					title := cleanTitle(in.Body.JournalTitle)
					if title == "" {
						title = "Journal"
					}
					if _, err := tx.Exec(ctx, `INSERT INTO wiki_pages (id, workspace_id, title, icon, position, created_by, updated_by, private_to, journal, area)
						VALUES ($1, $2, $3, '📓', 0, $4, $4, $4, true, $5)`, journal, p.WorkspaceID, title, p.UserID, area); err != nil {
						return err
					}
					if err := place(ctx, tx, p.WorkspaceID, area, nil, &p.UserID, nil, false, &journal, new(int)); err != nil {
						return err
					}
					if err := recordRevision(ctx, tx, p, journal, title, "📓", "", false); err != nil {
						return err
					}
					jp, err := loadPage(ctx, tx, p.WorkspaceID, journal)
					if err != nil {
						return err
					}
					if err := pageEvent(ctx, tx, p.WorkspaceID, jp, "wiki_page.created", eventPage(jp)); err != nil {
						return err
					}
				} else if err != nil {
					return err
				} else if err := roomFor(ctx, tx, p.WorkspaceID, 1); err != nil {
					return err
				}
				id := ids.New()
				title := cleanTitle(in.Body.Title)
				if title == "" {
					title = in.Body.Date
				}
				if _, err := tx.Exec(ctx, `INSERT INTO wiki_pages (id, workspace_id, parent_id, title, icon, body_html, position, created_by, updated_by, private_to, daily_date, area)
					VALUES ($1, $2, $3, $4, '', $5, 0, $6, $6, $6, $7, $8)`, id, p.WorkspaceID, journal, title, body, p.UserID, day, area); err != nil {
					return err
				}
				// Newest day first, as a journal reads.
				if err := place(ctx, tx, p.WorkspaceID, area, &journal, &p.UserID, nil, false, &id, new(int)); err != nil {
					return err
				}
				if err := recordRevision(ctx, tx, p, id, title, "", body, false); err != nil {
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
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.created", eventPage(pg))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})
}
