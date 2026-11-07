package wikiport

import (
	"bytes"
	"io"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// node is a page being imported.
type node struct {
	*Page
	src    *file  // its source, nil for a folder or a row without text
	kind   string // md, html, txt, csv, folder, row
	dir    string // the folder whose items are its subpages
	extra  *file  // a database's text: the Markdown or HTML file beside its CSV
	parent *node
	kids   []*node
	name   string // its file or folder name, without id and extension
	notion string // the Notion id in its name
	body   string // its Markdown, after the front matter
	html   *html.Node
	table  *csvTable
	cols   []string // a row's database's columns: Notion writes them as "Name: value" lines
	row    int      // a row's place in its CSV, -1 for none
	jc     *jsonCanvas
}

type importer struct {
	fs   *files
	opt  Options
	res  *Result
	err  error // a limit an asset read hit: it ends the import
	all  []*node
	keys map[string]*node // by Key, and by the folder a page owns
	dirs map[string]*node // by the folder it owns
	refs map[string]*node

	base      map[string][]*node // lower-case name, for wikilinks
	stem      map[string]*node   // lower-case path without extension
	notionIDs map[string]*node
	assetBase map[string][]*file
	assets    map[string]*Asset // by path; nil when refused
	order     []*Asset
	blocks    map[string]string
	canvases  map[*file]*jsonCanvas
	obsidian  bool
	dataN     int
}

// Import reads an upload and answers the pages it holds. uploads are one zip, or page
// sources (Markdown, HTML, CSV, text) and the files they use.
func Import(uploads []Upload, opt Options) (*Result, error) {
	fs, err := readUploads(uploads)
	if err != nil {
		return nil, err
	}
	imp := &importer{fs: fs, opt: opt, res: &Result{refs: map[string]bool{}}, keys: map[string]*node{}, dirs: map[string]*node{},
		refs: map[string]*node{}, base: map[string][]*node{}, stem: map[string]*node{}, notionIDs: map[string]*node{},
		assetBase: map[string][]*file{}, assets: map[string]*Asset{}, blocks: map[string]string{}, canvases: map[*file]*jsonCanvas{}}
	imp.layout()
	if len(imp.all) > MaxPages {
		return nil, ErrTooManyFiles
	}
	imp.read()
	imp.databases()
	if len(imp.all) > MaxPages {
		return nil, ErrTooManyFiles
	}
	imp.index()
	for _, n := range imp.all {
		imp.convert(n)
		if imp.err != nil {
			return nil, imp.err
		}
	}
	roots := imp.tree()
	if len(roots) == 0 {
		return nil, ErrEmpty
	}
	imp.res.Pages = imp.pages(roots)
	imp.limitDepth()
	imp.unused()
	for _, a := range imp.order {
		imp.res.Assets = append(imp.res.Assets, *a)
	}
	imp.res.Skipped = append(fs.skips, imp.res.Skipped...)
	return imp.res, nil
}

func (imp *importer) newRef() string {
	r := uuid.NewString()
	imp.res.refs[r] = true
	return r
}

func (imp *importer) newNode(f *file, kind, key string) *node {
	n := &node{Page: &Page{Key: key, Ref: imp.newRef()}, src: f, kind: kind, row: -1}
	imp.all = append(imp.all, n)
	imp.keys[key] = n
	imp.refs[n.Ref] = n
	return n
}

// stemOf is a source's path without its extension; Notion's "_all" CSV (every row of a
// database, beside the CSV of its current view) has the same stem as the other.
func stemOf(p string) string {
	s := strings.TrimSuffix(p, path.Ext(p))
	if sourceKind(p) == "csv" {
		s = strings.TrimSuffix(s, "_all")
	}
	return s
}

// layout makes a page of every source and of every folder that holds one, and puts each
// under the page of its folder. A folder's page is the source beside it with its name
// (Folder.md, Notion's "Page <id>.md" beside "Page <id>/", a database's CSV), the note
// inside it with its name (Folder/Folder.md), or else a page of its own.
func (imp *importer) layout() {
	var sources []*file
	for _, f := range imp.fs.list {
		if strings.EqualFold(path.Ext(f.path), ".base") {
			imp.skip(f.path, "unsupported")
			f.read = true // listed: not "unused" too
			continue
		}
		if sourceKind(f.path) == "" || !f.read {
			continue
		}
		if sourceKind(f.path) == "canvas" {
			c, err := readCanvas(f.data)
			if err != nil {
				imp.skip(f.path, "unreadable")
				continue
			}
			imp.canvases[f] = c
			imp.fs.obsidian = true // canvases are Obsidian's
		}
		sources = append(sources, f)
	}
	// One CSV per database: Notion's "_all" has every row.
	byStem := map[string][]*file{}
	for _, f := range sources {
		byStem[stemOf(f.path)] = append(byStem[stemOf(f.path)], f)
	}
	consumed := map[*file]bool{}
	csvOf := map[string]*file{}
	docOf := map[string]*file{}
	canvasOf := map[string]*file{}
	for st, group := range byStem {
		for _, f := range group {
			switch sourceKind(f.path) {
			case "canvas":
				canvasOf[st] = f
			case "csv":
				if cur := csvOf[st]; cur == nil || strings.HasSuffix(stemOfRaw(f.path), "_all") {
					if cur != nil {
						consumed[cur] = true
					}
					csvOf[st] = f
				} else {
					consumed[f] = true
				}
			default:
				if docOf[st] == nil || sourceKind(f.path) == "md" {
					docOf[st] = f
				}
			}
		}
	}
	extra := map[*file]*file{}
	for st, c := range csvOf {
		if d := docOf[st]; d != nil {
			extra[c] = d
			consumed[d] = true
		}
	}
	// Folders that hold a page source, at any depth, shallow first.
	dirSet := map[string]bool{}
	for _, f := range sources {
		for d := path.Dir(f.path); d != "."; d = path.Dir(d) {
			dirSet[d] = true
		}
	}
	dirs := make([]string, 0, len(dirSet))
	for d := range dirSet {
		dirs = append(dirs, d)
	}
	slices.SortFunc(dirs, func(a, b string) int {
		if c := strings.Count(a, "/") - strings.Count(b, "/"); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	for _, d := range dirs {
		var n *node
		inside := imp.fs.byPath[d+"/"+path.Base(d)+".md"]
		switch {
		case csvOf[d] != nil && !consumed[csvOf[d]]:
			n = imp.newNode(csvOf[d], "csv", csvOf[d].path)
		case docOf[d] != nil && !consumed[docOf[d]]:
			n = imp.newNode(docOf[d], sourceKind(docOf[d].path), docOf[d].path)
		case inside != nil && inside.read && !consumed[inside]:
			n = imp.newNode(inside, "md", inside.path)
		case canvasOf[d] != nil && !consumed[canvasOf[d]]:
			n = imp.newNode(canvasOf[d], "canvas", canvasOf[d].path)
		default:
			n = imp.newNode(nil, "folder", d+"/")
		}
		if n.src != nil {
			consumed[n.src] = true
			n.extra = extra[n.src]
		}
		n.dir = d
		imp.dirs[d] = n
		imp.keys[d+"/"] = n
	}
	for _, f := range sources {
		if consumed[f] {
			continue
		}
		consumed[f] = true
		n := imp.newNode(f, sourceKind(f.path), f.path)
		n.extra = extra[f]
	}
	for _, n := range imp.all {
		parentDir := ""
		if n.dir != "" {
			parentDir = path.Dir(n.dir)
		} else {
			parentDir = path.Dir(n.src.path)
		}
		if p := imp.dirs[parentDir]; p != nil && p != n {
			n.parent = p
			p.kids = append(p.kids, n)
		}
	}
	// An export's wrapping folder (Notion's "Export-<id>") is not a page.
	var roots []*node
	for _, n := range imp.all {
		if n.parent == nil {
			roots = append(roots, n)
		}
	}
	if len(roots) == 1 && roots[0].kind == "folder" && exportWrapper.MatchString(path.Base(roots[0].dir)) {
		w := roots[0]
		for _, k := range w.kids {
			k.parent = nil
		}
		imp.all = slices.DeleteFunc(imp.all, func(n *node) bool { return n == w })
		delete(imp.refs, w.Ref)
		delete(imp.res.refs, w.Ref)
	}
	for _, f := range imp.fs.list {
		if sourceKind(f.path) == "" && !ignored(f.path) {
			b := strings.ToLower(path.Base(f.path))
			imp.assetBase[b] = append(imp.assetBase[b], f)
		}
	}
	imp.obsidian = imp.fs.obsidian
	// A Notion export names every page with its id.
	for _, f := range sources {
		if notionSuffix.MatchString(path.Base(stemOf(f.path))) {
			imp.fs.notion = true
			break
		}
	}
}

func stemOfRaw(p string) string { return strings.TrimSuffix(p, path.Ext(p)) }

// linkStem is what links name a source by: its path without the extension, but a canvas's
// with it ([[Board.canvas]]), as Obsidian links them.
func linkStem(p string) string {
	if sourceKind(p) == "canvas" {
		return p
	}
	return stemOf(p)
}

var (
	exportWrapper = regexp.MustCompile(`(?i)^(export-[0-9a-f-]+(-part-\d+)?|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
	notionSuffix  = regexp.MustCompile(`(?i)(^|\s)([0-9a-f]{32})$`)
	notionAnyID   = regexp.MustCompile(`(?i)[0-9a-f]{32}`)
	h1Line        = regexp.MustCompile(`^#[ ]+(.+?)[ ]*#*[ ]*$`)
)

// cleanName is a page's title from a file or folder name: Notion's id taken off, and its
// "Untitled" left empty (the wiki shows an empty title as "Untitled").
func cleanName(name string) (title, notionID string) {
	if m := notionSuffix.FindStringSubmatchIndex(name); m != nil {
		notionID = strings.ToLower(name[m[4]:m[5]])
		name = name[:m[0]]
		if strings.TrimSpace(name) == "Untitled" {
			name = ""
		}
	}
	return foldTitle(name), notionID
}

func foldTitle(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return truncateRunes(strings.Join(strings.Fields(s), " "), maxTitle)
}

// read decodes each source and settles titles.
func (imp *importer) read() {
	for _, n := range imp.all {
		if n.kind == "folder" {
			n.name, n.notion = cleanName(path.Base(n.dir))
			n.Title = n.name
		} else {
			n.name, n.notion = cleanName(path.Base(stemOf(n.src.path)))
			n.Title = n.name
		}
		if n.notion != "" {
			imp.notionIDs[n.notion] = n
		}
		if n.src == nil {
			continue
		}
		switch n.kind {
		case "canvas":
			n.jc = imp.canvases[n.src]
		case "md":
			imp.readMarkdown(n, n.src)
		case "html":
			imp.readHTML(n, n.src)
		case "csv":
			imp.readCSV(n)
			switch {
			case n.extra == nil:
			case sourceKind(n.extra.path) == "md":
				imp.readMarkdown(n, n.extra)
			default:
				imp.readHTML(n, n.extra)
			}
		}
	}
}

func (imp *importer) readMarkdown(n *node, f *file) {
	fm, body := splitFrontmatter(decodeText(f.data))
	n.body = body
	if t := first(fm["title"]); t != "" {
		n.Title = foldTitle(t)
	} else if n.notion != "" {
		if h := firstH1(body); h != "" {
			n.Title = foldTitle(h)
			if n.Title == "Untitled" {
				n.Title = ""
			}
		}
	}
	if ic := first(fm["icon"]); validIcon(ic) {
		n.Icon = ic
	}
	n.Tags = cleanTags(fm["tags"])
	n.Aliases = append(fm["aliases"], fm["alias"]...)
	if strings.Contains(body, "[[") && !imp.fs.notion {
		imp.obsidian = true
	}
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return strings.TrimSpace(v[0])
}

// firstH1 is the text of a document's first line when it is a level 1 heading.
func firstH1(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if blank(l) {
			continue
		}
		if m := h1Line.FindStringSubmatch(l); m != nil {
			return m[1]
		}
		return ""
	}
	return ""
}

var tagChars = regexp.MustCompile(`[^\p{L}\p{N}_/-]+`)

// cleanTags are front matter tags as the wiki reads them: "#" and letters, digits, "_",
// "/" or "-", at least one letter.
func cleanTags(raw []string) []string {
	var out []string
	for _, r := range raw {
		for _, t := range strings.FieldsFunc(r, func(c rune) bool { return c == ',' || c == ' ' }) {
			t = strings.ToLower(strings.Trim(tagChars.ReplaceAllString(strings.TrimPrefix(t, "#"), "-"), "-/"))
			if t != "" && strings.IndexFunc(t, unicode.IsLetter) >= 0 && len([]rune(t)) <= 64 && !slices.Contains(out, t) {
				out = append(out, t)
			}
		}
	}
	return out
}

func (imp *importer) readHTML(n *node, f *file) {
	title, icon, body := parseHTMLDocument(f.data)
	n.html = body
	if title != "" && (n.Title == "" || n.notion != "" || n.kind == "html") {
		n.Title = foldTitle(title)
	}
	if validIcon(icon) {
		n.Icon = icon
	}
}

// parseHTMLDocument reads a page saved as HTML: its title (Notion's page title, the
// document's <title>, its first heading), its icon (Notion's) and the element holding
// its text.
func parseHTMLDocument(data []byte) (title, icon string, body *html.Node) {
	var r io.Reader = bytes.NewReader(data)
	if enc, _, _ := charset.DetermineEncoding(data, "text/html"); enc != nil {
		r = enc.NewDecoder().Reader(r)
	}
	doc, err := html.Parse(r)
	if err != nil {
		return "", "", nil
	}
	is := func(tag, class, id string) func(*html.Node) bool {
		return func(n *html.Node) bool {
			return (tag == "" || n.Data == tag) && (class == "" || hasClass(n, class)) && (id == "" || getAttr(n, "id") == id)
		}
	}
	if h := find(doc, is("h1", "page-title", "")); h != nil {
		title = textOf(h)
	} else if t := find(doc, is("title", "", "")); t != nil {
		title = textOf(t)
		if find(doc, is("", "", "main-content")) != nil { // Confluence: "Space : Page"
			if i := strings.LastIndex(title, " : "); i >= 0 {
				title = title[i+3:]
			}
		}
	}
	if ic := find(doc, is("", "page-header-icon", "")); ic != nil {
		icon = strings.TrimSpace(textOf(ic))
	}
	for _, m := range []func(*html.Node) bool{is("", "page-body", ""), is("", "", "main-content"), is("article", "", ""), is("main", "", ""), is("body", "", "")} {
		if body = find(doc, m); body != nil {
			break
		}
	}
	if body == nil {
		body = doc
	}
	h1 := find(body, is("h1", "", ""))
	if strings.TrimSpace(title) == "" && h1 != nil {
		title = textOf(h1)
	}
	if h1 != nil && sameTitle(textOf(h1), title) {
		h1.Parent.RemoveChild(h1)
	}
	return strings.TrimSpace(title), icon, body
}

func sameTitle(a, b string) bool {
	return strings.EqualFold(foldTitle(a), foldTitle(b))
}

// index lists pages by the names links use.
func (imp *importer) index() {
	for _, n := range imp.all {
		var p string
		switch {
		case n.dir != "" && n.kind == "folder":
			p = n.dir
		case n.src != nil:
			p = linkStem(n.src.path)
		default:
			continue
		}
		imp.stem[strings.ToLower(p)] = n
		b := strings.ToLower(path.Base(p))
		imp.base[b] = append(imp.base[b], n)
		if n.dir != "" && n.kind != "folder" {
			imp.stem[strings.ToLower(n.dir)] = n
		}
	}
}

// convert makes a page's body.
func (imp *importer) convert(n *node) {
	if n.kind == "canvas" {
		imp.convertCanvas(n)
		return
	}
	var root *html.Node
	src := n.src
	if n.kind == "csv" {
		src = n.extra
	}
	switch {
	case n.html != nil:
		root = n.html
	case n.kind == "md" || n.kind == "csv" && n.extra != nil:
		body := dropTitleLine(n.body, n.Title)
		if len(n.cols) > 0 {
			body = dropPropertyLines(body, n.cols)
		}
		raw := markdownToHTML(body, mdOptions{breaks: imp.obsidian && !imp.fs.notion})
		root = parseFragment(raw)
	case n.kind == "txt":
		root = parseFragment(hd.TextToHTML(decodeText(n.src.data)))
	default:
		return
	}
	d := &doc{imp: imp, node: n}
	if src != nil {
		d.dir = path.Dir(src.path)
	}
	d.normalize(root)
	if n.table != nil {
		dropTableLike(root, n.table.header)
	}
	d.subpages(root)
	body := renderChildren(root)
	if tags := missingTags(n.Tags, root); len(tags) > 0 {
		body += "<p>#" + html.EscapeString(strings.Join(tags, " #")) + "</p>"
	}
	body = sanitize(body)
	if len(body) > MaxBodyBytes {
		imp.skip(n.Key, "body_too_large")
		body = ""
	}
	n.BodyHTML = body
}

// dropTitleLine takes off a first heading that repeats the title, as Notion writes it.
func dropTitleLine(body, title string) string {
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		if blank(l) {
			continue
		}
		if m := h1Line.FindStringSubmatch(l); m != nil && sameTitle(m[1], title) {
			return strings.Join(lines[i+1:], "\n")
		}
		break
	}
	return body
}

// dropPropertyLines takes off the "Name: value" lines Notion writes under a database
// row's title: the row's values come from the database's CSV.
func dropPropertyLines(body string, cols []string) string {
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) && blank(lines[i]) {
		i++
	}
	start := i
	for i < len(lines) {
		name, _, ok := strings.Cut(lines[i], ":")
		if !ok || !slices.ContainsFunc(cols, func(c string) bool { return strings.EqualFold(strings.TrimSpace(c), strings.TrimSpace(name)) }) {
			break
		}
		i++
	}
	if i == start {
		return body
	}
	return strings.Join(lines[i:], "\n")
}

// missingTags are front matter tags the text doesn't already have.
func missingTags(tags []string, root *html.Node) []string {
	text := strings.ToLower(textOf(root))
	var out []string
	for _, t := range tags {
		if !regexp.MustCompile(`(^|\s)#` + regexp.QuoteMeta(t) + `($|[^\p{L}\p{N}_/-])`).MatchString(text) {
			out = append(out, t)
		}
	}
	return out
}

// dropTableLike removes the table a database's own page shows its rows in (as this
// package's export writes it): the rows are the database's.
func dropTableLike(root *html.Node, header []string) {
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "table" {
			continue
		}
		row := find(c, func(n *html.Node) bool { return n.Data == "tr" })
		if row == nil {
			continue
		}
		var cells []string
		for x := row.FirstChild; x != nil; x = x.NextSibling {
			if x.Type == html.ElementNode {
				cells = append(cells, strings.TrimSpace(textOf(x)))
			}
		}
		if slices.EqualFunc(cells, header, func(a, b string) bool { return strings.EqualFold(a, strings.TrimSpace(b)) }) {
			root.RemoveChild(c)
			return
		}
	}
}

