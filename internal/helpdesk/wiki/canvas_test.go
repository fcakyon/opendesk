package wiki_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type canvasPage struct {
	spaced
	Kind   string       `json:"kind"`
	Canvas *wiki.Canvas `json:"canvas"`
	Tags   []string     `json:"tags"`
}

func card(id, typ string, extra map[string]any) map[string]any {
	n := map[string]any{"id": id, "type": typ, "x": 0, "y": 0, "width": 240, "height": 120}
	for k, v := range extra {
		n[k] = v
	}
	return n
}

func TestCanvas(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer, admin := ws.Agent.As(ws), ws.Viewer.As(ws), ws.Admin.As(ws)

	// A new canvas is empty; a page is not a canvas.
	var cv canvasPage
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Launch plan", "kind": "canvas"}).Want(t, 201).JSON(t, &cv)
	if cv.Kind != "canvas" || cv.Canvas == nil || len(cv.Canvas.Nodes) != 0 || len(cv.Canvas.Edges) != 0 {
		t.Fatalf("new canvas %+v", cv.Canvas)
	}
	plain := create(t, e, agent, map[string]any{"title": "Refund policy"})
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "x", "canvas": map[string]any{"nodes": []any{}, "edges": []any{}}}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+plain.ID, agent, map[string]any{"canvas": map[string]any{"nodes": []any{}, "edges": []any{}}}).Want(t, 422)

	// Cards of every type, connected; text is sanitized, the defaults are left out.
	file := uuid.New()
	e.Exec(`INSERT INTO attachments (id, workspace_id, filename, size_bytes, storage_key) VALUES ($1, $2, 'plan.pdf', 10, 'k')`, file, ws.ID)
	full := map[string]any{
		"nodes": []any{
			card("t1", "text", map[string]any{"html": `<p>Ship the #launch on Friday<script>alert(1)</script></p>`, "color": "4"}),
			card("p1", "page", map[string]any{"page_id": plain.ID, "x": 400}),
			card("l1", "link", map[string]any{"url": "https://example.com/brief", "title": "Brief", "image": "https://example.com/i.png"}),
			card("f1", "file", map[string]any{"src": "/v1/attachments/" + file.String(), "name": "plan.pdf"}),
			card("g1", "group", map[string]any{"label": "  Week   one ", "width": 900, "height": 600, "x": -20, "y": -20, "color": "#aabbcc"}),
		},
		"edges": []any{
			map[string]any{"id": "e1", "fromNode": "t1", "fromSide": "right", "toNode": "p1", "toSide": "left", "toEnd": "arrow", "label": "explains"},
		},
	}
	_, seq := e.Events(ws.ID, 0)
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": full}).Want(t, 200).JSON(t, &cv)
	if len(cv.Canvas.Nodes) != 5 || len(cv.Canvas.Edges) != 1 || cv.Version != 1 {
		t.Fatalf("canvas %+v v%d", cv.Canvas, cv.Version)
	}
	if h := cv.Canvas.Nodes[0].HTML; strings.Contains(h, "script") || !strings.Contains(h, "Ship the") {
		t.Fatalf("text not sanitized: %s", h)
	}
	if cv.Canvas.Nodes[4].Label != "Week one" || cv.Canvas.Edges[0].ToEnd != "" {
		t.Fatalf("not normalized %+v %+v", cv.Canvas.Nodes[4], cv.Canvas.Edges[0])
	}
	if !slices.Contains(cv.Tags, "launch") {
		t.Fatalf("tags %v", cv.Tags)
	}
	var data string
	e.Scalar(`SELECT data::text FROM events WHERE workspace_id = $1 AND seq > $2 AND type = 'wiki_page.updated' ORDER BY seq LIMIT 1`, &data, ws.ID, seq)
	var ev struct {
		Canvas *wiki.Canvas `json:"canvas"`
	}
	if err := json.Unmarshal([]byte(data), &ev); err != nil || ev.Canvas == nil || len(ev.Canvas.Nodes) != 5 {
		t.Fatalf("event %s", data)
	}
	// The same canvas again changes nothing and says nothing.
	_, seq = e.Events(ws.ID, 0)
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": full}).Want(t, 200)
	if evs, _ := e.Events(ws.ID, seq); len(evs) != 0 {
		t.Fatalf("no-op saved %d events", len(evs))
	}

	// A page card is a link: a backlink, and in the graph. Its words are searched.
	if got := ids(mentions(t, e, viewer, "/v1/wiki/pages/"+plain.ID+"/backlinks")); !slices.Contains(got, cv.ID) {
		t.Fatalf("backlinks %v", got)
	}
	var graph struct{ Data []struct{ From, To string } }
	e.Do("GET", "/v1/wiki/graph", viewer, nil).Want(t, 200).JSON(t, &graph)
	if !slices.ContainsFunc(graph.Data, func(l struct{ From, To string }) bool { return l.From == cv.ID && l.To == plain.ID }) {
		t.Fatalf("graph %+v", graph.Data)
	}
	var found struct {
		Data []struct {
			ID      string `json:"id"`
			Snippet string `json:"snippet"`
		}
	}
	e.Do("GET", "/v1/wiki/search?q=explains", viewer, nil).Want(t, 200).JSON(t, &found)
	if len(found.Data) != 1 || found.Data[0].ID != cv.ID || !strings.Contains(found.Data[0].Snippet, "explains") {
		t.Fatalf("search %+v", found.Data)
	}

	// Wrong shapes are invalid_canvas.
	big := make([]any, 2001)
	for i := range big {
		big[i] = card(fmt.Sprintf("n%d", i), "group", nil)
	}
	bad := []map[string]any{
		{"nodes": []any{card("a b", "text", nil)}},
		{"nodes": []any{card("a", "text", nil), card("a", "text", nil)}},
		{"nodes": []any{card("a", "text", map[string]any{"x": 2e6})}},
		{"nodes": []any{card("a", "text", map[string]any{"width": 10})}},
		{"nodes": []any{card("a", "text", map[string]any{"color": "7"})}},
		{"nodes": []any{card("a", "shape", nil)}},
		{"nodes": []any{card("a", "page", nil)}},
		{"nodes": []any{card("a", "page", map[string]any{"page_id": uuid.NewString()})}},
		{"nodes": []any{card("a", "link", map[string]any{"url": "http://example.com"})}},
		{"nodes": []any{card("a", "link", map[string]any{"url": "javascript:alert(1)"})}},
		{"nodes": []any{card("a", "file", map[string]any{"src": "/v1/attachments/" + uuid.NewString(), "name": "x"})}},
		{"nodes": []any{card("a", "file", map[string]any{"src": "data:text/html,x", "name": "x"})}},
		{"nodes": []any{card("a", "group", map[string]any{"label": strings.Repeat("x", 201)})}},
		{"nodes": []any{card("a", "text", nil)}, "edges": []any{map[string]any{"id": "e", "fromNode": "a", "toNode": "zz"}}},
		{"nodes": []any{card("a", "text", nil)}, "edges": []any{map[string]any{"id": "e", "fromNode": "a", "toNode": "a", "fromSide": "middle"}}},
		{"nodes": []any{card("a", "text", nil)}, "edges": []any{map[string]any{"id": "e", "fromNode": "a", "toNode": "a", "toEnd": "diamond"}}},
		{"nodes": big},
		{"nodes": "nope"},
	}
	for i, b := range bad {
		r := e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": b})
		if r.Status != 422 || (i != len(bad)-1 && !strings.Contains(string(r.Body), "invalid_canvas")) {
			t.Fatalf("bad canvas %d: %d %s", i, r.Status, r.Body)
		}
	}
	other := e.NewWorkspace()
	foreign := create(t, e, other.Agent.As(other), map[string]any{"title": "Theirs"})
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": map[string]any{"nodes": []any{card("a", "page", map[string]any{"page_id": foreign.ID})}}}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, viewer, map[string]any{"canvas": full}).Want(t, 403)

	// Someone else's private page can't be put on a canvas; a card already there stays
	// when they save, and they read the canvas without learning its title.
	secret := create(t, e, admin, map[string]any{"title": "Admin's notes", "space": "private"})
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": map[string]any{"nodes": []any{card("s", "page", map[string]any{"page_id": secret.ID})}}}).Want(t, 422)
	withSecret := map[string]any{"nodes": []any{card("s", "page", map[string]any{"page_id": secret.ID})}}
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, admin, map[string]any{"canvas": withSecret}).Want(t, 200)
	withSecret["nodes"] = append(withSecret["nodes"].([]any), card("t", "text", map[string]any{"html": "<p>hi</p>"}))
	var saved canvasPage
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": withSecret}).Want(t, 200).JSON(t, &saved)
	if len(saved.Canvas.Nodes) != 2 || strings.Contains(string(e.Do("GET", "/v1/wiki/pages/"+cv.ID, viewer, nil).Want(t, 200).Body), "Admin's notes") {
		t.Fatal("a card for a page out of sight")
	}
	// A private canvas is its member's alone.
	mine := create(t, e, agent, map[string]any{"title": "Scratch", "kind": "canvas", "space": "private"})
	e.Do("GET", "/v1/wiki/pages/"+mine.ID, admin, nil).Want(t, 404)
	e.Do("PATCH", "/v1/wiki/pages/"+mine.ID, admin, map[string]any{"canvas": full}).Want(t, 404)

	// Duplicate: the cards come along, pointing at the copies of pages copied with it.
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": full}).Want(t, 200)
	sub := create(t, e, agent, map[string]any{"title": "Inside", "parent_id": cv.ID})
	full["nodes"] = append(full["nodes"].([]any), card("p2", "page", map[string]any{"page_id": sub.ID}))
	e.Do("PATCH", "/v1/wiki/pages/"+cv.ID, agent, map[string]any{"canvas": full}).Want(t, 200)
	var copied canvasPage
	e.Do("POST", "/v1/wiki/pages/"+cv.ID+"/duplicate", agent, map[string]any{"title": "Launch plan copy"}).Want(t, 201).JSON(t, &copied)
	if copied.Kind != "canvas" || copied.Canvas == nil || len(copied.Canvas.Nodes) != 6 || len(copied.Children) != 1 {
		t.Fatalf("copy %+v", copied)
	}
	if got := copied.Canvas.Nodes[5].PageID.String(); got != copied.Children[0].ID {
		t.Fatalf("copied page card points at %s, not the copy %s", got, copied.Children[0].ID)
	}
	if got := ids(mentions(t, e, viewer, "/v1/wiki/pages/"+plain.ID+"/backlinks")); !slices.Contains(got, copied.ID) {
		t.Fatalf("copy's backlinks %v", got)
	}

	// Trash: out of search, not editable; restore brings it back.
	e.Do("POST", "/v1/wiki/pages/"+copied.ID+"/trash", agent, nil).Want(t, 200)
	e.Do("PATCH", "/v1/wiki/pages/"+copied.ID, agent, map[string]any{"canvas": full}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages/"+copied.ID+"/restore", agent, nil).Want(t, 200)

	// Export as JSON Canvas: Markdown text, page cards as the files of the pages exported with
	// it; one left out is a link to the app or an empty text card.
	files := unzip(t, e.Do("GET", "/v1/wiki/pages/"+cv.ID+"/export?subpages=true", viewer, nil).Want(t, 200).Body)
	var jc struct {
		Nodes []map[string]any `json:"nodes"`
		Edges []map[string]any `json:"edges"`
	}
	if err := json.Unmarshal([]byte(files["Launch plan.canvas"]), &jc); err != nil {
		t.Fatalf("Launch plan.canvas in %v: %v", keys(files), err)
	}
	nodes := map[string]map[string]any{}
	for _, n := range jc.Nodes {
		nodes[n["id"].(string)] = n
	}
	if nodes["t1"]["text"] != "Ship the #launch on Friday" || nodes["p2"]["type"] != "file" || nodes["p2"]["file"] != "Launch plan/Inside.md" ||
		nodes["p1"]["type"] == "file" || nodes["g1"]["label"] != "Week one" || nodes["g1"]["color"] != "#aabbcc" || len(jc.Edges) != 1 || jc.Edges[0]["toNode"] != "p1" {
		t.Fatalf("json canvas %s", files["Launch plan.canvas"])
	}
	if _, ok := files["Launch plan/Inside.md"]; !ok {
		t.Fatalf("files %v", keys(files))
	}
	r := e.Do("GET", "/v1/wiki/pages/"+cv.ID+"/export", viewer, nil).Want(t, 200)
	if r.Header.Get("Content-Type") != "application/json; charset=utf-8" || r.Header.Get("Content-Disposition") != `attachment; filename="Launch plan.canvas"` {
		t.Fatalf("single canvas: %v", r.Header)
	}
	r = e.Do("GET", "/v1/wiki/pages/"+cv.ID+"/export?format=html", viewer, nil).Want(t, 200)
	if s := string(r.Body); !strings.Contains(s, `<div class="canvas"`) || !strings.Contains(s, "Ship the #launch on Friday") || !strings.Contains(s, "<line ") {
		t.Fatalf("html canvas: %s", s)
	}
}

