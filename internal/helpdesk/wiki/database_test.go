package wiki_test

import (
	"encoding/json"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type dbPage struct {
	spaced
	Kind     string         `json:"kind"`
	Database *wiki.Database `json:"database"`
	Props    map[string]any `json:"props"`
}

type dbRows struct {
	Data []struct {
		ID      string         `json:"id"`
		Title   string         `json:"title"`
		Props   map[string]any `json:"props"`
		Excerpt string         `json:"excerpt"`
	} `json:"data"`
	Templates []struct{ ID string } `json:"templates"`
}

func TestDatabases(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	// A new database: a title and tags, seen as a table.
	var db dbPage
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Bugs", "kind": "database"}).Want(t, 201).JSON(t, &db)
	if db.Kind != "database" || db.Database == nil || db.Database.Properties[0].Type != "title" || db.Database.Views[0].Type != "table" {
		t.Fatalf("database %+v", db.Database)
	}

	// Its schema: a status, a number, a date, people, a link, a relation and a unique id.
	other := create(t, e, agent, map[string]any{"title": "Customers", "kind": "database"})
	schema := map[string]any{
		"properties": []map[string]any{
			{"id": "title", "name": "Name", "type": "title"},
			{"id": "status", "name": "Status", "type": "status", "options": []map[string]any{{"id": "open", "name": "Open", "color": "blue"}, {"id": "done", "name": "Done", "color": "green"}},
				"groups": []map[string]any{{"id": "todo", "option_ids": []string{"open"}}, {"id": "done", "option_ids": []string{"done"}}}},
			{"id": "tags", "name": "Tags", "type": "multi_select", "options": []map[string]any{{"id": "ui", "name": "UI", "color": "pink"}}},
			{"id": "points", "name": "Points", "type": "number", "number_format": "number"},
			{"id": "due", "name": "Due", "type": "date"},
			{"id": "owner", "name": "Owner", "type": "person"},
			{"id": "link", "name": "Link", "type": "url"},
			{"id": "done", "name": "Done", "type": "checkbox"},
			{"id": "customer", "name": "Customer", "type": "relation", "database_id": other.ID},
			{"id": "count", "name": "Customers", "type": "rollup", "rollup": map[string]any{"relation": "customer", "property": "title", "fn": "count"}},
			{"id": "score", "name": "Score", "type": "formula", "formula": "prop(\"Points\") * 2"},
		},
		"views": []map[string]any{{"id": "table", "name": "All", "type": "table"}, {"id": "board", "name": "Board", "type": "board", "settings": map[string]any{"group_by": "status"}}},
	}
	e.Do("PATCH", "/v1/wiki/pages/"+db.ID, agent, map[string]any{"database": schema}).Want(t, 200).JSON(t, &db)
	if len(db.Database.Properties) != 11 || db.Database.Views[1].Settings["group_by"] != "status" || db.Version != 1 {
		t.Fatalf("schema %+v version %d", db.Database, db.Version)
	}
	bad := []map[string]any{
		{"properties": []map[string]any{{"id": "x", "name": "X", "type": "text"}}, "views": schema["views"]},
		{"properties": []map[string]any{{"id": "title", "name": "N", "type": "title"}, {"id": "t2", "name": "N2", "type": "title"}}, "views": schema["views"]},
		{"properties": []map[string]any{{"id": "title", "name": "N", "type": "title"}, {"id": "x", "name": "X", "type": "magic"}}, "views": schema["views"]},
		{"properties": []map[string]any{{"id": "title", "name": "N", "type": "title"}, {"id": "r", "name": "R", "type": "rollup", "rollup": map[string]any{"relation": "title", "property": "x", "fn": "count"}}}, "views": schema["views"]},
		{"properties": []map[string]any{{"id": "title", "name": "N", "type": "title"}}, "views": []map[string]any{}},
	}
	for _, b := range bad {
		e.Do("PATCH", "/v1/wiki/pages/"+db.ID, agent, map[string]any{"database": b}).Want(t, 422)
	}

	// Rows: values checked against their properties.
	acme := create(t, e, agent, map[string]any{"title": "Acme", "parent_id": other.ID})
	var row dbPage
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Login fails", "parent_id": db.ID, "body_html": "<p>Steps to reproduce: open the app.</p>",
		"props": map[string]any{"status": "open", "tags": []string{"ui"}, "points": 3, "due": map[string]any{"start": "2026-11-10"}, "owner": []string{ws.Agent.ID.String()},
			"link": "https://example.com/bug", "done": false, "customer": []string{acme.ID}}}).Want(t, 201).JSON(t, &row)
	if row.Props["status"] != "open" || row.Props["points"] != float64(3) {
		t.Fatalf("row props %+v", row.Props)
	}
	for _, p := range []map[string]any{
		{"status": "nope"}, {"tags": []string{"nope"}}, {"points": "three"}, {"due": map[string]any{"start": "tomorrow"}},
		{"owner": []string{ws.Viewer.ID.String() + "x"}}, {"link": "javascript:alert(1)"}, {"customer": []string{db.ID}},
		{"score": 1}, {"title": "x"}, {"nothing": 1},
	} {
		e.Do("PATCH", "/v1/wiki/pages/"+row.ID, agent, map[string]any{"props": p}).Want(t, 422)
	}
	stranger := e.NewWorkspace()
	e.Do("PATCH", "/v1/wiki/pages/"+row.ID, agent, map[string]any{"props": map[string]any{"owner": []string{stranger.Owner.ID.String()}}}).Want(t, 422)

	// A change merges; null takes a value away; neither moves the version.
	_, seq := e.Events(ws.ID, 0)
	rowID := row.ID
	row = dbPage{} // a decode into the old value would keep keys the answer no longer has
	e.Do("PATCH", "/v1/wiki/pages/"+rowID, agent, map[string]any{"props": map[string]any{"status": "done", "link": nil}}).Want(t, 200).JSON(t, &row)
	if row.Props["status"] != "done" || row.Props["link"] != nil || row.Props["points"] != float64(3) || row.Version != 1 {
		t.Fatalf("merged %+v v%d", row.Props, row.Version)
	}
	var data string
	e.Scalar(`SELECT data::text FROM events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT 1`, &data, ws.ID, seq)
	var ev map[string]any
	if err := json.Unmarshal([]byte(data), &ev); err != nil || ev["props"] == nil {
		t.Fatalf("event %s", data)
	}

	// The rows, with their values and how their text starts; a template row apart.
	create(t, e, agent, map[string]any{"title": "Second", "parent_id": db.ID})
	var tpl dbPage
	e.Do("POST", "/v1/wiki/pages/"+row.ID+"/duplicate", agent, map[string]any{"parent_id": db.ID, "title": "Bug report"}).Want(t, 201).JSON(t, &tpl)
	var rows dbRows
	e.Do("GET", "/v1/wiki/databases/"+db.ID+"/rows", viewer, nil).Want(t, 200).JSON(t, &rows)
	if len(rows.Data) != 3 || rows.Data[0].Excerpt != "Steps to reproduce: open the app." || rows.Data[2].Props["status"] != "done" {
		t.Fatalf("rows %+v", rows.Data)
	}
	e.Do("GET", "/v1/wiki/databases/"+row.ID+"/rows", viewer, nil).Want(t, 404)

	// A unique id added now numbers the rows there, oldest first; new rows count on.
	schema["properties"] = append(schema["properties"].([]map[string]any), map[string]any{"id": "num", "name": "ID", "type": "unique_id", "prefix": "BUG"})
	e.Do("PATCH", "/v1/wiki/pages/"+db.ID, agent, map[string]any{"database": schema}).Want(t, 200)
	var third dbPage
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Third", "parent_id": db.ID}).Want(t, 201).JSON(t, &third)
	e.Do("GET", "/v1/wiki/databases/"+db.ID+"/rows", viewer, nil).Want(t, 200).JSON(t, &rows)
	if rows.Data[0].Props["num"] != float64(1) || third.Props["num"] != float64(4) {
		t.Fatalf("numbers %+v %+v", rows.Data, third.Props)
	}
	e.Do("PATCH", "/v1/wiki/pages/"+third.ID, agent, map[string]any{"props": map[string]any{"num": 9}}).Want(t, 422)

	// Props go with rows only, a schema with databases only.
	page := create(t, e, agent, map[string]any{"title": "Plain"})
	e.Do("PATCH", "/v1/wiki/pages/"+page.ID, agent, map[string]any{"props": map[string]any{"status": "open"}}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+page.ID, agent, map[string]any{"database": schema}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+db.ID, viewer, map[string]any{"database": schema}).Want(t, 403)

	// A copy of the database takes its rows, their values pointing at the copies.
	var copied dbPage
	e.Do("POST", "/v1/wiki/pages/"+db.ID+"/duplicate", agent, map[string]any{"title": "Bugs copy"}).Want(t, 201).JSON(t, &copied)
	e.Do("GET", "/v1/wiki/databases/"+copied.ID+"/rows", viewer, nil).Want(t, 200).JSON(t, &rows)
	if copied.Kind != "database" || len(rows.Data) != 4 {
		t.Fatalf("copy %s rows %d", copied.Kind, len(rows.Data))
	}
}
