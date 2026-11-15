package wikiconv

import (
	"os"
	"strings"
	"testing"
)

const page = `<h2>Refunds</h2><p>Ask <span data-type="mention" data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" class="mention">@Maya Chen</span> before <time data-type="date" datetime="2026-11-06">Nov 6</time>, see <a data-type="page" data-id="11111111-1111-4111-8111-111111111111" href="/wiki/11111111-1111-4111-8111-111111111111">Escalation process</a> and <a href="https://example.com/a b">the docs</a> for <a data-type="ticket" data-id="55555555-5555-4555-8555-555555555555" href="/tickets/1042">#1042</a>. <strong>Never</strong> <em>promise</em> <mark data-bg="yellow">dates</mark>, <code>a*b</code>, <span data-comment="22222222-2222-4222-8222-222222222222">2 * 3_x</span>.</p>` +
	`<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>` +
	`<ol><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ol>` +
	`<div data-type="callout" data-tone="orange" data-icon="⚠️"><p>Careful</p></div>` +
	`<details><summary>More</summary><div data-type="detailsContent"><p>Hidden</p></div></details>` +
	`<pre><code class="language-go">fmt.Println("x")</code></pre>` +
	`<table><tbody><tr><th><p>Plan</p></th><th><p>Price</p></th></tr><tr><td><p>Pro | team</p></td><td><p>$10</p></td></tr></tbody></table>` +
	`<div data-type="database" data-id="33333333-3333-4333-8333-333333333333"></div>` +
	`<div data-type="tickets" data-id="66666666-6666-4666-8666-666666666666" data-limit="5"></div>` +
	`<img src="/v1/attachments/44444444-4444-4444-8444-444444444444" alt="Screen">` +
	`<img src="https://example.com/a.png" alt="A" data-caption="The form">` +
	`<div data-type="bookmark" data-url="https://example.com/post" data-title="A post"></div>` +
	`<p># not a heading</p><p>2026. was a year</p><hr>`

