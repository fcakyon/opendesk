package wiki_test

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type portFile struct{ name, body string }

func zipOf(t *testing.T, files ...portFile) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(f.body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type importOut struct {
	Pages   int      `json:"pages"`
	RootIDs []string `json:"root_ids"`
	Skipped []struct {
		Path   string `json:"path"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

func (o importOut) skipped(path, reason string) bool {
	for _, s := range o.Skipped {
		if s.Path == path && s.Reason == reason {
			return true
		}
	}
	return false
}

// importFiles posts files (and form fields) to POST /v1/wiki/import.
func importFiles(t *testing.T, e *hdtest.Env, a hdtest.Auth, fields map[string]string, files ...portFile) *hdtest.Resp {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for _, f := range files {
		w, err := mw.CreateFormFile("files", f.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(f.body))
	}
	_ = mw.Close()
	a.Header = map[string]string{"Content-Type": mw.FormDataContentType()}
	return e.Do("POST", "/v1/wiki/import", a, buf.Bytes())
}

func importOK(t *testing.T, e *hdtest.Env, a hdtest.Auth, fields map[string]string, files ...portFile) importOut {
	t.Helper()
	var out importOut
	importFiles(t, e, a, fields, files...).Want(t, 201).JSON(t, &out)
	return out
}

type fullPage struct {
	page
	Kind     string         `json:"kind"`
	Tags     []string       `json:"tags"`
	Props    map[string]any `json:"props"`
	Private  bool           `json:"private"`
	Database *struct {
		Properties []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Type    string `json:"type"`
			Options []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"options"`
		} `json:"properties"`
		NextID int `json:"next_id"`
	} `json:"database"`
}

func getPage(t *testing.T, e *hdtest.Env, a hdtest.Auth, id string) fullPage {
	t.Helper()
	var out fullPage
	e.Do("GET", "/v1/wiki/pages/"+id, a, nil).Want(t, 200).JSON(t, &out)
	return out
}

// idOf is the id of the page titled title in the tree.
func idOf(t *testing.T, nodes []node, title string) string {
	t.Helper()
	for _, n := range nodes {
		if n.Title == title {
			return n.ID
		}
	}
	t.Fatalf("no page %q", title)
	return ""
}

const pngBytes = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"

