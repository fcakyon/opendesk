package wikiport

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// The normalizer turns HTML from any source (the Markdown parser's, Notion's, Confluence's,
// a word processor's) into the wiki's blocks (contracts/wiki.md "Blocks"): links and
// files resolved to refs, each block in the element the editor writes, inline runs in
// paragraphs. hd.SanitizeWiki has the last word on what stays.

func parseFragment(body string) *html.Node {
	root := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(body), root)
	if err != nil {
		return root
	}
	for _, n := range nodes {
		root.AppendChild(n)
	}
	return root
}

func renderChildren(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		_ = html.Render(&b, c)
	}
	return b.String()
}

func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func hasAttr(n *html.Node, key string) bool {
	return slices.ContainsFunc(n.Attr, func(a html.Attribute) bool { return a.Key == key })
}

func setAttr(n *html.Node, key, val string) {
	for i, a := range n.Attr {
		if a.Key == key {
			n.Attr[i].Val = val
			return
		}
	}
	n.Attr = append(n.Attr, html.Attribute{Key: key, Val: val})
}

func delAttr(n *html.Node, keys ...string) {
	n.Attr = slices.DeleteFunc(n.Attr, func(a html.Attribute) bool { return slices.Contains(keys, a.Key) })
}

func hasClass(n *html.Node, class string) bool {
	return slices.Contains(strings.Fields(getAttr(n, "class")), class)
}

func classWithPrefix(n *html.Node, prefix string) string {
	for _, c := range strings.Fields(getAttr(n, "class")) {
		if strings.HasPrefix(c, prefix) {
			return c
		}
	}
	return ""
}

func elem(tag string, attrs ...string) *html.Node {
	n := &html.Node{Type: html.ElementNode, Data: tag, DataAtom: atom.Lookup([]byte(tag))}
	for i := 0; i+1 < len(attrs); i += 2 {
		n.Attr = append(n.Attr, html.Attribute{Key: attrs[i], Val: attrs[i+1]})
	}
	return n
}

func textNode(s string) *html.Node { return &html.Node{Type: html.TextNode, Data: s} }

// textOf is a node's visible text.
func textOf(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && (c.Data == "script" || c.Data == "style") {
			continue
		}
		b.WriteString(textOf(c))
	}
	return b.String()
}

// unwrap puts n's children in its place.
func unwrap(n *html.Node) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		n.RemoveChild(c)
		n.Parent.InsertBefore(c, n)
		c = next
	}
	n.Parent.RemoveChild(n)
}

// replaceWith puts with in n's place, n's children moved into it when keep.
func replaceWith(n, with *html.Node, keep bool) {
	if keep {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			n.RemoveChild(c)
			with.AppendChild(c)
			c = next
		}
	}
	n.Parent.InsertBefore(with, n)
	n.Parent.RemoveChild(n)
}

func find(n *html.Node, match func(*html.Node) bool) *html.Node {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && match(c) {
			return c
		}
		if f := find(c, match); f != nil {
			return f
		}
	}
	return nil
}

func clearChildren(n *html.Node) {
	for n.FirstChild != nil {
		n.RemoveChild(n.FirstChild)
	}
}