// subpages turns a paragraph that is only a link to one of the page's own subpages into
// the subpage block (or the database's view), as Notion and wikiconv write them.
func (d *doc) subpages(root *html.Node) {
	for c := root.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode && c.Data == "p" {
			if a := onlyChild(c); a != nil && a.Data == "a" && getAttr(a, "data-type") == "page" && getAttr(a, "data-block") == "" {
				if t := d.imp.refs[getAttr(a, "data-id")]; t != nil && t.parent == d.node && d.node != nil {
					block := elem("div", "data-type", "subpage", "data-id", t.Ref)
					if t.kind == "csv" {
						block = elem("div", "data-type", "database", "data-id", t.Ref, "data-view", "table")
					}
					root.InsertBefore(block, c)
					root.RemoveChild(c)
				}
			}
		}
		c = next
	}
}

// onlyChild is a node's one element child when the rest is whitespace.
func onlyChild(n *html.Node) *html.Node {
	var only *html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		switch {
		case c.Type == html.TextNode && strings.TrimSpace(c.Data) == "":
		case c.Type == html.ElementNode && only == nil:
			only = c
		default:
			return nil
		}
	}
	return only
}

// tree orders subpages: as the page's text links them first (Notion lists its subpages
// in order), then by name; a database's rows in its CSV's order.
func (imp *importer) tree() []*node {
	var roots []*node
	for _, n := range imp.all {
		if n.parent == nil {
			roots = append(roots, n)
		}
	}
	sortNodes(roots, nil)
	for _, n := range imp.all {
		if n.kind == "csv" {
			slices.SortStableFunc(n.kids, func(a, b *node) int {
				switch {
				case a.row >= 0 && b.row >= 0:
					return a.row - b.row
				case a.row >= 0:
					return -1
				case b.row >= 0:
					return 1
				}
				return naturalCompare(a.name, b.name)
			})
			continue
		}
		sortNodes(n.kids, n.Links)
	}
	return roots
}

