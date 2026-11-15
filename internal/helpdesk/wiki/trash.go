package wiki

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// TrashedPage is a page in the trash, with what went with it (contracts/wiki.md "Trash").
type TrashedPage struct {
	WikiNode
	DeletedAt time.Time       `json:"deleted_at"`
	DeletedBy *domain.UserRef `json:"deleted_by"`
	PurgeAt   time.Time       `json:"purge_at" doc:"When it goes for good"`
	Subpages  int             `json:"subpages" doc:"How many pages went to the trash with it"`
	Path      []WikiRef       `json:"path" doc:"Where it was: its ancestors when it was trashed, the top-level page first"`
}

func registerTrash(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "trash-wiki-page", Method: http.MethodPost, Path: "/v1/wiki/pages/{id}/trash",
		Summary: "Move a wiki page to the trash", Tags: tags,
		Description: "The page and its subpages leave the tree, search and the graph; they can be restored for 30 days, then go for good. The same people may trash a page as may delete it."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
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
				before, err := loadPage(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if before.DeletedAt != nil {
					return inTrash()
				}
				gone, _, err := subtree(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if err := canDelete(ctx, tx, p, gone); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET deleted_at = now(), deleted_by = $3, trashed_with = $4
					WHERE workspace_id = $1 AND id = ANY($2)`, p.WorkspaceID, gone, p.ActorUserID(), id); err != nil {
					return err
				}
				// Favorites of pages in the trash would point nowhere; nobody hears about them.
				if _, err := tx.Exec(ctx, `DELETE FROM wiki_favorites WHERE workspace_id = $1 AND page_id = ANY($2)`, p.WorkspaceID, gone); err != nil {
					return err
				}
				if err := dropHiddenNotifications(ctx, tx, p.WorkspaceID, gone); err != nil {
					return err
				}
				if err := place(ctx, tx, p.WorkspaceID, before.Area, before.ParentID, before.owner, before.TeamID, before.Template, nil, nil); err != nil {
					return err
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.trashed", "wiki_page", &id, map[string]any{"title": pg.Title, "subpages": len(gone) - 1}); err != nil {
					return err
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.deleted", map[string]any{"wiki_page_id": id, "wiki_page_ids": gone, "trashed": true})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "restore-wiki-page", Method: http.MethodPost, Path: "/v1/wiki/pages/{id}/restore",
		Summary: "Restore a wiki page from the trash", Tags: tags,
		Description: "Puts the page and what went to the trash with it back in the tree: under its parent when that is in the tree, else at the top level of its space, last."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
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
				before, err := loadPage(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				var root *uuid.UUID
				if err := tx.QueryRow(ctx, `SELECT trashed_with FROM wiki_pages WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).Scan(&root); err != nil {
					return err
				}
				if root == nil {
					return httpx.E(http.StatusUnprocessableEntity, "not_in_trash", "This page isn't in the trash.")
				}
				if *root != id {
					return httpx.E(http.StatusUnprocessableEntity, "trashed_with_parent", "This page went to the trash with a page above it. Restore that one.")
				}
				back, height, err := subtree(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				// Back under its parent while that is in the tree; else at the top of its space.
				var parentLive bool
				if before.ParentID != nil {
					if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM wiki_pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL)`, p.WorkspaceID, *before.ParentID).Scan(&parentLive); err != nil {
						return err
					}
				}
				par := before.ParentID
				if !parentLive {
					par = nil
				}
				if par != nil {
					up, err := ancestors(ctx, tx, p.WorkspaceID, *par)
					if err != nil {
						return err
					}
					if len(up)+1+height > maxDepth {
						par = nil
					}
				}
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET deleted_at = NULL, deleted_by = NULL, trashed_with = NULL WHERE workspace_id = $1 AND id = ANY($2)`, p.WorkspaceID, back); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET parent_id = $3 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, par); err != nil {
					return err
				}
				// A journal or a daily note restored next to a live one becomes a plain page.
				if _, err := tx.Exec(ctx, `UPDATE wiki_pages p SET journal = false, daily_date = NULL WHERE p.workspace_id = $1 AND p.id = ANY($2)
					AND ((p.journal AND EXISTS (SELECT 1 FROM wiki_pages o WHERE o.workspace_id = p.workspace_id AND o.private_to = p.private_to AND o.area = p.area AND o.journal AND o.deleted_at IS NULL AND o.id <> p.id))
					  OR (p.daily_date IS NOT NULL AND EXISTS (SELECT 1 FROM wiki_pages o WHERE o.workspace_id = p.workspace_id AND o.private_to = p.private_to AND o.area = p.area AND o.daily_date = p.daily_date AND o.deleted_at IS NULL AND o.id <> p.id)))`,
					p.WorkspaceID, back); err != nil {
					return err
				}
				if err := place(ctx, tx, p.WorkspaceID, before.Area, par, before.owner, before.TeamID, before.Template, &id, nil); err != nil {
					return err
				}
				if pg, err = loadPage(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.restored", "wiki_page", &id, map[string]any{"title": pg.Title, "subpages": len(back) - 1}); err != nil {
					return err
				}
				return pageEvent(ctx, tx, p.WorkspaceID, pg, "wiki_page.restored", map[string]any{"wiki_page": pg.node(), "wiki_page_ids": back})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &pageOut{pg}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-wiki-trash", Method: http.MethodGet, Path: "/v1/wiki/trash",
		Summary: "List the wiki's trash", Tags: tags,
		Description: "The pages of one area moved to the trash that the caller may see, last trashed first, each with how many pages went with it."},
		func(ctx context.Context, in *areaIn) (*struct{ Body httpx.Page[TrashedPage] }, error) {
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
			rows, err := d.DB.Pool.Query(ctx, `SELECT `+nodeCols+`, p.deleted_at,
					x.id, x.name, x.email, x.avatar_url,
					(SELECT count(*) - 1 FROM wiki_pages s WHERE s.workspace_id = p.workspace_id AND s.trashed_with = p.id)
				FROM wiki_pages p LEFT JOIN users x ON x.id = p.deleted_by
				WHERE p.workspace_id = $1 AND p.trashed_with = p.id AND p.area = $4 AND `+seesSQL("p", 2, 3)+`
				ORDER BY p.deleted_at DESC LIMIT 500`, p.WorkspaceID, me, hidden, in.Area)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := []TrashedPage{}
			defer rows.Close()
			for rows.Next() {
				var t TrashedPage
				var x userCols
				if err := rows.Scan(&t.ID, &t.ParentID, &t.Title, &t.Icon, &t.Position, &t.Version, &t.UpdatedAt, &t.CreatedBy, &t.Tags,
					&t.Private, &t.TeamID, &t.Journal, &t.DailyDate, &t.Template, &t.Verified, &t.Kind, &t.Area,
					&t.DeletedAt, &x.id, &x.name, &x.email, &x.avatar, &t.Subpages); err != nil {
					return nil, httpx.Wrap(err)
				}
				t.DeletedBy = x.ref()
				t.PurgeAt = t.DeletedAt.Add(trashKeep)
				out = append(out, t)
			}
			if err := rows.Err(); err != nil {
				return nil, httpx.Wrap(err)
			}
			for i := range out {
				if out[i].Path, err = ancestors(ctx, d.DB.Pool, p.WorkspaceID, out[i].ID); err != nil {
					return nil, httpx.Wrap(err)
				}
			}
			return &struct{ Body httpx.Page[TrashedPage] }{httpx.Page[TrashedPage]{Data: out}}, nil
		})
}