func TestMarkdown(t *testing.T) {
	titles := map[string]string{"11111111-1111-4111-8111-111111111111": "Escalation process", "33333333-3333-4333-8333-333333333333": "Known issues"}
	md := Markdown(page, MarkdownOptions{PageLink: func(id string) (string, bool) {
		t, ok := titles[id]
		return "[[" + t + "]]", ok
	}})
	for _, want := range []string{
		"## Refunds\n",
		"Ask @Maya Chen before Nov 6, see [[Escalation process]] and [the docs](https://example.com/a%20b) for #1042.",
		"**Never** *promise* ==dates==, `a*b`, 2 \\* 3\\_x.",
		"- [x] done\n- [ ] todo",
		"1. one\n   - nested\n2. two",
		"> [!warning]\n> Careful",
		"> [!note]- More\n> Hidden",
		"```go\nfmt.Println(\"x\")\n```",
		"| Plan | Price |\n| --- | --- |\n| Pro \\| team | \\$10 |",
		"[[Known issues]]",
		"![Screen](/v1/attachments/44444444-4444-4444-8444-444444444444)",
		"![A](https://example.com/a.png)\n*The form*",
		"[A post](https://example.com/post)",
		"\\# not a heading",
		"2026\\. was a year",
		"---",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
	if strings.Contains(md, "data-") || strings.Contains(md, "<span") {
		t.Errorf("markup left:\n%s", md)
	}

	// Without a resolver a page link keeps its text, and a database block goes.
	plain := Markdown(page, MarkdownOptions{})
	if !strings.Contains(plain, "see Escalation process and") || strings.Contains(plain, "Known issues") {
		t.Errorf("plain:\n%s", plain)
	}
}

func TestArticle(t *testing.T) {
	out, left := Article(page)
	if left != 3 { // the database, the ticket list and the workspace's own image
		t.Errorf("left out %d", left)
	}
	for _, want := range []string{
		"<h2>Refunds</h2>",
		"Ask Maya Chen before Nov 6, see Escalation process and",
		"<blockquote><p>Careful</p></blockquote>",
		"<p><strong>More</strong></p><p>Hidden</p>",
		"<p><strong>Plan</strong> | <strong>Price</strong></p><p>Pro | team | $10</p>",
		`<img src="https://example.com/a.png" alt="A"/><p><em>The form</em></p>`,
		`href="https://example.com/post"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, gone := range []string{"data-", "/wiki/", "/tickets/", "/v1/attachments", "mention", "<table", "<hr", "<details", "checkbox", "Known issues"} {
		if strings.Contains(out, gone) {
			t.Errorf("%q left in:\n%s", gone, out)
		}
	}
}

// Every block the editor writes converts without leaving wiki markup behind.
func TestEditorFixture(t *testing.T) {
	raw, err := os.ReadFile("../hd/testdata/wiki_editor.html")
	if err != nil {
		t.Fatal(err)
	}
	md := Markdown(string(raw), MarkdownOptions{})
	if strings.Contains(md, "data-") || strings.TrimSpace(md) == "" {
		t.Errorf("markdown:\n%s", md)
	}
	out, _ := Article(string(raw))
	if strings.Contains(out, "data-") || strings.TrimSpace(out) == "" {
		t.Errorf("article:\n%s", out)
	}
}

// The newer blocks: a synced block is an Obsidian embed in Markdown and stays out of an
// article, a button is its link or nothing, footnotes are numbered by where they are first
// referenced, and a toggle heading is a heading.
const blocks = `<p>Claim<sup data-type="footnote" data-note="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">9</sup> and another<sup data-type="footnote" data-note="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">9</sup>, again<sup data-type="footnote" data-note="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">9</sup>.</p>` +
	`<details data-heading="2"><summary>Folded section</summary><div data-type="detailsContent"><p>Inside</p></div></details>` +
	`<div data-type="transclusion" data-id="11111111-1111-4111-8111-111111111111"></div>` +
	`<div data-type="transclusion" data-id="11111111-1111-4111-8111-111111111111" data-block="22222222-2222-4222-8222-222222222222"></div>` +
	`<div data-type="transclusion" data-id="99999999-9999-4999-8999-999999999999"></div>` +
	`<div data-type="button" data-label="Status page" data-action="link" data-url="https://status.example.com"></div>` +
	`<div data-type="button" data-label="Add a to-do" data-action="todo"></div>` +
	`<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>` +
	`<div data-type="footnotes"><div data-type="footnote" data-note="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"><p>Second <strong>source</strong></p></div><div data-type="footnote" data-note="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"><p>First source</p></div><div data-type="footnote" data-note="cccccccc-cccc-4ccc-8ccc-cccccccccccc"><p>Nobody cites me</p></div></div>`

func TestNewBlocks(t *testing.T) {
	md := Markdown(blocks, MarkdownOptions{PageLink: func(id string) (string, bool) {
		if id == "11111111-1111-4111-8111-111111111111" {
			return "[[Guides/Escalation|Escalation process]]", true
		}
		return "", false
	}})
	for _, want := range []string{
		"Claim[^1] and another[^2], again[^1].",
		"## Folded section\n\nInside",
		"![[Guides/Escalation]]\n\n![[Guides/Escalation]]\n\n[Status page](https://status.example.com)",
		"```mermaid\ngraph TD; A-->B\n```",
		"[^2]: Second **source**\n[^1]: First source\n[^3]: Nobody cites me",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
	if strings.Contains(md, "Add a to-do") || strings.Contains(md, "9999") || strings.Contains(md, "|Escalation") {
		t.Errorf("markdown:\n%s", md)
	}

	out, left := Article(blocks)
	if left != 4 { // three synced blocks and the to-do button
		t.Errorf("left out %d", left)
	}
	for _, want := range []string{
		"<p>Claim[1] and another[2], again[1].</p>",
		"<h2>Folded section</h2><p>Inside</p>",
		`<a href="https://status.example.com"`, ">Status page</a>",
		"<p>[2] Second <strong>source</strong></p><p>[1] First source</p><p>[3] Nobody cites me</p>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, gone := range []string{"data-", "<sup", "Add a to-do", "<details"} {
		if strings.Contains(out, gone) {
			t.Errorf("%q left in:\n%s", gone, out)
		}
	}
}