func TestImportObsidianVault(t *testing.T) {
	e := hdtest.New(t, wiki.Register, widget.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)
	parent := create(t, e, agent, map[string]any{"title": "Imported"})
	_, seq := e.Events(ws.ID, 0)

	vault := zipOf(t,
		portFile{"Vault/.obsidian/app.json", "{}"},
		portFile{"Vault/Projects/Projects.md", "---\ntitle: All projects\ntags: [work, planning]\n---\nSee [[Alpha]] and [[Beta]].\n"},
		portFile{"Vault/Projects/Alpha.md", "# Alpha\n\n![[diagram.png]]\n\nNext: [[Beta]]\n\n![[fake.png]]\n"},
		portFile{"Vault/Projects/Beta.md", "Back to [[Alpha]] and ![[run.sh]]\n"},
		portFile{"Vault/attachments/diagram.png", pngBytes},
		portFile{"Vault/attachments/fake.png", "MZ\x90\x00 a program dressed as a picture"},
		portFile{"Vault/attachments/run.sh", "#!/bin/sh\necho"},
	)
	out := importOK(t, e, agent, map[string]string{"parent_id": parent.ID}, portFile{"vault.zip", string(vault)})
	if out.Pages != 4 || len(out.RootIDs) != 1 {
		t.Fatalf("import: %+v", out)
	}
	if !out.skipped("Vault/attachments/run.sh", "executable") || !out.skipped("Vault/attachments/fake.png", "executable") {
		t.Fatalf("skipped: %+v", out.Skipped)
	}

	// The tree lands under the parent, in order, numbered from 0.
	nodes := tree(t, e, viewer)
	vaultID := idOf(t, nodes, "Vault")
	if vaultID != out.RootIDs[0] || !slices.Equal(children(nodes, parent.ID), []string{"Vault"}) ||
		!slices.Equal(children(nodes, vaultID), []string{"All projects"}) ||
		!slices.Equal(children(nodes, idOf(t, nodes, "All projects")), []string{"Alpha", "Beta"}) {
		t.Fatalf("tree: %v / %v", children(nodes, parent.ID), children(nodes, vaultID))
	}
	alphaID, betaID, projectsID := idOf(t, nodes, "Alpha"), idOf(t, nodes, "Beta"), idOf(t, nodes, "All projects")

	// Links point at the pages made, both ways, and are indexed as links.
	alpha := getPage(t, e, viewer, alphaID)
	if !strings.Contains(alpha.BodyHTML, `data-id="`+betaID+`"`) || !strings.Contains(getPage(t, e, viewer, betaID).BodyHTML, `href="/wiki/`+alphaID+`"`) {
		t.Fatalf("links: %s", alpha.BodyHTML)
	}
	var links int
	e.Scalar(`SELECT count(*) FROM wiki_links WHERE workspace_id = $1 AND from_id = $2 AND to_id = $3`, &links, ws.ID, alphaID, betaID)
	if links != 1 {
		t.Fatal("the link to Beta is not indexed")
	}
	if projects := getPage(t, e, viewer, projectsID); !slices.Equal(projects.Tags, []string{"work", "planning"}) {
		t.Fatalf("tags: %v", projects.Tags)
	}

	// The picture is the page's own file: stored as an imported attachment, and named in the
	// body by its path, which a reader gets signed.
	var fileID uuid.UUID
	var name, ct string
	var holder *uuid.UUID
	e.Scalar(`SELECT id FROM attachments WHERE workspace_id = $1 AND imported`, &fileID, ws.ID)
	e.Scalar(`SELECT filename FROM attachments WHERE id = $1`, &name, fileID)
	e.Scalar(`SELECT content_type FROM attachments WHERE id = $1`, &ct, fileID)
	e.Scalar(`SELECT wiki_page_id FROM attachments WHERE id = $1`, &holder, fileID)
	if name != "diagram.png" || ct != "image/png" || holder == nil || holder.String() != alphaID {
		t.Fatalf("file: %s %s %v", name, ct, holder)
	}
	var stored string
	e.Scalar(`SELECT body_html FROM wiki_pages WHERE id = $1`, &stored, alphaID)
	if !strings.Contains(stored, `src="/v1/attachments/`+fileID.String()+`"`) {
		t.Fatalf("stored body: %s", stored)
	}
	if !strings.Contains(alpha.BodyHTML, `src="http://api.test/v1/attachments/`+fileID.String()+`?exp=`) {
		t.Fatalf("read body: %s", alpha.BodyHTML)
	}
	// Whoever sees the page reads its file; another workspace doesn't.
	if r := e.Do("GET", "/v1/attachments/"+fileID.String(), viewer, nil); r.Status != 200 || string(r.Body) != pngBytes {
		t.Fatalf("viewer reads the file: %d", r.Status)
	}
	other := e.NewWorkspace()
	e.Do("GET", "/v1/attachments/"+fileID.String(), other.Admin.As(other), nil).Want(t, 404)
	// Kept by the hourly sweep of unsent uploads.
	e.Exec(`UPDATE attachments SET created_at = now() - interval '2 days' WHERE id = $1`, fileID)
	var kept int
	e.Scalar(`SELECT count(*) FROM attachments WHERE id = $1 AND (message_id IS NOT NULL OR wiki_page_id IS NOT NULL)`, &kept, fileID)
	if kept != 1 {
		t.Fatal("the page's file is not held")
	}

	// One created event per page, parents first; one audit entry; nobody notified.
	types, _ := e.Events(ws.ID, seq)
	if !slices.Equal(types, []string{"wiki_page.created", "wiki_page.created", "wiki_page.created", "wiki_page.created"}) {
		t.Fatalf("events: %v", types)
	}
	var audits, notes int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'wiki_page.imported'`, &audits, ws.ID)
	e.Scalar(`SELECT count(*) FROM notifications WHERE workspace_id = $1`, &notes, ws.ID)
	if audits != 1 || notes != 0 {
		t.Fatalf("audits %d, notifications %d", audits, notes)
	}
}

func TestImportNotionDatabase(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	id := func(n int) string { return fmt.Sprintf("%032x", n+0xabc0) }
	home := "Export/Team Home " + id(1)
	csv := "Name,Status,Tags,Done,Points,Website\n" +
		"Write docs,In progress,\"docs, writing\",Yes,3,https://example.com\n" +
		"Ship,Done,docs,No,5,\n" +
		"Plan,Not started,\"planning, docs\",No,1,\n"
	out := importOK(t, e, agent, nil, portFile{"Export.zip", string(zipOf(t,
		portFile{home + ".md", "# Team Home\n\n[Tasks](Team%20Home%20" + id(1) + "/Tasks%20" + id(3) + ".csv)\n"},
		portFile{home + "/Tasks " + id(3) + ".csv", "Name\nonly the view\n"},
		portFile{home + "/Tasks " + id(3) + "_all.csv", csv},
		portFile{home + "/Tasks " + id(3) + "/Write docs " + id(4) + ".md", "# Write docs\n\nStatus: In progress\n\nThe row's own text."},
	))})
	// The export's folder holds the home page, which holds the database and its rows.
	if out.Pages != 6 || len(out.RootIDs) != 1 {
		t.Fatalf("import: %+v", out)
	}
	nodes := tree(t, e, agent)
	homeID := idOf(t, nodes, "Team Home")
	if !slices.Equal(children(nodes, out.RootIDs[0]), []string{"Team Home"}) || !slices.Equal(children(nodes, homeID), []string{"Tasks"}) {
		t.Fatalf("tree: %v", children(nodes, out.RootIDs[0]))
	}
	tasksID := idOf(t, nodes, "Tasks")
	tasks := getPage(t, e, agent, tasksID)
	if tasks.Kind != "database" || tasks.Database == nil || !slices.Equal(children(nodes, tasksID), []string{"Write docs", "Ship", "Plan"}) {
		t.Fatalf("database: %+v %v", tasks.Database, children(nodes, tasksID))
	}
	if !strings.Contains(getPage(t, e, agent, homeID).BodyHTML, `<div data-type="database" data-id="`+tasksID+`" data-view="table"></div>`) {
		t.Fatal("the home page doesn't show the database")
	}
	types := map[string]string{}
	options := map[string]string{}
	for _, p := range tasks.Database.Properties {
		types[p.ID] = p.Type
		for _, o := range p.Options {
			options[p.ID+":"+o.Name] = o.ID
		}
	}
	if types["title"] != "title" || types["status"] != "status" || types["tags"] != "multi_select" || types["done"] != "checkbox" ||
		types["points"] != "number" || types["website"] != "url" {
		t.Fatalf("schema: %v", types)
	}
	write := getPage(t, e, agent, idOf(t, nodes, "Write docs"))
	if write.Props["status"] != options["status:In progress"] || write.Props["done"] != true || write.Props["points"] != 3.0 ||
		write.Props["website"] != "https://example.com" || fmt.Sprint(write.Props["tags"]) != fmt.Sprint([]any{options["tags:docs"], options["tags:writing"]}) {
		t.Fatalf("row values: %v", write.Props)
	}
	if !strings.Contains(write.BodyHTML, "own text") {
		t.Fatalf("row body: %s", write.BodyHTML)
	}

	// The database is the API's own: a unique id added now numbers the rows in the import's order.
	var schema map[string]any
	e.Do("GET", "/v1/wiki/pages/"+tasksID, agent, nil).Want(t, 200).JSON(t, &struct {
		Database *map[string]any `json:"database"`
	}{&schema})
	schema["properties"] = append(schema["properties"].([]any), map[string]any{"id": "num", "name": "ID", "type": "unique_id", "prefix": "TASK"})
	e.Do("PATCH", "/v1/wiki/pages/"+tasksID, agent, map[string]any{"database": schema}).Want(t, 200)
	for i, title := range []string{"Write docs", "Ship", "Plan"} {
		if got := getPage(t, e, agent, idOf(t, nodes, title)).Props["num"]; got != float64(i+1) {
			t.Fatalf("%s numbered %v", title, got)
		}
	}
	// A new row takes the next number.
	row := create(t, e, agent, map[string]any{"parent_id": tasksID, "title": "Later"})
	if got := getPage(t, e, agent, row.ID).Props["num"]; got != 4.0 {
		t.Fatalf("new row numbered %v", got)
	}
}

func TestImportAccessAndLimits(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, admin, viewer := ws.Agent.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)
	notes := []portFile{{"Runbook.md", "# Runbook\n\nSee [[Escalation]]."}, {"Escalation.md", "Call the lead."}}

	// Viewers and keys without wiki:write import nothing.
	importFiles(t, e, viewer, nil, notes...).Want(t, 403)
	importFiles(t, e, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeWikiRead)}, nil, notes...).Want(t, 403)
	key := importOK(t, e, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeWikiRead, auth.ScopeWikiWrite)}, nil, notes...)
	if key.Pages != 2 || len(key.RootIDs) != 2 {
		t.Fatalf("key import: %+v", key)
	}

	// Private pages are the importer's alone.
	mine := importOK(t, e, agent, map[string]string{"space": "private"}, notes...)
	var mineTree []node
	for _, n := range tree(t, e, agent) {
		if slices.Contains(mine.RootIDs, n.ID) {
			mineTree = append(mineTree, n)
		}
	}
	runbook := getPage(t, e, agent, idOf(t, mineTree, "Runbook"))
	if !runbook.Private || !strings.Contains(runbook.BodyHTML, `data-id="`+idOf(t, mineTree, "Escalation")+`"`) {
		t.Fatalf("private import: %+v", runbook)
	}
	e.Do("GET", "/v1/wiki/pages/"+mine.RootIDs[0], admin, nil).Want(t, 404)
	for _, n := range tree(t, e, admin) {
		if slices.Contains(mine.RootIDs, n.ID) {
			t.Fatal("someone else's private import in the tree")
		}
	}
	// A parent out of sight, or another workspace's, is refused.
	other := e.NewWorkspace()
	foreign := create(t, e, other.Agent.As(other), map[string]any{"title": "Theirs"})
	importFiles(t, e, admin, map[string]string{"parent_id": mine.RootIDs[0]}, notes...).Want(t, 422)
	importFiles(t, e, agent, map[string]string{"parent_id": foreign.ID}, notes...).Want(t, 422)
	importFiles(t, e, agent, nil, portFile{"tool.exe", "MZ"}).Want(t, 422)

	// Depth: nothing goes under a page at the last level.
	at := create(t, e, agent, map[string]any{"title": "L1"})
	for i := 2; i <= 10; i++ {
		at = create(t, e, agent, map[string]any{"title": fmt.Sprintf("L%d", i), "parent_id": at.ID})
	}
	importFiles(t, e, agent, map[string]string{"parent_id": at.ID}, notes...).Want(t, 422)

	// The workspace's page limit is checked before anything is stored.
	var count int
	e.Scalar(`SELECT count(*) FROM wiki_pages WHERE workspace_id = $1`, &count, ws.ID)
	e.Exec(`INSERT INTO wiki_pages (workspace_id, title) SELECT $1, 'filler' FROM generate_series(1, $2::int)`, ws.ID, 4999-count)
	r := importFiles(t, e, agent, nil, portFile{"pics.zip", string(zipOf(t, portFile{"a/One.md", "![](p.png)"}, portFile{"a/p.png", pngBytes}))})
	if r.Want(t, 422); !strings.Contains(string(r.Body), "wiki_full") {
		t.Fatalf("over the limit: %s", r.Body)
	}
	var files int
	e.Scalar(`SELECT count(*) FROM attachments WHERE workspace_id = $1`, &files, ws.ID)
	if files != 0 {
		t.Fatalf("%d files stored for a refused import", files)
	}
	importOK(t, e, agent, nil, notes[1])
}

func TestExport(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	// One page, one file: a download with its title as its name.
	single := create(t, e, agent, map[string]any{"title": "Refunds", "body_html": "<p>Over <strong>100 euros</strong> ask the lead.</p>"})
	r := e.Do("GET", "/v1/wiki/pages/"+single.ID+"/export?format=markdown", viewer, nil).Want(t, 200)
	if r.Header.Get("Content-Type") != "text/markdown; charset=utf-8" || r.Header.Get("Content-Disposition") != `attachment; filename=Refunds.md` ||
		r.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(r.Header.Get("Cache-Control"), "no-store") {
		t.Fatalf("headers: %v", r.Header)
	}
	if !strings.Contains(string(r.Body), "**100 euros**") {
		t.Fatalf("markdown: %s", r.Body)
	}
	r = e.Do("GET", "/v1/wiki/pages/"+single.ID+"/export?format=html", viewer, nil).Want(t, 200)
	if r.Header.Get("Content-Type") != "text/html; charset=utf-8" || r.Header.Get("Content-Disposition") != `attachment; filename=Refunds.html` ||
		!strings.Contains(r.Header.Get("Content-Security-Policy"), "sandbox") || !strings.Contains(string(r.Body), "<strong>100 euros</strong>") {
		t.Fatalf("html: %v %s", r.Header, r.Body)
	}
	e.Do("GET", "/v1/wiki/pages/"+single.ID+"/export?format=pdf", viewer, nil).Want(t, 422)
	e.Do("GET", "/v1/wiki/pages/"+uuid.NewString()+"/export", viewer, nil).Want(t, 404)
	e.Do("GET", "/v1/wiki/pages/"+single.ID+"/export", hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeKBRead)}, nil).Want(t, 403)

	// A subtree as a zip: its pages, the files they use that are the workspace's, not what is
	// in the trash or out of the reader's sight.
	att, err := hd.SaveUpload(e.Ctx, e.D.Storage, e.D.DB.Pool, hd.Upload{WorkspaceID: ws.ID, UploadedBy: &ws.Agent.ID, Filename: "chart.png",
		Size: int64(len(pngBytes)), Body: strings.NewReader(pngBytes)})
	if err != nil {
		t.Fatal(err)
	}
	other := e.NewWorkspace()
	theirs, err := hd.SaveUpload(e.Ctx, e.D.Storage, e.D.DB.Pool, hd.Upload{WorkspaceID: other.ID, UploadedBy: &other.Agent.ID, Filename: "theirs.png",
		Size: int64(len(pngBytes)), Body: strings.NewReader(pngBytes)})
	if err != nil {
		t.Fatal(err)
	}
	root := create(t, e, agent, map[string]any{"title": "Handbook", "body_html": `<p>Start here.</p><img src="` + att.URL + `" alt="chart">` +
		`<img src="/v1/attachments/` + theirs.ID.String() + `" alt="x">`})
	child := create(t, e, agent, map[string]any{"title": "Refund policy", "parent_id": root.ID, "body_html": `<p>Back to <a data-type="page" data-id="` + root.ID + `" href="/wiki/` + root.ID + `">the handbook</a></p>`})
	create(t, e, agent, map[string]any{"title": "Edge cases", "parent_id": child.ID})
	gone := create(t, e, agent, map[string]any{"title": "Old draft", "parent_id": root.ID})
	e.Do("POST", "/v1/wiki/pages/"+gone.ID+"/trash", agent, nil).Want(t, 200)

	r = e.Do("GET", "/v1/wiki/pages/"+root.ID+"/export?subpages=true", viewer, nil).Want(t, 200)
	if r.Header.Get("Content-Type") != "application/zip" || r.Header.Get("Content-Disposition") != `attachment; filename=Handbook.zip` {
		t.Fatalf("zip headers: %v", r.Header)
	}
	files := unzip(t, r.Body)
	want := []string{"Handbook.md", "Handbook/Refund policy.md", "Handbook/Refund policy/Edge cases.md", "attachments/chart.png"}
	if got := keys(files); !slices.Equal(got, want) {
		t.Fatalf("zip holds %v, want %v", got, want)
	}
	if files["attachments/chart.png"] != pngBytes || !strings.Contains(files["Handbook.md"], "](attachments/chart.png)") ||
		strings.Contains(files["Handbook.md"], "attachments/theirs") ||
		!strings.Contains(files["Handbook/Refund policy.md"], "Back to [[Handbook]]") {
		t.Fatalf("zip contents: %q\n%q", files["Handbook.md"], files["Handbook/Refund policy.md"])
	}
	if strings.Contains(files["Handbook.md"], "exp=") {
		t.Fatal("a signed link left the workspace")
	}

	// The whole wiki: what the reader sees, not someone else's private pages or a private
	// team's they are not on.
	create(t, e, agent, map[string]any{"title": "My notes", "space": "private"})
	team := uuid.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Billing', true)`, team, ws.ID)
	e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, team, ws.Agent.ID)
	create(t, e, agent, map[string]any{"title": "Billing secrets", "space": "team", "team_id": team.String()})
	all := unzip(t, e.Do("GET", "/v1/wiki/export?format=html", viewer, nil).Want(t, 200).Body)
	for _, name := range []string{"Refunds.html", "Handbook.html", "Handbook/Refund policy.html"} {
		if _, ok := all[name]; !ok {
			t.Fatalf("whole wiki lacks %s: %v", name, keys(all))
		}
	}
	for name := range all {
		if strings.Contains(name, "My notes") || strings.Contains(name, "Billing") || strings.Contains(name, "Old draft") {
			t.Fatalf("the viewer's export holds %s", name)
		}
	}
	mineAll := unzip(t, e.Do("GET", "/v1/wiki/export", agent, nil).Want(t, 200).Body)
	if _, ok := mineAll["My notes.md"]; !ok {
		t.Fatalf("the agent's export lacks their own page: %v", keys(mineAll))
	}
	var audits int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'wiki.exported'`, &audits, ws.ID)
	if audits != 3 {
		t.Fatalf("export audits %d", audits)
	}
}

func unzip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