// Periodic empties pages that have been in the trash for 30 days (and forgets page views
// past 90 days) and sends the reminders that are due.
func Periodic() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) { return jobs.WikiTrashPurgeArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true}),
		river.NewPeriodicJob(river.PeriodicInterval(time.Minute),
			func() (river.JobArgs, *river.InsertOpts) {
				return jobs.WikiRemindersArgs{}, &river.InsertOpts{MaxAttempts: 3, UniqueOpts: river.UniqueOpts{ByPeriod: time.Minute}}
			}, &river.PeriodicJobOpts{RunOnStart: true}),
	}
}

// RegisterWorkers adds the trash's purge and the reminders.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	river.AddWorker(w, &purgeWorker{d: d})
	river.AddWorker(w, &reminderWorker{d: d})
}

type purgeWorker struct {
	river.WorkerDefaults[jobs.WikiTrashPurgeArgs]
	d *deps.Deps
}

func (pw *purgeWorker) Work(ctx context.Context, _ *river.Job[jobs.WikiTrashPurgeArgs]) error {
	if err := purgeTrash(ctx, pw.d, time.Now().Add(-trashKeep)); err != nil {
		return err
	}
	return purgeViews(ctx, pw.d)
}

// purgeTrash deletes for good every trashed page (with what went with it) trashed before.
func purgeTrash(ctx context.Context, d *deps.Deps, before time.Time) error {
	_, err := d.DB.Pool.Exec(ctx, `DELETE FROM wiki_pages WHERE trashed_with = id AND deleted_at < $1`, before)
	return err
}
