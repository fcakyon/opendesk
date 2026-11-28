package products

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
)

// HoldDelay is how long a held inbound job waits before it looks again. Turning Tickets
// back on does not wait for it: Reactivate wakes the workspace's held jobs.
const HoldDelay = 10 * time.Minute

// ErrHeld means inbound work was stored but must not change tickets while Tickets is off.
var ErrHeld = errors.New("ticket work is held while tickets are off for this workspace")

// Hold returns ErrHeld while the workspace has Tickets off, and nil once it is on.
func Hold(ctx context.Context, q db.Querier, wid uuid.UUID) error {
	if err := RequireTickets(ctx, q, wid); err != nil {
		return ErrHeld
	}
	return nil
}

// SnoozeHeld turns ErrHeld into a snooze, which uses no attempt; other errors pass through.
func SnoozeHeld(err error) error {
	if errors.Is(err, ErrHeld) {
		return river.JobSnooze(HoldDelay)
	}
	return err
}

// Reactivate wakes the inbound email, phone, WhatsApp and support channel jobs held for a
// workspace whose Tickets just came back on, oldest first, one millisecond apart.
func Reactivate(ctx context.Context, q db.Querier, wid uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE river_job j SET scheduled_at = now() + n.i * interval '1 millisecond'
		FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS i FROM river_job
			WHERE state = 'scheduled' AND (
				(kind IN ('email.process_inbound', 'phone.inbound', 'whatsapp.inbound') AND args->>'workspace_id' = $1::text)
				OR (kind = 'support_channels.inbound' AND args->>'connection_id' IN
					(SELECT id::text FROM support_channel_connections WHERE workspace_id = $1::text::uuid)))) n
		WHERE j.id = n.id`, wid.String())
	return err
}
