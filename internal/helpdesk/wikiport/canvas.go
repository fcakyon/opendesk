package wikiport

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"golang.org/x/net/html"

	"github.com/useopendesk/opendesk/internal/helpdesk/wikiconv"
)

// Canvases (contracts/wiki.md "Canvas"): an Obsidian canvas, a JSON Canvas 1.0 file
// (https://jsoncanvas.org), is imported as a canvas page and a canvas page is exported as one.

// Canvas is a canvas page's cards and connections as the wiki stores them: its JSON is what
// the wiki's POST and PATCH take as `canvas`. In an import, a page card's PageID and a file
// card's Src hold refs (see "Placeholders"); Result.ResolveCanvas puts the ids in.
type Canvas struct {
	Nodes []CanvasNode `json:"nodes"`
	Edges []CanvasEdge `json:"edges"`
}

// CanvasNode is a card: text, page, link, file or group.
type CanvasNode struct {
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Width       float64 `json:"width"`
	Height      float64 `json:"height"`
	Color       string  `json:"color,omitempty"`
	HTML        string  `json:"html,omitempty"`
	PageID      string  `json:"page_id,omitempty"`
	URL         string  `json:"url,omitempty"`
	Title       string  `json:"title,omitempty"`
	Description string  `json:"description,omitempty"`
	Image       string  `json:"image,omitempty"`
	Src         string  `json:"src,omitempty"`
	Name        string  `json:"name,omitempty"`
	Label       string  `json:"label,omitempty"`
}

// CanvasEdge is a connection between two cards.
type CanvasEdge struct {
	ID       string `json:"id"`
	FromNode string `json:"fromNode"`
	FromSide string `json:"fromSide,omitempty"`
	FromEnd  string `json:"fromEnd,omitempty"`
	ToNode   string `json:"toNode"`
	ToSide   string `json:"toSide,omitempty"`
	ToEnd    string `json:"toEnd,omitempty"`
	Color    string `json:"color,omitempty"`
	Label    string `json:"label,omitempty"`
}

// A canvas's bounds, as the wiki checks them.
const (
	maxCanvasBytes = 1 << 20
	maxCanvasNodes = 2000
	maxCanvasEdges = 4000
	maxCanvasCoord = 1e6
	minCanvasSize  = 20
	maxCanvasSize  = 20000
	maxCanvasLabel = 200
	maxCanvasURL   = 2000
)

var (
	canvasID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	canvasColor = regexp.MustCompile(`^(?:[1-6]|#[0-9a-fA-F]{6})$`)
	shortHex    = regexp.MustCompile(`^#[0-9a-fA-F]{3}$`)
	canvasSides = []string{"top", "right", "bottom", "left"}
)

// jsonCanvas is a JSON Canvas 1.0 file, read and written.
type jsonCanvas struct {
	Nodes []jsonNode `json:"nodes"`
	Edges []jsonEdge `json:"edges"`
}

type jsonNode struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
	Color      string  `json:"color,omitempty"`
	Text       *string `json:"text,omitempty"`
	File       string  `json:"file,omitempty"`
	Subpath    string  `json:"subpath,omitempty"`
	URL        string  `json:"url,omitempty"`
	Label      string  `json:"label,omitempty"`
	Background string  `json:"background,omitempty"`
}

type jsonEdge struct {
	ID       string `json:"id"`
	FromNode string `json:"fromNode"`
	FromSide string `json:"fromSide,omitempty"`
	FromEnd  string `json:"fromEnd,omitempty"`
	ToNode   string `json:"toNode"`
	ToSide   string `json:"toSide,omitempty"`
	ToEnd    string `json:"toEnd,omitempty"`
	Color    string `json:"color,omitempty"`
	Label    string `json:"label,omitempty"`
}

var errNotCanvas = errors.New("not a canvas")

