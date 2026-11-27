// Package thread is the WhatsApp conversation a ticket carries (contracts/whatsapp.md
// "Tickets"): the workspace number the customer wrote to, the wa_id they wrote from, the
// connection that holds that number now, and Meta's 24-hour customer service window. It is
// the one answer to "where does this ticket's reply go", shared by the ticket routes and the
// WhatsApp engine.
package thread

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// Window is Meta's customer service window: free-form replies are allowed for 24 hours after
// the customer's latest message.
const Window = 24 * time.Hour

// Thread is one ticket's WhatsApp conversation.
type Thread struct {
	PhoneNumberID string
	WaID          string
	// ConnectionID is the workspace's connection for PhoneNumberID, nil while the number is
	// not connected.
	ConnectionID *uuid.UUID
	// LastInbound is the customer's latest message to this number, from any ticket.
	LastInbound *time.Time
}

// ClosesAt is when the window closes, nil when the customer never wrote to this number.
func (t Thread) ClosesAt() *time.Time {
	if t.LastInbound == nil {
		return nil
	}
	at := t.LastInbound.Add(Window)
	return &at
}

// Open reports whether a free-form reply may go out at now.
func (t Thread) Open(now time.Time) bool {
	c := t.ClosesAt()
	return c != nil && now.Before(*c)
}

// ForTicket reads a ticket's conversation in one query. pgx.ErrNoRows means the ticket has
// none (it was not opened by a WhatsApp message).
func ForTicket(ctx context.Context, q db.Querier, wid, ticketID uuid.UUID) (Thread, error) {
	var t Thread
	err := q.QueryRow(ctx, `SELECT wt.phone_number_id, wt.wa_id, c.id, wc.last_inbound_at
		FROM whatsapp_tickets wt
		LEFT JOIN whatsapp_connections c ON c.workspace_id = wt.workspace_id AND c.phone_number_id = wt.phone_number_id
		LEFT JOIN whatsapp_contacts wc ON wc.workspace_id = wt.workspace_id AND wc.phone_number_id = wt.phone_number_id
			AND wc.wa_id = wt.wa_id
		WHERE wt.workspace_id = $1 AND wt.ticket_id = $2`, wid, ticketID).
		Scan(&t.PhoneNumberID, &t.WaID, &t.ConnectionID, &t.LastInbound)
	return t, err
}

// Link records the conversation a ticket the WhatsApp engine opened carries.
func Link(ctx context.Context, q db.Querier, wid, ticketID uuid.UUID, phoneNumberID, waID string) error {
	_, err := q.Exec(ctx, `INSERT INTO whatsapp_tickets (ticket_id, workspace_id, phone_number_id, wa_id)
		VALUES ($1,$2,$3,$4) ON CONFLICT (ticket_id) DO NOTHING`, ticketID, wid, phoneNumberID, waID)
	return err
}

// OpenTicket returns the open, pending or on-hold ticket of this conversation, most recent
// first, else pgx.ErrNoRows.
func OpenTicket(ctx context.Context, q db.Querier, wid uuid.UUID, phoneNumberID, waID string) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT t.id FROM whatsapp_tickets wt
		JOIN tickets t ON t.workspace_id = wt.workspace_id AND t.id = wt.ticket_id
		WHERE wt.workspace_id = $1 AND wt.phone_number_id = $2 AND wt.wa_id = $3
			AND t.deleted_at IS NULL AND t.status IN ('open', 'pending', 'on_hold')
		ORDER BY t.last_message_at DESC, t.id DESC LIMIT 1`, wid, phoneNumberID, waID).Scan(&id)
	return id, err
}

// Touch links a wa_id to the contact it writes as and advances the window to at. Every
// inbound message advances it, duplicates included (Meta's window counts them), and an
// older message never moves it back.
func Touch(ctx context.Context, q db.Querier, wid uuid.UUID, phoneNumberID, waID string, contactID uuid.UUID, name string, at time.Time) error {
	_, err := q.Exec(ctx, `INSERT INTO whatsapp_contacts (workspace_id, phone_number_id, wa_id, contact_id, profile_name, last_inbound_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (workspace_id, phone_number_id, wa_id) DO UPDATE SET contact_id = EXCLUDED.contact_id,
			profile_name = CASE WHEN EXCLUDED.profile_name <> '' THEN EXCLUDED.profile_name ELSE whatsapp_contacts.profile_name END,
			last_inbound_at = GREATEST(whatsapp_contacts.last_inbound_at, EXCLUDED.last_inbound_at),
			updated_at = now()`, wid, phoneNumberID, waID, contactID, name, at)
	return err
}
