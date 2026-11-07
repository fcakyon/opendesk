package hd

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// What the wiki editor writes (testdata/wiki_editor.html, every block of
// components/wiki/editor) keeps each block's attributes through SanitizeWiki.
func TestSanitizeWikiKeepsEditorBlocks(t *testing.T) {
	raw, err := os.ReadFile("testdata/wiki_editor.html")
	if err != nil {
		t.Fatal(err)
	}
	out := SanitizeWiki(string(raw))
	keep := []string{
		`<h1 data-block-id="c61e7b00-13ee-469c-9759-6c85e6e3453e">Big heading</h1>`,
		`style="text-align: center"`,
		`<p data-block-id="a3adda31-9724-4f84-a56c-93380c770405" data-color="red" data-bg="yellow">`,
		`<span data-color="red">red text</span>`,
		`<mark data-bg="blue">highlight</mark>`,
		`<span data-type="mention" data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" class="mention">@Maya Chen</span>`,
		`data-type="page" data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7"`,
		`<time data-type="date" datetime="2026-11-06">2026-11-06</time>`,
		`<span data-comment="5b0f6f8e-2f0b-4f55-9d0a-6d2f0c1c9a11">commented text</span>`,
		`<time data-type="date" datetime="2026-11-07T09:30" data-reminder="0d6c2f8a-7b1e-4c3d-8f5a-2e9b4a6c1d70">2026-11-07T09:30</time>`,
		`<time data-type="date" datetime="2026-11-08T09:30:00Z">2026-11-08T09:30:00Z</time>`,
		`<span data-latex="a^2+b^2" data-type="inline-math"></span>`,
		`<ul data-block-id="2be0deff-de52-4bf9-9dc2-b8979223096e" data-type="taskList">`,
		`data-checked="true" data-type="taskItem"`,
		`<summary>Toggle</summary><div data-type="detailsContent">`,
		`data-icon="⚠️" data-tone="orange" data-type="callout"`,
		`data-type="columns"><div data-type="column">`,
		`<code class="language-go">func main() {}</code>`,
		`data-latex="\sum_{i=1}^n x_i" data-type="block-math"`,
		`data-width="60" data-align="left" data-caption="A caption"`,
		`data-src="/v1/attachments/3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-name="report.pdf" data-size="2048" data-mime="application/pdf" data-type="file"`,
		`data-name="clip.mp4" data-type="video"`,
		`data-src="https://example.com/a.mp3" data-name="a.mp3" data-type="audio"`,
		`data-url="https://example.com/post" data-title="A post" data-description="About it" data-image="https://example.com/og.png" data-type="bookmark"`,
		`data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" data-type="embed"`,
		`data-type="toc"`,
		`data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-type="subpage"`,
		`data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-view="board" data-type="database"`,
		`<a data-type="ticket" data-id="7c1f3a52-4d2e-4b8a-9e61-0f5d2c8b3a14" href="/tickets/42" rel="nofollow noreferrer">#42 Refund stuck</a>`,
		`<a data-type="contact" data-id="b5e8d2c1-6f3a-4e7b-8d9c-1a2b3c4d5e6f" href="/contacts/b5e8d2c1-6f3a-4e7b-8d9c-1a2b3c4d5e6f" rel="nofollow noreferrer">Ana Ruiz</a>`,
		`data-type="tickets" data-id="2f4e6a8c-1b3d-4f5a-8c7e-9d0b1a2c3e4f" data-limit="10"`,
		`<hr data-block-id="b37d5388-87d5-44c1-a276-3283de343057">`,
		`<table data-block-id="e6b6142d-fc10-455d-9034-f78c32cda801" style="min-width: 160px">`,
		`<col style="min-width: 80px">`,
		`<th colwidth="120">`,
		`<td colspan="1" rowspan="1">`,
		`data-block-id="4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" data-heading="2"><summary>Toggle heading</summary>`,
		`data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-type="transclusion"></div>`,
		`data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-block="c61e7b00-13ee-469c-9759-6c85e6e3453e" data-type="transclusion"></div>`,
		`data-label="New escalation" data-action="template" data-template="9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b" data-type="button"`,
		`data-label="Add a to-do" data-action="todo" data-title="Call the customer back" data-type="button"`,
		`data-label="Status page" data-action="link" data-url="https://status.example.com" data-type="button"`,
		`data-label="Log a bug" data-action="row" data-database="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" data-title="New bug" data-props="{&#34;status&#34;:&#34;todo&#34;,&#34;urgent&#34;:true}" data-type="button"`,
		`<code class="language-mermaid">graph TD; A--&gt;B</code>`,
		`A claim<sup data-type="footnote" data-note="4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a">1</sup> with a source.`,
		`<div data-type="footnotes"><div data-type="footnote" data-note="4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"><p data-block-id="5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b">The source, page 4.</p></div></div>`,
	}
	for _, k := range keep {
		if !strings.Contains(out, k) {
			t.Errorf("lost %s", k)
		}
	}
	if strings.Contains(out, "<input") || strings.Contains(out, "<label") || strings.Contains(out, "<span></span>") {
		t.Errorf("a to-do's checkbox is drawn by the app, never stored: %s", out)
	}
	if again := SanitizeWiki(out); again != out {
		t.Errorf("not stable:\n%s\n%s", out, again)
	}
}

