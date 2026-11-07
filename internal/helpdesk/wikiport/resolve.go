package wikiport

import (
	"encoding/base64"
	"errors"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/net/html"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// Links and files: what a body names in its upload (a relative path, an Obsidian
// wikilink or embed, a notion.so link, a data: image) becomes a ref (see "Placeholders").

// doc is the body being converted, and where its links are read from.
type doc struct {
	imp  *importer
	node *node
	dir  string
}

func (imp *importer) blockID(key, slug string) string {
	k := key + "#" + slug
	if id, ok := imp.blocks[k]; ok {
		return id
	}
	id := uuid.NewString()
	imp.blocks[k] = id
	return id
}

func (d *doc) knownRef(id string) bool { return d.imp.res.refs[strings.ToLower(id)] }

func attachmentURL(ref string) string { return "/v1/attachments/" + ref }

// isRemote is a link with a scheme.
func isRemote(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && u.Scheme != "" && len(u.Scheme) > 1
}

// resolvePath is the upload path a relative link names from the document, and its
// fragment; "" when it leaves the upload.
func (d *doc) resolvePath(href string) (string, string) {
	href, frag, _ := strings.Cut(href, "#")
	href, _, _ = strings.Cut(href, "?")
	if u, err := url.PathUnescape(href); err == nil {
		href = u
	}
	if f, err := url.PathUnescape(frag); err == nil {
		frag = f
	}
	href = strings.ReplaceAll(href, `\`, "/")
	var p string
	if strings.HasPrefix(href, "/") {
		p = path.Clean(strings.TrimPrefix(href, "/"))
	} else {
		p = path.Join(d.dir, href)
	}
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return "", frag
	}
	return p, frag
}

// pageAt is the page a path in the upload names: a source, or a folder.
func (imp *importer) pageAt(p string) *node {
	if p == "" {
		return nil
	}
	if n := imp.keys[p]; n != nil {
		return n
	}
	if n := imp.keys[p+"/"]; n != nil {
		return n
	}
	l := strings.ToLower(p)
	if sourceKind(p) != "" {
		l = strings.ToLower(linkStem(p))
	}
	return imp.stem[l]
}

// pageLink makes a an inline link to page t (and the heading named by frag in it).
func (d *doc) pageLink(a *html.Node, t *node, frag string) *html.Node {
	href := "/wiki/" + t.Ref
	attrs := []string{"data-type", "page", "data-id", t.Ref}
	if slug := slugify(strings.TrimPrefix(frag, "^")); slug != "" && !strings.HasPrefix(frag, "^") {
		id := d.imp.blockID(t.Key, slug)
		attrs = append(attrs, "data-block", id)
		href += "#" + id
	}
	with := elem("a", append(attrs, "href", href)...)
	replaceWith(a, with, true)
	if strings.TrimSpace(textOf(with)) == "" && find(with, func(*html.Node) bool { return true }) == nil {
		title := t.Title
		if title == "" {
			title = "Untitled"
		}
		clearChildren(with)
		with.AppendChild(textNode(title))
	}
	if d.node != nil && t != d.node && !slices.Contains(d.node.Links, t.Key) {
		d.node.Links = append(d.node.Links, t.Key)
	}
	return with
}

func (d *doc) fixLink(n *html.Node) *html.Node {
	open := func() *html.Node {
		first, next := n.FirstChild, n.NextSibling
		unwrap(n)
		if first != nil {
			return first
		}
		return next
	}
	if getAttr(n, "data-type") == "page" {
		if d.knownRef(getAttr(n, "data-id")) {
			return n
		}
		return open()
	}
	if c := onlyChild(n); c != nil && c.Data == "img" {
		return open() // a linked image stands for itself
	}
	if hasAttr(n, "data-wikilink") {
		t, frag := d.imp.wikiTarget(getAttr(n, "data-wikilink"), d)
		if t == nil {
			return open()
		}
		with := d.pageLink(n, t, frag)
		return with
	}
	if hasAttr(n, "data-wikiembed") {
		return d.embed(n, getAttr(n, "data-wikiembed"))
	}
	href := strings.TrimSpace(getAttr(n, "href"))
	switch {
	case href == "" || strings.HasPrefix(href, "#"):
		return open()
	case isRemote(href):
		u, err := url.Parse(href)
		if err != nil {
			return open()
		}
		scheme := strings.ToLower(u.Scheme)
		if scheme != "http" && scheme != "https" && scheme != "mailto" {
			return open()
		}
		if t := d.imp.notionPage(u); t != nil {
			return d.pageLink(n, t, "")
		}
		n.Attr = []html.Attribute{{Key: "href", Val: href}}
		return n
	case strings.HasPrefix(href, "/wiki/") || strings.HasPrefix(href, "/v1/attachments/"):
		if d.knownRef(refIn(href)) {
			n.Attr = []html.Attribute{{Key: "href", Val: href}}
			return n
		}
		return open()
	}
	p, frag := d.resolvePath(href)
	if t := d.imp.pageAt(p); t != nil {
		return d.pageLink(n, t, frag)
	}
	if a := d.assetAt(href); a != nil {
		if strings.TrimSpace(textOf(n)) == "" {
			clearChildren(n)
			n.AppendChild(textNode(a.Name))
		}
		n.Attr = []html.Attribute{{Key: "href", Val: attachmentURL(a.Ref)}}
		if p := n.Parent; p != nil && p.Data == "p" && onlyChild(p) == n {
			with := assetBlock(a, strings.TrimSpace(textOf(n)))
			replaceWith(n, with, false)
			return with
		}
		return n
	}
	return open()
}

// notionPage is the imported page a notion.so link names by its id.
func (imp *importer) notionPage(u *url.URL) *node {
	host := strings.ToLower(u.Host)
	if !strings.HasSuffix(host, "notion.so") && !strings.HasSuffix(host, "notion.site") {
		return nil
	}
	ids := notionAnyID.FindAllString(u.Path, -1)
	if len(ids) == 0 {
		return nil
	}
	return imp.notionIDs[strings.ToLower(ids[len(ids)-1])]
}

// wikiTarget is the page an Obsidian link names: [[Note]], [[Folder/Note]], [[Note#Heading]],
// [[#Heading]] (this page). A name more than one note has is the one in the linking note's
// folder, else the one nearest the vault's top.
func (imp *importer) wikiTarget(target string, d *doc) (*node, string) {
	note, frag, _ := strings.Cut(target, "#")
	note = strings.TrimSpace(note)
	if note == "" {
		return d.node, frag
	}
	if strings.EqualFold(path.Ext(note), ".md") {
		note = strings.TrimSuffix(note, path.Ext(note))
	}
	l := strings.ToLower(strings.Trim(note, "/"))
	if strings.Contains(l, "/") {
		if n := imp.stem[l]; n != nil {
			return n, frag
		}
		if n := imp.stem[strings.ToLower(path.Join(d.dir, note))]; n != nil {
			return n, frag
		}
		for k, n := range imp.stem {
			if strings.HasSuffix(k, "/"+l) {
				return n, frag
			}
		}
		return nil, ""
	}
	return pickNearest(imp.base[l], d.dir, func(n *node) string {
		if n.src != nil {
			return n.src.path
		}
		return n.dir
	}), frag
}

func pickNearest[T any](list []T, dir string, pathOf func(T) string) T {
	var zero T
	if len(list) == 0 {
		return zero
	}
	for _, x := range list {
		if path.Dir(pathOf(x)) == dir {
			return x
		}
	}
	best := list[0]
	for _, x := range list[1:] {
		if strings.Count(pathOf(x), "/") < strings.Count(pathOf(best), "/") {
			best = x
		}
	}
	return best
}

// embed is ![[target]]: a page becomes a link to it; a file its image, player or file block.
func (d *doc) embed(n *html.Node, target string) *html.Node {
	name, _, _ := strings.Cut(target, "#")
	ext := strings.ToLower(path.Ext(name))
	if ext == "" || ext == ".md" || ext == ".canvas" {
		if t, f := d.imp.wikiTarget(target, d); t != nil {
			return d.pageLink(n, t, f)
		}
	}
	f := d.imp.assetFile(name, d)
	var a *Asset
	if f != nil {
		a = d.imp.asset(f)
	}
	if a == nil {
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	}
	alt := strings.TrimSpace(textOf(n))
	if _, err := strconv.Atoi(strings.SplitN(alt, "x", 2)[0]); err == nil {
		alt = "" // ![[image.png|300]] is a width
	}
	with := assetBlock(a, alt)
	replaceWith(n, with, false)
	return with
}

// assetFile is the file a link names: by its path from the note, from the vault's top,
// or (as Obsidian finds attachments) by its name anywhere.
func (imp *importer) assetFile(name string, d *doc) *file {
	p, _ := d.resolvePath(name)
	if f := imp.fileAt(p); f != nil {
		return f
	}
	clean := strings.TrimPrefix(strings.ReplaceAll(name, `\`, "/"), "/")
	if u, err := url.PathUnescape(clean); err == nil {
		clean = u
	}
	if f := imp.fileAt(path.Clean(clean)); f != nil {
		return f
	}
	return pickNearest(imp.assetBase[strings.ToLower(path.Base(clean))], d.dir, func(f *file) string { return f.path })
}

func (imp *importer) fileAt(p string) *file {
	if p == "" || p == "." {
		return nil
	}
	f := imp.fs.byPath[p]
	if f == nil {
		f = imp.fs.lower[strings.ToLower(p)]
	}
	if f == nil || sourceKind(f.path) != "" {
		return nil
	}
	return f
}

func (d *doc) assetAt(href string) *Asset {
	f := d.imp.assetFile(href, d)
	if f == nil {
		return nil
	}
	return d.imp.asset(f)
}

// asset takes a file a page uses: never a program or a script, nor a file over the
// attachment limit.
func (imp *importer) asset(f *file) *Asset {
	if a, ok := imp.assets[f.path]; ok {
		return a
	}
	imp.assets[f.path] = nil
	name := hd.CleanFilename(path.Base(f.path))
	if hd.IsExecutable(nil, name) {
		imp.skip(f.path, "executable")
		return nil
	}
	data, err := imp.fs.load(f, MaxFileBytes)
	switch {
	case errors.Is(err, errFileTooLarge):
		imp.skip(f.path, "too_large")
		return nil
	case err != nil:
		if imp.err == nil {
			imp.err = err
		}
		return nil
	case len(data) == 0:
		imp.skip(f.path, "unreadable")
		return nil
	}
	return imp.addAsset(f.path, name, data)
}

func (imp *importer) addAsset(key, name string, data []byte) *Asset {
	head := data[:min(len(data), 4096)]
	if hd.IsExecutable(head, name) {
		imp.skip(key, "executable")
		return nil
	}
	mime := strings.TrimSpace(strings.SplitN(hd.DetectType(head, name), ";", 2)[0])
	a := &Asset{Ref: imp.newRef(), Key: key, Name: name, MIME: mime, Data: data}
	imp.assets[key] = a
	imp.order = append(imp.order, a)
	return a
}

// assetBlock is the block that shows a file: an image, a player, or the file.
func assetBlock(a *Asset, alt string) *html.Node {
	switch {
	case hd.InlineSafe(a.MIME):
		return elem("img", "src", attachmentURL(a.Ref), "alt", alt)
	case strings.HasPrefix(a.MIME, "video/"):
		return elem("div", "data-type", "video", "data-src", attachmentURL(a.Ref), "data-name", a.Name, "data-size", strconv.Itoa(len(a.Data)), "data-mime", a.MIME)
	case strings.HasPrefix(a.MIME, "audio/"):
		return elem("div", "data-type", "audio", "data-src", attachmentURL(a.Ref), "data-name", a.Name, "data-size", strconv.Itoa(len(a.Data)), "data-mime", a.MIME)
	}
	return elem("div", "data-type", "file", "data-src", attachmentURL(a.Ref), "data-name", a.Name, "data-size", strconv.Itoa(len(a.Data)), "data-mime", a.MIME)
}

var dataURI = regexp.MustCompile(`^data:(image/(?:png|jpeg|gif|webp));base64,`)

func (d *doc) fixImage(n *html.Node) *html.Node {
	src := strings.TrimSpace(getAttr(n, "src"))
	alt := getAttr(n, "alt")
	caption := getAttr(n, "data-caption")
	gone := func() *html.Node {
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	}
	var a *Asset
	switch {
	case dataURI.MatchString(src):
		m := dataURI.FindStringSubmatch(src)
		enc := src[len(m[0]):]
		if base64.StdEncoding.DecodedLen(len(enc)) > MaxFileBytes {
			d.imp.skip("data:"+m[1], "too_large")
			return gone()
		}
		data, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(enc), ""))
		if err != nil || len(data) == 0 {
			return gone()
		}
		d.imp.dataN++
		ext := "." + strings.TrimPrefix(m[1], "image/")
		key := "data:" + strconv.Itoa(d.imp.dataN)
		if d.node != nil {
			key = d.node.Key + "#image-" + strconv.Itoa(d.imp.dataN)
		}
		if a = d.imp.addAsset(key, "image-"+strconv.Itoa(d.imp.dataN)+ext, data); a == nil {
			return gone()
		}
	case strings.HasPrefix(src, "/v1/attachments/"):
		if !d.knownRef(refIn(src)) {
			return gone()
		}
	case isRemote(src):
		if s := strings.ToLower(src); !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "http://") {
			return gone()
		}
	case src == "":
		return gone()
	default:
		if a = d.assetAt(src); a == nil {
			return gone()
		}
	}
	if a != nil {
		if !hd.InlineSafe(a.MIME) {
			with := assetBlock(a, alt)
			replaceWith(n, with, false)
			return with
		}
		src = attachmentURL(a.Ref)
	}
	attrs := []html.Attribute{{Key: "src", Val: src}, {Key: "alt", Val: alt}}
	if caption != "" {
		attrs = append(attrs, html.Attribute{Key: "data-caption", Val: truncateRunes(caption, 500)})
	}
	for _, k := range []string{"data-width", "data-align"} {
		if v := getAttr(n, k); v != "" {
			attrs = append(attrs, html.Attribute{Key: k, Val: v})
		}
	}
	n.Attr = attrs
	return n
}

// fixMedia turns players and frames into the wiki's video, audio and embed blocks.
func (d *doc) fixMedia(n *html.Node) *html.Node {
	gone := func() *html.Node {
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	}
	src := getAttr(n, "src")
	if src == "" {
		if s := find(n, func(c *html.Node) bool { return c.Data == "source" }); s != nil {
			src = getAttr(s, "src")
		}
	}
	if n.Data == "source" || src == "" {
		return gone()
	}
	if n.Data == "iframe" {
		if !strings.HasPrefix(strings.ToLower(src), "https://") {
			return gone()
		}
		with := elem("div", "data-type", "embed", "data-url", src)
		replaceWith(n, with, false)
		return with
	}
	var with *html.Node
	switch {
	case strings.HasPrefix(strings.ToLower(src), "https://"):
		with = elem("div", "data-type", n.Data, "data-src", src, "data-name", path.Base(src))
	case isRemote(src):
		return gone()
	default:
		a := d.assetAt(src)
		if a == nil {
			return gone()
		}
		with = assetBlock(a, "")
	}
	replaceWith(n, with, false)
	return with
}
