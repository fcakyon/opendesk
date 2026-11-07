package wikiport

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func cardByID(c *Canvas, id string) *CanvasNode {
	for i := range c.Nodes {
		if c.Nodes[i].ID == id {
			return &c.Nodes[i]
		}
	}
	return nil
}

func edgeIDs(c *Canvas) []string {
	var out []string
	for _, e := range c.Edges {
		out = append(out, e.ID+":"+e.FromNode+"->"+e.ToNode)
	}
	return out
}

func TestObsidianCanvas(t *testing.T) {
	board := `{
	"nodes": [
		{"id": "g1", "type": "group", "x": -40, "y": -40, "width": 900, "height": 500, "label": "  Launch   week ", "background": "attachments/bg.png", "color": "#abc"},
		{"id": "t1", "type": "text", "x": 0, "y": 0, "width": 250, "height": 120, "color": "4", "text": "# Plan\nRead [[Alpha]] and ![[diagram.png]] #launch"},
		{"id": "f1", "type": "file", "x": 300, "y": 0, "width": 400, "height": 300, "file": "Projects/Alpha.md", "subpath": "#Goals"},
		{"id": "f2", "type": "file", "x": 300, "y": 320, "width": 400, "height": 300, "file": "attachments/diagram.png", "color": "purple"},
		{"id": "f3", "type": "file", "x": 0, "y": 320, "width": 250, "height": 60, "file": "attachments/report.pdf"},
		{"id": "f4", "type": "file", "x": 0, "y": 400, "width": 250, "height": 60, "file": "Missing.md"},
		{"id": "f5", "type": "file", "x": 0, "y": 480, "width": 250, "height": 60, "file": "Other.canvas"},
		{"id": "f6", "type": "file", "x": 0, "y": 560, "width": 250, "height": 60, "file": "attachments/run.sh"},
		{"id": "l1", "type": "link", "x": 800, "y": 0, "width": 10, "height": 99999, "url": "https://example.com/brief"},
		{"id": "l2", "type": "link", "x": 800, "y": 200, "width": 250, "height": 60, "url": "http://example.com/old"},
		{"id": "not an id!", "type": "text", "x": 5e9, "y": 0, "width": 250, "height": 60, "text": "far away"},
		{"id": "t1", "type": "text", "x": 0, "y": 700, "width": 250, "height": 60, "text": "same id"},
		{"id": "s1", "type": "sticker", "x": 0, "y": 0, "width": 50, "height": 50}
	],
	"edges": [
		{"id": "e1", "fromNode": "t1", "fromSide": "right", "toNode": "f1", "toSide": "left", "label": "read\nfirst", "color": "2"},
		{"id": "e2", "fromNode": "f1", "toNode": "f2", "fromEnd": "arrow", "toEnd": "none", "fromSide": "middle"},
		{"id": "e3", "fromNode": "t1", "toNode": "s1"},
		{"id": "e4", "fromNode": "t1", "toNode": "nowhere"},
		{"id": "e1", "fromNode": "f2", "toNode": "l1"}
	]
}`
	data := zipBytes(t,
		entry{"Vault/.obsidian/app.json", "{}"},
		entry{"Vault/Projects/Alpha.md", "## Goals\n\nShip it."},
		entry{"Vault/Board.canvas", board},
		entry{"Vault/Other.canvas", `{"nodes":[],"edges":[]}`},
		entry{"Vault/Broken.canvas", `{"nodes": [`},
		entry{"Vault/Plain.canvas", `[1, 2]`},
		entry{"Vault/Home.md", "See [[Board.canvas|the board]] and ![[Other.canvas]]"},
		entry{"Vault/attachments/diagram.png", png},
		entry{"Vault/attachments/report.pdf", "%PDF-1.4 x"},
		entry{"Vault/attachments/run.sh", "#!/bin/sh\necho"},
		entry{"Vault/attachments/bg.png", png},
	)
	res := importOK(t, Options{}, upload("vault.zip", data))
	if got, want := outline(res.Pages, ""), "Vault\n  Board\n  Home\n  Other\n  Projects\n    Alpha\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	boardPage, alpha, other, home := byTitle(t, res, "Board"), byTitle(t, res, "Alpha"), byTitle(t, res, "Other"), byTitle(t, res, "Home")
	c := boardPage.Canvas
	if c == nil || boardPage.BodyHTML != "" || other.Canvas == nil || len(other.Canvas.Nodes) != 0 {
		t.Fatalf("board: %+v %q, other %+v", c, boardPage.BodyHTML, other.Canvas)
	}
	// Unreadable canvases are listed, not made.
	if !hasSkip(res, "Vault/Broken.canvas", "unreadable") || !hasSkip(res, "Vault/Plain.canvas", "unreadable") || !hasSkip(res, "Vault/Board.canvas", "canvas_simplified") {
		t.Errorf("skipped: %+v", res.Skipped)
	}
	if !hasSkip(res, "Vault/attachments/run.sh", "executable") || !hasSkip(res, "Vault/attachments/bg.png", "unused") {
		t.Errorf("skipped: %+v", res.Skipped)
	}

	// Cards: the sticker is gone, the bad and repeated ids are new, the rest kept in order.
	if len(c.Nodes) != 12 {
		t.Fatalf("nodes: %+v", c.Nodes)
	}
	var order []string
	for _, n := range c.Nodes {
		order = append(order, n.Type)
	}
	if want := []string{"group", "text", "page", "file", "file", "text", "page", "text", "link", "text", "text", "text"}; !slices.Equal(order, want) {
		t.Fatalf("types %v, want %v", order, want)
	}
	far, again := c.Nodes[10], c.Nodes[11]
	if !canvasID.MatchString(far.ID) || far.ID == "not an id!" || far.X != maxCanvasCoord || again.ID == "t1" || !canvasID.MatchString(again.ID) {
		t.Errorf("ids and bounds: %+v %+v", far, again)
	}

	g := cardByID(c, "g1")
	if g.Label != "Launch week" || g.Color != "#aabbcc" || g.Width != 900 {
		t.Errorf("group: %+v", g)
	}
	text := cardByID(c, "t1")
	diagram := assetByKey(res, "Vault/attachments/diagram.png")
	if diagram == nil || text.Color != "4" {
		t.Fatalf("diagram %+v, text %+v", diagram, text)
	}
	contains(t, "text card", text.HTML, "<h1", ">Plan</h1>", pageLinkTo(alpha), `<img src="/v1/attachments/`+diagram.Ref+`"`, "#launch")
	if f1 := cardByID(c, "f1"); f1.Type != "page" || f1.PageID != alpha.Ref {
		t.Errorf("note card: %+v", f1)
	}
	if f2 := cardByID(c, "f2"); f2.Type != "file" || f2.Src != "/v1/attachments/"+diagram.Ref || f2.Name != "diagram.png" || f2.Color != "" {
		t.Errorf("image card: %+v", f2)
	}
	report := assetByKey(res, "Vault/attachments/report.pdf")
	if f3 := cardByID(c, "f3"); report == nil || f3.Type != "file" || f3.Src != "/v1/attachments/"+report.Ref {
		t.Errorf("pdf card: %+v", f3)
	}
	if f4 := cardByID(c, "f4"); f4.Type != "text" || f4.HTML != "<p>Missing.md</p>" {
		t.Errorf("missing note: %+v", f4)
	}
	if f5 := cardByID(c, "f5"); f5.Type != "page" || f5.PageID != other.Ref {
		t.Errorf("canvas card: %+v", f5)
	}
	if f6 := cardByID(c, "f6"); f6.Type != "text" {
		t.Errorf("script card: %+v", f6)
	}
	if l1 := cardByID(c, "l1"); l1.Type != "link" || l1.URL != "https://example.com/brief" || l1.Width != minCanvasSize || l1.Height != maxCanvasSize {
		t.Errorf("link card: %+v", l1)
	}
	if l2 := cardByID(c, "l2"); l2.Type != "text" || !strings.Contains(l2.HTML, `href="http://example.com/old"`) {
		t.Errorf("http card: %+v", l2)
	}
	// The canvas links its pages, as a body does.
	if !slices.Equal(boardPage.Links, []string{alpha.Key, other.Key}) {
		t.Errorf("links %v", boardPage.Links)
	}
	contains(t, "home", home.BodyHTML, pageLinkTo(boardPage), ">the board</a>", pageLinkTo(other))

	// Connections: to cards that are there, ids kept unless repeated, sides and ends checked.
	if len(c.Edges) != 3 {
		t.Fatalf("edges %v", edgeIDs(c))
	}
	e1, e2, e5 := c.Edges[0], c.Edges[1], c.Edges[2]
	if e1 != (CanvasEdge{ID: "e1", FromNode: "t1", FromSide: "right", ToNode: "f1", ToSide: "left", Color: "2", Label: "read first"}) {
		t.Errorf("e1 %+v", e1)
	}
	if e2 != (CanvasEdge{ID: "e2", FromNode: "f1", FromEnd: "arrow", ToNode: "f2", ToEnd: "none"}) {
		t.Errorf("e2 %+v", e2)
	}
	if e5.ID == "e1" || e5.FromNode != "f2" || e5.ToNode != "l1" {
		t.Errorf("repeated edge id %+v", e5)
	}

	// Resolve: refs become ids; a card whose ref has none goes with its connections.
	ids := map[string]string{alpha.Ref: uuid.NewString(), other.Ref: uuid.NewString(), diagram.Ref: uuid.NewString()}
	got := res.ResolveCanvas(c, ids)
	if p := cardByID(&got, "f1"); p == nil || p.PageID != ids[alpha.Ref] {
		t.Errorf("resolved page card %+v", p)
	}
	if f := cardByID(&got, "f2"); f == nil || f.Src != "/v1/attachments/"+ids[diagram.Ref] {
		t.Errorf("resolved file card %+v", f)
	}
	if cardByID(&got, "f3") != nil {
		t.Error("a file without an id stayed")
	}
	contains(t, "resolved text", cardByID(&got, "t1").HTML, `data-id="`+ids[alpha.Ref]+`"`, "/v1/attachments/"+ids[diagram.Ref])
	if len(got.Edges) != 3 {
		t.Errorf("resolved edges %v", edgeIDs(&got))
	}
	delete(ids, alpha.Ref)
	got = res.ResolveCanvas(c, ids)
	if cardByID(&got, "f1") != nil || len(got.Edges) != 1 || got.Edges[0].FromNode != "f2" {
		t.Errorf("a page card without an id stayed: %v", edgeIDs(&got))
	}
	if strings.Contains(cardByID(&got, "t1").HTML, alpha.Ref) {
		t.Error("a ref stayed in a text card")
	}
}

