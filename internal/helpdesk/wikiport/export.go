package wikiport

import (
	"archive/zip"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"

	xhtml "golang.org/x/net/html"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/wikiconv"
)

// Format is what an export writes.
type Format string

const (
	// FormatMarkdown is an Obsidian vault: a Markdown file per page, a folder beside it
	// for its subpages, [[links]] between pages, a CSV and a table per database, a JSON
	// Canvas file (.canvas) per canvas.
	FormatMarkdown Format = "markdown"
	// FormatHTML is a standalone HTML file per page, linked to each other by relative paths.
	FormatHTML Format = "html"
)

// ExportPage is a page to export.
type ExportPage struct {
	ID string
	// ParentID is the page it sits under; a page whose parent isn't exported is at the top.
	ParentID string
	Title    string
	Icon     string
	BodyHTML string
	// Kind is "page", "database" or "canvas".
	Kind      string
	Database  *Database
	Canvas    *Canvas
	Props     map[string]any
	Tags      []string
	Aliases   []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ExportOptions shape an export.
type ExportOptions struct {
	Format Format
	// Frontmatter writes each Markdown page's title, icon, aliases, dates, tags and a row's values
	// as YAML front matter.
	Frontmatter bool
	// Attachment opens one of the workspace's files a body uses, by its id; the export
	// carries it under attachments/ and links it by relative path. Without it, or when it
	// fails, the link goes to the app (BaseURL).
	Attachment func(id string) (name string, body io.ReadCloser, err error)
	// BaseURL is the app's address (https://app.opendesk.sh): links to pages and files the
	// export doesn't carry point there. Without it, such a link keeps only its text.
	BaseURL string
}

// assetDir is where an export keeps the files bodies use.
const assetDir = "attachments"

type exportPage struct {
	*ExportPage
	kids   []*exportPage
	parent *exportPage
	file   string // its path in the zip
	folder string // where its subpages go
	link   string // what [[ ]] names it by
}

type exporter struct {
	opt   ExportOptions
	zw    *zip.Writer
	byID  map[string]*exportPage
	files map[string]string // attachment id → path in the zip
	used  map[string]bool   // lower-case paths taken
	ext   string
}

// ExportZip writes pages as a zip. Pages come in order among their siblings, and are only
// those the reader may see: what a body links to outside them is left as text or a link
// to the app.
func ExportZip(w io.Writer, pages []ExportPage, opt ExportOptions) error {
	e := &exporter{opt: opt, zw: zip.NewWriter(w), byID: map[string]*exportPage{}, files: map[string]string{}, used: map[string]bool{}, ext: ".md"}
	if opt.Format == FormatHTML {
		e.ext = ".html"
	} else if opt.Format != FormatMarkdown {
		return fmt.Errorf("wikiport: unknown format %q", opt.Format)
	}
	list := make([]*exportPage, len(pages))
	for i := range pages {
		list[i] = &exportPage{ExportPage: &pages[i]}
		e.byID[pages[i].ID] = list[i]
	}
	var roots []*exportPage
	for _, p := range list {
		if parent := e.byID[p.ParentID]; parent != nil && p.ParentID != p.ID {
			p.parent = parent
			parent.kids = append(parent.kids, p)
		} else {
			roots = append(roots, p)
		}
	}
	e.used[assetDir] = true
	e.place(roots, "")
	e.links(list)
	var write func([]*exportPage) error
	write = func(ps []*exportPage) error {
		for _, p := range ps {
			if err := e.write(p); err != nil {
				return err
			}
			if err := write(p.kids); err != nil {
				return err
			}
		}
		return nil
	}
	if err := write(roots); err != nil {
		return err
	}
	return e.zw.Close()
}

// place gives each page a file name unique in its folder; a page with subpages gets the
// folder of the same name beside its file.
func (e *exporter) place(ps []*exportPage, folder string) {
	for _, p := range ps {
		name := e.unique(folder, fileName(p.Title))
		p.file = path.Join(folder, name+e.extOf(p.ExportPage))
		p.folder = path.Join(folder, name)
		e.place(p.kids, p.folder)
	}
}

// extOf is a page's file extension: a canvas in a vault is a JSON Canvas file.
func (e *exporter) extOf(p *ExportPage) string {
	if isCanvas(p) && e.opt.Format == FormatMarkdown {
		return ".canvas"
	}
	return e.ext
}

func isCanvas(p *ExportPage) bool { return p.Kind == "canvas" && p.Canvas != nil }

func (e *exporter) unique(folder, name string) string {
	try := name
	for i := 2; e.used[strings.ToLower(path.Join(folder, try))]; i++ {
		try = name + " (" + strconv.Itoa(i) + ")"
	}
	e.used[strings.ToLower(path.Join(folder, try))] = true
	return try
}

// fileName is a title fit for a file name on every system.
func fileName(title string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\:*?"<>|#^[]`, r) {
			return -1
		}
		return r
	}, title)
	name = strings.Trim(strings.Join(strings.Fields(name), " "), ". ")
	name = truncateRunes(name, 100)
	if name == "" {
		return "Untitled"
	}
	return name
}

