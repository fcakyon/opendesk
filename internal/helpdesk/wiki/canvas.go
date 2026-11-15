package wiki

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Canvases (contracts/wiki.md "Canvas"): a page that is a canvas keeps cards and the
// connections between them, a superset of JSON Canvas 1.0. Text cards hold wiki HTML
// (sanitized like a body). wikiport imports and exports canvases as JSON Canvas files.

const (
	maxCanvasBytes = 1 << 20
	maxCanvasNodes = 2000
	maxCanvasEdges = 4000
	maxCanvasCoord = 1e6
	minCanvasSize  = 20
	maxCanvasSize  = 20000
	maxCanvasLabel = 200
	// A canvas this large or smaller rides in wiki_page.updated; a larger one is refetched.
	maxCanvasEvent = 256 << 10
)

var (
	canvasNodeTypes = []string{"text", "page", "link", "file", "group"}
	canvasSides     = []string{"top", "right", "bottom", "left"}
	canvasEnds      = []string{"none", "arrow"}
	canvasID        = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	canvasColor     = regexp.MustCompile(`^(?:[1-6]|#[0-9a-fA-F]{6})$`)
	attachmentSrc   = regexp.MustCompile(`^/v1/attachments/([0-9a-fA-F-]{36})(?:\?.*)?$`)
)

// CanvasNode is a card on a canvas. Its fields beyond the position and size depend on its type.
type CanvasNode struct {
	ID     string  `json:"id"`
	Type   string  `json:"type" enum:"text,page,link,file,group"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Color  string  `json:"color,omitempty" doc:"A preset 1 to 6, or #rrggbb"`
	// text: wiki HTML, sanitized like a body.
	HTML string `json:"html,omitempty"`
	// page: a page of the workspace.
	PageID *uuid.UUID `json:"page_id,omitempty"`
	// link: an https address and the card read from it (POST /v1/wiki/unfurl).
	URL         string `json:"url,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	// file: an attachment of the workspace or an https address.
	Src  string `json:"src,omitempty"`
	Name string `json:"name,omitempty"`
	// group: its label.
	Label string `json:"label,omitempty"`
}

// CanvasEdge connects two cards.
type CanvasEdge struct {
	ID       string `json:"id"`
	FromNode string `json:"fromNode"`
	FromSide string `json:"fromSide,omitempty" enum:"top,right,bottom,left"`
	FromEnd  string `json:"fromEnd,omitempty" enum:"none,arrow" doc:"Default none"`
	ToNode   string `json:"toNode"`
	ToSide   string `json:"toSide,omitempty" enum:"top,right,bottom,left"`
	ToEnd    string `json:"toEnd,omitempty" enum:"none,arrow" doc:"Default arrow"`
	Color    string `json:"color,omitempty"`
	Label    string `json:"label,omitempty"`
}

// Canvas is what a canvas page keeps. Nodes are in z order: later ones are drawn above.
type Canvas struct {
	Nodes []CanvasNode `json:"nodes"`
	Edges []CanvasEdge `json:"edges"`
}

func emptyCanvas() Canvas { return Canvas{Nodes: []CanvasNode{}, Edges: []CanvasEdge{}} }

func canvasInvalid(format string, a ...any) error {
	return httpx.E(422, "invalid_canvas", fmt.Sprintf(format, a...))
}

func inRange(v, lo, hi float64) bool { return v >= lo && v <= hi }