func TestCanvasAlone(t *testing.T) {
	// A canvas uploaded alone is a page; what it names is text.
	res := importOK(t, Options{}, upload("Plan.canvas", []byte(`{"nodes":[{"id":"a","type":"file","file":"Notes/Idea.md","x":0,"y":0,"width":200,"height":80},{"id":"b","type":"text","text":"Hi","x":0,"y":100}]}`)))
	if len(res.Pages) != 1 || res.Pages[0].Title != "Plan" || res.Pages[0].Canvas == nil {
		t.Fatalf("pages %+v", res.Pages)
	}
	c := res.Pages[0].Canvas
	if len(c.Nodes) != 2 || c.Nodes[0].Type != "text" || c.Nodes[0].HTML != "<p>Idea.md</p>" || c.Nodes[1].HTML != "<p>Hi</p>" || c.Nodes[1].Width != 250 || len(c.Edges) != 0 {
		t.Errorf("canvas %+v", c)
	}
	// An unreadable canvas alone makes nothing: import_empty, not a failure.
	if _, err := Import([]Upload{upload("Plan.canvas", []byte(`{"nodes": 7}`))}, Options{}); !errors.Is(err, ErrEmpty) {
		t.Errorf("unreadable canvas: %v", err)
	}
}

func TestCanvasLimits(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"nodes":[`)
	for i := range maxCanvasNodes + 5 {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"id":"n` + strings.Repeat("x", i%3) + `","type":"text","text":"a","x":0,"y":0,"width":100,"height":100}`)
	}
	b.WriteString(`],"edges":[{"id":"e","fromNode":"n","toNode":"nx"}]}`)
	res := importOK(t, Options{}, upload("Big.canvas", []byte(b.String())))
	c := res.Pages[0].Canvas
	if len(c.Nodes) != maxCanvasNodes || !hasSkip(res, "Big.canvas", "canvas_trimmed") {
		t.Fatalf("nodes %d, skipped %+v", len(c.Nodes), res.Skipped)
	}
	seen := map[string]bool{}
	for _, n := range c.Nodes {
		if seen[n.ID] || !canvasID.MatchString(n.ID) {
			t.Fatalf("id %q twice or invalid", n.ID)
		}
		seen[n.ID] = true
	}
	// The connection joins the first cards of those ids.
	if len(c.Edges) != 1 || c.Edges[0].FromNode != "n" || c.Edges[0].ToNode != "nx" {
		t.Errorf("edges %+v", c.Edges)
	}
}

