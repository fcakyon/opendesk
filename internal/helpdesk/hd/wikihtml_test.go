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
		`<hr data-block-id="b37d5388-87d5-44c1-a276-3283de343057">`,
		`<table data-block-id="e6b6142d-fc10-455d-9034-f78c32cda801" style="min-width: 160px">`,
		`<col style="min-width: 80px">`,
		`<th colwidth="120">`,
		`<td colspan="1" rowspan="1">`,
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