func TestImportCanvas(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	board := `{"nodes": [
		{"id": "t1", "type": "text", "text": "Read [[Alpha]] #launch", "x": 0, "y": 0, "width": 250, "height": 120},
		{"id": "p1", "type": "file", "file": "Alpha.md", "x": 300, "y": 0, "width": 400, "height": 300},
		{"id": "i1", "type": "file", "file": "attachments/diagram.png", "x": 0, "y": 200, "width": 300, "height": 200, "color": "5"},
		{"id": "x1", "type": "file", "file": "attachments/fake.png", "x": 0, "y": 500, "width": 300, "height": 200}
	], "edges": [
		{"id": "e1", "fromNode": "t1", "toNode": "p1", "label": "see"},
		{"id": "e2", "fromNode": "i1", "toNode": "x1"}
	]}`
	vault := zipOf(t,
		portFile{"Vault/.obsidian/app.json", "{}"},
		portFile{"Vault/Alpha.md", "Alpha's text"},
		portFile{"Vault/Board.canvas", board},
		portFile{"Vault/Broken.canvas", `{"nodes": [`},
		portFile{"Vault/attachments/diagram.png", pngBytes},
		portFile{"Vault/attachments/fake.png", "MZ\x90\x00 a program dressed as a picture"},
	)
	out := importOK(t, e, agent, nil, portFile{"vault.zip", string(vault)})
	if out.Pages != 3 || !out.skipped("Vault/Broken.canvas", "unreadable") || !out.skipped("Vault/attachments/fake.png", "executable") ||
		!out.skipped("Vault/Board.canvas", "canvas_simplified") {
		t.Fatalf("import: %+v", out)
	}
	nodes := tree(t, e, viewer)
	boardID, alphaID := idOf(t, nodes, "Board"), idOf(t, nodes, "Alpha")

	// A canvas page: its cards point at the pages and files made with it.
	var cv canvasPage
	e.Do("GET", "/v1/wiki/pages/"+boardID, viewer, nil).Want(t, 200).JSON(t, &cv)
	if cv.Kind != "canvas" || cv.Canvas == nil || len(cv.Canvas.Nodes) != 4 || len(cv.Canvas.Edges) != 2 {
		t.Fatalf("canvas %+v", cv.Canvas)
	}
	c := cv.Canvas
	if !strings.Contains(c.Nodes[0].HTML, `data-id="`+alphaID+`"`) || c.Nodes[1].Type != "page" || c.Nodes[1].PageID == nil || c.Nodes[1].PageID.String() != alphaID {
		t.Fatalf("cards %+v", c.Nodes[:2])
	}
	var fileID uuid.UUID
	var holder *uuid.UUID
	e.Scalar(`SELECT id FROM attachments WHERE workspace_id = $1 AND imported`, &fileID, ws.ID)
	e.Scalar(`SELECT wiki_page_id FROM attachments WHERE id = $1`, &holder, fileID)
	if c.Nodes[2].Type != "file" || !strings.Contains(c.Nodes[2].Src, "/v1/attachments/"+fileID.String()) || c.Nodes[2].Name != "diagram.png" || c.Nodes[2].Color != "5" {
		t.Fatalf("file card %+v", c.Nodes[2])
	}
	if holder == nil || holder.String() != boardID {
		t.Fatalf("the picture is not the canvas's own file: %v", holder)
	}
	if c.Nodes[3].Type != "text" || !strings.Contains(c.Nodes[3].HTML, "fake.png") || c.Edges[0].Label != "see" {
		t.Fatalf("refused file %+v, edges %+v", c.Nodes[3], c.Edges)
	}
	// Its cards count as its text: links and tags.
	if !slices.Contains(cv.Tags, "launch") {
		t.Fatalf("tags %v", cv.Tags)
	}
	if got := ids(mentions(t, e, viewer, "/v1/wiki/pages/"+alphaID+"/backlinks")); !slices.Contains(got, boardID) {
		t.Fatalf("Alpha's backlinks %v", got)
	}

	// A canvas uploaded alone, unreadable: nothing to import, said plainly.
	importFiles(t, e, agent, nil, portFile{"Board.canvas", "not json"}).Want(t, 422)
}