func TestSanitizeWikiRefuses(t *testing.T) {
	cases := map[string]string{
		"script":            `<p>a</p><script>alert(1)</script>`,
		"handler":           `<p onclick="alert(1)">a</p>`,
		"iframe":            `<iframe src="https://evil.example"></iframe>`,
		"javascript link":   `<a href="javascript:alert(1)">x</a>`,
		"embed javascript":  `<div data-type="embed" data-url="javascript:alert(1)"></div>`,
		"embed http":        `<div data-type="embed" data-url="http://insecure.example"></div>`,
		"file elsewhere":    `<div data-type="file" data-src="data:text/html,hi"></div>`,
		"unknown div type":  `<div data-type="script" data-url="https://x.example"></div>`,
		"free style":        `<p style="background:url(https://x.example)">a</p>`,
		"unknown tone":      `<span data-color="url(x)">a</span>`,
		"code class":        `<code class="evil one">a</code>`,
		"table style":       `<table style="position: fixed">a</table>`,
		"page link non-id":  `<a data-type="page" data-id="../../x" href="/wiki/x">x</a>`,
		"time not a day":    `<time data-type="date" datetime="tomorrow">x</time>`,
		"comment non-id":    `<span data-comment="tomorrow">x</span>`,
		"reminder non-id":   `<time data-type="date" datetime="2026-11-06" data-reminder="tomorrow">x</time>`,
		"comment on a div":  `<div data-comment="5b0f6f8e-2f0b-4f55-9d0a-6d2f0c1c9a11">x</div>`,
		"img width huge":    `<img src="https://x.example/a.png" data-width="1e9">`,
		"callout icon html": `<div data-type="callout" data-icon="<b>">x</div>`,
		"tickets limit":     `<div data-type="tickets" data-id="2f4e6a8c-1b3d-4f5a-8c7e-9d0b1a2c3e4f" data-limit="1e9">x</div>`,
		"tickets view":      `<div data-type="tickets" data-id="../views/evil" data-limit="5">x</div>`,
		"mention type":      `<a data-type="script" data-id="7c1f3a52-4d2e-4b8a-9e61-0f5d2c8b3a14" href="/tickets/1">x</a>`,
	}
	bad := regexp.MustCompile(`(?i)script|onclick|iframe|javascript:|http://|data:text|data-type="script"|background|url\(|evil|position|\.\./|tomorrow|1e9|&lt;b&gt;|<div data-comment`)
	for name, in := range cases {
		if out := SanitizeWiki(in); bad.MatchString(out) {
			t.Errorf("%s: kept %q", name, out)
		}
	}
}

// The knowledge base's allowlist stays its own: wiki blocks don't reach articles.
func TestSanitizeRichUnchangedByWiki(t *testing.T) {
	out := SanitizeRich(`<div data-type="callout" data-icon="💡"><p>x</p></div><mark data-bg="red">y</mark>`)
	if strings.Contains(out, "data-type") || strings.Contains(out, "data-bg") || strings.Contains(out, "<mark") {
		t.Errorf("rich policy took wiki blocks: %s", out)
	}
}