var (
	// blockTags are the blocks the wiki keeps, as elements.
	blockTags = map[string]bool{"p": true, "h1": true, "h2": true, "h3": true, "ul": true, "ol": true, "blockquote": true,
		"pre": true, "table": true, "img": true, "details": true, "hr": true, "div": true}
	// inlineTags are the inline elements the wiki keeps.
	inlineTags = map[string]bool{"a": true, "strong": true, "em": true, "u": true, "s": true, "code": true, "br": true,
		"span": true, "mark": true, "time": true}
	renames = map[string]string{"b": "strong", "i": "em", "del": "s", "strike": "s", "ins": "u", "h4": "h3", "h5": "h3",
		"h6": "h3", "tt": "code", "kbd": "code", "samp": "code", "var": "em", "cite": "em", "dfn": "em"}
	// atomTypes are wiki blocks drawn from their attributes alone.
	atomTypes = []string{"file", "video", "audio", "bookmark", "embed", "toc", "subpage", "database", "block-math"}
	// containerTypes hold blocks.
	containerTypes = []string{"callout", "columns", "column", "detailsContent"}
	// dropTags go with what is in them.
	dropTags = map[string]bool{"script": true, "style": true, "head": true, "title": true, "noscript": true, "template": true,
		"object": true, "embed": true, "applet": true, "svg": true, "form": true, "button": true, "select": true, "textarea": true,
		"nav": true, "colgroup": true, "meta": true, "link": true, "base": true}
	tones = []string{"gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}
)

// normalize shapes a document's body in place.
func (d *doc) normalize(root *html.Node) {
	d.walk(root)
	hoistImages(root)
	d.blockify(root)
	dropEmpty(root)
}

func (d *doc) walk(parent *html.Node) {
	for c := parent.FirstChild; c != nil; {
		next := d.fix(c)
		if next == c {
			if c.Type == html.ElementNode {
				d.walk(c)
				d.after(c)
			}
			next = c.NextSibling
		}
		c = next
	}
}

// fix rewrites one node. It answers n when n stays (its children are walked next), or the
// node to go on from: the first of its children once it is unwrapped, what took its
// place (fixed in turn), or its next sibling once it is gone.
func (d *doc) fix(n *html.Node) *html.Node {
	if n.Type == html.CommentNode || n.Type == html.DoctypeNode {
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	}
	if n.Type != html.ElementNode {
		return n
	}
	gone := func() *html.Node {
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	}
	open := func() *html.Node {
		first, next := n.FirstChild, n.NextSibling
		unwrap(n)
		if first != nil {
			return first
		}
		return next
	}
	swap := func(with *html.Node, keep bool) *html.Node {
		replaceWith(n, with, keep)
		return with
	}
	if to, ok := renames[n.Data]; ok {
		return swap(elem(to, keepAttrs(n, "class", "style")...), true)
	}
	if dropTags[n.Data] {
		return gone()
	}
	switch n.Data {
	case "a":
		return d.fixLink(n)
	case "img":
		return d.fixImage(n)
	case "video", "audio", "source", "iframe":
		return d.fixMedia(n)
	case "input":
		return gone() // a to-do's box: its item says whether it is checked
	case "figure":
		return d.fixFigure(n)
	case "figcaption":
		return swap(elem("p"), true)
	case "aside":
		return swap(calloutFrom(n), true)
	case "details":
		shapeDetails(n)
		return n
	case "summary":
		if n.Parent == nil || n.Parent.Data != "details" {
			return swap(elem("p"), true)
		}
		return n
	case "pre":
		shapePre(n)
		return n
	case "ul", "ol":
		if n.Data == "ul" && (hasClass(n, "toggle") || hasClass(n, "notion-toggle")) {
			for c := n.FirstChild; c != nil; { // Notion wraps each toggle in a list of one
				next := c.NextSibling
				if c.Type == html.ElementNode && c.Data == "li" {
					unwrap(c)
				}
				c = next
			}
			return open()
		}
		if hasClass(n, "to-do-list") {
			setAttr(n, "data-type", "taskList")
		}
		delAttr(n, "class", "style", "start", "type")
		return n
	case "li":
		d.fixItem(n)
		return n
	case "span", "mark", "font":
		return d.fixSpan(n)
	case "time":
		return n
	case "div", "section", "article", "main", "header", "footer", "body", "html", "center", "dl", "dd", "dt", "address", "label":
		return d.fixDiv(n, open, swap)
	case "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col":
		if n.Data == "caption" {
			return swap(elem("p"), true)
		}
		return n
	case "p", "h1", "h2", "h3", "blockquote", "hr", "br", "strong", "em", "u", "s", "code", "sub", "sup", "small", "abbr", "q":
		delAttr(n, "data-mention")
		if n.Data == "sub" || n.Data == "sup" || n.Data == "small" || n.Data == "abbr" || n.Data == "q" {
			return open()
		}
		d.styleMarks(n)
		if n.Data == "h1" || n.Data == "h2" || n.Data == "h3" {
			d.headingID(n)
		}
		return n
	}
	return open()
}

// keepAttrs copies the named attributes of n.
func keepAttrs(n *html.Node, keys ...string) []string {
	var out []string
	for _, a := range n.Attr {
		if slices.Contains(keys, a.Key) {
			out = append(out, a.Key, a.Val)
		}
	}
	return out
}

// after runs once a node's children are fixed.
func (d *doc) after(n *html.Node) {
	switch {
	case n.Data == "ul" && getAttr(n, "data-type") == "":
		// A list whose every item is a to-do is a to-do list.
		all, any := true, false
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "li" {
				if getAttr(c, "data-type") == "taskItem" {
					any = true
				} else {
					all = false
				}
			}
		}
		if any && all {
			setAttr(n, "data-type", "taskList")
		}
	case n.Data == "ul" && getAttr(n, "data-type") == "taskList":
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "li" && getAttr(c, "data-type") == "" {
				setAttr(c, "data-type", "taskItem")
				setAttr(c, "data-checked", "false")
			}
		}
	case n.Data == "ol" || n.Data == "ul":
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "li" {
				delAttr(c, "data-type", "data-checked")
			}
		}
	}
	if n.Data == "div" && slices.Contains(containerTypes, getAttr(n, "data-type")) || slices.Contains([]string{"blockquote", "li", "td", "th"}, n.Data) {
		d.blockify(n)
	}
	if n.Data == "details" {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "div" {
				d.blockify(c)
			}
		}
	}
}

