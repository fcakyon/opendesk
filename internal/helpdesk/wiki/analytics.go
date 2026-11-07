package wiki

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Page analytics (contracts/wiki.md "Page analytics"): how often a page is opened, per day,
// as counts. Who opened it stays with the readers list ("Favorites, recent pages and readers").
const (
	// viewGap: a person's reads of a page closer together than this are one view, so a page
	// read again as others save it, or opened and reloaded, counts once.
	viewGap = 30 * time.Minute
	// viewKeep: days of views kept.
	viewKeep        = 90
	defaultViewDays = 28
)

// recordVisit counts a person's read of a page: a visit (recent pages, readers) and, once
// per viewGap, a view of the day (analytics). A failure is logged, never the read's.
func recordVisit(ctx context.Context, d *deps.Deps, wid, uid, id uuid.UUID) {
	if _, err := d.DB.Pool.Exec(ctx, `WITH prev AS (
			SELECT last_at FROM wiki_visits WHERE workspace_id = $1 AND user_id = $2 AND page_id = $3
		), visit AS (
			INSERT INTO wiki_visits (workspace_id, user_id, page_id) VALUES ($1, $2, $3)
			ON CONFLICT (workspace_id, user_id, page_id) DO UPDATE SET visits = wiki_visits.visits + 1, last_at = now()
		)
		INSERT INTO wiki_page_views (workspace_id, page_id, day, user_id) VALUES ($1, $3, (now() AT TIME ZONE 'UTC')::date, $2)
		ON CONFLICT (page_id, day, user_id) DO UPDATE SET views = wiki_page_views.views +
			CASE WHEN coalesce((SELECT last_at FROM prev), '-infinity') > now() - $4::int * interval '1 second' THEN 0 ELSE 1 END`,
		wid, uid, id, int(viewGap.Seconds())); err != nil {
		slog.WarnContext(ctx, "wiki: record visit", "err", err)
	}
}

// purgeViews forgets the days of views older than viewKeep.
func purgeViews(ctx context.Context, d *deps.Deps) error {
	_, err := d.DB.Pool.Exec(ctx, `DELETE FROM wiki_page_views WHERE day < (now() AT TIME ZONE 'UTC')::date - $1::int`, viewKeep)
	return err
}

// ViewDay is one day of a page's analytics.
type ViewDay struct {
	Date    string `json:"date" doc:"YYYY-MM-DD, UTC"`
	Views   int    `json:"views" doc:"Times it was opened (reads by one person within 30 minutes count once)"`
	Viewers int    `json:"viewers" doc:"How many people opened it"`
}

// EditDay is how many times a page was edited on a day.
type EditDay struct {
	Date  string `json:"date" doc:"YYYY-MM-DD, UTC"`
	Count int    `json:"count" doc:"Revisions started that day (one person's edits close together are one)"`
}

// PageAnalytics is how much a page was read and edited lately: counts only, never who.
type PageAnalytics struct {
	Days         []ViewDay `json:"days" doc:"Every day of the range, oldest first, today last"`
	TotalViews   int       `json:"total_views"`
	TotalViewers int       `json:"total_viewers" doc:"Different people over the whole range"`
	Edits        []EditDay `json:"edits" doc:"Every day of the range, oldest first"`
}

func registerAnalytics(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "get-wiki-page-analytics", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/analytics",
		Summary: "See how a wiki page is read", Tags: tags,
		Description: "Views and people per day (UTC) over the last `days` days, and edits per day. Counts only."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Days int    `query:"days" minimum:"0" maximum:"90" doc:"Default 28"`
		}) (*struct{ Body PageAnalytics }, error) {
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
			days := in.Days
			if days <= 0 {
				days = defaultViewDays
			}
			out, err := pageAnalytics(ctx, d, p.WorkspaceID, id, days)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body PageAnalytics }{out}, nil
		})
}

func pageAnalytics(ctx context.Context, d *deps.Deps, wid, id uuid.UUID, days int) (PageAnalytics, error) {
	out := PageAnalytics{Days: []ViewDay{}, Edits: []EditDay{}}
	// The range's days, today (UTC) last.
	const series = `SELECT g::date AS day FROM generate_series((now() AT TIME ZONE 'UTC')::date - ($3::int - 1), (now() AT TIME ZONE 'UTC')::date, '1 day') g`
	rows, err := d.DB.Pool.Query(ctx, `WITH r AS (`+series+`)
		SELECT to_char(r.day, 'YYYY-MM-DD'), coalesce(sum(v.views), 0)::int, count(v.user_id)::int
		FROM r LEFT JOIN wiki_page_views v ON v.page_id = $2 AND v.workspace_id = $1 AND v.day = r.day
		GROUP BY r.day ORDER BY r.day`, wid, id, days)
	if err != nil {
		return out, err
	}
	if out.Days, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (ViewDay, error) {
		var x ViewDay
		err := r.Scan(&x.Date, &x.Views, &x.Viewers)
		return x, err
	}); err != nil {
		return out, err
	}
	for _, x := range out.Days {
		out.TotalViews += x.Views
	}
	if err := d.DB.Pool.QueryRow(ctx, `SELECT count(DISTINCT user_id) FROM wiki_page_views
		WHERE workspace_id = $1 AND page_id = $2 AND day > (now() AT TIME ZONE 'UTC')::date - $3::int`, wid, id, days).Scan(&out.TotalViewers); err != nil {
		return out, err
	}
	rows, err = d.DB.Pool.Query(ctx, `WITH r AS (`+series+`)
		SELECT to_char(r.day, 'YYYY-MM-DD'), count(x.id)::int
		FROM r LEFT JOIN wiki_page_revisions x ON x.workspace_id = $1 AND x.page_id = $2 AND (x.created_at AT TIME ZONE 'UTC')::date = r.day
		GROUP BY r.day ORDER BY r.day`, wid, id, days)
	if err != nil {
		return out, err
	}
	out.Edits, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (EditDay, error) {
		var x EditDay
		err := r.Scan(&x.Date, &x.Count)
		return x, err
	})
	return out, err
}
