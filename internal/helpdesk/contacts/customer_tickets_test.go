package contacts_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

type customerTicketsPage struct {
	Data []struct {
		ID      string `json:"id"`
		Subject string `json:"subject"`
		Contact struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"contact"`
	} `json:"data"`
	Total int `json:"total"`
}

// A ticket's customer tickets come from every address the customer used: a second address that
// wrote in the ticket, the chat visitor who typed the address, the contact who has an address the
// visitor typed, and a ticket filed under another contact that the customer wrote in.
func TestCustomerTickets(t *testing.T) {
	e := hdtest.New(t, contacts.Register, tickets.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)

	newContact := func(body map[string]any) string {
		var c struct {
			ID string `json:"id"`
		}
		e.Do("POST", "/v1/contacts", a, body).Want(t, 201).JSON(t, &c)
		return c.ID
	}
	newTicket := func(contact, subject string) string {
		var tk struct {
			ID string `json:"id"`
		}
		e.Do("POST", "/v1/tickets", a, map[string]any{"subject": subject, "contact_id": contact, "body_html": "<p>x</p>"}).Want(t, 201).JSON(t, &tk)
		return tk.ID
	}
	inbound := func(ticket, contact, text string) {
		e.Exec(`INSERT INTO messages (workspace_id, ticket_id, kind, direction, author_type, author_contact_id, body_html, body_text)
			VALUES ($1, $2, 'reply', 'inbound', 'contact', $3, $4, $5)`,
			ws.ID, uuid.MustParse(ticket), uuid.MustParse(contact), "<p>"+text+"</p>", text)
	}
	list := func(ticket string) customerTicketsPage {
		var got customerTicketsPage
		e.Do("GET", "/v1/tickets/"+ticket+"/customer-tickets", a, nil).Want(t, 200).JSON(t, &got)
		return got
	}

	first := newContact(map[string]any{"email": "alex@example.test", "name": "Alex"})
	second := newContact(map[string]any{"email": "alex.work@example.test", "name": "Alex at work"})
	visitor := newContact(map[string]any{"name": "Chat visitor", "custom": map[string]any{"widget_email": " Alex.Work@Example.test "}})
	stranger := newContact(map[string]any{"email": "someone@example.test", "name": "Someone"})
	extra := newContact(map[string]any{"email": "home@example.test", "name": "Home"})
	e.Do("POST", "/v1/contacts/"+extra+"/emails", a, map[string]any{"email": "alex.old@example.test"}).Want(t, 201)
	typedOld := newContact(map[string]any{"name": "Old visitor", "custom": map[string]any{"widget_email": "alex.old@example.test"}})

	current := newTicket(first, "Order question")
	own := newTicket(first, "Earlier, same address")
	fromSecond := newTicket(second, "Earlier, from work")
	fromChat := newTicket(visitor, "Chat about the order")
	newTicket(stranger, "Not the customer")
	newTicket(extra, "Not linked either")
	newTicket(typedOld, "Typed another address")
	merged := newTicket(second, "Merged away")
	e.Exec(`UPDATE tickets SET merged_into_id = $1 WHERE id = $2`, uuid.MustParse(fromSecond), uuid.MustParse(merged))

	if got := list(current); got.Total != 1 || len(got.Data) != 1 || got.Data[0].ID != own {
		t.Fatalf("before the second address wrote: %+v", got)
	}

	// The customer writes into the ticket from the second address: its tickets come in, and the
	// chat visitor's who typed that address.
	inbound(current, second, "The order number")
	got := list(current)
	ids := map[string]string{}
	for _, x := range got.Data {
		ids[x.ID] = x.Contact.Email
	}
	if got.Total != 3 || len(ids) != 3 || ids[own] != "alex@example.test" || ids[fromSecond] != "alex.work@example.test" ||
		ids[fromChat] != " Alex.Work@Example.test " {
		t.Fatalf("with the second address: %+v", got)
	}

	// From the chat visitor's side: the address it typed brings the contact who has it, and the
	// ticket that contact wrote in, filed under the first address.
	got = list(fromChat)
	chatSide := map[string]bool{}
	for _, x := range got.Data {
		chatSide[x.ID] = true
	}
	if got.Total != 2 || !chatSide[fromSecond] || !chatSide[current] {
		t.Fatalf("from the chat: %+v", got)
	}

	// A typed address matches an extra address too, and the extra address's contact sees the visitor.
	extraTicket := newTicket(extra, "From home")
	if got := list(extraTicket); got.Total != 2 {
		t.Fatalf("from the extra address: %+v", got)
	}

	// A ticket filed under another contact (a contact form's misspelt address) that the customer wrote in.
	typo := newContact(map[string]any{"email": "alx@example.test", "name": "Alex (form)"})
	filed := newTicket(typo, "Form with a misspelt address")
	inbound(filed, first, "It is me")
	got = list(current)
	found := false
	for _, x := range got.Data {
		found = found || (x.ID == filed && x.Contact.Email == "alx@example.test")
	}
	if got.Total != 4 || !found {
		t.Fatalf("with the misspelt form ticket: %+v", got)
	}

	// A ticket of a private team the caller is not on stays out, and is not found itself.
	team := uuid.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Private', true)`, team, ws.ID)
	e.Exec(`UPDATE tickets SET team_id = $1, assignee_id = NULL WHERE id = $2`, team, uuid.MustParse(own))
	if got := list(current); got.Total != 3 {
		t.Fatalf("with a private team's ticket: %+v", got)
	}
	e.Do("GET", "/v1/tickets/"+own+"/customer-tickets", a, nil).Want(t, 404)

	e.Do("GET", "/v1/tickets/"+uuid.NewString()+"/customer-tickets", a, nil).Want(t, 404)
	e.Do("GET", "/v1/tickets/not-an-id/customer-tickets", a, nil).Want(t, 404)
	other := e.NewWorkspace()
	e.Do("GET", "/v1/tickets/"+current+"/customer-tickets", other.Agent.As(other), nil).Want(t, 404)
}
