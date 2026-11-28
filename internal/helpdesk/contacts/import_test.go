package contacts_test

import (
	"encoding/csv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type contactImportUpload struct {
	UploadID  uuid.UUID `json:"upload_id"`
	Rows      int       `json:"rows"`
	Suggested struct {
		Name  string `json:"name"`
		Email string `json:"email"`
		Phone string `json:"phone"`
	} `json:"suggested"`
}

type importState struct {
	ID        uuid.UUID `json:"id"`
	Status    string    `json:"status"`
	Total     int       `json:"total"`
	Processed int       `json:"processed"`
	Created   int       `json:"created"`
	Updated   int       `json:"updated"`
	Skipped   int       `json:"skipped"`
	Failed    int       `json:"failed"`
	Errors    []struct {
		Line    int    `json:"line"`
		Message string `json:"message"`
	} `json:"errors"`
}

func runImport(t *testing.T, e *hdtest.Env, ws hdtest.WS, a hdtest.Auth, file, onMatch string, mapping map[string]any) importState {
	t.Helper()
	var up contactImportUpload
	e.Upload("/v1/contacts/import/upload", a, "people.csv", []byte(file)).Want(t, 201).JSON(t, &up)
	var x importState
	e.Do("POST", "/v1/contacts/imports", a, map[string]any{"upload_id": up.UploadID, "mapping": mapping, "match_on": "email", "on_match": onMatch}).Want(t, 201).JSON(t, &x)
	if err := contacts.RunImport(e.Ctx, e.D, x.ID); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", "/v1/contacts/imports/"+x.ID.String(), a, nil).Want(t, 200).JSON(t, &x)
	return x
}

