package email

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/crypto"
)

// Mail from an extra address of a contact lands on that contact, and a blocked contact is
// blocked at every address.
func TestInboundFromExtraAddress(t *testing.T) {
	w := newWorld(t)
	m := w.mailbox(InboundForwarding, OutboundSystem, nil)
	primary, extra := customer(), customer()
	mustExec(t, w.d, `WITH c AS (INSERT INTO contacts (workspace_id, email, name) VALUES ($1, $2, 'Carla') RETURNING id)
		INSERT INTO contact_emails (workspace_id, contact_id, email) SELECT $1, id, $3 FROM c`, w.wid, primary, extra)

	id := w.receive(m, fixture(t, "new_plain.eml", "{{FROM}}", extra, "{{TO}}", w.forwardAddr(m, ""), "{{ID}}", crypto.RandomString(8)))
	tk := w.ticket(w.messageFor(id).TicketID)
	var email string
	var contacts int
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT c.email FROM tickets t JOIN contacts c ON c.id = t.contact_id WHERE t.id = $1`, tk.ID).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, w.wid).Scan(&contacts); err != nil {
		t.Fatal(err)
	}
	if email != primary || contacts != 1 {
		t.Fatalf("mail from the extra address made contact %q, %d contacts", email, contacts)
	}

	mustExec(t, w.d, `UPDATE contacts SET blocked = true WHERE workspace_id = $1 AND email = $2`, w.wid, primary)
	raw := "From: " + extra + "\r\nTo: x@y.test\r\nSubject: hi\r\nMessage-ID: <bx" + crypto.RandomString(5) + "@a.test>\r\n\r\nbody\r\n"
	if st, reason := w.inbound(w.receive(m, raw)); st != "ignored" || reason != "blocked_contact" {
		t.Fatalf("blocked at the extra address: %s %s", st, reason)
	}
}