func (d *doc) fixDiv(n *html.Node, open func() *html.Node, swap func(*html.Node, bool) *html.Node) *html.Node {
	t := getAttr(n, "data-type")
	switch {
	case slices.Contains(atomTypes, t):
		clearChildren(n)
		if t == "file" || t == "video" || t == "audio" {
			if src := getAttr(n, "data-src"); src != "" && !isRemote(src) && !strings.HasPrefix(src, "/v1/attachments/") {
				if a := d.assetAt(src); a != nil {
					setAttr(n, "data-src", attachmentURL(a.Ref))
				} else {
					next := n.NextSibling
					n.Parent.RemoveChild(n)
					return next
				}
			}
		}
		if (t == "subpage" || t == "database") && !d.knownRef(getAttr(n, "data-id")) {
			next := n.NextSibling
			n.Parent.RemoveChild(n)
			return next
		}
		return n
	case slices.Contains(containerTypes, t):
		if t == "columns" {
			cols := 0
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && (getAttr(c, "data-type") == "column" || hasClass(c, "column")) {
					cols++
				}
			}
			if cols < 2 || cols > 5 {
				return open()
			}
		}
		return n
	case hasClass(n, "column-list"):
		cols := 0
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && hasClass(c, "column") {
				cols++
			}
		}
		if cols >= 2 && cols <= 5 {
			return swap(elem("div", "data-type", "columns"), true)
		}
		return open()
	case hasClass(n, "column") && n.Parent != nil && getAttr(n.Parent, "data-type") == "columns":
		return swap(elem("div", "data-type", "column"), true)
	case classWithPrefix(n, "confluence-information-macro-") != "":
		kind := strings.TrimPrefix(classWithPrefix(n, "confluence-information-macro-"), "confluence-information-macro-")
		tone := map[string]string{"note": "orange", "information": "blue", "tip": "green", "warning": "red"}[kind]
		if tone == "" {
			return open()
		}
		icon := map[string]string{"note": "📝", "information": "ℹ️", "tip": "💡", "warning": "⚠️"}[kind]
		return swap(elem("div", "data-type", "callout", "data-icon", icon, "data-tone", tone), true)
	case hasClass(n, "checkbox"):
		next := n.NextSibling
		n.Parent.RemoveChild(n)
		return next
	case hasClass(n, "katex-display") || hasClass(n, "equation-container"):
		return swap(mathNode(n, true), false)
	}
	return open()
}

