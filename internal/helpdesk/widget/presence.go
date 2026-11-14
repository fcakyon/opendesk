package widget

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
)

// The visitor's comings back (contracts/realtime.md "Live events", customer.presence): the
// first widget request after domain.ChatAwayAfter of quiet tells the agents on each of the
// visitor's open chats, so their "on the page" indicator turns on at once. Going away has no
// event (it is the absence of requests): clients read GET /v1/tickets/{id}/visitor-presence
// again after its last_seen_at + away_after_seconds.

var (
	seenMu sync.Mutex
	seen   = map[uuid.UUID]time.Time{}
)

// comeback records a request of the contact's widget at now and reports whether the contact
// had been quiet at least domain.ChatAwayAfter, or was not seen by this process yet.
func comeback(contactID uuid.UUID, now time.Time) bool {
	seenMu.Lock()
	defer seenMu.Unlock()
	t, ok := seen[contactID]
	if len(seen) > 10000 {
		seen = map[uuid.UUID]time.Time{}
	}
	seen[contactID] = now
	return !ok || now.Sub(t) >= domain.ChatAwayAfter
}

// VisitorSeen returns what auth.Resolver calls when a visitor's request refreshes their
// session's last_seen_at; the widget session calls it too. It never blocks the request.
func VisitorSeen(d *deps.Deps) func(ctx context.Context, wid, contactID uuid.UUID) {
	return func(ctx context.Context, wid, contactID uuid.UUID) {
		if d.NATS == nil || contactID == uuid.Nil || !comeback(contactID, time.Now()) {
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			evs, err := presenceEvents(ctx, d, wid, contactID)
			if err != nil {
				return
			}
			for _, ev := range evs {
				events.PublishLive(d.NATS.Conn, ev)
			}
		}()
	}
}

// presenceEvents are the customer.presence events for the contact's open chats (at most
// five), with each ticket's private team and brand like customer.typing.
func presenceEvents(ctx context.Context, d *deps.Deps, wid, contactID uuid.UUID) ([]events.LiveEvent, error) {
	rows, err := d.DB.Pool.Query(ctx, `SELECT t.id, t.brand_id, tm.id FROM tickets t
		LEFT JOIN teams tm ON tm.id = t.team_id AND tm.private
		WHERE t.workspace_id = $1 AND t.contact_id = $2 AND t.channel = 'chat' AND t.deleted_at IS NULL
			AND t.status IN ('open', 'pending', 'on_hold')
		ORDER BY t.updated_at DESC LIMIT 5`, wid, contactID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (events.LiveEvent, error) {
		ev := events.LiveEvent{WorkspaceID: wid, ContactID: contactID, Type: "customer.presence", Data: map[string]any{}}
		err := r.Scan(&ev.TicketID, &ev.BrandID, &ev.TeamID)
		return ev, err
	})
}
