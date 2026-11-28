package tickets_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

func addContact(e *hdtest.Env, ws hdtest.WS, name, email string, blocked bool) uuid.UUID {
	id := ids.New()
	var em any
	if email != "" {
		em = email
	}
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, blocked) VALUES ($1, $2, $3, $4, $5)`, id, ws.ID, name, em, blocked)
	return id
}

// runNotice runs the message's job until it queues no more, as the worker does.
func runNotice(t *testing.T, e *hdtest.Env, ws hdtest.WS, id uuid.UUID) int {
	t.Helper()
	runs := 0
	for ; runs < 100; runs++ {
		var state string
		e.Scalar(`SELECT state FROM contact_messages WHERE id = $1`, &state, id)
		if state != "sending" {
			return runs
		}
		var next int
		e.Scalar(`SELECT next_index FROM contact_messages WHERE id = $1`, &next, id)
		if err := tickets.ContinueContactMessage(e.Ctx, e.D, jobs.ContactMessageArgs{WorkspaceID: ws.ID, MessageID: id, NextIndex: next}); err != nil {
			t.Fatal(err)
		}
	}
	t.Fatal("never finished")
	return runs
}

// TestContactMessage: one message to a selection makes a ticket for each customer it can reach,
// each with the shared label, filled for that customer and sent to them alone (contracts/api.md
// "Messages to many customers").
func TestContactMessage(t *testing.T) {
	e, ws := newEnv(t)
	mailbox := addMailbox(t, e, ws)
	e.SetSettings(ws, map[string]any{"csat_enabled": true})
	ana := addContact(e, ws, "Ana Silva", "ana-"+ids.New().String()[24:]+"@example.com", false)
	ben := addContact(e, ws, "Ben Okafor", "ben-"+ids.New().String()[24:]+"@example.com", false)
	noEmail := addContact(e, ws, "Phone Only", "", false)
	blocked := addContact(e, ws, "Blocked", "blocked-"+ids.New().String()[24:]+"@example.com", true)
	as := ws.Agent.As(ws)
	target := map[string]any{"ids": []uuid.UUID{ana, ben, noEmail, blocked, ana}}

	var preview tickets.NoticePreview
	e.Do("POST", "/v1/contacts/message/preview", as, target).Want(t, 200).JSON(t, &preview)
	if preview.Reaches != 2 || preview.Skipped["no_email"] != 1 || preview.Skipped["blocked"] != 1 {
		t.Fatalf("preview: %+v", preview)
	}
	e.Do("POST", "/v1/contacts/message/preview", ws.Viewer.As(ws), target).Want(t, 403)
	e.Do("POST", "/v1/contacts/message/preview", as, map[string]any{"ids": []uuid.UUID{ids.New()}}).Want(t, 404)
	e.Do("POST", "/v1/contacts/message/preview", as, map[string]any{}).Want(t, 422)

	body := map[string]any{"ids": target["ids"], "mailbox_id": mailbox, "subject": "Planned maintenance on Friday",
		"body_html": "<p>Hi {{ contact.first_name }}, we will be offline from 22:00.</p>", "label": "Maintenance Nov"}
	e.Do("POST", "/v1/contacts/message", ws.Viewer.As(ws), body).Want(t, 403)
	var m tickets.ContactMessage
	e.Do("POST", "/v1/contacts/message", as, body).Want(t, 202).JSON(t, &m)
	if m.State != "sending" || m.Total != 2 || m.Sent != 0 || m.Status != "solved" || m.Skipped["no_email"] != 1 || m.Skipped["blocked"] != 1 {
		t.Fatalf("created: %+v", m)
	}
	// One at a time.
	e.Do("POST", "/v1/contacts/message", as, body).Want(t, 409)
	if countRows(t, e, `SELECT count(*) FROM tickets WHERE workspace_id = $1`, ws.ID) != 0 {
		t.Fatal("tickets before the job ran")
	}

	// A field an agent must fill before solving a ticket does not stop a solved notice.
	e.Exec(`INSERT INTO custom_fields (workspace_id, entity, key, name, type, options, required_on_solve) VALUES ($1, 'ticket', 'resolution', 'Resolution', 'text', '[]', true)`, ws.ID)
	runNotice(t, e, ws, m.ID)
	e.Do("GET", "/v1/contact-messages/"+m.ID.String(), as, nil).Want(t, 200).JSON(t, &m)
	if m.State != "done" || m.Sent != 2 || m.Failed != 0 || m.FinishedAt == nil {
		t.Fatalf("done: %+v", m)
	}
	for name, id := range map[string]uuid.UUID{"Ana": ana, "Ben": ben} {
		if countRows(t, e, `SELECT count(*) FROM tickets t WHERE t.workspace_id = $1 AND t.contact_id = $2 AND t.subject = 'Planned maintenance on Friday'
			AND t.status = 'solved' AND t.channel = 'email' AND t.csat_requested_at IS NULL`, ws.ID, id) != 1 {
			t.Fatalf("%s: ticket missing, not solved, or asked for a rating", name)
		}
		if countRows(t, e, `SELECT count(*) FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id JOIN tickets t ON t.id = tt.ticket_id
			WHERE t.contact_id = $1 AND g.name = 'Maintenance Nov'`, id) != 1 {
			t.Fatalf("%s: label missing", name)
		}
		// Filled for them, and addressed to them alone.
		first := strings.Fields(name)[0]
		if countRows(t, e, `SELECT count(*) FROM messages m JOIN tickets t ON t.id = m.ticket_id JOIN contacts c ON c.id = t.contact_id
			WHERE t.contact_id = $1 AND m.direction = 'outbound' AND m.body_text LIKE $2 AND m.to_emails = ARRAY[c.email::text] AND cardinality(m.cc_emails) = 0
			AND m.delivery_status = 'pending'`, id, "Hi "+first+",%") != 1 {
			t.Fatalf("%s: message not filled for them or not addressed to them alone", name)
		}
	}
	if countRows(t, e, `SELECT count(*) FROM tickets WHERE workspace_id = $1 AND contact_id IN ($2, $3)`, ws.ID, noEmail, blocked) != 0 {
		t.Fatal("a skipped customer got a ticket")
	}
	if countRows(t, e, `SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'contact_message.sent' AND data->>'total' = '2'
		AND data::text NOT LIKE '%offline%'`, ws.ID) != 1 {
		t.Fatal("the send is not audited, or the audit holds its text")
	}
	// The label exists once, as a label of tickets.
	if countRows(t, e, `SELECT count(*) FROM tags WHERE workspace_id = $1 AND name = 'Maintenance Nov'`, ws.ID) != 1 {
		t.Fatal("label not created once")
	}
	var list struct{ Data []tickets.ContactMessage }
	e.Do("GET", "/v1/contact-messages", as, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != m.ID {
		t.Fatalf("list: %+v", list.Data)
	}
}

// TestContactMessageRefusals: what a send needs, and the limits it keeps.
func TestContactMessageRefusals(t *testing.T) {
	e, ws := newEnv(t)
	mailbox := addMailbox(t, e, ws)
	as := ws.Agent.As(ws)
	reach := addContact(e, ws, "Reach Me", "reach-"+ids.New().String()[24:]+"@example.com", false)
	nobody := addContact(e, ws, "Phone Only", "", false)
	good := map[string]any{"ids": []uuid.UUID{reach}, "mailbox_id": mailbox, "subject": "Hello", "body_html": "<p>Hi</p>", "label": "Notice"}
	with := func(k string, v any) map[string]any {
		b := map[string]any{}
		for key, val := range good {
			b[key] = val
		}
		b[k] = v
		return b
	}
	for name, b := range map[string]map[string]any{
		"no recipients": with("ids", []uuid.UUID{nobody}),
		"no body":       with("body_html", "<p></p>"),
		"no label":      with("label", ""),
		"bad label":     with("label", "<b>x</b>"),
		"bad mailbox":   with("mailbox_id", "nope"),
		"other mailbox": with("mailbox_id", ids.New()),
		"bad status":    with("status", "closed"),
	} {
		if r := e.Do("POST", "/v1/contacts/message", as, b); r.Status < 400 || r.Status == 500 {
			t.Fatalf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if countRows(t, e, `SELECT count(*) FROM contact_messages WHERE workspace_id = $1`, ws.ID) != 0 {
		t.Fatal("a refused send was recorded")
	}

	// Cancelled before the job ran: nothing is made, and another can start.
	var m tickets.ContactMessage
	e.Do("POST", "/v1/contacts/message", as, good).Want(t, 202).JSON(t, &m)
	e.Do("POST", "/v1/contact-messages/"+m.ID.String()+"/cancel", ws.Viewer.As(ws), nil).Want(t, 403)
	e.Do("POST", "/v1/contact-messages/"+m.ID.String()+"/cancel", as, nil).Want(t, 200).JSON(t, &m)
	if m.State != "cancelled" {
		t.Fatalf("cancel: %+v", m)
	}
	runNotice(t, e, ws, m.ID)
	if countRows(t, e, `SELECT count(*) FROM tickets WHERE workspace_id = $1`, ws.ID) != 0 {
		t.Fatal("a cancelled message made tickets")
	}

	// Ten a day.
	for i := 0; i < 9; i++ {
		e.Exec(`INSERT INTO contact_messages (id, workspace_id, subject, body_html, label, status, state, contact_ids, total) VALUES ($1, $2, 's', 'b', 'l', 'solved', 'done', '{}', 0)`,
			ids.New(), ws.ID)
	}
	e.Do("POST", "/v1/contacts/message", as, good).Want(t, 429)
	e.Exec(`UPDATE contact_messages SET created_at = now() - interval '2 days' WHERE workspace_id = $1 AND subject = 's'`, ws.ID)
	e.Do("POST", "/v1/contacts/message", as, good).Want(t, 202)
}

// TestContactMessageChunks: a long list goes a few at a time, a failure leaves the rest, and a
// message whose address is gone stops.
func TestContactMessageChunks(t *testing.T) {
	e, ws := newEnv(t)
	mailbox := addMailbox(t, e, ws)
	as := ws.Agent.As(ws)
	for i := 0; i < 45; i++ {
		addContact(e, ws, "Customer", "c"+strings.Repeat("x", i%3)+ids.New().String()[20:]+"@example.com", false)
	}
	var m tickets.ContactMessage
	// By the People list's filter, the way a "select everyone who matches" does.
	e.Do("POST", "/v1/contacts/message", as, map[string]any{"query": map[string]any{"q": "Customer"}, "mailbox_id": mailbox, "subject": "Notice",
		"body_html": "<p>Hello</p>", "label": "Notice", "status": "pending"}).Want(t, 202).JSON(t, &m)
	if m.Total != 45 || m.Status != "pending" {
		t.Fatalf("created: %+v", m)
	}
	args := jobs.ContactMessageArgs{WorkspaceID: ws.ID, MessageID: m.ID}
	if err := tickets.ContinueContactMessage(e.Ctx, e.D, args); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", "/v1/contact-messages/"+m.ID.String(), as, nil).Want(t, 200).JSON(t, &m)
	if m.Sent != 20 || m.State != "sending" || countRows(t, e, `SELECT count(*) FROM river_job WHERE kind = 'helpdesk.contact_message' AND scheduled_at > now()
		AND (args->>'next_index')::int = 20`) != 1 {
		t.Fatalf("after one run: %+v, next job queued: %d", m, countRows(t, e, `SELECT count(*) FROM river_job WHERE kind = 'helpdesk.contact_message'`))
	}
	// The same run again, as a retry would: it finds the message moved on and does nothing.
	if err := tickets.ContinueContactMessage(e.Ctx, e.D, args); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", "/v1/contact-messages/"+m.ID.String(), as, nil).Want(t, 200).JSON(t, &m)
	if m.Sent != 20 || countRows(t, e, `SELECT count(*) FROM tickets WHERE workspace_id = $1`, ws.ID) != 20 ||
		countRows(t, e, `SELECT count(*) FROM river_job WHERE kind = 'helpdesk.contact_message' AND scheduled_at > now()`) != 1 {
		t.Fatalf("a repeated run sent again or queued a second job: %+v", m)
	}
	// The address is removed part way: the rest is not sent, and the message says why.
	e.Exec(`DELETE FROM mailboxes WHERE id = $1`, mailbox)
	runNotice(t, e, ws, m.ID)
	e.Do("GET", "/v1/contact-messages/"+m.ID.String(), as, nil).Want(t, 200).JSON(t, &m)
	if m.State != "cancelled" || m.Sent != 20 || m.LastError == "" || countRows(t, e, `SELECT count(*) FROM tickets WHERE workspace_id = $1`, ws.ID) != 20 {
		t.Fatalf("after the address went: %+v", m)
	}
}

// TestContactMessageLinks: a link made of template tags reaches each customer filled for them,
// and a filled link is cleaned like any other.
func TestContactMessageLinks(t *testing.T) {
	e, ws := newEnv(t)
	mailbox := addMailbox(t, e, ws)
	as := ws.Agent.As(ws)
	ana := addContact(e, ws, "Ana Silva", "ana-"+ids.New().String()[24:]+"@example.com", false)
	odd := addContact(e, ws, "javascript:alert(1) Odd", "odd-"+ids.New().String()[24:]+"@example.com", false)
	html := `<p>Hi, <a href="https://status.example.com/?for={{ contact.first_name | url_encode }}">see your status</a> or <a href="{{ contact.first_name }}">here</a>.</p>`
	var m tickets.ContactMessage
	e.Do("POST", "/v1/contacts/message", as, map[string]any{"ids": []uuid.UUID{ana, odd}, "mailbox_id": mailbox, "subject": "Your status page",
		"body_html": html, "label": "Status"}).Want(t, 202).JSON(t, &m)
	runNotice(t, e, ws, m.ID)
	body := func(contact uuid.UUID) string {
		var html string
		e.Scalar(`SELECT m.body_html FROM messages m JOIN tickets t ON t.id = m.ticket_id WHERE t.workspace_id = $1 AND t.contact_id = $2 AND m.direction = 'outbound'`,
			&html, ws.ID, contact)
		return html
	}
	if got := body(ana); !strings.Contains(got, `href="https://status.example.com/?for=Ana"`) || !strings.Contains(got, `href="Ana"`) {
		t.Fatalf("Ana's links not filled: %s", got)
	}
	if got := body(odd); strings.Contains(got, `href="javascript`) {
		t.Fatalf("a filled link was not cleaned: %s", got)
	}
}
