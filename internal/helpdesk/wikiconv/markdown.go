package wikiconv

import (
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// MarkdownOptions says how links to other wiki pages are written.
type MarkdownOptions struct {
	// PageLink is the Markdown for a link to the page with this id ("[[Title]]" in an
	// Obsidian vault, "[Title](Title.md)" elsewhere); ok false keeps only the link's text.
	PageLink func(id string) (md string, ok bool)
}

// Markdown is the page body as Markdown with Obsidian's extensions where Markdown has
// none: callouts and toggles as callouts, highlights as ==text==, math as $…$, synced
// blocks as embeds (![[…]]), footnotes as [^1].
func Markdown(body string, opt MarkdownOptions) string {
	root := parse(body)
	m := mdWriter{opt: opt, notes: footnoteNumbers(root)}
	out := m.blocks(root)
	return strings.TrimSpace(blankRuns.ReplaceAllString(out, "\n\n")) + "\n"
}

var blankRuns = regexp.MustCompile(`\n{3,}`)

type mdWriter struct {
	opt MarkdownOptions
	// notes numbers the page's footnotes by their id (footnoteNumbers).
	notes map[string]int
}

// blocks renders a node's children as blocks separated by blank lines.
func (m mdWriter) blocks(n *html.Node) string {
	var parts []string
	var run []*html.Node // inline content outside a block (a bare text node, a stray span)
	flush := func() {
		if len(run) == 0 {
			return
		}
		var b strings.Builder
		for _, c := range run {
			b.WriteString(m.inline(c))
		}
		if s := strings.TrimSpace(b.String()); s != "" {
			parts = append(parts, guardLineStart(s))
		}
		run = nil
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if !isBlock(c) {
			run = append(run, c)
			continue
		}
		flush()
		if s := m.block(c); strings.TrimSpace(s) != "" {
			parts = append(parts, s)
		}
	}
	flush()
	return strings.Join(parts, "\n\n")
}

var blockTags = map[string]bool{"p": true, "h1": true, "h2": true, "h3": true, "h4": true, "ul": true, "ol": true,
	"li": true, "blockquote": true, "pre": true, "hr": true, "table": true, "details": true, "summary": true,
	"div": true, "figure": true}

func isBlock(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	if n.Data == "img" {
		return n.Parent != nil && n.Parent.Parent == nil // a top-level image is a block
	}
	return blockTags[n.Data]
}

func (m mdWriter) block(n *html.Node) string {
	switch kind(n) {
	case "p":
		return guardLineStart(strings.TrimSpace(m.inlines(n)))
	case "h1", "h2", "h3", "h4":
		level := int(n.Data[1] - '0')
		return strings.Repeat("#", level) + " " + strings.TrimSpace(m.inlines(n))
	case "ul", "ol", "taskList":
		return m.list(n)
	case "blockquote":
		return quote(m.blocks(n), "")
	case "pre":
		lang := ""
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "code" {
				lang = strings.TrimPrefix(attr(c, "class"), "language-")
			}
		}
		code := strings.TrimRight(text(n), "\n")
		fence := "```"
		for strings.Contains(code, fence) {
			fence += "`"
		}
		return fence + lang + "\n" + code + "\n" + fence
	case "hr":
		return "---"
	case "img":
		return m.image(n)
	case "table":
		return m.table(n)
	case "callout":
		return quote(m.blocks(n), "[!"+calloutType(attr(n, "data-tone"))+"]")
	case "details":
		if level := attr(n, "data-heading"); level == "1" || level == "2" || level == "3" {
			// A toggle heading: Obsidian folds a heading and what is under it on its own.
			var parts []string
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type != html.ElementNode {
					continue
				}
				if c.Data == "summary" {
					parts = append(parts, strings.Repeat("#", int(level[0]-'0'))+" "+strings.TrimSpace(m.inlines(c)))
				} else if s := m.blocks(c); strings.TrimSpace(s) != "" {
					parts = append(parts, s)
				}
			}
			return strings.Join(parts, "\n\n")
		}
		summary := ""
		var body strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "summary" {
				summary = strings.TrimSpace(m.inlines(c))
				continue
			}
			if c.Type == html.ElementNode {
				body.WriteString(m.blocks(c))
			}
		}
		return quote(body.String(), "[!note]- "+summary)
	case "file", "video", "audio":
		name := attr(n, "data-name")
		src := attr(n, "data-src")
		if name == "" {
			name = src
		}
		return "[" + escape(name) + "](" + linkTarget(src) + ")"
	case "bookmark", "embed":
		url := attr(n, "data-url")
		if t := attr(n, "data-title"); t != "" {
			return "[" + escape(t) + "](" + linkTarget(url) + ")"
		}
		return "<" + url + ">"
	case "block-math":
		return "$$\n" + attr(n, "data-latex") + "\n$$"
	case "subpage", "database":
		if s, ok := m.page(attr(n, "data-id")); ok {
			return s
		}
		return ""
	case "transclusion":
		// Obsidian's embed of a note: ![[Note]] (an alias would be read as a size there).
		if s, ok := m.page(attr(n, "data-id")); ok {
			if i := strings.Index(s, "|"); strings.HasPrefix(s, "[[") && i > 0 {
				s = s[:i] + "]]"
			}
			return "!" + s
		}
		return ""
	case "button":
		if url := attr(n, "data-url"); attr(n, "data-action") == "link" && url != "" {
			return "[" + escape(attr(n, "data-label")) + "](" + linkTarget(url) + ")"
		}
		return ""
	case "footnotes":
		var lines []string
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if kind(c) != "footnote" {
				continue
			}
			text := strings.ReplaceAll(strings.TrimSpace(m.blocks(c)), "\n\n", "\n")
			text = strings.ReplaceAll(text, "\n", "\n    ")
			lines = append(lines, fmt.Sprintf("[^%d]: %s", m.notes[attr(c, "data-note")], text))
		}
		return strings.Join(lines, "\n")
	case "toc":
		return ""
	}
	return m.blocks(n) // columns, a column, a toggle's content, any other wrapper
}

