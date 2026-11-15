package domain

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// VisitorPresence is whether a chat's visitor is on the page now, by the signal the chat
// follow-up uses (ChatFollowUpDue): one of their widget sessions was seen within
// ChatAwayAfter. contracts/api.md "Visitor presence".
type VisitorPresence struct {
	Chat             bool       `json:"chat" doc:"A chat ticket with a contact; false: the rest is empty"`
	Present          bool       `json:"present" doc:"The visitor's widget made a request within away_after_seconds, so an agent's reply is not emailed"`
	LastSeenAt       *time.Time `json:"last_seen_at" doc:"The last request of any of the visitor's widget sessions"`
	AwayAfterSeconds int        `json:"away_after_seconds" doc:"How long a quiet widget still counts as on the page"`
	EmailFollowUp    bool       `json:"email_follow_up" doc:"While the visitor is away, an agent's reply also goes out by email (the widget's email_follow_up is on and the contact has an email)"`
}

// LoadVisitorPresence reads a ticket's visitor presence; a ticket that is not a chat with a
// contact has Chat false. A missing ticket is db not found.
func LoadVisitorPresence(ctx context.Context, q db.Querier, wid, ticketID uuid.UUID) (VisitorPresence, error) {
	away := int(ChatAwayAfter / time.Second)
	p := VisitorPresence{AwayAfterSeconds: away}
	err := q.QueryRow(ctx, `SELECT t.channel = 'chat' AND t.contact_id IS NOT NULL, s.seen, COALESCE(s.seen >= now() - make_interval(secs => $3), false)
		FROM tickets t
		LEFT JOIN LATERAL (SELECT max(ws.last_seen_at) AS seen FROM widget_sessions ws
			WHERE ws.contact_id = t.contact_id AND ws.workspace_id = t.workspace_id) s ON true
		WHERE t.workspace_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`, wid, ticketID, away).Scan(&p.Chat, &p.LastSeenAt, &p.Present)
	if err != nil || !p.Chat {
		return VisitorPresence{AwayAfterSeconds: away}, err
	}
	// The follow-up's own test with no session counting as seen: would a reply be emailed
	// were the visitor away?
	p.EmailFollowUp, err = ChatFollowUpDue(ctx, q, wid, ticketID, time.Now().Add(24*time.Hour))
	return p, err
}
