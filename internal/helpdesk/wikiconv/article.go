package wikiconv

import (
	"fmt"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// Article is the page body as help center HTML (hd.SanitizeRich): wiki blocks become the
// article's plain equivalents, and what belongs to the team stays behind. Teammates'
// mentions and links to wiki pages keep only their text; comment anchors, dates and tones
// their words. The workspace's own files and images, databases, ticket lists and subpage
// links are left out, and so are synced blocks and buttons that do more than open a link;
// leftOut counts them so the app can say so. Links to tickets and contacts keep their text.
// Footnotes become [1] in the text and a paragraph each at the end; a toggle heading a heading.
func Article(body string) (out string, leftOut int) {
	root := parse(body)
	leftOut = article{notes: footnoteNumbers(root)}.rewriteAll(root)
	var b strings.Builder
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		_ = html.Render(&b, c)
	}
	return hd.SanitizeRich(b.String()), leftOut
}

func element(tag string, a atom.Atom, children ...*html.Node) *html.Node {
	n := &html.Node{Type: html.ElementNode, Data: tag, DataAtom: a}
	for _, c := range children {
		n.AppendChild(c)
	}
	return n
}

func textNode(s string) *html.Node { return &html.Node{Type: html.TextNode, Data: s} }

func link(href, label string) *html.Node {
	a := element("a", atom.A, textNode(label))
	a.Attr = []html.Attribute{{Key: "href", Val: href}}
	return element("p", atom.P, a)
}

// unwrap puts a node's children in its place.
func unwrap(n *html.Node) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		n.RemoveChild(c)
		n.Parent.InsertBefore(c, n)
		c = next
	}
	n.Parent.RemoveChild(n)
}

func replace(n, with *html.Node) {
	n.Parent.InsertBefore(with, n)
	n.Parent.RemoveChild(n)
}

type article struct {
	// notes numbers the page's footnotes by their id (footnoteNumbers).
	notes map[string]int
}

// rewriteAll rewrites the tree in place and counts what it left out.
func (a article) rewriteAll(n *html.Node) int {
	left := 0
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		left += a.rewriteAll(c)
		left += a.rewrite(c)
		c = next
	}
	return left
}

func (a article) rewrite(n *html.Node) int {
	if n.Type != html.ElementNode || n.Parent == nil {
		return 0
	}
	switch kind(n) {
	case "mention":
		replace(n, textNode(strings.TrimPrefix(text(n), "@")))
	case "page", "date", "ticket", "contact":
		replace(n, textNode(text(n)))
	case "inline-math":
		replace(n, element("code", atom.Code, textNode(attr(n, "data-latex"))))
	case "block-math":
		replace(n, element("pre", atom.Pre, element("code", atom.Code, textNode(attr(n, "data-latex")))))
	case "callout":
		q := element("blockquote", atom.Blockquote)
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			n.RemoveChild(c)
			q.AppendChild(c)
			c = next
		}
		replace(n, q)
	case "summary":
		switch attr(n.Parent, "data-heading") {
		case "1":
			replace(n, element("h1", atom.H1, textNode(text(n))))
		case "2":
			replace(n, element("h2", atom.H2, textNode(text(n))))
		case "3":
			replace(n, element("h3", atom.H3, textNode(text(n))))
		default:
			replace(n, element("p", atom.P, element("strong", atom.Strong, textNode(text(n)))))
		}
	case "footnote":
		mark := textNode(fmt.Sprintf("[%d]", a.notes[attr(n, "data-note")]))
		if n.Data == "sup" {
			replace(n, mark)
			return 0
		}
		// A note: its number before its text, as a paragraph of the article's end.
		p := element("p", atom.P, mark, textNode(" "))
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "p" {
				for x := c.FirstChild; x != nil; {
					next := x.NextSibling
					c.RemoveChild(x)
					p.AppendChild(x)
					x = next
				}
				break
			}
		}
		replace(n, p)
	case "footnotes":
		unwrap(n)
	case "transclusion":
		n.Parent.RemoveChild(n)
		return 1
	case "button":
		if url := attr(n, "data-url"); attr(n, "data-action") == "link" && url != "" {
			replace(n, link(url, attr(n, "data-label")))
			return 0
		}
		n.Parent.RemoveChild(n)
		return 1
	case "details", "detailsContent", "columns", "column", "label":
		if n.Data == "label" {
			n.Parent.RemoveChild(n)
			return 0
		}
		unwrap(n)
	case "table":
		var rows []*html.Node
		var walk func(*html.Node)
		walk = func(x *html.Node) {
			if x.Type == html.ElementNode && x.Data == "tr" {
				p := element("p", atom.P)
				first := true
				for c := x.FirstChild; c != nil; c = c.NextSibling {
					if c.Type != html.ElementNode || (c.Data != "td" && c.Data != "th") {
						continue
					}
					if !first {
						p.AppendChild(textNode(" | "))
					}
					first = false
					cell := textNode(strings.TrimSpace(text(c)))
					if c.Data == "th" {
						p.AppendChild(element("strong", atom.Strong, cell))
					} else {
						p.AppendChild(cell)
					}
				}
				rows = append(rows, p)
				return
			}
			for c := x.FirstChild; c != nil; c = c.NextSibling {
				walk(c)
			}
		}
		walk(n)
		for _, r := range rows {
			n.Parent.InsertBefore(r, n)
		}
		n.Parent.RemoveChild(n)
	case "hr", "toc":
		n.Parent.RemoveChild(n)
	case "subpage", "database", "tickets":
		n.Parent.RemoveChild(n)
		return 1
	case "img":
		if internal(attr(n, "src")) {
			n.Parent.RemoveChild(n)
			return 1
		}
		if c := attr(n, "data-caption"); c != "" {
			cap := element("p", atom.P, element("em", atom.Em, textNode(c)))
			if n.NextSibling != nil {
				n.Parent.InsertBefore(cap, n.NextSibling)
			} else {
				n.Parent.AppendChild(cap)
			}
		}
	case "file", "video", "audio":
		src := attr(n, "data-src")
		if internal(src) {
			n.Parent.RemoveChild(n)
			return 1
		}
		name := attr(n, "data-name")
		if name == "" {
			name = src
		}
		replace(n, link(src, name))
	case "bookmark", "embed":
		url := attr(n, "data-url")
		label := attr(n, "data-title")
		if label == "" {
			label = url
		}
		replace(n, link(url, label))
	}
	return 0
}
