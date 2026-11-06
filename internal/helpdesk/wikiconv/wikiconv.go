// Package wikiconv turns a wiki page's HTML (contracts/wiki.md "Body") into other shapes:
// Markdown for export and for Ollie, and help center HTML for publishing a page as an
// article draft. Both read the sanitized body; neither carries what belongs to the team
// alone into an article (mentions of teammates, links to wiki pages, comment anchors,
// databases, the workspace's own attachments).
package wikiconv

import (
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// parse reads a body fragment as children of a <div>.
func parse(body string) *html.Node {
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

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// kind is a node's wiki block or inline type: data-type, else the tag.
func kind(n *html.Node) string {
	if n.Type != html.ElementNode {
		return ""
	}
	if t := attr(n, "data-type"); t != "" {
		return t
	}
	return n.Data
}

// text is a node's visible text.
func text(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			return
		}
		if n.Type == html.ElementNode && (n.Data == "label" || n.Data == "input") {
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

// internal is a link to the workspace's own files, which only signed-in members can open.
func internal(src string) bool { return strings.HasPrefix(src, "/") }