func sortNodes(list []*node, links []string) {
	pos := map[string]int{}
	for i, k := range links {
		if _, ok := pos[k]; !ok {
			pos[k] = i
		}
	}
	slices.SortStableFunc(list, func(a, b *node) int {
		pa, oka := pos[a.Key]
		pb, okb := pos[b.Key]
		switch {
		case oka && okb:
			return pa - pb
		case oka:
			return -1
		case okb:
			return 1
		}
		return naturalCompare(a.name, b.name)
	})
}

// naturalCompare orders names as people read them: case aside, numbers by value.
func naturalCompare(a, b string) int {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		da, db := leadingDigits(a), leadingDigits(b)
		if da != "" && db != "" {
			na, _ := strconv.ParseFloat(da, 64)
			nb, _ := strconv.ParseFloat(db, 64)
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			a, b = a[len(da):], b[len(db):]
			continue
		}
		ra, rb := []rune(a)[0], []rune(b)[0]
		if ra != rb {
			if ra < rb {
				return -1
			}
			return 1
		}
		a, b = a[len(string(ra)):], b[len(string(rb)):]
	}
	return len(a) - len(b)
}

func leadingDigits(s string) string {
	i := 0
	for i < len(s) && i < 15 && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}

func (imp *importer) pages(list []*node) []*Page {
	out := make([]*Page, 0, len(list))
	for _, n := range list {
		n.Children = imp.pages(n.kids)
		out = append(out, n.Page)
	}
	return out
}