func sampleCanvas() ([]ExportPage, map[string][]byte) {
	board, note, sub, pic, gone := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	canvas := &Canvas{
		Nodes: []CanvasNode{
			{ID: "g1", Type: "group", X: -40, Y: -40, Width: 1200, Height: 700, Label: "Launch week", Color: "#aabbcc"},
			{ID: "t1", Type: "text", X: 0, Y: 0, Width: 260, Height: 140, Color: "4",
				HTML: `<p>Read <a data-type="page" data-id="` + note + `" href="/wiki/` + note + `">Notes</a> first <strong>now</strong></p><img src="/v1/attachments/` + pic + `" alt="">`},
			{ID: "p1", Type: "page", PageID: note, X: 300, Y: 0, Width: 400, Height: 300},
			{ID: "p2", Type: "page", PageID: sub, X: 300, Y: 320, Width: 400, Height: 300, Color: "6"},
			{ID: "p3", Type: "page", PageID: gone, X: 720, Y: 320, Width: 200, Height: 100},
			{ID: "f1", Type: "file", Src: "/v1/attachments/" + pic + "?sig=abc", Name: "pic.png", X: 0, Y: 200, Width: 260, Height: 200},
			{ID: "l1", Type: "link", URL: "https://example.com/brief", Title: "Brief", X: 720, Y: 0, Width: 300, Height: 120},
		},
		Edges: []CanvasEdge{
			{ID: "e1", FromNode: "t1", FromSide: "right", ToNode: "p1", ToSide: "left", Label: "explains", Color: "2"},
			{ID: "e2", FromNode: "p1", ToNode: "p2", FromEnd: "arrow", ToEnd: "none"},
			{ID: "e3", FromNode: "f1", ToNode: "l1"},
		},
	}
	return []ExportPage{
		{ID: note, Title: "Notes", Kind: "page", BodyHTML: "<p>The notes</p>"},
		{ID: board, Title: "Board", Kind: "canvas", Canvas: canvas},
		{ID: sub, ParentID: board, Title: "Inside", Kind: "page", BodyHTML: "<p>Under the board</p>"},
	}, map[string][]byte{pic: []byte(png)}
}