// links settles how [[ ]] names each page: its file name where that is the only one, else
// its path in the vault; a canvas with its extension, as Obsidian names one.
func (e *exporter) links(list []*exportPage) {
	count := map[string]int{}
	for _, p := range list {
		count[strings.ToLower(path.Base(p.folder))]++
	}
	for _, p := range list {
		if count[strings.ToLower(path.Base(p.folder))] == 1 {
			p.link = path.Base(p.folder)
		} else {
			p.link = p.folder
		}
		if ext := e.extOf(p.ExportPage); ext == ".canvas" {
			p.link += ext
		}
	}
}

func (e *exporter) create(name string) (io.Writer, error) {
	return e.zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now().UTC()})
}

func (e *exporter) write(p *exportPage) error {
	dir := path.Dir(p.file)
	out, err := e.render(p, dir)
	if err != nil {
		return err
	}
	w, err := e.create(p.file)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(w, out); err != nil {
		return err
	}
	if p.Kind == "database" && p.Database != nil && e.opt.Format == FormatMarkdown {
		w, err := e.create(strings.TrimSuffix(p.file, e.ext) + ".csv")
		if err != nil {
			return err
		}
		return writeCSV(w, p, e)
	}
	return nil
}

// render is a page's file.
func (e *exporter) render(p *exportPage, dir string) (string, error) {
	switch {
	case e.opt.Format == FormatHTML:
		return e.htmlPage(p, e.prepare(p.BodyHTML, dir), dir), nil
	case isCanvas(p.ExportPage):
		return e.canvasJSON(p, dir)
	}
	return e.markdownPage(p, e.prepare(p.BodyHTML, dir)), nil
}

// prepare rewrites a body's links for the export: files it carries by relative path,
// pages and files it doesn't to the app.
func (e *exporter) prepare(body, dir string) string {
	if body == "" {
		return ""
	}
	root := parseFragment(body)
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == xhtml.ElementNode {
				e.prepareNode(c, dir)
				walk(c)
			}
			c = next
		}
	}
	walk(root)
	return renderChildren(root)
}

func (e *exporter) prepareNode(n *xhtml.Node, dir string) {
	for i, a := range n.Attr {
		if a.Key != "src" && a.Key != "data-src" && a.Key != "href" {
			continue
		}
		if !strings.HasPrefix(a.Val, "/v1/attachments/") {
			continue
		}
		if p := e.attachment(refIn(a.Val)); p != "" {
			n.Attr[i].Val = relPath(dir, p)
			if e.opt.Format == FormatHTML {
				n.Attr[i].Val = hrefPath(n.Attr[i].Val)
			}
		} else if e.opt.BaseURL != "" {
			n.Attr[i].Val = strings.TrimRight(e.opt.BaseURL, "/") + a.Val
		}
	}
	// A link to a page the export doesn't carry goes to the app, as an ordinary link.
	if n.Data == "a" && getAttr(n, "data-type") == "page" && e.byID[getAttr(n, "data-id")] == nil {
		id := getAttr(n, "data-id")
		delAttr(n, "data-type", "data-id", "data-block")
		if e.opt.BaseURL != "" {
			setAttr(n, "href", strings.TrimRight(e.opt.BaseURL, "/")+"/wiki/"+id)
		} else {
			delAttr(n, "href")
		}
	}
}