// readCanvas reads a .canvas file: a JSON object with nodes and edges.
func readCanvas(data []byte) (*jsonCanvas, error) {
	text := bytes.TrimSpace([]byte(decodeText(data)))
	if len(text) == 0 || text[0] != '{' {
		return nil, errNotCanvas
	}
	var c jsonCanvas
	if err := json.Unmarshal(text, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// --- import -----------------------------------------------------------------------------

// convertCanvas makes a canvas page's cards from its file. Text is Markdown read as a note's;
// a file naming a note of the upload is a page card, a file of the upload a file card, a link
// a link card. What the wiki can't keep as it was (a heading of a note, an http link, a file
// not in the upload, a group's background, a node of an unknown type) is simplified and the
// page listed once as canvas_simplified; cards past the canvas's limits as canvas_trimmed.
func (imp *importer) convertCanvas(n *node) {
	d := &doc{imp: imp, node: n, dir: path.Dir(n.src.path)}
	src := n.jc
	out := &Canvas{Nodes: []CanvasNode{}, Edges: []CanvasEdge{}}
	simplified, trimmed := false, false

	// Ids the wiki takes are kept; another, or a repeated one, gets a new id.
	used := map[string]bool{}
	for _, s := range src.Nodes {
		if canvasID.MatchString(s.ID) {
			used[s.ID] = true
		}
	}
	for _, s := range src.Edges {
		if canvasID.MatchString(s.ID) {
			used[s.ID] = true
		}
	}
	taken := map[string]bool{}
	idOf := map[string]string{}
	for _, s := range src.Nodes {
		if len(out.Nodes) == maxCanvasNodes {
			trimmed = true
			break
		}
		card, ok := d.canvasCard(s, &simplified)
		if !ok {
			simplified = true
			continue
		}
		id := s.ID
		if !canvasID.MatchString(id) || taken[id] {
			id = freshID(used)
		}
		taken[id] = true
		if _, seen := idOf[s.ID]; !seen {
			idOf[s.ID] = id
		}
		card.ID = id
		out.Nodes = append(out.Nodes, card)
	}
	taken = map[string]bool{}
	for _, s := range src.Edges {
		from, okFrom := idOf[s.FromNode]
		to, okTo := idOf[s.ToNode]
		if !okFrom || !okTo {
			continue // a connection to a card that isn't there
		}
		if len(out.Edges) == maxCanvasEdges {
			trimmed = true
			break
		}
		id := s.ID
		if !canvasID.MatchString(id) || taken[id] {
			id = freshID(used)
		}
		taken[id] = true
		e := CanvasEdge{ID: id, FromNode: from, ToNode: to, Color: mapColor(s.Color), Label: cleanLabel(s.Label)}
		if slices.Contains(canvasSides, s.FromSide) {
			e.FromSide = s.FromSide
		}
		if slices.Contains(canvasSides, s.ToSide) {
			e.ToSide = s.ToSide
		}
		// The defaults (no arrow at the start, an arrow at the end) are left out.
		if s.FromEnd == "arrow" {
			e.FromEnd = "arrow"
		}
		if s.ToEnd == "none" {
			e.ToEnd = "none"
		}
		out.Edges = append(out.Edges, e)
	}
	if simplified {
		imp.skip(n.Key, "canvas_simplified")
	}
	if trimmed {
		imp.skip(n.Key, "canvas_trimmed")
	}
	if raw, err := json.Marshal(out); err != nil || len(raw) > maxCanvasBytes {
		imp.skip(n.Key, "body_too_large")
		out = &Canvas{Nodes: []CanvasNode{}, Edges: []CanvasEdge{}}
	}
	n.Canvas = out
}

// canvasCard is a JSON Canvas node as a card, without its id; false for a node of a type the
// wiki doesn't know.
func (d *doc) canvasCard(s jsonNode, simplified *bool) (CanvasNode, bool) {
	card := CanvasNode{
		X: clampCoord(s.X), Y: clampCoord(s.Y),
		Width: clampSize(s.Width), Height: clampSize(s.Height),
		Color: mapColor(s.Color),
	}
	switch s.Type {
	case "text":
		card.Type = "text"
		if s.Text != nil {
			card.HTML = d.canvasText(*s.Text)
		}
	case "file":
		d.canvasFile(&card, s, simplified)
	case "link":
		u := strings.TrimSpace(s.URL)
		if parsed, err := url.Parse(u); err == nil && strings.EqualFold(parsed.Scheme, "https") && parsed.Host != "" &&
			len(u) <= maxCanvasURL && !strings.ContainsAny(u, " \t\r\n\"'<>") {
			card.Type, card.URL = "link", u
			break
		}
		// An http address, or one the wiki can't keep as a card, stays as text.
		*simplified = true
		card.Type = "text"
		card.HTML = sanitize(`<p><a href="` + html.EscapeString(u) + `">` + html.EscapeString(u) + `</a></p>`)
	case "group":
		card.Type, card.Label = "group", cleanLabel(s.Label)
		if s.Background != "" {
			*simplified = true // a picture behind a group isn't kept
		}
	default:
		return CanvasNode{}, false
	}
	return card, true
}

// canvasText is a text node's Markdown as wiki HTML, its links and files resolved as a note's.
func (d *doc) canvasText(md string) string {
	if strings.TrimSpace(md) == "" {
		return ""
	}
	root := parseFragment(markdownToHTML(md, mdOptions{breaks: true}))
	d.normalize(root)
	return sanitize(renderChildren(root))
}

// canvasFile makes a file node a page card (a note or canvas of the upload) or a file card
// (any other file of it). A file that isn't in the upload, or that isn't taken (a program,
// too large), is a text card with its name.
func (d *doc) canvasFile(card *CanvasNode, s jsonNode, simplified *bool) {
	target := strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(s.File), `\`, "/"), "/")
	asText := func() {
		*simplified = true
		card.Type = "text"
		if target != "" {
			card.HTML = sanitize("<p>" + html.EscapeString(path.Base(target)) + "</p>")
		}
	}
	if target == "" {
		asText()
		return
	}
	if sourceKind(target) != "" {
		t := d.imp.vaultPage(target, d)
		if t == nil {
			asText()
			return
		}
		if strings.TrimSpace(s.Subpath) != "" {
			*simplified = true // a card shows a whole page, not a heading of it
		}
		card.Type, card.PageID = "page", t.Ref
		if t != d.node && !slices.Contains(d.node.Links, t.Key) {
			d.node.Links = append(d.node.Links, t.Key)
		}
		return
	}
	f := d.imp.vaultFile(target, d)
	var a *Asset
	if f != nil {
		a = d.imp.asset(f)
	}
	if a == nil {
		asText()
		return
	}
	card.Type, card.Src, card.Name = "file", attachmentURL(a.Ref), truncateRunes(a.Name, 255)
}

// vaultPage is the page a canvas's file path names. JSON Canvas paths start at the vault's
// top, which may be a folder of the upload: the canvas's own folder and each above it are
// tried, then the name alone, as a [[link]] finds it.
func (imp *importer) vaultPage(target string, d *doc) *node {
	for dir := d.dir; ; dir = path.Dir(dir) {
		if t := imp.pageAt(path.Join(dir, target)); t != nil {
			return t
		}
		if dir == "." || dir == "/" {
			break
		}
	}
	t, _ := imp.wikiTarget(path.Base(target), d)
	return t
}

// vaultFile is the file a canvas's file path names, found as vaultPage finds a page.
func (imp *importer) vaultFile(target string, d *doc) *file {
	for dir := d.dir; ; dir = path.Dir(dir) {
		if f := imp.fileAt(path.Join(dir, target)); f != nil {
			return f
		}
		if dir == "." || dir == "/" {
			break
		}
	}
	return pickNearest(imp.assetBase[strings.ToLower(path.Base(target))], d.dir, func(f *file) string { return f.path })
}

func freshID(used map[string]bool) string {
	for {
		id := strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
		if !used[id] {
			used[id] = true
			return id
		}
	}
}

// mapColor is a JSON Canvas colour as the wiki keeps one: a preset "1" to "6" (red, orange,
// yellow, green, cyan, purple: the app's tones) or #rrggbb; #rgb is written out; anything
// else is left out.
func mapColor(c string) string {
	c = strings.TrimSpace(c)
	if shortHex.MatchString(c) {
		c = "#" + strings.Repeat(c[1:2], 2) + strings.Repeat(c[2:3], 2) + strings.Repeat(c[3:4], 2)
	}
	if canvasColor.MatchString(c) {
		return c
	}
	return ""
}

func cleanLabel(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return truncateRunes(strings.Join(strings.Fields(s), " "), maxCanvasLabel)
}

func clampCoord(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(max(-maxCanvasCoord, min(maxCanvasCoord, v)))
}

func clampSize(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v == 0 {
		return 250 // a node without a size
	}
	return math.Round(max(minCanvasSize, min(maxCanvasSize, v)))
}

// ResolveCanvas puts ids in place of refs on a canvas of this result, as Resolve does in a
// body: text cards are resolved as bodies, and a page or file card whose ref has no id (or
// that names no page or file of this import) is taken off with its connections.
func (r *Result) ResolveCanvas(c *Canvas, ids map[string]string) Canvas {
	out := Canvas{Nodes: make([]CanvasNode, 0, len(c.Nodes)), Edges: make([]CanvasEdge, 0, len(c.Edges))}
	kept := map[string]bool{}
	resolve := func(ref string) (string, bool) {
		ref = strings.ToLower(ref)
		id, ok := ids[ref]
		return strings.ToLower(id), ok && r.refs[ref] && uuidLike(id)
	}
	for _, n := range c.Nodes {
		switch n.Type {
		case "text":
			n.HTML = r.Resolve(n.HTML, ids)
		case "page":
			id, ok := resolve(n.PageID)
			if !ok {
				continue
			}
			n.PageID = id
		case "file":
			if !strings.HasPrefix(strings.ToLower(n.Src), "https://") {
				id, ok := resolve(refIn(n.Src))
				if !ok || !strings.HasPrefix(n.Src, "/v1/attachments/") {
					continue
				}
				n.Src = attachmentURL(id)
			}
		}
		kept[n.ID] = true
		out.Nodes = append(out.Nodes, n)
	}
	for _, e := range c.Edges {
		if kept[e.FromNode] && kept[e.ToNode] {
			out.Edges = append(out.Edges, e)
		}
	}
	return out
}

// --- export -----------------------------------------------------------------------------

// canvasJSON is a canvas page as a JSON Canvas file: text cards in Markdown, page cards as
// file nodes naming the exported pages, files the export carries as file nodes, https files
// as links. A page or file it doesn't carry is a link to the app (BaseURL), else text.
func (e *exporter) canvasJSON(p *exportPage, dir string) (string, error) {
	out := jsonCanvas{Nodes: []jsonNode{}, Edges: []jsonEdge{}}
	md := wikiconv.MarkdownOptions{PageLink: e.pageLink}
	text := func(s string) *string { return &s }
	base := strings.TrimRight(e.opt.BaseURL, "/")
	for _, n := range p.Canvas.Nodes {
		j := jsonNode{ID: n.ID, Type: n.Type, X: math.Round(n.X), Y: math.Round(n.Y), Width: math.Round(n.Width), Height: math.Round(n.Height), Color: n.Color}
		switch n.Type {
		case "text":
			j.Text = text(strings.TrimSpace(wikiconv.Markdown(e.prepare(n.HTML, dir), md)))
		case "page":
			switch t := e.byID[n.PageID]; {
			case t != nil:
				j.Type, j.File = "file", t.file
			case base != "":
				j.Type, j.URL = "link", base+"/wiki/"+n.PageID
			default:
				j.Type, j.Text = "text", text("")
			}
		case "link":
			j.URL = n.URL
		case "file":
			id := refIn(n.Src)
			switch {
			case strings.HasPrefix(strings.ToLower(n.Src), "https://"):
				j.Type, j.URL = "link", n.Src
			case e.attachment(id) != "":
				j.File = e.attachment(id)
			case base != "" && id != "":
				j.Type, j.URL = "link", base+attachmentURL(id)
			default:
				j.Type, j.Text = "text", text(n.Name)
			}
		case "group":
			j.Label = n.Label
		default:
			continue
		}
		out.Nodes = append(out.Nodes, j)
	}
	for _, c := range p.Canvas.Edges {
		out.Edges = append(out.Edges, jsonEdge(c))
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "\t")
	if err := enc.Encode(out); err != nil {
		return "", err
	}
	return b.String(), nil
}

// canvasTones are the presets' colours, as the app draws them.
var canvasTones = map[string]string{"1": "#ef4444", "2": "#f97316", "3": "#eab308", "4": "#22c55e", "5": "#06b6d4", "6": "#a855f7"}

func canvasTone(c string) string {
	if t, ok := canvasTones[c]; ok {
		return t
	}
	if canvasColor.MatchString(c) {
		return c
	}
	return ""
}

func px(v float64) string { return strconv.FormatFloat(math.Round(v), 'f', -1, 64) }

// htmlCanvas draws a canvas page in its HTML file: the cards where they sit, groups below the
// connections, the connections as lines between the cards' sides.
func (e *exporter) htmlCanvas(p *exportPage, dir string) string {
	c := p.Canvas
	if c == nil || len(c.Nodes) == 0 {
		return ""
	}
	const pad = 40
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	byID := make(map[string]CanvasNode, len(c.Nodes))
	for _, n := range c.Nodes {
		minX, minY = min(minX, n.X), min(minY, n.Y)
		maxX, maxY = max(maxX, n.X+n.Width), max(maxY, n.Y+n.Height)
		byID[n.ID] = n
	}
	at := func(x, y float64) (float64, float64) { return x - minX + pad, y - minY + pad }
	w, h := maxX-minX+2*pad, maxY-minY+2*pad
	var b strings.Builder
	b.WriteString(`<div class="canvas-wrap"><div class="canvas" style="width:` + px(w) + `px;height:` + px(h) + `px">`)
	card := func(n CanvasNode) {
		x, y := at(n.X, n.Y)
		style := "left:" + px(x) + "px;top:" + px(y) + "px;width:" + px(n.Width) + "px;height:" + px(n.Height) + "px"
		if t := canvasTone(n.Color); t != "" {
			style += ";--tone:" + t
		}
		b.WriteString(`<div class="card ` + html.EscapeString(n.Type) + `" style="` + html.EscapeString(style) + `">`)
		b.WriteString(e.htmlCard(n, dir))
		b.WriteString("</div>")
	}
	for _, n := range c.Nodes {
		if n.Type == "group" {
			card(n)
		}
	}
	b.WriteString(`<svg width="` + px(w) + `" height="` + px(h) + `" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>`)
	for _, edge := range c.Edges {
		from, okFrom := byID[edge.FromNode]
		to, okTo := byID[edge.ToNode]
		if !okFrom || !okTo {
			continue
		}
		fromSide, toSide := facingSides(from, to)
		if edge.FromSide != "" {
			fromSide = edge.FromSide
		}
		if edge.ToSide != "" {
			toSide = edge.ToSide
		}
		x1, y1 := at(sidePoint(from, fromSide))
		x2, y2 := at(sidePoint(to, toSide))
		tone := canvasTone(edge.Color)
		if tone == "" {
			tone = "var(--muted)"
		}
		b.WriteString(`<g style="color:` + html.EscapeString(tone) + `"><line x1="` + px(x1) + `" y1="` + px(y1) + `" x2="` + px(x2) + `" y2="` + px(y2) + `" stroke="currentColor" stroke-width="2"`)
		if edge.ToEnd != "none" {
			b.WriteString(` marker-end="url(#arrow)"`)
		}
		if edge.FromEnd == "arrow" {
			b.WriteString(` marker-start="url(#arrow)"`)
		}
		b.WriteString("/>")
		if edge.Label != "" {
			b.WriteString(`<text x="` + px((x1+x2)/2) + `" y="` + px((y1+y2)/2-6) + `" text-anchor="middle" class="edge-label">` + html.EscapeString(edge.Label) + `</text>`)
		}
		b.WriteString("</g>")
	}
	b.WriteString("</svg>")
	for _, n := range c.Nodes {
		if n.Type != "group" {
			card(n)
		}
	}
	b.WriteString("</div></div>")
	return b.String()
}

// htmlCard is what a card shows in an HTML export.
func (e *exporter) htmlCard(n CanvasNode, dir string) string {
	base := strings.TrimRight(e.opt.BaseURL, "/")
	link := func(href, text string) string {
		if href == "" {
			return html.EscapeString(text)
		}
		return `<a href="` + html.EscapeString(href) + `">` + html.EscapeString(text) + `</a>`
	}
	switch n.Type {
	case "text":
		root := parseFragment(e.prepare(n.HTML, dir))
		e.htmlBlocks(root, dir)
		return renderChildren(root)
	case "page":
		if t := e.byID[n.PageID]; t != nil {
			return `<p class="card-title">` + link(hrefPath(relPath(dir, t.file)), orUntitled(t.Title)) + `</p>`
		}
		href := ""
		if base != "" {
			href = base + "/wiki/" + n.PageID
		}
		return `<p class="muted">` + link(href, "A page not in this export") + `</p>`
	case "link":
		title := n.Title
		if title == "" {
			title = n.URL
		}
		href := ""
		if strings.HasPrefix(strings.ToLower(n.URL), "https://") {
			href = n.URL
		}
		out := `<p class="card-title">` + link(href, title) + `</p>`
		if n.Description != "" {
			out += `<p class="muted">` + html.EscapeString(n.Description) + `</p>`
		}
		return out
	case "file":
		href := ""
		switch id := refIn(n.Src); {
		case strings.HasPrefix(strings.ToLower(n.Src), "https://"):
			href = n.Src
		case e.attachment(id) != "":
			href = hrefPath(relPath(dir, e.attachment(id)))
		case base != "" && id != "":
			href = base + attachmentURL(id)
		}
		name := n.Name
		if name == "" {
			name = path.Base(n.Src)
		}
		switch strings.ToLower(path.Ext(name)) {
		case ".png", ".jpg", ".jpeg", ".gif", ".webp":
			if href != "" {
				return `<img src="` + html.EscapeString(href) + `" alt="` + html.EscapeString(name) + `">`
			}
		}
		return `<p class="card-title">` + link(href, name) + `</p>`
	case "group":
		if n.Label == "" {
			return ""
		}
		return `<div class="group-label">` + html.EscapeString(n.Label) + `</div>`
	}
	return ""
}

// facingSides are the sides of two cards that face each other.
func facingSides(from, to CanvasNode) (string, string) {
	dx := (to.X + to.Width/2) - (from.X + from.Width/2)
	dy := (to.Y + to.Height/2) - (from.Y + from.Height/2)
	switch {
	case math.Abs(dx) >= math.Abs(dy) && dx >= 0:
		return "right", "left"
	case math.Abs(dx) >= math.Abs(dy):
		return "left", "right"
	case dy >= 0:
		return "bottom", "top"
	}
	return "top", "bottom"
}

func sidePoint(n CanvasNode, side string) (float64, float64) {
	switch side {
	case "top":
		return n.X + n.Width/2, n.Y
	case "bottom":
		return n.X + n.Width/2, n.Y + n.Height
	case "left":
		return n.X, n.Y + n.Height/2
	}
	return n.X + n.Width, n.Y + n.Height/2
}
