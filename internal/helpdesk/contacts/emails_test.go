package contacts_test

import (
	"context"
	"net/url"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
)

type withEmails struct {
	contact
	Emails []string `json:"emails"`
}

func TestContactEmails(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)

	var jane, other withEmails
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "jane@work.example", "name": "Jane"}).Want(t, 201).JSON(t, &jane)
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "bob@work.example", "name": "Bob"}).Want(t, 201).JSON(t, &other)
	if jane.Emails == nil || len(jane.Emails) != 0 {
		t.Fatalf("a new contact has extras: %v", jane.Emails)
	}
	base := "/v1/contacts/" + jane.ID + "/emails"

	// An extra address, lowercased.
	e.Do("POST", base, a, map[string]any{"email": " Jane@Home.Example "}).Want(t, 201).JSON(t, &jane)
	if !slices.Equal(jane.Emails, []string{"jane@home.example"}) || *jane.Email != "jane@work.example" {
		t.Fatalf("after add: %+v", jane)
	}

	// An address belongs to one contact: not the same one again, not her primary, not anyone's primary or extra.
	e.Do("POST", base, a, map[string]any{"email": "jane@home.example"}).Want(t, 409)
	e.Do("POST", base, a, map[string]any{"email": "jane@work.example"}).Want(t, 409)
	e.Do("POST", base, a, map[string]any{"email": "bob@work.example"}).Want(t, 409)
	e.Do("POST", "/v1/contacts/"+other.ID+"/emails", a, map[string]any{"email": "jane@home.example"}).Want(t, 409)
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "jane@home.example", "name": "Imposter"}).Want(t, 409)
	e.Do("PATCH", "/v1/contacts/"+other.ID, a, map[string]any{"email": "jane@home.example"}).Want(t, 409)
	e.Do("POST", base, a, map[string]any{"email": "not-an-address"}).Want(t, 422)

	// Search finds her by the extra address.
	var found page[withEmails]
	e.Do("GET", "/v1/contacts?q=jane@home", a, nil).Want(t, 200).JSON(t, &found)
	if len(found.Data) != 1 || found.Data[0].ID != jane.ID {
		t.Fatalf("search by extra: %+v", found.Data)
	}

	// Make the extra the primary: the old primary becomes an extra.
	e.Do("POST", base+"/"+url.PathEscape("jane@home.example")+"/make-primary", a, nil).Want(t, 200).JSON(t, &jane)
	if *jane.Email != "jane@home.example" || !slices.Equal(jane.Emails, []string{"jane@work.example"}) {
		t.Fatalf("after make-primary: %+v", jane)
	}
	e.Do("POST", base+"/"+url.PathEscape("nobody@home.example")+"/make-primary", a, nil).Want(t, 404)

	// Remove an extra; the primary is not removed here.
	e.Do("DELETE", base+"/"+url.PathEscape("jane@home.example"), a, nil).Want(t, 404)
	e.Do("DELETE", base+"/"+url.PathEscape("jane@work.example"), a, nil).Want(t, 200).JSON(t, &jane)
	if len(jane.Emails) != 0 || *jane.Email != "jane@home.example" {
		t.Fatalf("after remove: %+v", jane)
	}
	// Freed, the address can belong to someone else.
	e.Do("POST", "/v1/contacts/"+other.ID+"/emails", a, map[string]any{"email": "jane@work.example"}).Want(t, 201)

	// At most 20 extras.
	for i := 0; i < domain.MaxContactEmails; i++ {
		e.Do("POST", base, a, map[string]any{"email": hdtest.Fmt("extra%d@home.example", i)}).Want(t, 201)
	}
	e.Do("POST", base, a, map[string]any{"email": "one-more@home.example"}).Want(t, 422)

	// Extras sit beside a primary: the primary can't be cleared while there are extras, and a
	// contact without one gets no extras.
	e.Do("PATCH", "/v1/contacts/"+jane.ID, a, map[string]any{"email": nil}).Want(t, 422)
	var nameOnly withEmails
	e.Do("POST", "/v1/contacts", a, map[string]any{"name": "No address"}).Want(t, 201).JSON(t, &nameOnly)
	e.Do("POST", "/v1/contacts/"+nameOnly.ID+"/emails", a, map[string]any{"email": "noaddr@home.example"}).Want(t, 422)

	// Viewers read only; another workspace's contact is not found.
	e.Do("POST", base, ws.Viewer.As(ws), map[string]any{"email": "v@home.example"}).Want(t, 403)
	foreign := e.NewWorkspace()
	e.Do("POST", base, foreign.Agent.As(foreign), map[string]any{"email": "f@home.example"}).Want(t, 404)
}

// Mail, tickets and imports reach a contact by any of its addresses.
func TestContactByExtraAddress(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var c withEmails
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "ann@work.example", "name": "Ann"}).Want(t, 201).JSON(t, &c)
	e.Do("POST", "/v1/contacts/"+c.ID+"/emails", a, map[string]any{"email": "ann@home.example"}).Want(t, 201)
	id := uuid.MustParse(c.ID)

	var got uuid.UUID
	var created bool
	err := e.D.DB.Tx(context.Background(), func(tx pgx.Tx) error {
		var err error
		got, created, err = domain.UpsertContactByEmail(context.Background(), tx, ws.ID, "Ann@Home.Example", "Ann at home")
		return err
	})
	if err != nil || got != id || created {
		t.Fatalf("upsert by extra: %v %v %v", got, created, err)
	}
	if n := countContacts(t, e, ws.ID); n != 1 {
		t.Fatalf("contacts after upsert: %d", n)
	}
	// A new address is still a new contact.
	err = e.D.DB.Tx(context.Background(), func(tx pgx.Tx) error {
		var err error
		got, created, err = domain.UpsertContactByEmail(context.Background(), tx, ws.ID, "new@home.example", "")
		return err
	})
	if err != nil || got == id || !created {
		t.Fatalf("upsert of a new address: %v %v %v", got, created, err)
	}
}

func countContacts(t *testing.T, e *hdtest.Env, wid uuid.UUID) int {
	t.Helper()
	var n int
	e.Scalar(`SELECT count(*) FROM contacts WHERE workspace_id = $1`, &n, wid)
	return n
}