// attachment carries a file in the zip once; "" when it can't.
func (e *exporter) attachment(id string) string {
	if id == "" || e.opt.Attachment == nil || e.zw == nil {
		return ""
	}
	if p, ok := e.files[id]; ok {
		return p
	}
	e.files[id] = ""
	name, body, err := e.opt.Attachment(id)
	if err != nil || body == nil {
		return ""
	}
	defer body.Close()
	file := hd.CleanFilename(name)
	ext := path.Ext(file)
	stem := strings.TrimSuffix(file, ext)
	try := file
	for i := 2; e.used[strings.ToLower(path.Join(assetDir, try))]; i++ {
		try = stem + " (" + strconv.Itoa(i) + ")" + ext
	}
	e.used[strings.ToLower(path.Join(assetDir, try))] = true
	p := path.Join(assetDir, try)
	w, err := e.create(p)
	if err != nil {
		return ""
	}
	if _, err := io.Copy(w, io.LimitReader(body, hd.MaxAttachmentBytes)); err != nil {
		return ""
	}
	e.files[id] = p
	return p
}

// relPath is the path to `to` from the folder `from`, both in the zip.
func relPath(from, to string) string {
	if from == "." || from == "" {
		return to
	}
	fromParts, toParts := strings.Split(from, "/"), strings.Split(to, "/")
	i := 0
	for i < len(fromParts) && i < len(toParts)-1 && fromParts[i] == toParts[i] {
		i++
	}
	return strings.Repeat("../", len(fromParts)-i) + strings.Join(toParts[i:], "/")
}

// hrefPath is a relative path as an HTML link: each part escaped.
func hrefPath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		if s != ".." {
			parts[i] = url.PathEscape(s)
		}
	}
	return strings.Join(parts, "/")
}

func (e *exporter) pageLink(id string) (string, bool) {
	t := e.byID[id]
	if t == nil {
		return "", false
	}
	alias := strings.NewReplacer("[", "", "]", "", "|", "").Replace(strings.Join(strings.Fields(t.Title), " "))
	if alias == "" || alias == path.Base(t.link) {
		return "[[" + t.link + "]]", true
	}
	return "[[" + t.link + "|" + alias + "]]", true
}

func (e *exporter) markdownPage(p *exportPage, body string) string {
	var b strings.Builder
	if e.opt.Frontmatter {
		b.WriteString(frontmatter(p.ExportPage, e.rowSchema(p)))
	}
	md := wikiconv.Markdown(body, wikiconv.MarkdownOptions{PageLink: e.pageLink})
	if strings.TrimSpace(md) != "" {
		b.WriteString(md)
	}
	if p.Kind == "database" && p.Database != nil {
		if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n\n") {
			b.WriteString("\n")
		}
		b.WriteString(e.markdownTable(p))
	}
	return b.String()
}

func (e *exporter) rowSchema(p *exportPage) *Database {
	if p.parent != nil && p.parent.Kind == "database" {
		return p.parent.Database
	}
	return nil
}

// frontmatter is a page's YAML front matter; a row's values follow its own fields.
func frontmatter(p *ExportPage, schema *Database) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("title: " + yamlQuote(p.Title) + "\n")
	if p.Icon != "" {
		b.WriteString("icon: " + yamlQuote(p.Icon) + "\n")
	}
	if !p.CreatedAt.IsZero() {
		b.WriteString("created: " + p.CreatedAt.UTC().Format(time.RFC3339) + "\n")
	}
	if !p.UpdatedAt.IsZero() {
		b.WriteString("updated: " + p.UpdatedAt.UTC().Format(time.RFC3339) + "\n")
	}
	if len(p.Aliases) > 0 {
		b.WriteString("aliases:\n")
		for _, a := range p.Aliases {
			b.WriteString("  - " + yamlQuote(a) + "\n")
		}
	}
	if len(p.Tags) > 0 {
		b.WriteString("tags:\n")
		for _, t := range p.Tags {
			b.WriteString("  - " + yamlQuote(t) + "\n")
		}
	}
	if schema != nil {
		for _, prop := range schema.Properties[min(1, len(schema.Properties)):] {
			if v := formatValue(prop, p, nil); v != "" {
				b.WriteString(yamlQuote(prop.Name) + ": " + yamlQuote(v) + "\n")
			}
		}
	}
	b.WriteString("---\n\n")
	return b.String()
}