func TestExportCanvasRoundTrip(t *testing.T) {
	pages, files := sampleCanvas()
	attach := func(id string) (string, io.ReadCloser, error) {
		data, ok := files[id]
		if !ok {
			return "", nil, errors.New("gone")
		}
		return "pic.png", io.NopCloser(bytes.NewReader(data)), nil
	}
	var buf bytes.Buffer
	if err := ExportZip(&buf, pages, ExportOptions{Format: FormatMarkdown, Frontmatter: true, Attachment: attach}); err != nil {
		t.Fatal(err)
	}
	zipped := readZip(t, buf.Bytes())
	var names []string
	for k := range zipped {
		names = append(names, k)
	}
	slices.Sort(names)
	if want := []string{"Board.canvas", "Board/Inside.md", "Notes.md", "attachments/pic.png"}; !slices.Equal(names, want) {
		t.Fatalf("files %v, want %v", names, want)
	}
	var jc jsonCanvas
	if err := json.Unmarshal([]byte(zipped["Board.canvas"]), &jc); err != nil {
		t.Fatalf("Board.canvas: %v\n%s", err, zipped["Board.canvas"])
	}
	written := map[string]jsonNode{}
	for _, n := range jc.Nodes {
		written[n.ID] = n
	}
	if n := written["t1"]; n.Type != "text" || n.Text == nil || *n.Text != "Read [[Notes]] first **now**\n\n![](attachments/pic.png)" {
		t.Errorf("text node %+v %q", n, deref(n.Text))
	}
	if n := written["p1"]; n.Type != "file" || n.File != "Notes.md" {
		t.Errorf("page node %+v", n)
	}
	if n := written["p2"]; n.Type != "file" || n.File != "Board/Inside.md" || n.Color != "6" {
		t.Errorf("subpage node %+v", n)
	}
	if n := written["p3"]; n.Type != "text" || deref(n.Text) != "" {
		t.Errorf("page left out %+v", n)
	}
	if n := written["f1"]; n.Type != "file" || n.File != "attachments/pic.png" {
		t.Errorf("file node %+v", n)
	}
	if n := written["l1"]; n.Type != "link" || n.URL != "https://example.com/brief" {
		t.Errorf("link node %+v", n)
	}
	if n := written["g1"]; n.Type != "group" || n.Label != "Launch week" || n.X != -40 || n.Width != 1200 {
		t.Errorf("group node %+v", n)
	}
	if len(jc.Edges) != 3 || jc.Edges[0] != (jsonEdge{ID: "e1", FromNode: "t1", FromSide: "right", ToNode: "p1", ToSide: "left", Label: "explains", Color: "2"}) {
		t.Errorf("edges %+v", jc.Edges)
	}

	// And back: the same cards, connections and links.
	res := importOK(t, Options{}, upload("export.zip", buf.Bytes()))
	if got, want := outline(res.Pages, ""), "Board\n  Inside\nNotes\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	board, notes, inside := byTitle(t, res, "Board"), byTitle(t, res, "Notes"), byTitle(t, res, "Inside")
	pic := assetByKey(res, "attachments/pic.png")
	if board.Canvas == nil || pic == nil {
		t.Fatalf("board %+v, pic %+v", board.Canvas, pic)
	}
	want := pages[1].Canvas
	back := board.Canvas
	if len(back.Nodes) != len(want.Nodes) {
		t.Fatalf("nodes %+v", back.Nodes)
	}
	for i, w := range want.Nodes {
		g := back.Nodes[i]
		if g.ID != w.ID || g.X != w.X || g.Y != w.Y || g.Width != w.Width || g.Height != w.Height || g.Color != w.Color {
			t.Errorf("node %d: %+v, want %+v", i, g, w)
		}
	}
	if !slices.Equal(back.Edges, want.Edges) {
		t.Errorf("edges %+v\nwant %+v", back.Edges, want.Edges)
	}
	types := []string{}
	for _, n := range back.Nodes {
		types = append(types, n.Type)
	}
	if !slices.Equal(types, []string{"group", "text", "page", "page", "text", "file", "link"}) {
		t.Errorf("types %v", types)
	}
	if p := cardByID(back, "p1"); p.PageID != notes.Ref {
		t.Errorf("p1 %+v", p)
	}
	if p := cardByID(back, "p2"); p.PageID != inside.Ref {
		t.Errorf("p2 %+v", p)
	}
	if f := cardByID(back, "f1"); f.Src != "/v1/attachments/"+pic.Ref || f.Name != "pic.png" {
		t.Errorf("f1 %+v", f)
	}
	if l := cardByID(back, "l1"); l.URL != "https://example.com/brief" {
		t.Errorf("l1 %+v", l)
	}
	if g := cardByID(back, "g1"); g.Label != "Launch week" {
		t.Errorf("g1 %+v", g)
	}
	contains(t, "t1", cardByID(back, "t1").HTML, pageLinkTo(notes), "<strong>now</strong>", `<img src="/v1/attachments/`+pic.Ref+`"`)
	if !slices.Contains(board.Links, notes.Key) || !slices.Contains(board.Links, inside.Key) {
		t.Errorf("links %v", board.Links)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("skipped %+v", res.Skipped)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestExportCanvasHTML(t *testing.T) {
	pages, files := sampleCanvas()
	var buf bytes.Buffer
	err := ExportZip(&buf, pages, ExportOptions{Format: FormatHTML, BaseURL: "https://app.example.com", Attachment: func(id string) (string, io.ReadCloser, error) {
		return "pic.png", io.NopCloser(bytes.NewReader(files[id])), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	zipped := readZip(t, buf.Bytes())
	page := zipped["Board.html"]
	contains(t, "Board.html", page, `<div class="canvas" style="width:1280px;height:780px">`,
		`<div class="card group" style="left:40px;top:40px;width:1200px;height:700px;--tone:#aabbcc"><div class="group-label">Launch week</div></div>`,
		`<div class="card text" style="left:80px;top:80px;width:260px;height:140px;--tone:#22c55e"><p>Read <a href="Notes.html">Notes</a> first <strong>now</strong></p>`,
		`<a href="Board/Inside.html">Inside</a>`, `<a href="https://app.example.com/wiki/`, "A page not in this export",
		`<img src="attachments/pic.png" alt="pic.png">`, `<a href="https://example.com/brief">Brief</a>`,
		`<line x1="340" y1="150" x2="380" y2="230" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>`,
		`marker-start="url(#arrow)"/>`, `class="edge-label">explains</text>`)
	lacks(t, "Board.html", page, "/v1/attachments", "sig=abc", "data-type=\"page\"")

	// One canvas alone: Markdown is its JSON Canvas file, pages and files linked to the app.
	var one bytes.Buffer
	if err := ExportFile(&one, pages[1], ExportOptions{Format: FormatMarkdown, BaseURL: "https://app.example.com"}); err != nil {
		t.Fatal(err)
	}
	if ExportFileName(pages[1], FormatMarkdown) != "Board.canvas" || ExportFileName(pages[1], FormatHTML) != "Board.html" {
		t.Error("canvas file names")
	}
	var jc jsonCanvas
	if err := json.Unmarshal(one.Bytes(), &jc); err != nil || len(jc.Nodes) != 7 {
		t.Fatalf("single canvas: %v %s", err, one.String())
	}
	contains(t, "single", one.String(), `"url": "https://app.example.com/wiki/`, `"url": "https://app.example.com/v1/attachments/`, "[Notes](https://app.example.com/wiki/")
	lacks(t, "single", one.String(), "sig=abc", `"file"`)
}