// footnoteNumbers numbers a body's footnotes from 1: by where each is first referenced in
// the text, then the notes nothing references, in the list's order.
func footnoteNumbers(root *html.Node) map[string]int {
	out := map[string]int{}
	var defs []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if kind(n) == "footnote" {
			id := attr(n, "data-note")
			if n.Data == "sup" {
				if _, ok := out[id]; !ok {
					out[id] = len(out) + 1
				}
			} else {
				defs = append(defs, id)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	for _, id := range defs {
		if _, ok := out[id]; !ok {
			out[id] = len(out) + 1
		}
	}
	return out
}

// list renders ul/ol items, indenting each item's following lines under its marker.
func (m mdWriter) list(n *html.Node) string {
	var lines []string
	i := 0
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		i++
		marker := "- "
		switch {
		case kind(c) == "taskItem":
			if attr(c, "data-checked") == "true" {
				marker = "- [x] "
			} else {
				marker = "- [ ] "
			}
		case n.Data == "ol":
			marker = fmt.Sprintf("%d. ", i)
		}
		body := m.blocks(c)
		// A tight list: an item's paragraphs read as one line each.
		body = strings.ReplaceAll(body, "\n\n", "\n")
		pad := strings.Repeat(" ", len(marker))
		if strings.HasPrefix(marker, "- [") {
			pad = "  "
		}
		ls := strings.Split(body, "\n")
		for j, l := range ls {
			if j == 0 {
				lines = append(lines, marker+l)
			} else if l != "" {
				lines = append(lines, pad+l)
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (m mdWriter) table(n *html.Node) string {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.ElementNode && x.Data == "tr" {
			var cells []string
			for c := x.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && (c.Data == "td" || c.Data == "th") {
					s := strings.TrimSpace(strings.ReplaceAll(m.blocks(c), "\n\n", "<br>"))
					cells = append(cells, strings.ReplaceAll(strings.ReplaceAll(s, "\n", "<br>"), "|", `\|`))
				}
			}
			rows = append(rows, cells)
			return
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	if len(rows) == 0 {
		return ""
	}
	width := 0
	for _, r := range rows {
		width = max(width, len(r))
	}
	line := func(r []string) string {
		for len(r) < width {
			r = append(r, "")
		}
		return "| " + strings.Join(r, " | ") + " |"
	}
	out := []string{line(rows[0]), "|" + strings.Repeat(" --- |", width)}
	for _, r := range rows[1:] {
		out = append(out, line(r))
	}
	return strings.Join(out, "\n")
}

func (m mdWriter) image(n *html.Node) string {
	alt := attr(n, "alt")
	caption := attr(n, "data-caption")
	if alt == "" {
		alt = caption
	}
	s := "![" + escape(alt) + "](" + linkTarget(attr(n, "src")) + ")"
	if caption != "" && n.Parent != nil && n.Parent.Parent == nil {
		s += "\n*" + escape(caption) + "*"
	}
	return s
}

func (m mdWriter) inlines(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(m.inline(c))
	}
	return b.String()
}

var spaces = regexp.MustCompile(`\s+`)

func (m mdWriter) inline(n *html.Node) string {
	if n.Type == html.TextNode {
		return escape(spaces.ReplaceAllString(n.Data, " "))
	}
	if n.Type != html.ElementNode {
		return ""
	}
	wrap := func(mark string) string {
		inner := m.inlines(n)
		t := strings.TrimSpace(inner)
		if t == "" {
			return inner
		}
		// Markdown emphasis can't start or end with a space: keep them outside.
		lead := inner[:len(inner)-len(strings.TrimLeft(inner, " "))]
		trail := inner[len(strings.TrimRight(inner, " ")):]
		return lead + mark + t + mark + trail
	}
	switch kind(n) {
	case "strong", "b":
		return wrap("**")
	case "em", "i":
		return wrap("*")
	case "s", "del", "strike":
		return wrap("~~")
	case "mark":
		return wrap("==")
	case "code":
		t := text(n)
		tick := "`"
		for strings.Contains(t, tick) {
			tick += "`"
		}
		return tick + t + tick
	case "br":
		return "\\\n"
	case "img":
		return m.image(n)
	case "page":
		if s, ok := m.page(attr(n, "data-id")); ok {
			return s
		}
		return m.inlines(n)
	case "a":
		href := attr(n, "href")
		inner := strings.TrimSpace(m.inlines(n))
		if href == "" {
			return inner
		}
		if inner == "" {
			return "<" + href + ">"
		}
		return "[" + inner + "](" + linkTarget(href) + ")"
	case "inline-math":
		return "$" + attr(n, "data-latex") + "$"
	case "footnote":
		if n.Data == "sup" {
			return fmt.Sprintf("[^%d]", m.notes[attr(n, "data-note")])
		}
		return m.inlines(n)
	case "label", "input":
		return ""
	}
	return m.inlines(n) // mentions, dates, comment anchors, tones keep their text
}

func (m mdWriter) page(id string) (string, bool) {
	if m.opt.PageLink == nil || id == "" {
		return "", false
	}
	return m.opt.PageLink(id)
}

// quote prefixes every line with "> ", under an optional first line (a callout's type).
func quote(body, head string) string {
	var lines []string
	if head != "" {
		lines = append(lines, "> "+strings.TrimSpace(head))
	}
	for _, l := range strings.Split(strings.TrimSpace(body), "\n") {
		if l == "" {
			lines = append(lines, ">")
		} else {
			lines = append(lines, "> "+l)
		}
	}
	return strings.Join(lines, "\n")
}

func calloutType(tone string) string {
	switch tone {
	case "red":
		return "danger"
	case "orange", "yellow":
		return "warning"
	case "green":
		return "success"
	case "blue":
		return "info"
	case "purple":
		return "example"
	}
	return "note"
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "[", `\[`, "]", `\]`, "<", `\<`, "~", `\~`, "$", `\$`)

func escape(s string) string { return mdSpecial.Replace(s) }

// linkTarget is a URL fit for (…): spaces and parentheses would end it early.
func linkTarget(u string) string {
	return strings.NewReplacer(" ", "%20", "(", "%28", ")", "%29").Replace(u)
}

var (
	lineStart = regexp.MustCompile(`^(#|>|[-+] )`)
	numbered  = regexp.MustCompile(`^(\d+)([.)] )`)
)

// guardLineStart keeps a paragraph that starts like a heading, quote or list from becoming one.
func guardLineStart(s string) string {
	if lineStart.MatchString(s) {
		return `\` + s
	}
	return numbered.ReplaceAllString(s, `$1\$2`)
}