// cleanCanvas checks a canvas and normalizes it: text sanitized, fields that don't belong
// to a card's type dropped, defaults left out.
func cleanCanvas(raw json.RawMessage) (Canvas, error) {
	if len(raw) > maxCanvasBytes {
		return Canvas{}, canvasInvalid("A canvas holds up to 1 MB.")
	}
	if t := bytes.TrimSpace(raw); len(t) == 0 || t[0] != '{' {
		return Canvas{}, canvasInvalid("A canvas is an object with nodes and edges.")
	}
	var c Canvas
	if err := json.Unmarshal(raw, &c); err != nil {
		return Canvas{}, canvasInvalid("The canvas isn't valid: %s", err.Error())
	}
	if len(c.Nodes) > maxCanvasNodes {
		return Canvas{}, canvasInvalid("A canvas holds up to 2,000 cards.")
	}
	if len(c.Edges) > maxCanvasEdges {
		return Canvas{}, canvasInvalid("A canvas holds up to 4,000 connections.")
	}
	out := Canvas{Nodes: make([]CanvasNode, 0, len(c.Nodes)), Edges: make([]CanvasEdge, 0, len(c.Edges))}
	nodes := make(map[string]bool, len(c.Nodes))
	for _, n := range c.Nodes {
		if !canvasID.MatchString(n.ID) || nodes[n.ID] {
			return Canvas{}, canvasInvalid("Each card needs its own id of 1 to 64 letters, digits, _ or -.")
		}
		nodes[n.ID] = true
		if !inRange(n.X, -maxCanvasCoord, maxCanvasCoord) || !inRange(n.Y, -maxCanvasCoord, maxCanvasCoord) {
			return Canvas{}, canvasInvalid("A card sits within a million points of the middle.")
		}
		if !inRange(n.Width, minCanvasSize, maxCanvasSize) || !inRange(n.Height, minCanvasSize, maxCanvasSize) {
			return Canvas{}, canvasInvalid("A card is 20 to 20,000 points wide and high.")
		}
		if n.Color != "" && !canvasColor.MatchString(n.Color) {
			return Canvas{}, canvasInvalid("A colour is 1 to 6 or #rrggbb.")
		}
		clean := CanvasNode{ID: n.ID, Type: n.Type, X: n.X, Y: n.Y, Width: n.Width, Height: n.Height, Color: n.Color}
		switch n.Type {
		case "text":
			clean.HTML = hd.SanitizeWiki(n.HTML)
		case "page":
			if n.PageID == nil || *n.PageID == uuid.Nil {
				return Canvas{}, canvasInvalid("A page card needs page_id.")
			}
			clean.PageID = n.PageID
		case "link":
			u := strings.TrimSpace(n.URL)
			parsed, err := url.Parse(u)
			if len(u) > 2000 || err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || strings.ContainsAny(u, " \t\r\n\"'<>") {
				return Canvas{}, canvasInvalid("A link card needs an https address.")
			}
			if (n.Image != "" && (len(n.Image) > 2000 || !hd.WikiSrc(n.Image))) || !shortText(n.Title, 300) || !shortText(n.Description, 500) {
				return Canvas{}, canvasInvalid("A link card's title, description or image isn't valid.")
			}
			clean.URL, clean.Image = u, n.Image
			clean.Title = strings.Join(strings.Fields(n.Title), " ")
			clean.Description = strings.Join(strings.Fields(n.Description), " ")
		case "file":
			if n.Src == "" || len(n.Src) > 2000 || !hd.WikiSrc(n.Src) || !shortText(n.Name, 255) {
				return Canvas{}, canvasInvalid("A file card needs an uploaded file or an https address, and a name of up to 255 characters.")
			}
			clean.Src, clean.Name = n.Src, strings.TrimSpace(n.Name)
		case "group":
			if !shortText(n.Label, maxCanvasLabel) {
				return Canvas{}, canvasInvalid("A group's label is up to 200 characters.")
			}
			clean.Label = strings.Join(strings.Fields(n.Label), " ")
		default:
			return Canvas{}, canvasInvalid("%q isn't a card type.", n.Type)
		}
		out.Nodes = append(out.Nodes, clean)
	}
	edges := make(map[string]bool, len(c.Edges))
	for _, e := range c.Edges {
		if !canvasID.MatchString(e.ID) || edges[e.ID] {
			return Canvas{}, canvasInvalid("Each connection needs its own id of 1 to 64 letters, digits, _ or -.")
		}
		edges[e.ID] = true
		if !nodes[e.FromNode] || !nodes[e.ToNode] {
			return Canvas{}, canvasInvalid("A connection joins two cards of the canvas.")
		}
		for _, side := range []string{e.FromSide, e.ToSide} {
			if side != "" && !slices.Contains(canvasSides, side) {
				return Canvas{}, canvasInvalid("A side is top, right, bottom or left.")
			}
		}
		for _, end := range []string{e.FromEnd, e.ToEnd} {
			if end != "" && !slices.Contains(canvasEnds, end) {
				return Canvas{}, canvasInvalid("An end is none or arrow.")
			}
		}
		if e.Color != "" && !canvasColor.MatchString(e.Color) {
			return Canvas{}, canvasInvalid("A colour is 1 to 6 or #rrggbb.")
		}
		if !shortText(e.Label, maxCanvasLabel) {
			return Canvas{}, canvasInvalid("A connection's label is up to 200 characters.")
		}
		e.Label = strings.Join(strings.Fields(e.Label), " ")
		// The defaults are left out, as JSON Canvas does.
		if e.FromEnd == "none" {
			e.FromEnd = ""
		}
		if e.ToEnd == "arrow" {
			e.ToEnd = ""
		}
		out.Edges = append(out.Edges, e)
	}
	return out, nil
}