// A link to a ticket or a contact keeps its type, the record's id and the app's route for
// it; any other href or attribute goes, and without an id it is a plain link.
func TestSanitizeWikiMentionLinks(t *testing.T) {
	const tk, ct = "7c1f3a52-4d2e-4b8a-9e61-0f5d2c8b3a14", "b5e8d2c1-6f3a-4e7b-8d9c-1a2b3c4d5e6f"
	cases := []struct{ name, in, want string }{
		{"ticket", `<a href="/tickets/42" data-id="` + tk + `" data-type="ticket">#42 Hi</a>`,
			`<a data-type="ticket" data-id="` + tk + `" href="/tickets/42" rel="nofollow noreferrer">#42 Hi</a>`},
		{"contact", `<a data-type="contact" data-id="` + ct + `" href="/contacts/` + ct + `">Ana</a>`,
			`<a data-type="contact" data-id="` + ct + `" href="/contacts/` + ct + `" rel="nofollow noreferrer">Ana</a>`},
		{"other attributes", `<a data-type="ticket" data-id="` + tk + `" data-block="` + tk + `" data-mention="` + tk + `" target="_blank" title="x" href="/tickets/7">#7</a>`,
			`<a data-type="ticket" data-id="` + tk + `" href="/tickets/7" rel="nofollow noreferrer">#7</a>`},
		{"ticket elsewhere", `<a data-type="ticket" data-id="` + tk + `" href="https://evil.example/tickets/42">#42</a>`,
			`<a data-type="ticket" data-id="` + tk + `">#42</a>`},
		{"ticket by id", `<a data-type="ticket" data-id="` + tk + `" href="/tickets/` + tk + `">#42</a>`,
			`<a data-type="ticket" data-id="` + tk + `">#42</a>`},
		{"ticket route of a contact", `<a data-type="ticket" data-id="` + tk + `" href="/contacts/` + ct + `">x</a>`,
			`<a data-type="ticket" data-id="` + tk + `">x</a>`},
		{"contact route of a ticket", `<a data-type="contact" data-id="` + ct + `" href="/tickets/42">x</a>`,
			`<a data-type="contact" data-id="` + ct + `">x</a>`},
		{"path tricks", `<a data-type="ticket" data-id="` + tk + `" href="/tickets/42/../../admin">x</a><a data-type="contact" data-id="` + ct + `" href="//evil.example/contacts/` + ct + `">y</a>`,
			`<a data-type="ticket" data-id="` + tk + `">x</a><a data-type="contact" data-id="` + ct + `">y</a>`},
		{"no id", `<a data-type="ticket" data-id="42" href="/tickets/42">#42</a>`,
			`<a href="/tickets/42" rel="nofollow noreferrer">#42</a>`},
		{"escaped text kept", `<p>a &amp; b <a data-type="ticket" data-id="` + tk + `" href="/tickets/1">#1 &lt;x&gt;</a> <a href="https://x.example/?a=1&amp;b=2">q</a></p>`,
			`<p>a &amp; b <a data-type="ticket" data-id="` + tk + `" href="/tickets/1" rel="nofollow noreferrer">#1 &lt;x&gt;</a> <a href="https://x.example/?a=1&amp;b=2" rel="nofollow noreferrer noopener" target="_blank">q</a></p>`},
	}
	for _, c := range cases {
		out := SanitizeWiki(c.in)
		if out != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, out, c.want)
		}
		if again := SanitizeWiki(out); again != out {
			t.Errorf("%s: not stable: %s", c.name, again)
		}
	}
}