// fixItem marks a to-do: Notion's box, or a checkbox input at the item's start.
func (d *doc) fixItem(n *html.Node) {
	if getAttr(n, "data-type") == "taskItem" {
		if getAttr(n, "data-checked") != "true" {
			setAttr(n, "data-checked", "false")
		}
		return
	}
	box := find(n, func(c *html.Node) bool {
		return c.Data == "input" && strings.EqualFold(getAttr(c, "type"), "checkbox") || c.Data == "div" && hasClass(c, "checkbox")
	})
	if box == nil {
		delAttr(n, "data-type", "data-checked")
		return
	}
	checked := hasAttr(box, "checked") || hasClass(box, "checkbox-on")
	n.Attr = []html.Attribute{{Key: "data-type", Val: "taskItem"}, {Key: "data-checked", Val: map[bool]string{true: "true", false: "false"}[checked]}}
	box.Parent.RemoveChild(box)
}

// fixSpan keeps tones (the wiki's, Notion's highlight classes), mentions, equations and
// emphasis written as styles.
func (d *doc) fixSpan(n *html.Node) *html.Node {
	if getAttr(n, "data-type") == "inline-math" {
		clearChildren(n)
		return n
	}
	// A mention names a person by id: one from an upload is only its text, as is any
	// other id an upload names that isn't one of its own pages or files.
	delAttr(n, "data-mention", "data-id")
	if hasClass(n, "notion-text-equation-token") || hasClass(n, "katex") {
		with := mathNode(n, false)
		replaceWith(n, with, false)
		return with
	}
	if c := classWithPrefix(n, "highlight-"); c != "" {
		tone := strings.TrimPrefix(c, "highlight-")
		bg := strings.HasSuffix(tone, "_background")
		tone = strings.TrimSuffix(tone, "_background")
		if slices.Contains(tones, tone) {
			var with *html.Node
			if bg {
				with = elem("mark", "data-bg", tone)
			} else {
				with = elem("span", "data-color", tone)
			}
			replaceWith(n, with, true)
			return with
		}
	}
	if n.Data == "mark" {
		bg := getAttr(n, "data-bg")
		n.Attr = nil
		if slices.Contains(tones, bg) {
			setAttr(n, "data-bg", bg)
		}
		return n
	}
	if tone := getAttr(n, "data-color"); n.Data == "span" && slices.Contains(tones, tone) {
		n.Attr = []html.Attribute{{Key: "data-color", Val: tone}}
		return n
	}
	if outer, inner := styleWrap(n); outer != nil {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			n.RemoveChild(c)
			inner.AppendChild(c)
			c = next
		}
		replaceWith(n, outer, false)
		return outer
	}
	first, next := n.FirstChild, n.NextSibling
	unwrap(n)
	if first != nil {
		return first
	}
	return next
}

// styleWrap is the emphasis a span's inline style asks for (word processors' exports):
// the outermost element and the one its text goes in.
func styleWrap(n *html.Node) (outer, inner *html.Node) {
	style := strings.ToLower(strings.ReplaceAll(getAttr(n, "style"), " ", ""))
	if style == "" {
		return nil, nil
	}
	var tags []string
	if containsAny(style, "font-weight:bold", "font-weight:600", "font-weight:700", "font-weight:800", "font-weight:900") {
		tags = append(tags, "strong")
	}
	if strings.Contains(style, "font-style:italic") {
		tags = append(tags, "em")
	}
	if strings.Contains(style, "line-through") {
		tags = append(tags, "s")
	}
	if strings.Contains(style, "underline") {
		tags = append(tags, "u")
	}
	for _, t := range tags {
		x := elem(t)
		if outer == nil {
			outer = x
		} else {
			inner.AppendChild(x)
		}
		inner = x
	}
	return outer, inner
}

// styleMarks drops a block's attributes but its alignment and the wiki's tones.
func (d *doc) styleMarks(n *html.Node) {
	var keep []html.Attribute
	for _, a := range n.Attr {
		switch a.Key {
		case "data-color", "data-bg":
			if slices.Contains(tones, a.Val) {
				keep = append(keep, a)
			}
		case "style":
			if al := textAlign(a.Val); al != "" {
				keep = append(keep, html.Attribute{Key: "style", Val: "text-align: " + al + ";"})
			}
		case "class":
			if n.Data == "code" && codeLanguage(a.Val) != "" {
				keep = append(keep, html.Attribute{Key: "class", Val: "language-" + codeLanguage(a.Val)})
			}
		}
	}
	n.Attr = keep
}