func TestContactImport(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, phone) VALUES ($1, $2, 'Existing Ann', 'ann@example.com', '')`, ids.New(), ws.ID)

	file := "Full name,E-mail,Phone,Company,Labels\n" +
		"Bob,bob@example.com,555 1,Acme,\"vip; beta\"\n" +
		"Ann Lee,ANN@example.com,555 2,Acme,\n" +
		"No email,not-an-email,,,\n" +
		"Dora,,,,\n"
	mapping := map[string]any{"name": "Full name", "email": "E-mail", "phone": "Phone", "company": "Company", "labels": "Labels"}

	// The headers are matched to fields without being told.
	var up contactImportUpload
	e.Upload("/v1/contacts/import/upload", a, "people.csv", []byte(file)).Want(t, 201).JSON(t, &up)
	if up.Rows != 4 || up.Suggested.Email != "E-mail" || up.Suggested.Name != "Full name" || up.Suggested.Phone != "Phone" {
		t.Fatalf("upload %+v", up)
	}

	// Skip: the existing person is left alone, the others are added, bad rows fail alone.
	x := runImport(t, e, ws, a, file, "skip", mapping)
	if x.Status != "done" || x.Created != 2 || x.Skipped != 1 || x.Failed != 1 || x.Processed != 4 {
		t.Fatalf("skip run %+v", x)
	}
	if len(x.Errors) != 1 || x.Errors[0].Line != 4 {
		t.Fatalf("errors %+v", x.Errors)
	}
	if n := count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID); n != 3 {
		t.Fatalf("%d contacts", n)
	}
	var phone string
	e.Scalar(`SELECT phone FROM contacts WHERE workspace_id = $1 AND email = 'ann@example.com'`, &phone, ws.ID)
	if phone != "" {
		t.Fatalf("skip changed Ann: %q", phone)
	}
	if n := count(e, `SELECT count(*) FROM contacts ct JOIN companies co ON co.id = ct.company_id WHERE ct.workspace_id = $1 AND co.name = 'Acme'`, ws.ID); n != 1 {
		t.Fatalf("%d in Acme", n)
	}
	if n := count(e, `SELECT count(*) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.workspace_id = $1`, ws.ID); n != 2 {
		t.Fatalf("%d labels", n)
	}

	// Fill: Ann has a name already, so only her phone is set. A row without the email it
	// would be found by has nothing to match, so it is added again.
	x = runImport(t, e, ws, a, file, "fill", mapping)
	if x.Created != 1 || x.Updated != 2 || x.Failed != 1 {
		t.Fatalf("fill run %+v", x)
	}
	var name string
	e.Scalar(`SELECT name FROM contacts WHERE workspace_id = $1 AND email = 'ann@example.com'`, &name, ws.ID)
	e.Scalar(`SELECT phone FROM contacts WHERE workspace_id = $1 AND email = 'ann@example.com'`, &phone, ws.ID)
	if name != "Existing Ann" || phone != "555 2" {
		t.Fatalf("fill gave %q %q", name, phone)
	}

	// Overwrite replaces the name.
	x = runImport(t, e, ws, a, file, "overwrite", mapping)
	e.Scalar(`SELECT name FROM contacts WHERE workspace_id = $1 AND email = 'ann@example.com'`, &name, ws.ID)
	if name != "Ann Lee" || x.Updated != 2 || x.Created != 1 {
		t.Fatalf("overwrite gave %q %+v", name, x)
	}
}

func TestContactImportRefusals(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var up contactImportUpload
	e.Upload("/v1/contacts/import/upload", a, "people.csv", []byte("Name,Email\nA,a@example.com\n")).Want(t, 201).JSON(t, &up)
	start := func(mapping map[string]any, matchOn string) *hdtest.Resp {
		return e.Do("POST", "/v1/contacts/imports", a, map[string]any{"upload_id": up.UploadID, "mapping": mapping, "match_on": matchOn, "on_match": "skip"})
	}
	start(map[string]any{"email": "Nope"}, "email").Want(t, 422)
	start(map[string]any{}, "email").Want(t, 422)
	start(map[string]any{"name": "Name"}, "email").Want(t, 422)
	start(map[string]any{"email": "Email"}, "external_id").Want(t, 422)
	e.Upload("/v1/contacts/import/upload", a, "people.exe", []byte("Name,Email\nA,a@b.co\n")).Want(t, 422)
	e.Upload("/v1/contacts/import/upload", a, "people.csv", []byte("Name,Email\n")).Want(t, 422)

	// Another workspace's upload is not found.
	other := e.NewWorkspace()
	e.Do("POST", "/v1/contacts/imports", other.Agent.As(other), map[string]any{"upload_id": up.UploadID, "mapping": map[string]any{"email": "Email"}, "match_on": "email", "on_match": "skip"}).Want(t, 404)
	// A viewer cannot import.
	v := e.AddUser(ws, auth.RoleViewer, "Viewer").As(ws)
	e.Upload("/v1/contacts/import/upload", v, "people.csv", []byte("Name,Email\nA,a@example.com\n")).Want(t, 403)
	e.Do("POST", "/v1/contacts/export", v, map[string]any{"query": map[string]any{}}).Want(t, 403)
}

func TestContactExport(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, notes) VALUES ($1, $2, '=HYPERLINK("x")', 'a@example.com', 'hello, "world"')`, ids.New(), ws.ID)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Bee', 'b@example.com')`, ids.New(), ws.ID)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Other workspace', 'c@example.com')`, ids.New(), e.NewWorkspace().ID)

	r := e.Do("POST", "/v1/contacts/export", a, map[string]any{"query": map[string]any{}}).Want(t, 200)
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("content type %q", ct)
	}
	if cd := r.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf("disposition %q", cd)
	}
	recs, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(r.Body), "\xEF\xBB\xBF"))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 3 || recs[0][0] != "Name" || recs[0][1] != "Email" {
		t.Fatalf("export %v", recs)
	}
	for _, rec := range recs[1:] {
		if strings.HasPrefix(rec[0], "=") {
			t.Fatalf("a formula went out as is: %q", rec[0])
		}
		if rec[1] == "c@example.com" {
			t.Fatal("another workspace's person was exported")
		}
	}

	// By id: one person; an id of another workspace is not found.
	var id string
	e.Scalar(`SELECT id::text FROM contacts WHERE workspace_id = $1 AND email = 'b@example.com'`, &id, ws.ID)
	r = e.Do("POST", "/v1/contacts/export", a, map[string]any{"ids": []string{id}}).Want(t, 200)
	if n := strings.Count(string(r.Body), "\n"); n != 2 {
		t.Fatalf("%d lines:\n%s", n, r.Body)
	}
	var foreign string
	e.Scalar(`SELECT id::text FROM contacts WHERE email = 'c@example.com' AND workspace_id <> $1 LIMIT 1`, &foreign, ws.ID)
	e.Do("POST", "/v1/contacts/export", a, map[string]any{"ids": []string{foreign}}).Want(t, 404)
	e.Do("POST", "/v1/contacts/export", a, map[string]any{}).Want(t, 422)
}

// An export imported again leaves people as they were, though its cells are neutralized
// for spreadsheets: a phone in +1 form goes out as '+1 and comes back as +1.
func TestContactExportImportRoundTrip(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, phone, notes) VALUES ($1, $2, 'Ann', 'ann@example.com', '+1 555 0134', '=1+1')`, ids.New(), ws.ID)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, phone, notes) VALUES ($1, $2, 'Bob', 'bob@example.com', '-5', '''kept as typed')`, ids.New(), ws.ID)

	r := e.Do("POST", "/v1/contacts/export", a, map[string]any{"query": map[string]any{}}).Want(t, 200)
	if !strings.Contains(string(r.Body), "'+1 555 0134") || !strings.Contains(string(r.Body), "'=1+1") {
		t.Fatalf("export not neutralized:\n%s", r.Body)
	}
	x := runImport(t, e, ws, a, string(r.Body), "overwrite", map[string]any{"name": "Name", "email": "Email", "phone": "Phone", "notes": "Notes"})
	if x.Status != "done" || x.Updated != 2 || x.Failed != 0 {
		t.Fatalf("round trip %+v", x)
	}
	for email, want := range map[string][2]string{"ann@example.com": {"+1 555 0134", "=1+1"}, "bob@example.com": {"-5", "'kept as typed"}} {
		var phone, notes string
		e.Scalar(`SELECT phone FROM contacts WHERE workspace_id = $1 AND email = $2`, &phone, ws.ID, email)
		e.Scalar(`SELECT notes FROM contacts WHERE workspace_id = $1 AND email = $2`, &notes, ws.ID, email)
		if phone != want[0] || notes != want[1] {
			t.Fatalf("%s came back as %q %q", email, phone, notes)
		}
	}
}
