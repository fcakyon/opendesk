package contacts_test

import (
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

type merged struct {
	withEmails
	Phone string `json:"phone"`
	Notes string `json:"notes"`
	Tags  []struct {
		Name string `json:"name"`
	} `json:"tags"`
	TicketCount int `json:"ticket_count"`
}

func TestMergeContacts(t *testing.T) {
	e := hdtest.New(t, contacts.Register, tickets.Register)
	ws := e.NewWorkspace()
	a, admin := ws.Agent.As(ws), ws.Admin.As(ws)

	var keep, gone merged
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "ann@work.example", "name": "Ann", "notes": "Keeps notes", "tags": []string{"vip"},
		"custom": map[string]any{"plan": "team", "seats": 3}}).Want(t, 201).JSON(t, &keep)
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "ann@home.example", "name": "A. Smith", "phone": "+1 555", "notes": "From the other",
		"tags": []string{"vip", "beta"}, "custom": map[string]any{"plan": "free", "source": "form"}}).Want(t, 201).JSON(t, &gone)
	e.Do("POST", "/v1/contacts/"+gone.ID+"/emails", a, map[string]any{"email": "ann@old.example"}).Want(t, 201)
	for _, c := range []merged{keep, gone, gone} {
		e.Do("POST", "/v1/tickets", a, map[string]any{"subject": "T " + uuid.NewString()[:4], "contact_id": c.ID, "body_html": "<p>x</p>"}).Want(t, 201)
	}
	// Uploads of the contact that goes follow to the one that stays; its widget sessions end.
	e.Exec(`INSERT INTO widget_sessions (id, workspace_id, contact_id, token_hash) VALUES ($1, $2, $3, uuid_send($1))`, uuid.New(), ws.ID, uuid.MustParse(gone.ID))
	e.Exec(`INSERT INTO attachments (id, workspace_id, filename, size_bytes, storage_key, uploaded_by_contact_id) VALUES ($1, $2, 'a.txt', 1, 'k', $3)`,
		uuid.New(), ws.ID, uuid.MustParse(gone.ID))
	_, seq := e.Events(ws.ID, 0)

	// Only admins merge.
	e.Do("POST", "/v1/contacts/"+gone.ID+"/merge", a, map[string]any{"into": keep.ID}).Want(t, 403)

	var got merged
	e.Do("POST", "/v1/contacts/"+gone.ID+"/merge", admin, map[string]any{"into": keep.ID}).Want(t, 200).JSON(t, &got)
	if got.ID != keep.ID || *got.Email != "ann@work.example" || got.Name != "Ann" || got.Phone != "+1 555" {
		t.Fatalf("merged contact: %+v", got)
	}
	slices.Sort(got.Emails)
	if !slices.Equal(got.Emails, []string{"ann@home.example", "ann@old.example"}) {
		t.Fatalf("addresses after merge: %v", got.Emails)
	}
	if got.Notes != "Keeps notes\n\nFrom the other" || got.Custom["plan"] != "team" || got.Custom["source"] != "form" || got.TicketCount != 3 || len(got.Tags) != 2 {
		t.Fatalf("details after merge: %+v", got)
	}
	e.Do("GET", "/v1/contacts/"+gone.ID, a, nil).Want(t, 404)
	if n := countRows(t, e, `SELECT count(*) FROM attachments WHERE uploaded_by_contact_id = $1`, uuid.MustParse(keep.ID)); n != 1 {
		t.Fatalf("uploads on the kept contact: %d", n)
	}
	if n := countRows(t, e, `SELECT count(*) FROM widget_sessions WHERE workspace_id = $1`, ws.ID); n != 0 {
		t.Fatalf("widget sessions after merge: %d", n)
	}
	if n := countRows(t, e, `SELECT count(*) FROM tickets WHERE contact_id = $1`, uuid.MustParse(keep.ID)); n != 3 {
		t.Fatalf("tickets on the kept contact: %d", n)
	}
	// Mail from any of the removed contact's addresses now reaches the kept one.
	for _, addr := range []string{"ann@home.example", "ann@old.example"} {
		var id uuid.UUID
		err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
			var err error
			id, _, err = domain.UpsertContactByEmail(e.Ctx, tx, ws.ID, addr, "")
			return err
		})
		if err != nil || id.String() != keep.ID {
			t.Fatalf("%s reaches %v (%v)", addr, id, err)
		}
	}
	types, _ := e.Events(ws.ID, seq)
	for _, want := range []string{"contact.deleted", "contact.updated", "ticket.updated"} {
		if !slices.Contains(types, want) {
			t.Errorf("missing event %s in %v", want, types)
		}
	}
	if n := countRows(t, e, `SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'contact.merged'`, ws.ID); n != 1 {
		t.Fatalf("audit entries: %d", n)
	}
}