func textAlign(style string) string {
	style = strings.ToLower(strings.ReplaceAll(style, " ", ""))
	for _, al := range []string{"center", "right", "justify"} {
		if strings.Contains(style, "text-align:"+al) {
			return al
		}
	}
	return ""
}

// mathNode is an equation from KaTeX's markup: its TeX source, kept in an annotation.
func mathNode(n *html.Node, block bool) *html.Node {
	latex := ""
	if a := find(n, func(c *html.Node) bool { return c.Data == "annotation" }); a != nil {
		latex = strings.TrimSpace(textOf(a))
	}
	if latex == "" {
		latex = strings.TrimSpace(textOf(n))
	}
	if block {
		return elem("div", "data-type", "block-math", "data-latex", latex)
	}
	return elem("span", "data-type", "inline-math", "data-latex", latex)
}

// calloutFrom is the callout an <aside> or Notion's callout figure becomes: an emoji at
// its start is its icon.
func calloutFrom(n *html.Node) *html.Node {
	icon := ""
	if ic := find(n, func(c *html.Node) bool { return hasClass(c, "icon") }); ic != nil {
		icon = strings.TrimSpace(textOf(ic))
		ic.Parent.RemoveChild(ic)
	} else if t := firstText(n); t != nil {
		e, rest := leadingEmoji(t.Data)
		if e != "" {
			icon, t.Data = e, rest
		}
	}
	if !validIcon(icon) {
		icon = "💡"
	}
	return elem("div", "data-type", "callout", "data-icon", icon, "data-tone", "gray")
}

func firstText(n *html.Node) *html.Node {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			if strings.TrimSpace(c.Data) != "" {
				return c
			}
			continue
		}
		if c.Type == html.ElementNode {
			if c.Data == "img" {
				return nil
			}
			if t := firstText(c); t != nil {
				return t
			}
		}
	}
	return nil
}

// leadingEmoji splits an emoji (with its variation selector, skin tone, keycap, tags and
// the emoji joined to it) off the start of s.
func leadingEmoji(s string) (string, string) {
	t := strings.TrimLeft(s, " \n\t")
	r, size := utf8.DecodeRuneInString(t)
	if !pictographic(r) {
		return "", s
	}
	i := size
	for i < len(t) {
		r, size := utf8.DecodeRuneInString(t[i:])
		switch {
		case r == 0xFE0F || r == 0x20E3 || (r >= 0x1F3FB && r <= 0x1F3FF) || (r >= 0xE0020 && r <= 0xE007F):
			i += size
		case r >= 0x1F1E6 && r <= 0x1F1FF: // the second regional indicator of a flag
			i += size
		case r == 0x200D:
			next, n := utf8.DecodeRuneInString(t[i+size:])
			if !pictographic(next) {
				return t[:i], strings.TrimLeft(t[i:], " ")
			}
			i += size + n
		default:
			return t[:i], strings.TrimLeft(t[i:], " ")
		}
	}
	return t[:i], ""
}

func pictographic(r rune) bool {
	return r >= 0x1F000 && r <= 0x1FAFF || r >= 0x2600 && r <= 0x27BF || r >= 0x2B00 && r <= 0x2BFF ||
		r >= 0x2190 && r <= 0x21FF || r >= 0x2300 && r <= 0x23FF || r == 0x00A9 || r == 0x00AE || r == 0x203C ||
		r == 0x2049 || r == 0x2122 || r == 0x2139 || r == 0x3030 || r == 0x303D
}