// markdownTable is a database's rows as a Markdown table, the title linking each row.
func (e *exporter) markdownTable(p *exportPage) string {
	props := p.Database.Properties
	var b strings.Builder
	cell := func(s string) string {
		return strings.ReplaceAll(strings.Join(strings.Fields(s), " "), "|", `\|`)
	}
	b.WriteString("|")
	for _, prop := range props {
		b.WriteString(" " + cell(prop.Name) + " |")
	}
	b.WriteString("\n|" + strings.Repeat(" --- |", len(props)) + "\n")
	for _, row := range p.kids {
		b.WriteString("|")
		for i, prop := range props {
			v := formatValue(prop, row.ExportPage, e)
			if i == 0 {
				if l, ok := e.pageLink(row.ID); ok {
					v = l
				}
				v = strings.ReplaceAll(v, "|", `\|`)
				b.WriteString(" " + v + " |")
				continue
			}
			b.WriteString(" " + cell(v) + " |")
		}
		b.WriteString("\n")
	}
	return b.String()
}

func writeCSV(w io.Writer, p *exportPage, e *exporter) error {
	cw := csv.NewWriter(w)
	var head []string
	for _, prop := range p.Database.Properties {
		head = append(head, prop.Name)
	}
	if err := cw.Write(head); err != nil {
		return err
	}
	for _, row := range p.kids {
		rec := make([]string, len(p.Database.Properties))
		for i, prop := range p.Database.Properties {
			rec[i] = formatValue(prop, row.ExportPage, e)
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

// formatValue is a row's value of a property as text: options by name, dates as
// YYYY-MM-DD (a range "start → end"), checkboxes Yes or No, related rows by title. People
// and tickets are ids only the workspace can read: left out.
func formatValue(prop Property, row *ExportPage, e *exporter) string {
	switch prop.Type {
	case "title":
		return row.Title
	case "created_time":
		return dateText(row.CreatedAt, prop.DateTime)
	case "edited_time":
		return dateText(row.UpdatedAt, prop.DateTime)
	}
	raw, ok := row.Props[prop.ID]
	if !ok || raw == nil {
		return ""
	}
	var v any
	if b, err := json.Marshal(raw); err == nil {
		_ = json.Unmarshal(b, &v)
	}
	optionName := func(id any) string {
		s, _ := id.(string)
		for _, o := range prop.Options {
			if o.ID == s {
				return o.Name
			}
		}
		return ""
	}
	switch prop.Type {
	case "text", "url", "email", "phone":
		s, _ := v.(string)
		return s
	case "number":
		f, _ := v.(float64)
		return strconv.FormatFloat(f, 'f', -1, 64)
	case "unique_id":
		f, _ := v.(float64)
		n := strconv.FormatFloat(f, 'f', -1, 64)
		if prop.Prefix != "" {
			return prop.Prefix + "-" + n
		}
		return n
	case "checkbox":
		if b, _ := v.(bool); b {
			return "Yes"
		}
		return "No"
	case "select", "status":
		return optionName(v)
	case "multi_select":
		list, _ := v.([]any)
		var names []string
		for _, id := range list {
			if n := optionName(id); n != "" {
				names = append(names, n)
			}
		}
		return strings.Join(names, ", ")
	case "date":
		m, _ := v.(map[string]any)
		start, _ := m["start"].(string)
		end, _ := m["end"].(string)
		if end != "" {
			return start + " → " + end
		}
		return start
	case "files":
		list, _ := v.([]any)
		var names []string
		for _, f := range list {
			if m, ok := f.(map[string]any); ok {
				if n, _ := m["name"].(string); n != "" {
					names = append(names, n)
				}
			}
		}
		return strings.Join(names, ", ")
	case "relation":
		if e == nil {
			return ""
		}
		list, _ := v.([]any)
		var names []string
		for _, id := range list {
			s, _ := id.(string)
			if t := e.byID[s]; t != nil {
				names = append(names, t.Title)
			}
		}
		return strings.Join(names, ", ")
	}
	return ""
}

func dateText(t time.Time, withTime bool) string {
	if t.IsZero() {
		return ""
	}
	if withTime {
		return t.UTC().Format(time.RFC3339)
	}
	return t.UTC().Format(time.DateOnly)
}

// htmlPage is a page as a standalone document. Its markup is the wiki's, which the style
// draws; links between pages are relative, and each block that the app draws from its
// attributes gets a plain link or text inside it.
func (e *exporter) htmlPage(p *exportPage, body, dir string) string {
	root := parseFragment(body)
	e.htmlBlocks(root, dir)
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	title := p.Title
	if title == "" {
		title = "Untitled"
	}
	b.WriteString("<title>" + html.EscapeString(title) + "</title><style>" + pageCSS + "</style></head>\n<body><article class=\"page\"><header>")
	if p.Icon != "" {
		b.WriteString("<div class=\"page-header-icon\">" + html.EscapeString(p.Icon) + "</div>")
	}
	b.WriteString("<h1 class=\"page-title\">" + html.EscapeString(title) + "</h1></header>\n<div class=\"page-body\">")
	b.WriteString(renderChildren(root))
	if p.Kind == "database" && p.Database != nil {
		b.WriteString(e.htmlTable(p, dir))
	}
	if isCanvas(p.ExportPage) {
		b.WriteString(e.htmlCanvas(p, dir))
	}
	b.WriteString("</div></article></body></html>\n")
	return b.String()
}

func (e *exporter) htmlTable(p *exportPage, dir string) string {
	var b strings.Builder
	b.WriteString("<table class=\"database\"><thead><tr>")
	for _, prop := range p.Database.Properties {
		b.WriteString("<th>" + html.EscapeString(prop.Name) + "</th>")
	}
	b.WriteString("</tr></thead><tbody>")
	for _, row := range p.kids {
		b.WriteString("<tr>")
		for i, prop := range p.Database.Properties {
			v := html.EscapeString(formatValue(prop, row.ExportPage, e))
			if i == 0 {
				v = "<a href=\"" + html.EscapeString(hrefPath(relPath(dir, row.file))) + "\">" + v + "</a>"
			}
			b.WriteString("<td>" + v + "</td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return b.String()
}

func (e *exporter) htmlBlocks(n *xhtml.Node, dir string) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type != xhtml.ElementNode {
			c = next
			continue
		}
		switch t := getAttr(c, "data-type"); {
		case c.Data == "a" && t == "page":
			target := e.byID[getAttr(c, "data-id")]
			delAttr(c, "data-type", "data-id", "data-block")
			if target != nil {
				setAttr(c, "href", hrefPath(relPath(dir, target.file)))
			}
		case t == "subpage" || t == "database":
			target := e.byID[getAttr(c, "data-id")]
			if target == nil {
				n.RemoveChild(c)
				break
			}
			a := elem("a", "href", hrefPath(relPath(dir, target.file)))
			a.AppendChild(textNode(orUntitled(target.Title)))
			pp := elem("p")
			pp.AppendChild(a)
			n.InsertBefore(pp, c)
			n.RemoveChild(c)
		case t == "file" || t == "video" || t == "audio":
			src := getAttr(c, "data-src")
			name := getAttr(c, "data-name")
			if name == "" {
				name = path.Base(src)
			}
			if t == "file" || strings.HasPrefix(src, "/") {
				a := elem("a", "href", src)
				a.AppendChild(textNode(name))
				c.AppendChild(a)
			} else {
				c.AppendChild(elem(t, "controls", "", "src", src))
			}
		case t == "bookmark" || t == "embed":
			u := getAttr(c, "data-url")
			label := getAttr(c, "data-title")
			if label == "" {
				label = u
			}
			a := elem("a", "href", u)
			a.AppendChild(textNode(label))
			c.AppendChild(a)
		case t == "block-math" || t == "inline-math":
			code := elem("code")
			code.AppendChild(textNode(getAttr(c, "data-latex")))
			c.AppendChild(code)
		default:
			e.htmlBlocks(c, dir)
		}
		c = next
	}
}

func orUntitled(s string) string {
	if strings.TrimSpace(s) == "" {
		return "Untitled"
	}
	return s
}

const pageCSS = `:root{color-scheme:light dark;--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e4e4e7;--muted:#a1a1aa;--line:#3f3f46;--soft:#27272a;--bg:#18181b}}
body{margin:0;font:16px/1.6 Geist,ui-sans-serif,system-ui,sans-serif;color:var(--ink)}
.page{max-width:760px;margin:0 auto;padding:48px 24px}
.page-header-icon{font-size:48px;line-height:1}
.page-title{font-size:2.2em;margin:.3em 0 .6em}
a{color:inherit;text-decoration-color:var(--muted)}
pre,code{font-family:"Geist Mono",ui-monospace,monospace;font-size:.9em}
pre{background:var(--soft);padding:12px 16px;border-radius:6px;overflow:auto}
:not(pre)>code{background:var(--soft);padding:.1em .3em;border-radius:4px}
blockquote{margin:0;padding-left:1em;border-left:3px solid var(--line)}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}
td p,th p{margin:0}
img{max-width:100%;border-radius:6px}
hr{border:0;border-top:1px solid var(--line)}
mark{background:#fef08a;border-radius:2px}
ul[data-type=taskList]{list-style:none;padding-left:.2em}
li[data-type=taskItem]::before{content:"☐ "}li[data-checked=true]::before{content:"☑ "}
li[data-type=taskItem]>p{display:inline}
li[data-checked=true]{color:var(--muted)}
div[data-type=callout]{display:flex;gap:10px;background:var(--soft);padding:12px 16px;border-radius:6px;margin:1em 0}
div[data-type=callout]::before{content:attr(data-icon)}
div[data-type=callout]>p{margin:0}
div[data-type=columns]{display:flex;gap:24px}div[data-type=column]{flex:1;min-width:0}
details{margin:.5em 0}summary{cursor:pointer}
div[data-type=block-math]{text-align:center;margin:1em 0}
div[data-type=file],div[data-type=bookmark],div[data-type=embed]{border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:1em 0}
video,audio{max-width:100%}
.canvas-wrap{overflow:auto;margin:1em 0;border:1px solid var(--line);border-radius:6px;background:var(--soft)}
.canvas{position:relative}.canvas>svg{position:absolute;left:0;top:0;overflow:visible}
.card{position:absolute;box-sizing:border-box;overflow:auto;padding:8px 12px;border:1px solid var(--line);border-top:3px solid var(--tone,var(--line));border-radius:6px;background:var(--bg);font-size:14px;line-height:1.5}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}.card img{display:block;max-height:100%;margin:0 auto}
.card.group{background:transparent;border:1.5px dashed var(--tone,var(--muted));overflow:visible}
.group-label{position:absolute;top:-1.7em;left:0;font-size:13px;color:var(--muted)}
.card-title{font-weight:500}.muted{color:var(--muted)}.edge-label{font-size:12px;fill:var(--ink)}
[data-color=gray]{color:#71717a}[data-color=brown]{color:#a16207}[data-color=orange]{color:#ea580c}[data-color=yellow]{color:#ca8a04}[data-color=green]{color:#16a34a}[data-color=blue]{color:#2563eb}[data-color=purple]{color:#9333ea}[data-color=pink]{color:#db2777}[data-color=red]{color:#dc2626}
[data-bg=gray]{background:#f4f4f5}[data-bg=brown]{background:#fef3c7}[data-bg=orange]{background:#ffedd5}[data-bg=yellow]{background:#fef9c3}[data-bg=green]{background:#dcfce7}[data-bg=blue]{background:#dbeafe}[data-bg=purple]{background:#f3e8ff}[data-bg=pink]{background:#fce7f3}[data-bg=red]{background:#fee2e2}
`

// ExportFileName is the file a single page exports to: a canvas in Markdown is a JSON
// Canvas file.
func ExportFileName(page ExportPage, format Format) string {
	switch {
	case format == FormatHTML:
		return fileName(page.Title) + ".html"
	case isCanvas(&page):
		return fileName(page.Title) + ".canvas"
	}
	return fileName(page.Title) + ".md"
}

// ExportFile writes one page as a Markdown or HTML file (ExportFileName). Its links to
// other pages and its files point to the app (BaseURL); Attachment is not used.
func ExportFile(w io.Writer, page ExportPage, opt ExportOptions) error {
	e := &exporter{opt: opt, byID: map[string]*exportPage{}, files: map[string]string{}, used: map[string]bool{}}
	opt.Attachment = nil
	e.opt = opt
	p := &exportPage{ExportPage: &page, file: ExportFileName(page, opt.Format)}
	if opt.Format != FormatHTML && opt.Format != FormatMarkdown {
		return fmt.Errorf("wikiport: unknown format %q", opt.Format)
	}
	out, err := e.render(p, ".")
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, out)
	return err
}
