package wiki

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/notifyprefs"
)

// Reminders (contracts/wiki.md "Reminders"): a date in a page's text with data-reminder
// reminds the person who set it when the time comes.
const (
	// maxReminders bounds the reminders one page keeps.
	maxReminders = 100
	// reminderHour is when a reminder on a bare date goes off, in its owner's timezone.
	reminderHour = 9
	// reminderBatch is how many due reminders one transaction sends.
	reminderBatch = 100
	// reminderLate: a reminder more than this late (the server was down, the date was
	// already past when written) is dropped instead of sent.
	reminderLate = 24 * time.Hour
)

// syncReminders makes the page's reminders the marks of its body: each id is kept or
// added (a new one belongs to the person saving; an existing one keeps its owner) with
// its time in its owner's notification timezone, a changed time goes off again, and ids
// no longer in the body are removed.
func syncReminders(ctx context.Context, tx pgx.Tx, p *auth.Principal, page uuid.UUID, marks []reminderMark) error {
	if len(marks) > maxReminders {
		marks = marks[:maxReminders]
	}
	rows, err := tx.Query(ctx, `SELECT id, user_id FROM wiki_reminders WHERE workspace_id = $1 AND page_id = $2`, p.WorkspaceID, page)
	if err != nil {
		return err
	}
	owners := map[uuid.UUID]uuid.UUID{}
	for rows.Next() {
		var id, uid uuid.UUID
		if err := rows.Scan(&id, &uid); err != nil {
			rows.Close()
			return err
		}
		owners[id] = uid
	}
	if err := rows.Err(); err != nil {
		return err
	}
	zones := map[uuid.UUID]*time.Location{}
	keep := []uuid.UUID{}
	for _, m := range marks {
		owner, ok := owners[m.id]
		if !ok {
			me := p.ActorUserID()
			if me == nil {
				continue // only a person sets a reminder
			}
			owner = *me
		}
		loc, ok := zones[owner]
		if !ok {
			s, err := notifyprefs.LoadSettings(ctx, tx, owner)
			if err != nil {
				return err
			}
			loc = s.Location()
			zones[owner] = loc
		}
		at, ok := reminderTime(m.datetime, loc)
		if !ok {
			continue
		}
		// An id of another page's reminder stays that page's.
		tag, err := tx.Exec(ctx, `INSERT INTO wiki_reminders (id, workspace_id, page_id, user_id, remind_at, label)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (id) DO UPDATE SET remind_at = EXCLUDED.remind_at, label = EXCLUDED.label,
				sent_at = CASE WHEN wiki_reminders.remind_at = EXCLUDED.remind_at THEN wiki_reminders.sent_at END
			WHERE wiki_reminders.workspace_id = EXCLUDED.workspace_id AND wiki_reminders.page_id = EXCLUDED.page_id`,
			m.id, p.WorkspaceID, page, owner, at, m.label)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			keep = append(keep, m.id)
		}
	}
	_, err = tx.Exec(ctx, `DELETE FROM wiki_reminders WHERE workspace_id = $1 AND page_id = $2 AND NOT id = ANY($3::uuid[])`, p.WorkspaceID, page, keep)
	return err
}

// reminderTime reads a reminder's datetime: RFC 3339, a local date and time, or a bare
// date (reminderHour that day), local times in loc.
func reminderTime(raw string, loc *time.Location) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, true
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return t, true
		}
	}
	if d, err := time.Parse(time.DateOnly, raw); err == nil {
		return time.Date(d.Year(), d.Month(), d.Day(), reminderHour, 0, 0, 0, loc), true
	}
	return time.Time{}, false
}

type reminderWorker struct {
	river.WorkerDefaults[jobs.WikiRemindersArgs]
	d *deps.Deps
}

func (rw *reminderWorker) Work(ctx context.Context, _ *river.Job[jobs.WikiRemindersArgs]) error {
	return sendReminders(ctx, rw.d, time.Now())
}

// sendReminders sends every reminder due at now, once: each batch is claimed with SKIP
// LOCKED, so workers running at once share the work. A reminder on a page its owner may no
// longer see, a template, or one more than reminderLate late is marked done unsent.
func sendReminders(ctx context.Context, d *deps.Deps, now time.Time) error {
	for {
		n := 0
		err := d.DB.Tx(ctx, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `SELECT id, workspace_id, page_id, user_id, remind_at, label FROM wiki_reminders
				WHERE sent_at IS NULL AND remind_at <= $1 ORDER BY remind_at LIMIT $2 FOR UPDATE SKIP LOCKED`, now, reminderBatch)
			if err != nil {
				return err
			}
			type due struct {
				id, wid, page, user uuid.UUID
				at                  time.Time
				label               string
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (due, error) {
				var x due
				err := r.Scan(&x.id, &x.wid, &x.page, &x.user, &x.at, &x.label)
				return x, err
			})
			if err != nil {
				return err
			}
			n = len(list)
			for _, x := range list {
				if _, err := tx.Exec(ctx, `UPDATE wiki_reminders SET sent_at = now() WHERE id = $1`, x.id); err != nil {
					return err
				}
				if x.at.Before(now.Add(-reminderLate)) {
					continue
				}
				head, err := headOf(ctx, tx, x.wid, x.page)
				if err != nil {
					return err
				}
				if head.template {
					continue
				}
				who, err := audience(ctx, tx, x.wid, x.page, []uuid.UUID{x.user})
				if err != nil {
					return err
				}
				if len(who) == 0 {
					continue
				}
				if err := hd.Notify(ctx, tx, x.wid, x.user, typeReminder, nil, map[string]any{"page_id": x.page.String(), "page_title": head.pg.Title,
					"reminder_id": x.id.String(), "remind_at": x.at.UTC().Format(time.RFC3339), "label": x.label}); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil || n < reminderBatch {
			return err
		}
	}
}