// validIcon is a short emoji without letters, digits or markup; the wiki checks it in full.
func validIcon(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > 16 {
		return false
	}
	for _, r := range s {
		if r < 0x80 || unicode.IsLetter(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func shapeDetails(n *html.Node) {
	delAttr(n, "open", "class", "style")
	var summary *html.Node
	var content *html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "summary" && summary == nil {
			summary = c
		}
		if c.Type == html.ElementNode && c.Data == "div" && getAttr(c, "data-type") == "detailsContent" {
			content = c
		}
	}
	if summary == nil {
		summary = elem("summary")
		n.InsertBefore(summary, n.FirstChild)
	}
	if content == nil {
		content = elem("div", "data-type", "detailsContent")
		n.AppendChild(content)
	}
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c != summary && c != content {
			n.RemoveChild(c)
			content.AppendChild(c)
		}
		c = next
	}
	n.RemoveChild(summary)
	n.InsertBefore(summary, n.FirstChild)
}

func shapePre(n *html.Node) {
	var code *html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "code" {
			code = c
		}
	}
	lang := codeLanguage(strings.TrimPrefix(classWithPrefix(n, "language-"), "language-"))
	if code != nil {
		if l := codeLanguage(strings.TrimPrefix(classWithPrefix(code, "language-"), "language-")); l != "" {
			lang = l
		}
	}
	text := textOf(n)
	clearChildren(n)
	n.Attr = nil
	c := elem("code")
	if lang != "" {
		setAttr(c, "class", "language-"+lang)
	}
	c.AppendChild(textNode(strings.TrimSuffix(text, "\n")))
	n.AppendChild(c)
}

func (d *doc) fixFigure(n *html.Node) *html.Node {
	if hasClass(n, "callout") {
		with := calloutFrom(n)
		replaceWith(n, with, true)
		return with
	}
	if hasClass(n, "equation") {
		with := mathNode(n, true)
		replaceWith(n, with, false)
		return with
	}
	// An image and its caption.
	if img := find(n, func(c *html.Node) bool { return c.Data == "img" }); img != nil {
		if cap := find(n, func(c *html.Node) bool { return c.Data == "figcaption" }); cap != nil {
			if t := strings.TrimSpace(textOf(cap)); t != "" {
				setAttr(img, "data-caption", truncateRunes(t, 500))
			}
			cap.Parent.RemoveChild(cap)
		}
	}
	first, next := n.FirstChild, n.NextSibling
	unwrap(n)
	if first != nil {
		return first
	}
	return next
}

// headingID gives a heading the block id links to it use (Note#Heading).
func (d *doc) headingID(n *html.Node) {
	if d == nil || d.node == nil {
		return
	}
	if slug := slugify(textOf(n)); slug != "" {
		setAttr(n, "data-block-id", d.imp.blockID(d.node.Key, slug))
	}
}

// blockify wraps runs of inline content in a container into paragraphs, and drops
// whitespace between blocks.
func (d *doc) blockify(n *html.Node) {
	var run []*html.Node
	flush := func(before *html.Node) {
		if len(run) == 0 {
			return
		}
		keep := false
		for _, c := range run {
			if c.Type != html.TextNode || strings.TrimSpace(c.Data) != "" {
				keep = true
			}
		}
		if !keep {
			for _, c := range run {
				n.RemoveChild(c)
			}
			run = nil
			return
		}
		p := elem("p")
		n.InsertBefore(p, before)
		for _, c := range run {
			n.RemoveChild(c)
			p.AppendChild(c)
		}
		trimEdges(p)
		run = nil
	}
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if isBlock(c) {
			flush(c)
		} else if c.Type == html.ElementNode && c.Data == "br" && len(run) == 0 {
			n.RemoveChild(c) // a break between blocks
		} else {
			run = append(run, c)
		}
		c = next
	}
	flush(nil)
}

func isBlock(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	if n.Data == "summary" {
		return true
	}
	return blockTags[n.Data]
}