// checkCanvasRefs makes sure the pages and files a canvas adds are the workspace's, and
// pages the viewer may see. Cards already on the canvas (prev) stay as they are, so a
// teammate who can't see a page still saves the canvas it is on, and a page deleted
// since leaves a card the app shows as gone.
func checkCanvasRefs(ctx context.Context, tx pgx.Tx, v Viewer, wid uuid.UUID, next Canvas, prev *Canvas) error {
	had := map[string]bool{}
	if prev != nil {
		for _, n := range prev.Nodes {
			if n.PageID != nil {
				had["page:"+n.PageID.String()] = true
			}
			if n.Src != "" {
				had["file:"+n.Src] = true
			}
		}
	}
	var pages, files []uuid.UUID
	for _, n := range next.Nodes {
		if n.PageID != nil && !had["page:"+n.PageID.String()] {
			pages = append(pages, *n.PageID)
		}
		if m := attachmentSrc.FindStringSubmatch(n.Src); m != nil && !had["file:"+n.Src] {
			id, err := uuid.Parse(m[1])
			if err != nil {
				return canvasInvalid("A file card names a file that isn't in this workspace.")
			}
			files = append(files, id)
		}
	}
	if pages = uniq(pages); len(pages) > 0 {
		me, hidden := v.args()
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = ANY($2) AND p.deleted_at IS NULL AND `+seesSQL("p", 3, 4),
			wid, pages, me, hidden).Scan(&n); err != nil {
			return err
		}
		if n != len(pages) {
			return canvasInvalid("A page card names a page that isn't in this workspace.")
		}
	}
	if files = uniq(files); len(files) > 0 {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE workspace_id = $1 AND id = ANY($2)`, wid, files).Scan(&n); err != nil {
			return err
		}
		if n != len(files) {
			return canvasInvalid("A file card names a file that isn't in this workspace.")
		}
	}
	return nil
}

// canvasLinkHTML is what a canvas adds to its page's text for links and tags: its text
// cards, and a link to each page on it (contracts/wiki.md "Links and tags").
func canvasLinkHTML(raw []byte) string {
	if raw == nil {
		return ""
	}
	var c Canvas
	if err := json.Unmarshal(raw, &c); err != nil {
		return ""
	}
	var b strings.Builder
	for _, n := range c.Nodes {
		switch {
		case n.Type == "text" && n.HTML != "":
			b.WriteString("\n")
			b.WriteString(n.HTML)
		case n.Type == "page" && n.PageID != nil:
			b.WriteString(`<a href="/wiki/` + n.PageID.String() + `"></a>`)
		}
	}
	return b.String()
}

// canvasPlain is the words on a canvas, for search: its text cards, labels, link cards'
// titles and descriptions, and file names. Up to 256K characters.
func canvasPlain(raw []byte) string {
	if raw == nil {
		return ""
	}
	var c Canvas
	if err := json.Unmarshal(raw, &c); err != nil {
		return ""
	}
	var parts []string
	for _, n := range c.Nodes {
		for _, s := range []string{hd.HTMLToText(n.HTML), n.Label, n.Title, n.Description, n.Name} {
			if s = strings.TrimSpace(s); s != "" {
				parts = append(parts, s)
			}
		}
	}
	for _, e := range c.Edges {
		if e.Label != "" {
			parts = append(parts, e.Label)
		}
	}
	return hd.Truncate(strings.Join(parts, "\n"), 256<<10)
}

// canvasEventData puts a changed canvas into wiki_page.updated: whole while it is small,
// else a flag that has readers fetch the page.
func canvasEventData(data map[string]any, c *Canvas) {
	if raw, err := json.Marshal(c); err == nil && len(raw) <= maxCanvasEvent {
		data["canvas"] = c
		return
	}
	data["canvas_changed"] = true
}

// applyCanvas replaces a canvas's cards and connections; it reports whether anything
// changed. Like a database's schema it keeps the version and adds no revision; it does
// move the page's last edit, and its links and tags follow it.
func applyCanvas(ctx context.Context, tx pgx.Tx, v Viewer, p *auth.Principal, id uuid.UUID, raw json.RawMessage) (bool, error) {
	if len(raw) == 0 {
		return false, nil
	}
	var kind, body string
	var stored []byte
	if err := tx.QueryRow(ctx, `SELECT kind, canvas, body_html FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id).Scan(&kind, &stored, &body); err != nil {
		return false, err
	}
	if kind != "canvas" {
		return false, canvasInvalid("Only a canvas has cards.")
	}
	var prev Canvas
	if err := json.Unmarshal(stored, &prev); err != nil {
		return false, err
	}
	next, err := cleanCanvas(raw)
	if err != nil {
		return false, err
	}
	if err := checkCanvasRefs(ctx, tx, v, p.WorkspaceID, next, &prev); err != nil {
		return false, err
	}
	before, _ := json.Marshal(prev)
	after, _ := json.Marshal(next)
	if bytes.Equal(before, after) {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET canvas = $3, updated_by = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
		p.WorkspaceID, id, after, p.ActorUserID()); err != nil {
		return false, err
	}
	return true, indexBody(ctx, tx, p.WorkspaceID, id, body)
}
