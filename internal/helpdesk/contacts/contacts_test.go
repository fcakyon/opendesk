package contacts_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type contact struct {
	ID          string         `json:"id"`
	Email       *string        `json:"email"`
	Name        string         `json:"name"`
	Phone       string         `json:"phone"`
	ExternalID  *string        `json:"external_id"`
	Blocked     bool           `json:"blocked"`
	Custom      map[string]any `json:"custom"`
	TicketCount int            `json:"ticket_count"`
	Company     *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"company"`
}

type page[T any] struct {
	Data       []T     `json:"data"`
	NextCursor *string `json:"next_cursor"`
}

type company struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Domain       string  `json:"domain"`
	ExternalID   *string `json:"external_id"`
	ContactCount int     `json:"contact_count"`
}

func TestContactCRUD(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)

	var c contact
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "  Jane.Doe@Example.com ", "phone": "+1 555"}).Want(t, 201).JSON(t, &c)
	if c.Email == nil || *c.Email != "jane.doe@example.com" || c.Name != "jane doe" || c.Custom == nil {
		t.Fatalf("created %+v", c)
	}
	// Duplicate email and bad input.
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "jane.doe@example.com"}).Want(t, 409)
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "not-an-email"}).Want(t, 422)
	r := e.Do("POST", "/v1/contacts", a, map[string]any{"name": "visit https://evil.example"}).Want(t, 422)
	if r.Map(t)["code"] != "invalid_name" {
		t.Fatalf("code %s", r.Body)
	}
	e.Do("POST", "/v1/contacts", a, map[string]any{"phone": "1"}).Want(t, 422)
	e.Do("POST", "/v1/contacts", a, map[string]any{"name": "Bob", "avatar_url": "http://x.example/a.png"}).Want(t, 422)

	// External id uniqueness.
	e.Do("POST", "/v1/contacts", a, map[string]any{"name": "Bob", "external_id": "u-1"}).Want(t, 201)
	e.Do("POST", "/v1/contacts", a, map[string]any{"name": "Rob", "external_id": "u-1"}).Want(t, 409)

	// Company link, patch, clear.
	var co company
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Acme Inc", "domain": "https://www.Acme.com/"}).Want(t, 201).JSON(t, &co)
	if co.Domain != "acme.com" {
		t.Fatalf("domain %q", co.Domain)
	}
	e.Do("PATCH", "/v1/contacts/"+c.ID, a, map[string]any{"company_id": co.ID, "name": "Jane Doe", "custom": map[string]any{"plan": "pro"}, "blocked": true}).Want(t, 200).JSON(t, &c)
	if c.Company == nil || c.Company.ID != co.ID || c.Name != "Jane Doe" || c.Custom["plan"] != "pro" || !c.Blocked {
		t.Fatalf("patched %+v", c)
	}
	e.Do("GET", "/v1/companies/"+co.ID, a, nil).Want(t, 200).JSON(t, &co)
	if co.ContactCount != 1 {
		t.Fatalf("contact_count %d", co.ContactCount)
	}
	e.Do("PATCH", "/v1/contacts/"+c.ID, a, map[string]any{"company_id": nil, "external_id": "j-9"}).Want(t, 200).JSON(t, &c)
	if c.Company != nil || c.ExternalID == nil || *c.ExternalID != "j-9" || c.Name != "Jane Doe" {
		t.Fatalf("cleared %+v", c)
	}
	// Unknown company id.
	e.Do("PATCH", "/v1/contacts/"+c.ID, a, map[string]any{"company_id": ids.New().String()}).Want(t, 422)

	e.Do("GET", "/v1/contacts/"+c.ID, ws.Viewer.As(ws), nil).Want(t, 200)
	e.Do("DELETE", "/v1/contacts/"+c.ID, a, nil).Want(t, 204)
	e.Do("GET", "/v1/contacts/"+c.ID, a, nil).Want(t, 404)
	e.Do("DELETE", "/v1/contacts/"+c.ID, a, nil).Want(t, 404)

	types, _ := e.Events(ws.ID, 0)
	for _, want := range []string{"contact.created", "contact.updated", "contact.deleted", "company.created"} {
		if !slices.Contains(types, want) {
			t.Errorf("missing event %s in %v", want, types)
		}
	}
}

func TestContactAccess(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	other := e.NewWorkspace()
	var c contact
	e.Do("POST", "/v1/contacts", ws.Agent.As(ws), map[string]any{"email": "a@example.com"}).Want(t, 201).JSON(t, &c)

	e.Do("POST", "/v1/contacts", ws.Viewer.As(ws), map[string]any{"email": "v@example.com"}).Want(t, 403)
	e.Do("PATCH", "/v1/contacts/"+c.ID, ws.Viewer.As(ws), map[string]any{"name": "X"}).Want(t, 403)
	e.Do("GET", "/v1/contacts", hdtest.Auth{}, nil).Want(t, 401)

	// Workspace B cannot see or touch workspace A's contact, even with the same email.
	e.Do("GET", "/v1/contacts/"+c.ID, other.Owner.As(other), nil).Want(t, 404)
	e.Do("PATCH", "/v1/contacts/"+c.ID, other.Owner.As(other), map[string]any{"name": "X"}).Want(t, 404)
	e.Do("DELETE", "/v1/contacts/"+c.ID, other.Owner.As(other), nil).Want(t, 404)
	e.Do("GET", "/v1/contacts/"+c.ID+"/tickets", other.Owner.As(other), nil).Want(t, 404)
	e.Do("POST", "/v1/contacts", other.Agent.As(other), map[string]any{"email": "a@example.com"}).Want(t, 201)
	var co company
	e.Do("POST", "/v1/companies", other.Agent.As(other), map[string]any{"name": "Other"}).Want(t, 201).JSON(t, &co)
	e.Do("PATCH", "/v1/contacts/"+c.ID, ws.Agent.As(ws), map[string]any{"company_id": co.ID}).Want(t, 422)
	e.Do("GET", "/v1/companies/"+co.ID, ws.Agent.As(ws), nil).Want(t, 404)

	// API key scopes.
	readKey := e.APIKey(ws, "contacts:read")
	e.Do("GET", "/v1/contacts", hdtest.Auth{Bearer: readKey}, nil).Want(t, 200)
	e.Do("POST", "/v1/contacts", hdtest.Auth{Bearer: readKey}, map[string]any{"email": "k@example.com"}).Want(t, 403)
	e.Do("GET", "/v1/contacts/"+c.ID+"/tickets", hdtest.Auth{Bearer: readKey}, nil).Want(t, 403)
	ticketKey := e.APIKey(ws, "contacts:read", "tickets:read")
	e.Do("GET", "/v1/contacts/"+c.ID+"/tickets", hdtest.Auth{Bearer: ticketKey}, nil).Want(t, 200)
	writeKey := e.APIKey(ws, "contacts:write")
	e.Do("POST", "/v1/contacts", hdtest.Auth{Bearer: writeKey}, map[string]any{"email": "k@example.com"}).Want(t, 201)
	e.Do("GET", "/v1/contacts", hdtest.Auth{Bearer: e.APIKey(ws, "tickets:read")}, nil).Want(t, 403)
}

func TestContactSearchAndPaging(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var co company
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Globex", "domain": "globex.com"}).Want(t, 201).JSON(t, &co)
	for i := 0; i < 5; i++ {
		e.Do("POST", "/v1/contacts", a, map[string]any{"email": hdtest.Fmt("user%d@example.com", i), "name": hdtest.Fmt("Person Number%d", i)}).Want(t, 201)
	}
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "marie.curie@globex.com", "name": "Marie Curie", "company_id": co.ID}).Want(t, 201)

	var p page[contact]
	e.Do("GET", "/v1/contacts?q=curie", a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 1 || p.Data[0].Name != "Marie Curie" {
		t.Fatalf("fts %+v", p.Data)
	}
	e.Do("GET", "/v1/contacts?q=marie.cu", a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 1 {
		t.Fatalf("email prefix %+v", p.Data)
	}
	e.Do("GET", "/v1/contacts?company_id="+co.ID, a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 1 || p.Data[0].Company == nil {
		t.Fatalf("company filter %+v", p.Data)
	}
	e.Do("GET", "/v1/contacts?company_id=nope", a, nil).Want(t, 422)

	seen := map[string]bool{}
	cursor := ""
	for pages := 0; pages < 10; pages++ {
		path := "/v1/contacts?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		var pg page[contact]
		e.Do("GET", path, a, nil).Want(t, 200).JSON(t, &pg)
		for _, c := range pg.Data {
			if seen[c.ID] {
				t.Fatalf("duplicate %s", c.ID)
			}
			seen[c.ID] = true
		}
		if pg.NextCursor == nil {
			break
		}
		cursor = *pg.NextCursor
	}
	if len(seen) != 6 {
		t.Fatalf("paged %d contacts, want 6", len(seen))
	}
	e.Do("GET", "/v1/contacts?cursor=!!!", a, nil).Want(t, 400)
}

func TestContactTickets(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var c contact
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "t@example.com"}).Want(t, 201).JSON(t, &c)
	for i := 1; i <= 3; i++ {
		e.Exec(`INSERT INTO tickets (id, workspace_id, number, subject, channel, contact_id, last_message_at, brand_id)
			VALUES ($1, $2, $3, $4, 'api', $5, now() - make_interval(hours => $6), $7)`, ids.New(), ws.ID, i, hdtest.Fmt("T%d", i), c.ID, i, ws.BrandID)
	}
	e.Exec(`UPDATE tickets SET deleted_at = now() WHERE workspace_id = $1 AND number = 3`, ws.ID)
	var p page[struct {
		Subject string `json:"subject"`
	}]
	e.Do("GET", "/v1/contacts/"+c.ID+"/tickets", a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 2 || p.Data[0].Subject != "T1" {
		t.Fatalf("tickets %+v", p.Data)
	}
	e.Do("GET", "/v1/contacts/"+c.ID, a, nil).Want(t, 200).JSON(t, &c)
	if c.TicketCount != 2 {
		t.Fatalf("ticket_count %d", c.TicketCount)
	}
}

func TestCompanies(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var co company
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Initech", "domain": "initech.com"}).Want(t, 201).JSON(t, &co)
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Initech 2", "domain": "INITECH.com"}).Want(t, 409)
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "  "}).Want(t, 422)
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Bad", "domain": "not a domain"}).Want(t, 422)
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Umbrella"}).Want(t, 201)
	e.Do("POST", "/v1/companies", ws.Viewer.As(ws), map[string]any{"name": "Nope"}).Want(t, 403)

	var p page[company]
	e.Do("GET", "/v1/companies?q=init", a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 1 || p.Data[0].Name != "Initech" {
		t.Fatalf("q %+v", p.Data)
	}
	e.Do("GET", "/v1/companies?limit=1", a, nil).Want(t, 200).JSON(t, &p)
	if len(p.Data) != 1 || p.NextCursor == nil {
		t.Fatalf("page %+v", p)
	}
	var p2 page[company]
	e.Do("GET", "/v1/companies?limit=1&cursor="+*p.NextCursor, a, nil).Want(t, 200).JSON(t, &p2)
	if len(p2.Data) != 1 || p2.Data[0].ID == p.Data[0].ID {
		t.Fatalf("page2 %+v", p2)
	}

	e.Do("PATCH", "/v1/companies/"+co.ID, a, map[string]any{"name": "Initech LLC", "notes": "big"}).Want(t, 200).JSON(t, &co)
	if co.Name != "Initech LLC" || co.Domain != "initech.com" {
		t.Fatalf("patched %+v", co)
	}

	// External id: set, unique per workspace, cleared with null.
	e.Do("PATCH", "/v1/companies/"+co.ID, a, map[string]any{"external_id": " acct-1 "}).Want(t, 200).JSON(t, &co)
	if co.ExternalID == nil || *co.ExternalID != "acct-1" || co.Name != "Initech LLC" {
		t.Fatalf("external id %+v", co)
	}
	e.Do("POST", "/v1/companies", a, map[string]any{"name": "Copy", "external_id": "acct-1"}).Want(t, 409)
	e.Do("PATCH", "/v1/companies/"+co.ID, a, map[string]any{"external_id": nil}).Want(t, 200).JSON(t, &co)
	if co.ExternalID != nil {
		t.Fatalf("external id kept %+v", co)
	}
	var c contact
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "p@initech.com", "company_id": co.ID}).Want(t, 201).JSON(t, &c)
	e.Do("DELETE", "/v1/companies/"+co.ID, a, nil).Want(t, http.StatusNoContent)
	e.Do("GET", "/v1/contacts/"+c.ID, a, nil).Want(t, 200).JSON(t, &c)
	if c.Company != nil {
		t.Fatal("company kept after delete")
	}
	types, _ := e.Events(ws.ID, 0)
	if !slices.Contains(types, "company.updated") || !slices.Contains(types, "company.deleted") {
		t.Fatalf("events %v", types)
	}
}