// trimEdges trims a paragraph's leading and trailing whitespace and breaks.
func trimEdges(p *html.Node) {
	for p.FirstChild != nil && (p.FirstChild.Type == html.TextNode && strings.TrimSpace(p.FirstChild.Data) == "" || p.FirstChild.Data == "br") {
		p.RemoveChild(p.FirstChild)
	}
	for p.LastChild != nil && (p.LastChild.Type == html.TextNode && strings.TrimSpace(p.LastChild.Data) == "" || p.LastChild.Data == "br") {
		p.RemoveChild(p.LastChild)
	}
	if p.FirstChild != nil && p.FirstChild.Type == html.TextNode {
		p.FirstChild.Data = strings.TrimLeft(p.FirstChild.Data, " \n\t")
	}
	if p.LastChild != nil && p.LastChild.Type == html.TextNode {
		p.LastChild.Data = strings.TrimRight(p.LastChild.Data, " \n\t")
	}
}

// hoistImages moves images, files, players and the other blocks drawn from attributes out
// of paragraphs and headings: each is a block of its own.
func hoistImages(root *html.Node) {
	var imgs []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && (c.Data == "img" || c.Data == "div" && slices.Contains(atomTypes, getAttr(c, "data-type"))) {
				imgs = append(imgs, c)
			}
			collect(c)
		}
	}
	collect(root)
	for _, img := range imgs {
		block := img.Parent
		for block != nil && block != root && !slices.Contains([]string{"p", "h1", "h2", "h3"}, block.Data) {
			if isBlock(block) {
				block = nil
				break
			}
			block = block.Parent
		}
		if block == nil || block == root {
			continue
		}
		splitAround(block, img)
	}
}

// splitAround splits block in two at img, leaving img between the halves.
func splitAround(block, img *html.Node) {
	after := &html.Node{Type: html.ElementNode, Data: block.Data, DataAtom: block.DataAtom, Attr: slices.Clone(block.Attr)}
	delAttr(after, "data-block-id")
	// Move everything after img (at each level up to block) into after.
	var path []*html.Node
	for x := img; x != block; x = x.Parent {
		path = append(path, x)
	}
	dst := after
	for i := len(path) - 1; i >= 0; i-- {
		x := path[i]
		if i > 0 { // an inline wrapper: copy it into after
			cp := &html.Node{Type: html.ElementNode, Data: x.Data, DataAtom: x.DataAtom, Attr: slices.Clone(x.Attr)}
			for s := path[i-1].NextSibling; s != nil; {
				next := s.NextSibling
				x.RemoveChild(s)
				cp.AppendChild(s)
				s = next
			}
			dst.InsertBefore(cp, dst.FirstChild)
			for s := x.NextSibling; s != nil; {
				next := s.NextSibling
				x.Parent.RemoveChild(s)
				dst.AppendChild(s)
				s = next
			}
			dst = cp
			continue
		}
		for s := x.NextSibling; s != nil; {
			next := s.NextSibling
			x.Parent.RemoveChild(s)
			dst.AppendChild(s)
			s = next
		}
	}
	img.Parent.RemoveChild(img)
	block.Parent.InsertBefore(img, block.NextSibling)
	block.Parent.InsertBefore(after, img.NextSibling)
	for _, p := range []*html.Node{block, after} {
		trimEdges(p)
	}
}

// dropEmpty removes paragraphs, headings and inline wrappers with nothing in them.
func dropEmpty(n *html.Node) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode {
			dropEmpty(c)
			if c.Data == "p" || c.Data == "h1" || c.Data == "h2" || c.Data == "h3" {
				trimEdges(c)
			}
			switch c.Data {
			case "p", "h1", "h2", "h3", "strong", "em", "u", "s", "mark", "a", "blockquote", "ul", "ol", "li":
				if c.FirstChild == nil || (c.Data == "p" && strings.TrimSpace(textOf(c)) == "" && find(c, func(x *html.Node) bool { return x.Data == "img" || x.Data == "span" || x.Data == "time" }) == nil) {
					if !(c.Data == "li" || c.Data == "a" && getAttr(c, "data-type") == "page") {
						n.RemoveChild(c)
					}
				}
			case "span":
				if c.FirstChild == nil && getAttr(c, "data-type") != "inline-math" {
					n.RemoveChild(c)
				}
			}
		}
		c = next
	}
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// slugify is a heading's anchor: lower case, words joined by "-".
func slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
			continue
		}
		dash = true
	}
	return b.String()
}