func TestMergeContactsRefusals(t *testing.T) {
	e := hdtest.New(t, contacts.Register, tickets.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)
	mk := func(body map[string]any) merged {
		var c merged
		e.Do("POST", "/v1/contacts", admin, body).Want(t, 201).JSON(t, &c)
		return c
	}
	one := mk(map[string]any{"email": "one@example.com", "name": "One", "external_id": "u-1"})
	two := mk(map[string]any{"email": "two@example.com", "name": "Two", "external_id": "u-2"})
	same := mk(map[string]any{"email": "same@example.com", "name": "Same", "external_id": "u-1x"})
	blocked := mk(map[string]any{"email": "blocked@example.com", "name": "Blocked", "blocked": true})
	merge := func(from, into string) *hdtest.Resp {
		return e.Do("POST", "/v1/contacts/"+from+"/merge", admin, map[string]any{"into": into})
	}

	merge(one.ID, one.ID).Want(t, 422)
	merge(one.ID, uuid.NewString()).Want(t, 404)
	merge(uuid.NewString(), one.ID).Want(t, 404)
	merge(one.ID, "nope").Want(t, 404)
	merge(one.ID, two.ID).Want(t, 409)     // two different identities
	merge(blocked.ID, two.ID).Want(t, 422) // blocked with not blocked
	merge(two.ID, blocked.ID).Want(t, 422)
	e.Do("GET", "/v1/contacts/"+one.ID, admin, nil).Want(t, 200)

	// A person without an external id merges into one with it, and gives theirs up when they have it alone.
	plain := mk(map[string]any{"email": "plain@example.com", "name": "Plain"})
	var got merged
	merge(same.ID, plain.ID).Want(t, 200).JSON(t, &got)
	var ext *string
	e.Scalar(`SELECT external_id FROM contacts WHERE id = $1`, &ext, uuid.MustParse(plain.ID))
	if ext == nil || *ext != "u-1x" {
		t.Fatalf("external id after merge: %v", ext)
	}

	// A contact without an address takes the other's primary as its own, and the rest as extras.
	nameOnly := mk(map[string]any{"name": "Name only"})
	withExtra := mk(map[string]any{"email": "first@example.com", "name": "With extra"})
	e.Do("POST", "/v1/contacts/"+withExtra.ID+"/emails", admin, map[string]any{"email": "second@example.com"}).Want(t, 201)
	merge(withExtra.ID, nameOnly.ID).Want(t, 200).JSON(t, &got)
	if got.Email == nil || *got.Email != "first@example.com" || !slices.Equal(got.Emails, []string{"second@example.com"}) {
		t.Fatalf("addresses after merging into a contact without one: %v %v", got.Email, got.Emails)
	}

	// Too many addresses for one contact.
	many := mk(map[string]any{"email": "many@example.com", "name": "Many"})
	full := mk(map[string]any{"email": "full@example.com", "name": "Full"})
	for i := 0; i < domain.MaxContactEmails; i++ {
		e.Do("POST", "/v1/contacts/"+full.ID+"/emails", admin, map[string]any{"email": hdtest.Fmt("f%d@example.com", i)}).Want(t, 201)
	}
	merge(many.ID, full.ID).Want(t, 422)

	// Another workspace's contacts are not found.
	foreign := e.NewWorkspace()
	e.Do("POST", "/v1/contacts/"+one.ID+"/merge", foreign.Admin.As(foreign), map[string]any{"into": two.ID}).Want(t, 404)
}

func countRows(t *testing.T, e *hdtest.Env, sql string, args ...any) int {
	t.Helper()
	var n int
	e.Scalar(sql, &n, args...)
	return n
}