// limitDepth keeps the tree within the wiki's depth: what is below a page at the last
// level is placed beside that page, after it, in order.
func (imp *importer) limitDepth() {
	limit := imp.opt.Depth
	if limit <= 0 || limit > MaxDepth {
		limit = MaxDepth
	}
	var flatten func([]*Page) []*Page
	flatten = func(ps []*Page) []*Page {
		var out []*Page
		for _, p := range ps {
			imp.skip(p.Key, "moved_up")
			kids := p.Children
			p.Children = nil
			out = append(out, p)
			out = append(out, flatten(kids)...)
		}
		return out
	}
	var fit func([]*Page, int) []*Page
	fit = func(list []*Page, level int) []*Page {
		var out []*Page
		for _, p := range list {
			out = append(out, p)
			if level < limit {
				p.Children = fit(p.Children, level+1)
				continue
			}
			kids := p.Children
			p.Children = nil
			out = append(out, flatten(kids)...)
		}
		return out
	}
	imp.res.Pages = fit(imp.res.Pages, 1)
}

func (imp *importer) skip(p, reason string) {
	imp.res.Skipped = append(imp.res.Skipped, Skip{Path: p, Reason: reason})
}

// unused lists the files no page used.
func (imp *importer) unused() {
	for _, f := range imp.fs.list {
		if sourceKind(f.path) != "" || f.read {
			continue
		}
		if _, ok := imp.assets[f.path]; ok {
			continue
		}
		if hd.IsExecutable(nil, f.path) {
			imp.skip(f.path, "executable")
		} else {
			imp.skip(f.path, "unused")
		}
	}
}