// The newer blocks keep each attribute only with a value of its shape: a synced block's page
// and block ids, a button's label, action and targets, a footnote's id, a toggle heading's level.
func TestSanitizeWikiNewBlocks(t *testing.T) {
	const id = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7"
	cases := []struct{ name, in, want string }{
		{"synced page", `<div data-type="transclusion" data-id="` + id + `"></div>`,
			`<div data-type="transclusion" data-id="` + id + `"></div>`},
		{"synced block", `<div data-type="transclusion" data-id="` + id + `" data-block="` + id + `"></div>`,
			`<div data-type="transclusion" data-id="` + id + `" data-block="` + id + `"></div>`},
		{"synced block bad ids", `<div data-type="transclusion" data-id="../x" data-block="#top"></div>`,
			`<div data-type="transclusion"></div>`},
		{"synced block content", `<div data-type="transclusion" data-id="` + id + `"><script>alert(1)</script><p>copied</p></div>`,
			`<div data-type="transclusion" data-id="` + id + `"><p>copied</p></div>`},
		{"button link", `<div data-type="button" data-label="Open" data-action="link" data-url="https://x.example/a"></div>`,
			`<div data-type="button" data-label="Open" data-action="link" data-url="https://x.example/a"></div>`},
		{"button bad action", `<div data-type="button" data-label="Go" data-action="eval"></div>`,
			`<div data-type="button" data-label="Go"></div>`},
		{"button javascript url", `<div data-type="button" data-label="Go" data-action="link" data-url="javascript:alert(1)"></div>`,
			`<div data-type="button" data-label="Go" data-action="link"></div>`},
		{"button http url", `<div data-type="button" data-label="Go" data-action="link" data-url="http://x.example"></div>`,
			`<div data-type="button" data-label="Go" data-action="link"></div>`},
		{"button long label", `<div data-type="button" data-label="` + strings.Repeat("a", 101) + `" data-action="todo"></div>`,
			`<div data-type="button" data-action="todo"></div>`},
		{"button label newline", "<div data-type=\"button\" data-label=\"a\nb\" data-action=\"todo\"></div>",
			`<div data-type="button" data-action="todo"></div>`},
		{"button targets", `<div data-type="button" data-action="row" data-database="` + id + `" data-template="nope"></div>`,
			`<div data-type="button" data-action="row" data-database="` + id + `"></div>`},
		{"button props", `<div data-type="button" data-action="row" data-props='{"a":1}'></div>`,
			`<div data-type="button" data-action="row" data-props="{&#34;a&#34;:1}"></div>`},
		{"button props not an object", `<div data-type="button" data-action="row" data-props="[1]"></div>`,
			`<div data-type="button" data-action="row"></div>`},
		{"button props too long", `<div data-type="button" data-action="row" data-props='{"a":"` + strings.Repeat("x", 1000) + `"}'></div>`,
			`<div data-type="button" data-action="row"></div>`},
		{"button attrs elsewhere", `<p data-label="x" data-action="link" data-url="https://x.example">a</p>`,
			`<p>a</p>`},
		{"footnote", `<p>a<sup data-type="footnote" data-note="` + id + `">1</sup></p><div data-type="footnotes"><div data-type="footnote" data-note="` + id + `"><p>n</p></div></div>`,
			`<p>a<sup data-type="footnote" data-note="` + id + `">1</sup></p><div data-type="footnotes"><div data-type="footnote" data-note="` + id + `"><p>n</p></div></div>`},
		{"footnote bad id", `<p>a<sup data-type="footnote" data-note="1">1</sup></p><div data-type="footnote" data-note="1"></div>`,
			`<p>a<sup data-type="footnote">1</sup></p><div data-type="footnote"></div>`},
		{"footnote other type", `<p>a<sup data-type="mention" data-id="` + id + `" onclick="x()">1</sup></p>`,
			`<p>a<sup>1</sup></p>`},
		{"toggle heading", `<details data-heading="3"><summary>s</summary></details>`,
			`<details data-heading="3"><summary>s</summary></details>`},
		{"toggle heading level", `<details data-heading="4"><summary>s</summary></details><p data-heading="1">p</p>`,
			`<details><summary>s</summary></details><p>p</p>`},
	}
	for _, c := range cases {
		out := SanitizeWiki(c.in)
		if out != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, out, c.want)
		}
		if again := SanitizeWiki(out); again != out {
			t.Errorf("%s: not stable: %s", c.name, again)
		}
	}
}
