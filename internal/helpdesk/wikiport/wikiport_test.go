package wikiport

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

type entry struct{ name, body string }

func zipBytes(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func upload(name string, data []byte) Upload {
	return Upload{Name: name, Body: bytes.NewReader(data), Size: int64(len(data))}
}

func importOK(t *testing.T, opt Options, ups ...Upload) *Result {
	t.Helper()
	res, err := Import(ups, opt)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	walk(res.Pages, func(p *Page) {
		if got := hd.SanitizeWiki(p.BodyHTML); got != p.BodyHTML {
			t.Errorf("%s: body is not what SanitizeWiki keeps:\n got %s\nwant %s", p.Key, p.BodyHTML, got)
		}
	})
	return res
}

func walk(ps []*Page, f func(*Page)) {
	for _, p := range ps {
		f(p)
		walk(p.Children, f)
	}
}

func byTitle(t *testing.T, res *Result, title string) *Page {
	t.Helper()
	var found *Page
	walk(res.Pages, func(p *Page) {
		if p.Title == title && found == nil {
			found = p
		}
	})
	if found == nil {
		t.Fatalf("no page %q in:\n%s", title, outline(res.Pages, ""))
	}
	return found
}

// outline is the tree as indented titles.
func outline(ps []*Page, indent string) string {
	var b strings.Builder
	for _, p := range ps {
		b.WriteString(indent + p.Title + "\n")
		b.WriteString(outline(p.Children, indent+"  "))
	}
	return b.String()
}

func titles(ps []*Page) []string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Title)
	}
	return out
}

func assetByKey(res *Result, key string) *Asset {
	for i := range res.Assets {
		if res.Assets[i].Key == key {
			return &res.Assets[i]
		}
	}
	return nil
}

func hasSkip(res *Result, path, reason string) bool {
	return slices.Contains(res.Skipped, Skip{Path: path, Reason: reason})
}

func contains(t *testing.T, where, body string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(body, w) {
			t.Errorf("%s: missing %s\nin %s", where, w, body)
		}
	}
}

func lacks(t *testing.T, where, body string, unwanted ...string) {
	t.Helper()
	for _, w := range unwanted {
		if strings.Contains(body, w) {
			t.Errorf("%s: has %s\nin %s", where, w, body)
		}
	}
}

func pageLinkTo(p *Page) string { return `data-type="page" data-id="` + p.Ref + `"` }

var png = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"

func TestObsidianVault(t *testing.T) {
	data := zipBytes(t,
		entry{"Vault/.obsidian/app.json", "{}"},
		entry{"Vault/Projects/Projects.md", "---\ntitle: All projects\ntags: [work, planning]\naliases: [P]\n---\nSee [[Alpha]] and [[Alpha#Goals|the goals]].\n\n[[Beta]]\n"},
		entry{"Vault/Projects/Alpha.md", strings.Join([]string{
			"---", "tags:", "  - roadmap", "---",
			"# Alpha", "", "## Goals", "", "Ship it ==soon==.", "Second line", "",
			"> [!warning] Careful", "> This is **bold** and $x^2$, not $5 or $10.", "",
			"> [!faq]- Folded", "> Hidden text", "",
			"- [ ] todo", "- [x] done", "",
			"$$", `\sum_i x_i`, "$$", "",
			"```go", "func main() {}", "```", "",
			"| a | b |", "| --- | --- |", `| 1 | [[Beta\|B]] |`, "",
			"![[diagram.png]]", "",
			"%%secret%% visible #tag/sub and %%a", "multi-line%% after", "",
			"[Gamma's page](../Notes/Gamma.md) and [[Gamma]] and [[Nowhere]]",
		}, "\n")},
		entry{"Vault/Projects/Beta.md", "Beta body with ![[report.pdf]] and ![[run.sh]] and ![[Notes/Gamma]]"},
		entry{"Vault/Notes/Gamma.md", "Gamma"},
		entry{"Vault/Notes/Gamma Folder.md", "Folder note"},
		entry{"Vault/Notes/Gamma Folder/Child.md", "Child of the folder note"},
		entry{"Vault/attachments/diagram.png", png},
		entry{"Vault/attachments/report.pdf", "%PDF-1.4 x"},
		entry{"Vault/attachments/run.sh", "#!/bin/sh\necho"},
		entry{"Vault/attachments/unused.png", png},
		entry{"Vault/Tasks.base", "views: []"},
	)
	res := importOK(t, Options{}, upload("vault.zip", data))

	if got, want := outline(res.Pages, ""), "Vault\n  Notes\n    Gamma\n    Gamma Folder\n      Child\n  All projects\n    Alpha\n    Beta\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	vault, projects := res.Pages[0], byTitle(t, res, "All projects")
	alpha, beta, gamma := byTitle(t, res, "Alpha"), byTitle(t, res, "Beta"), byTitle(t, res, "Gamma")
	if vault.Key != "Vault/" || projects.Key != "Vault/Projects/Projects.md" || byTitle(t, res, "Gamma Folder").Key != "Vault/Notes/Gamma Folder.md" {
		t.Errorf("keys: %q %q", vault.Key, projects.Key)
	}

	// Front matter: the title, tags as #tags at the end, aliases left out.
	contains(t, "projects", projects.BodyHTML, pageLinkTo(alpha), "<p>#work #planning</p>")
	lacks(t, "projects", projects.BodyHTML, "aliases")
	if !slices.Equal(projects.Tags, []string{"work", "planning"}) || !slices.Equal(alpha.Tags, []string{"roadmap"}) {
		t.Errorf("tags: %v %v", projects.Tags, alpha.Tags)
	}
	// A link to a heading names the heading's block.
	goals := regexp.MustCompile(`<h2 data-block-id="([0-9a-f-]{36})">Goals</h2>`).FindStringSubmatch(alpha.BodyHTML)
	if goals == nil {
		t.Fatalf("alpha has no Goals heading with a block id: %s", alpha.BodyHTML)
	}
	contains(t, "projects", projects.BodyHTML, `data-block="`+goals[1]+`" href="/wiki/`+alpha.Ref+`#`+goals[1]+`"`, `>the goals</a>`)
	// A paragraph that is only a link to a subpage is the subpage block.
	contains(t, "projects", projects.BodyHTML, `<div data-type="subpage" data-id="`+beta.Ref+`"></div>`)
	if !slices.Equal(projects.Links, []string{alpha.Key, beta.Key}) {
		t.Errorf("links: %v", projects.Links)
	}

	contains(t, "alpha", alpha.BodyHTML,
		"<p>Ship it <mark>soon</mark>.<br/>Second line</p>",
		`<div data-type="callout" data-icon="⚠️" data-tone="orange"><p><strong>Careful</strong></p>`,
		`<span data-type="inline-math" data-latex="x^2"></span>, not $5 or $10.`,
		`<details><summary>Folded</summary><div data-type="detailsContent"><p>Hidden text</p></div></details>`,
		`<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>todo</p></li><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>`,
		`<div data-type="block-math" data-latex="\sum_i x_i"></div>`,
		`<pre><code class="language-go">func main() {}</code></pre>`,
		`<td><p><a `+pageLinkTo(beta), `>B</a>`,
		"visible #tag/sub and  after",
		`>Gamma&#39;s page</a>`, pageLinkTo(gamma), "Nowhere",
	)
	lacks(t, "alpha", alpha.BodyHTML, "secret", "multi-line", "<h1", "[[")
	diagram := assetByKey(res, "Vault/attachments/diagram.png")
	if diagram == nil || diagram.MIME != "image/png" || diagram.Name != "diagram.png" {
		t.Fatalf("diagram asset: %+v", diagram)
	}
	contains(t, "alpha", alpha.BodyHTML, `<img src="/v1/attachments/`+diagram.Ref+`" alt=""/>`)

	report := assetByKey(res, "Vault/attachments/report.pdf")
	if report == nil {
		t.Fatal("no report asset")
	}
	contains(t, "beta", beta.BodyHTML, `<p>Beta body with</p><div data-type="file" data-src="/v1/attachments/`+report.Ref+`" data-name="report.pdf" data-size="10" data-mime="application/pdf"></div>`, pageLinkTo(gamma))
	if assetByKey(res, "Vault/attachments/run.sh") != nil || !hasSkip(res, "Vault/attachments/run.sh", "executable") {
		t.Errorf("a script became an asset: %+v", res.Skipped)
	}
	if !hasSkip(res, "Vault/Tasks.base", "unsupported") || !hasSkip(res, "Vault/attachments/unused.png", "unused") {
		t.Errorf("skipped: %+v", res.Skipped)
	}
	if len(res.Assets) != 2 {
		t.Errorf("assets: %d", len(res.Assets))
	}
}

func TestNotionExport(t *testing.T) {
	id := func(n int) string { return fmt.Sprintf("%032x", n+0xabc0) }
	root := "Export-0b1c2d3e-1234/"
	home := "Team Home " + id(1)
	csvBody := "\xef\xbb\xbfName,Status,Tags,Due,Done,Points,Owner,Website,Related\n" +
		"Write docs,In progress,\"docs, writing\",\"November 6, 2026\",Yes,3,Maya Chen,https://example.com,\"Plan (Plan%20" + id(6) + ".md)\"\n" +
		"Ship,Done,docs,\"November 8, 2026 → November 9, 2026\",No,\"1,250.5\",Sam,,\n" +
		"Plan,Not started,\"planning, docs\",\"November 10, 2026 3:30 PM\",No,1,Maya Chen,,\n" +
		"Ship,Done,,,No,2,,,\n"
	data := zipBytes(t,
		entry{root + home + ".md", "# Team Home\n\nWelcome.\n\n<aside>\n🧭 Read the **handbook** first.\n\n</aside>\n\n" +
			"[Onboarding](Team%20Home%20" + id(1) + "/Onboarding%20" + id(2) + ".md)\n\n" +
			"[Tasks](Team%20Home%20" + id(1) + "/Tasks%20" + id(3) + ".csv)\n\n" +
			"See [the tasks](https://www.notion.so/myteam/Tasks-" + id(3) + "?pvs=4)."},
		entry{root + home + "/Onboarding " + id(2) + ".md", "# Onboarding\n\nBack to [Home](../Team%20Home%20" + id(1) + ".md).\n\n![Shot](Onboarding%20" + id(2) + "/shot%201.png)"},
		entry{root + home + "/Onboarding " + id(2) + "/shot 1.png", png},
		entry{root + home + "/Tasks " + id(3) + ".csv", "Name\nonly the view\n"},
		entry{root + home + "/Tasks " + id(3) + "_all.csv", csvBody},
		entry{root + home + "/Tasks " + id(3) + "/Write docs " + id(4) + ".md", "# Write docs\n\nStatus: In progress\nTags: docs, writing\nDue: November 6, 2026\n\nThe row's own text."},
		entry{root + home + "/Tasks " + id(3) + "/Write docs " + id(4) + "/Notes " + id(7) + ".md", "# Notes\n\nUnder a row."},
		entry{root + "Untitled " + id(5) + ".md", "Loose page"},
	)
	res := importOK(t, Options{}, upload("Export.zip", data))

	if got, want := outline(res.Pages, ""), "\nTeam Home\n  Onboarding\n  Tasks\n    Write docs\n      Notes\n    Ship\n    Plan\n    Ship\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	homePage, onboarding, tasks := byTitle(t, res, "Team Home"), byTitle(t, res, "Onboarding"), byTitle(t, res, "Tasks")
	contains(t, "home", homePage.BodyHTML,
		`<p>Welcome.</p><div data-type="callout" data-icon="🧭" data-tone="gray"><p>Read the <strong>handbook</strong> first.</p></div>`,
		`<div data-type="subpage" data-id="`+onboarding.Ref+`"></div>`,
		`<div data-type="database" data-id="`+tasks.Ref+`" data-view="table"></div>`,
		`<p>See <a `+pageLinkTo(tasks),
	)
	lacks(t, "home", homePage.BodyHTML, "<h1", "notion.so")
	shot := assetByKey(res, root+home+"/Onboarding "+id(2)+"/shot 1.png")
	if shot == nil {
		t.Fatalf("no screenshot asset: %+v", res.Assets)
	}
	contains(t, "onboarding", onboarding.BodyHTML, `<a `+pageLinkTo(homePage), `<img src="/v1/attachments/`+shot.Ref+`" alt="Shot"/>`)

	db := tasks.Database
	if db == nil {
		t.Fatal("Tasks is not a database")
	}
	types := map[string]string{}
	for _, p := range db.Properties {
		types[p.Name] = p.Type
	}
	want := map[string]string{"Name": "title", "Status": "status", "Tags": "multi_select", "Due": "date", "Done": "checkbox",
		"Points": "number", "Owner": "text", "Website": "url", "Related": "text"}
	for k, v := range want {
		if types[k] != v {
			t.Errorf("%s is %q, want %q", k, types[k], v)
		}
	}
	if db.Properties[0].ID != "title" || len(db.Views) != 1 || db.Views[0].Type != "table" || db.NextID != 1 {
		t.Errorf("schema: %+v", db)
	}
	prop := func(name string) Property {
		for _, p := range db.Properties {
			if p.Name == name {
				return p
			}
		}
		return Property{}
	}
	option := func(prop Property, name string) string {
		for _, o := range prop.Options {
			if o.Name == name {
				return o.ID
			}
		}
		t.Fatalf("%s has no option %q", prop.Name, name)
		return ""
	}
	status, tags := prop("Status"), prop("Tags")
	if !prop("Due").DateTime {
		t.Error("Due has a time of day in one row")
	}
	for _, g := range status.Groups {
		if g.ID == "done" && !slices.Equal(g.OptionIDs, []string{option(status, "Done")}) ||
			g.ID == "todo" && !slices.Equal(g.OptionIDs, []string{option(status, "Not started")}) {
			t.Errorf("status groups: %+v", status.Groups)
		}
	}
	rows := tasks.Children
	write := rows[0]
	if write.Key != root+home+"/Tasks "+id(3)+"/Write docs "+id(4)+".md" || write.BodyHTML != "<p>The row&#39;s own text.</p>" {
		t.Errorf("row page: %q %q", write.Key, write.BodyHTML)
	}
	check := func(row *Page, key string, want any) {
		t.Helper()
		if got := fmt.Sprint(row.Props[key]); got != fmt.Sprint(want) {
			t.Errorf("%s.%s = %s, want %v", row.Title, key, got, want)
		}
	}
	check(write, "status", option(status, "In progress"))
	check(write, "tags", []string{option(tags, "docs"), option(tags, "writing")})
	check(write, "due", DateValue{Start: "2026-11-06"})
	check(write, "done", true)
	check(write, "points", 3.0)
	check(write, "owner", "Maya Chen")
	check(write, "website", "https://example.com")
	check(write, "related", "Plan")
	check(rows[1], "due", DateValue{Start: "2026-11-08", End: "2026-11-09"})
	check(rows[1], "points", 1250.5)
	check(rows[1], "done", false)
	check(rows[2], "due", DateValue{Start: "2026-11-10T15:30:00Z"})
	if _, ok := rows[1].Props["website"]; ok {
		t.Error("an empty cell has a value")
	}
	if rows[1].BodyHTML != "" || rows[1].Key == rows[3].Key {
		t.Errorf("rows without a page: %q %q", rows[1].Key, rows[3].Key)
	}
}

func TestHTMLImport(t *testing.T) {
	notion := `<!doctype html><html><head><meta charset="utf-8"><title>Runbook</title><style>p{color:red}</style></head><body><article class="page"><header><div class="page-header-icon"><span class="icon">📘</span></div><h1 class="page-title">Runbook</h1></header><div class="page-body">` +
		`<h4>Deep heading</h4><p>Text with <b>bold</b>, <span class="highlight-red">red</span> and <mark class="highlight-yellow_background">hl</mark>.</p>` +
		`<figure class="callout"><div style="font-size:1.5em"><span class="icon">⚠️</span></div><div style="width:100%">Mind the gap</div></figure>` +
		`<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Done thing</span></li><li><div class="checkbox checkbox-off"></div> <span>Open thing</span></li></ul>` +
		`<ul class="toggle"><li><details open=""><summary>More</summary><p>Inside</p></details></li></ul>` +
		`<pre class="code"><code class="language-JavaScript">let a = 1;</code></pre>` +
		`<div class="column-list"><div class="column"><p>L</p></div><div class="column"><p>R</p></div></div>` +
		`<script>alert(1)</script><p><img src="data:image/png;base64,iVBORw0KGgo=" onerror="x()"> after</p>` +
		`<figure class="equation"><div class="equation-container"><span class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span></span></div></figure>` +
		`<p>Ask <span data-type="mention" data-id="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" class="mention">@Maya</span> or <a data-mention="3dcb61fa-abc6-47ac-9916-06acf5b7fdf7" href="https://x.example">Sam</a></p>` +
		`<table><tr><td>a</td><td>b</td></tr></table><p><a href="javascript:alert(1)">bad</a> <a href="https://ok.example" onclick="x()">ok</a> <a href="Other%20page.html">other</a></p></div></article></body></html>`
	confluence := "<html><head><meta charset=\"windows-1252\"><title>Space : Caf\xe9 notes</title></head><body><div id=\"main-content\" class=\"wiki-content\">" +
		`<div class="confluence-information-macro confluence-information-macro-warning"><div class="confluence-information-macro-body"><p>Danger</p></div></div>` +
		`<p><span style="font-weight: bold">Strong</span> and <span style="font-style:italic;text-decoration:underline">both</span></p><h5>Small</h5><iframe src="https://www.youtube.com/watch?v=x"></iframe></div></body></html>`
	other := "<html><body><h1>Other page</h1><p>Plain</p></body></html>"
	res := importOK(t, Options{},
		upload("Runbook.html", []byte(notion)),
		upload("confluence.htm", []byte(confluence)),
		upload("Other page.html", []byte(other)),
		upload("notes.txt", []byte("First para\nsame para\n\n<b>Second</b>")))

	run := byTitle(t, res, "Runbook")
	if run.Icon != "📘" {
		t.Errorf("icon %q", run.Icon)
	}
	img := res.Assets[0]
	if img.MIME != "image/png" || !strings.HasSuffix(img.Name, ".png") {
		t.Errorf("data image: %+v", img)
	}
	contains(t, "runbook", run.BodyHTML,
		`<h3 data-block-id=`, `>Deep heading</h3><p>Text with <strong>bold</strong>, <span data-color="red">red</span> and <mark data-bg="yellow">hl</mark>.</p>`,
		`<div data-type="callout" data-icon="⚠️" data-tone="gray"><p>Mind the gap</p></div>`,
		`<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done thing</p></li><li data-type="taskItem" data-checked="false"><p>Open thing</p></li></ul>`,
		`<details><summary>More</summary><div data-type="detailsContent"><p>Inside</p></div></details>`,
		`<pre><code class="language-javascript">let a = 1;</code></pre>`,
		`<div data-type="columns"><div data-type="column"><p>L</p></div><div data-type="column"><p>R</p></div></div>`,
		`<img src="/v1/attachments/`+img.Ref+`" alt=""/><p>after</p>`,
		`<div data-type="block-math" data-latex="E=mc^2"></div>`,
		`<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>`,
		`<p>bad <a href="https://ok.example"`, `<a `+pageLinkTo(byTitle(t, res, "Other page")),
	)
	contains(t, "runbook", run.BodyHTML, "<p>Ask @Maya or <a href=\"https://x.example\"")
	lacks(t, "runbook", run.BodyHTML, "<script", "alert", "onerror", "onclick", "Runbook</h", "style=", "3dcb61fa", "mention")

	conf := byTitle(t, res, "Café notes")
	contains(t, "confluence", conf.BodyHTML,
		`<div data-type="callout" data-icon="⚠️" data-tone="red"><p>Danger</p></div>`,
		`<p><strong>Strong</strong> and <em><u>both</u></em></p>`, `>Small</h3>`,
		`<div data-type="embed" data-url="https://www.youtube.com/watch?v=x"></div>`)
	if body := byTitle(t, res, "Other page").BodyHTML; body != "<p>Plain</p>" {
		t.Errorf("other: %s", body)
	}
	if body := byTitle(t, res, "notes").BodyHTML; body != "<p>First para<br/>same para</p><p>&lt;b&gt;Second&lt;/b&gt;</p>" {
		t.Errorf("text: %s", body)
	}
}

// mdBody imports one Markdown file and answers its body.
func mdBody(t *testing.T, src string) string {
	t.Helper()
	res := importOK(t, Options{}, upload("Note.md", []byte(src)))
	return res.Pages[0].BodyHTML
}

func TestMarkdown(t *testing.T) {
	cases := []struct{ name, md, want string }{
		{"emphasis", "**b** *i* _i_ __b__ ***bi*** ~~s~~ ==m==", "<p><strong>b</strong> <em>i</em> <em>i</em> <strong>b</strong> <strong><em>bi</em></strong> <s>s</s> <mark>m</mark></p>"},
		{"nested emphasis", "*a **b** c*", "<p><em>a <strong>b</strong> c</em></p>"},
		{"snake case", "snake_case_name and 2 * 3 * 4", "<p>snake_case_name and 2 * 3 * 4</p>"},
		{"code", "use `a *b*` and ``x ` y``", "<p>use <code>a *b*</code> and <code>x ` y</code></p>"},
		{"escapes", `\*not\* \[x\] \# \<b\> 1\. a`, "<p>*not* [x] # &lt;b&gt; 1. a</p>"},
		{"prices", "costs $5 and $10 total", "<p>costs $5 and $10 total</p>"},
		{"links", `[a](https://x.example/a_(b) "t") <https://y.example> https://z.example/p. [mail](mailto:a@b.example)`, `<p><a href="https://x.example/a_(b)" rel="nofollow noreferrer noopener" target="_blank">a</a> <a href="https://y.example" rel="nofollow noreferrer noopener" target="_blank">https://y.example</a> <a href="https://z.example/p" rel="nofollow noreferrer noopener" target="_blank">https://z.example/p</a>. <a href="mailto:a@b.example" rel="nofollow noreferrer">mail</a></p>`},
		{"dangerous", "<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>", "<p>x</p>"},
		{"headings", "Title\n=====\n\nSub\n---\n\n#### Four ####\n\n#nottag", `<h1 data-block-id`},
		{"lists", "1. one\n2. two\n   - nested\n\n- a\n\n- b", "<ol><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ol><ul><li><p>a</p></li><li><p>b</p></li></ul>"},
		{"quote", "> a\nlazy\n>\n> b", "<blockquote><p>a\nlazy</p><p>b</p></blockquote>"},
		{"hard break", "a  \nb\\\nc\nd", "<p>a<br/>b<br/>c\nd</p>"},
		{"rule and indented code", "a\n\n***\n\n    code <x>\n", "<p>a</p><hr/><pre><code>code &lt;x&gt;</code></pre>"},
		{"math fence", "```math\na+b\n```", `<div data-type="block-math" data-latex="a+b"></div>`},
		{"one-line math", "$$e^x$$", `<div data-type="block-math" data-latex="e^x"></div>`},
		{"html details", "<details>\n<summary>Sum</summary>\n\n**inside**\n\n</details>", `<details><summary>Sum</summary><div data-type="detailsContent"><p><strong>inside</strong></p></div></details>`},
		{"callout kinds", "> [!tip] T\n> x\n\n> [!unknown]\n> y", `<div data-type="callout" data-icon="💡" data-tone="green"><p><strong>T</strong></p><p>x</p></div><div data-type="callout" data-icon="💡" data-tone="gray"><p>y</p></div>`},
		{"table escapes", "| a \\| b | `c|d` |\n|:--|--:|\n| 1 |", "<table><tbody><tr><th><p>a | b</p></th><th><p><code>c|d</code></p></th></tr><tr><td><p>1</p></td><td></td></tr></tbody></table>"},
		{"entities", "&amp; &copy; & <", "<p>&amp; © &amp; &lt;</p>"},
		{"unresolved wikilink", "[[Missing page|shown]]", "<p>shown</p>"},
		{"remote image", "![alt](https://img.example/a.png)", `<img src="https://img.example/a.png" alt="alt"/>`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := mdBody(t, c.md)
			if c.name == "headings" {
				re := regexp.MustCompile(`^<h1 data-block-id="[0-9a-f-]{36}">Title</h1><h2 data-block-id="[0-9a-f-]{36}">Sub</h2><h3 data-block-id="[0-9a-f-]{36}">Four</h3><p>#nottag</p>$`)
				if !re.MatchString(got) {
					t.Errorf("got  %s", got)
				}
				return
			}
			if got != c.want {
				t.Errorf("\n got %s\nwant %s", got, c.want)
			}
		})
	}
}

func TestResolve(t *testing.T) {
	res := importOK(t, Options{},
		upload("a.zip", zipBytes(t,
			entry{"A.md", "[[B]] and [[C]]\n\n![[pic.png]]\n\n![[doc.pdf]]\n\n[[A#Top]]\n\n# Top"},
			entry{"B.md", "b"}, entry{"C.md", "c"}, entry{"pic.png", png}, entry{"doc.pdf", "%PDF-1.4"})))
	a, b, c := byTitle(t, res, "A"), byTitle(t, res, "B"), byTitle(t, res, "C")
	pic, pdf := assetByKey(res, "pic.png"), assetByKey(res, "doc.pdf")
	bID, picID := uuid.NewString(), uuid.NewString()
	got := res.Resolve(a.BodyHTML, map[string]string{a.Ref: uuid.NewString(), b.Ref: bID, pic.Ref: picID})
	contains(t, "resolved", got, `data-id="`+bID+`"`, `href="/wiki/`+bID+`"`, `<img src="/v1/attachments/`+picID+`"`, "and C")
	lacks(t, "resolved", got, c.Ref, b.Ref, pic.Ref, pdf.Ref, "data-type=\"file\"", "A#Top")
	if got != hd.SanitizeWiki(got) {
		t.Errorf("resolved body is not sanitized: %s", got)
	}
	// A heading link on the page itself keeps its block id with the page's new id.
	self := uuid.NewString()
	if got := res.Resolve(a.BodyHTML, map[string]string{a.Ref: self}); !strings.Contains(got, `href="/wiki/`+self+`#`) {
		t.Errorf("self link: %s", got)
	}
	if res.Resolve("", nil) != "" {
		t.Error("empty body")
	}
}

func TestDepthLimit(t *testing.T) {
	res := importOK(t, Options{Depth: 2}, upload("d.zip", zipBytes(t,
		entry{"A/B/C/D.md", "d"}, entry{"A/B/C.md", "c"}, entry{"A/B/E.md", "e"})))
	if got, want := outline(res.Pages, ""), "A\n  B\n  C\n  D\n  E\n"; got != want {
		t.Errorf("tree:\n%s\nwant\n%s", got, want)
	}
	for _, k := range []string{"A/B/C.md", "A/B/C/D.md", "A/B/E.md"} {
		if !hasSkip(res, k, "moved_up") {
			t.Errorf("%s not listed as moved: %+v", k, res.Skipped)
		}
	}
}

func TestEncodings(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// A name in code page 437 (0x82 is é), and text in Windows-1252 (0xe9 is é).
	w, _ := zw.CreateHeader(&zip.FileHeader{Name: "Caf\x82.md", NonUTF8: true, Method: zip.Deflate})
	_, _ = w.Write([]byte("Caf\xe9 au lait"))
	w, _ = zw.Create("utf16.txt")
	_, _ = w.Write([]byte("\xff\xfeH\x00i\x00"))
	_ = zw.Close()
	res := importOK(t, Options{}, upload("e.zip", buf.Bytes()))
	if body := byTitle(t, res, "Café").BodyHTML; body != "<p>Café au lait</p>" {
		t.Errorf("body %q", body)
	}
	if body := byTitle(t, res, "utf16").BodyHTML; body != "<p>Hi</p>" {
		t.Errorf("utf16 %q", body)
	}
}

func TestImportRefusals(t *testing.T) {
	symlink := func() []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		h := &zip.FileHeader{Name: "link.md"}
		h.SetMode(os.ModeSymlink | 0o777)
		w, _ := zw.CreateHeader(h)
		_, _ = w.Write([]byte("/etc/passwd"))
		_ = zw.Close()
		return buf.Bytes()
	}
	many := func() []byte {
		var es []entry
		for i := range MaxFiles + 1 {
			es = append(es, entry{fmt.Sprintf("f%d.md", i), "x"})
		}
		return zipBytes(t, es...)
	}
	deep := strings.Repeat("d/", MaxPathDepth) + "x.md"
	cases := []struct {
		name string
		ups  []Upload
		want error
	}{
		{"zip slip", []Upload{upload("a.zip", zipBytes(t, entry{"ok.md", "x"}, entry{"../evil.md", "x"}))}, ErrUnsafePath},
		{"nested zip slip", []Upload{upload("a.zip", zipBytes(t, entry{"a/../../evil.md", "x"}))}, ErrUnsafePath},
		{"absolute path", []Upload{upload("a.zip", zipBytes(t, entry{"/etc/evil.md", "x"}))}, ErrUnsafePath},
		{"drive path", []Upload{upload("a.zip", zipBytes(t, entry{`C:\evil.md`, "x"}))}, ErrUnsafePath},
		{"symlink", []Upload{upload("a.zip", symlink())}, ErrUnsafePath},
		{"too deep", []Upload{upload("a.zip", zipBytes(t, entry{deep, "x"}))}, ErrTooDeep},
		{"too many files", []Upload{upload("a.zip", many())}, ErrTooManyFiles},
		{"upload too large", []Upload{{Name: "a.md", Body: bytes.NewReader(nil), Size: MaxUploadBytes + 1}}, ErrTooLarge},
		{"compression ratio", []Upload{upload("a.zip", zipBytes(t, entry{"bomb.md", strings.Repeat("\x00", 4<<20)}))}, ErrCompression},
		{"lying sizes", []Upload{upload("a.zip", lyingZip(t))}, ErrCompression},
		{"not a zip", []Upload{upload("a.zip", []byte("PK\x03\x04garbage"))}, ErrUnreadable},
		{"nothing to import", []Upload{upload("a.zip", zipBytes(t, entry{"pic.png", png}))}, ErrEmpty},
		{"no page source", []Upload{upload("pic.png", []byte(png))}, ErrUnsupported},
		{"no upload", nil, ErrEmpty},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := Import(c.ups, Options{})
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v (%v), want %v", err, res, c.want)
			}
		})
	}
}

// lyingZip declares a file of 100 bytes that inflates to far more.
func lyingZip(t *testing.T) []byte {
	var comp bytes.Buffer
	fw, _ := flate.NewWriter(&comp, flate.BestCompression)
	payload := bytes.Repeat([]byte("a"), 200<<10)
	_, _ = fw.Write(payload)
	_ = fw.Close()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateRaw(&zip.FileHeader{Name: "note.md", Method: zip.Deflate, CRC32: crc32.ChecksumIEEE(payload),
		CompressedSize64: uint64(comp.Len()), UncompressedSize64: 100})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write(comp.Bytes())
	_ = zw.Close()
	return buf.Bytes()
}

func TestTotalSizeCounted(t *testing.T) {
	fs := newFiles()
	fs.total = MaxTotalBytes - 10
	if _, err := fs.readCounted(strings.NewReader(strings.Repeat("x", 100)), 100, 0, MaxFileBytes); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v", err)
	}
	fs = newFiles()
	if _, err := fs.readCounted(strings.NewReader(strings.Repeat("x", 2<<20)), 2<<20, 1000, MaxFileBytes); !errors.Is(err, ErrCompression) {
		t.Fatalf("ratio while reading: %v", err)
	}
}

func TestAssetSafety(t *testing.T) {
	res := importOK(t, Options{}, upload("a.zip", zipBytes(t,
		entry{"Note.md", "![[tool.exe]] ![[fake.png]] ![[page.svg]] ![[big.bin]] [link](setup.msi)\n\n![[ok.png]]"},
		entry{"tool.exe", "MZ\x90\x00"},
		entry{"fake.png", "MZ\x90\x00 not an image"},
		entry{"page.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`},
		entry{"setup.msi", "\xd0\xcf\x11\xe0"},
		entry{"ok.png", png},
		entry{"nested.zip", string(zipBytes(t, entry{"inner.zip", string(zipBytes(t, entry{"x.md", "x"}))}, entry{"Inner note.md", "from a part"}))},
	)))
	for _, k := range []string{"tool.exe", "fake.png", "setup.msi"} {
		if assetByKey(res, k) != nil || !hasSkip(res, k, "executable") {
			t.Errorf("%s: %+v", k, res.Skipped)
		}
	}
	svg := assetByKey(res, "page.svg")
	if svg == nil || strings.Contains(svg.MIME, "svg") || strings.HasPrefix(svg.MIME, "image/") {
		t.Errorf("an SVG is stored as an active type: %+v", svg)
	}
	note := byTitle(t, res, "Note")
	contains(t, "note", note.BodyHTML, `<div data-type="file" data-src="/v1/attachments/`+svg.Ref+`" data-name="page.svg"`, `<img src="/v1/attachments/`+assetByKey(res, "ok.png").Ref)
	lacks(t, "note", note.BodyHTML, "tool", "fake", "setup")
	// Notion splits a large export into zips inside the zip: one level is unpacked.
	byTitle(t, res, "Inner note")
	if !hasSkip(res, "inner.zip", "nested_archive") {
		t.Errorf("deeper archive: %+v", res.Skipped)
	}
}

func readZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func sampleWiki() ([]ExportPage, map[string][]byte) {
	home, guide, tasks, r1, r2, dup1, dup2 := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	pic, other := uuid.NewString(), uuid.NewString()
	when := time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)
	db := &Database{Properties: []Property{
		{ID: "title", Name: "Name", Type: "title"},
		{ID: "status", Name: "Status", Type: "select", Options: []Option{{ID: "a", Name: "Open", Color: "blue"}, {ID: "b", Name: "Done", Color: "green"}}},
		{ID: "due", Name: "Due", Type: "date"},
		{ID: "done", Name: "Done?", Type: "checkbox"},
		{ID: "n", Name: "Points", Type: "number"},
		{ID: "made", Name: "Created", Type: "created_time"},
	}, Views: []View{{ID: "table", Name: "Table", Type: "table"}}, NextID: 1}
	pages := []ExportPage{
		{ID: home, Title: "Home", Icon: "🏠", Kind: "page", CreatedAt: when, UpdatedAt: when, Tags: []string{"start"},
			BodyHTML: `<p>Read the <a data-type="page" data-id="` + guide + `" href="/wiki/` + guide + `">Guide</a> and <a data-type="page" data-id="` + other + `" href="/wiki/` + other + `">a page left out</a>. #start</p>` +
				`<div data-type="subpage" data-id="` + guide + `"></div><div data-type="database" data-id="` + tasks + `" data-view="table"></div>` +
				`<img src="/v1/attachments/` + pic + `" alt="Pic"><div data-type="callout" data-icon="⚠️" data-tone="orange"><p>Careful</p></div>` +
				`<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul><p>Math <span data-type="inline-math" data-latex="x^2"></span></p>`},
		{ID: guide, ParentID: home, Title: "Guide: the basics?", Kind: "page", BodyHTML: `<h2>Start</h2><p>Back <a data-type="page" data-id="` + home + `" href="/wiki/` + home + `">home</a></p>`},
		{ID: tasks, ParentID: home, Title: "Tasks", Kind: "database", Database: db, BodyHTML: "<p>All the tasks.</p>"},
		{ID: r1, ParentID: tasks, Title: "Write docs", Props: map[string]any{"status": "a", "due": map[string]any{"start": "2026-11-06"}, "done": true, "n": 3}, CreatedAt: when, BodyHTML: "<p>Row text</p>"},
		{ID: r2, ParentID: tasks, Title: "Ship", Props: map[string]any{"status": "b", "due": map[string]any{"start": "2026-11-08", "end": "2026-11-09"}, "done": false, "n": 5.5}, CreatedAt: when},
		{ID: dup1, ParentID: home, Title: "Same", BodyHTML: "<p>one</p>"},
		{ID: dup2, ParentID: home, Title: "Same", BodyHTML: "<p>two</p>"},
	}
	return pages, map[string][]byte{pic: []byte(png)}
}

func TestExportMarkdownRoundTrip(t *testing.T) {
	pages, files := sampleWiki()
	var buf bytes.Buffer
	opened := 0
	err := ExportZip(&buf, pages, ExportOptions{Format: FormatMarkdown, Frontmatter: true, BaseURL: "https://app.example.com",
		Attachment: func(id string) (string, io.ReadCloser, error) {
			opened++
			data, ok := files[id]
			if !ok {
				return "", nil, errors.New("gone")
			}
			return "pic.png", io.NopCloser(bytes.NewReader(data)), nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	zipped := readZip(t, buf.Bytes())
	names := make([]string, 0, len(zipped))
	for k := range zipped {
		names = append(names, k)
	}
	slices.Sort(names)
	want := []string{"Home.md", "Home/Guide the basics.md", "Home/Same (2).md", "Home/Same.md", "Home/Tasks.csv", "Home/Tasks.md", "Home/Tasks/Ship.md", "Home/Tasks/Write docs.md", "attachments/pic.png"}
	if !slices.Equal(names, want) {
		t.Fatalf("files:\n%v\nwant\n%v", names, want)
	}
	if opened != 1 {
		t.Errorf("the attachment was opened %d times", opened)
	}
	homeMD := zipped["Home.md"]
	contains(t, "Home.md", homeMD, "---\ntitle: \"Home\"\nicon: \"🏠\"\ncreated: 2026-11-06T09:30:00Z\n", "tags:\n  - \"start\"\n",
		"[[Guide the basics|Guide: the basics?]]", "[a page left out](https://app.example.com/wiki/", "![Pic](attachments/pic.png)",
		"> [!warning]\n> Careful", "- [x] done", "$x^2$", "\n[[Tasks]]\n")
	contains(t, "Tasks.md", zipped["Home/Tasks.md"], "All the tasks.", "| Name | Status | Due | Done? | Points | Created |",
		"| [[Write docs]] | Open | 2026-11-06 | Yes | 3 | 2026-11-06 |", "| [[Ship]] | Done | 2026-11-08 → 2026-11-09 | No | 5.5 | 2026-11-06 |")
	contains(t, "Tasks.csv", zipped["Home/Tasks.csv"], "Name,Status,Due,Done?,Points,Created\nWrite docs,Open,2026-11-06,Yes,3,2026-11-06\n")
	contains(t, "row", zipped["Home/Tasks/Write docs.md"], "\"Status\": \"Open\"\n", "Row text")
	contains(t, "guide", zipped["Home/Guide the basics.md"], "Back [[Home]]")
	// Two pages of one name: links say which.
	if !strings.Contains(zipped["Home/Same.md"], "one") || !strings.Contains(zipped["Home/Same (2).md"], "two") {
		t.Error("same names")
	}

	// And back.
	res := importOK(t, Options{}, upload("export.zip", buf.Bytes()))
	if got, want := outline(res.Pages, ""), "Home\n  Guide: the basics?\n  Tasks\n    Write docs\n    Ship\n  Same\n  Same\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	home, guide, tasks := byTitle(t, res, "Home"), byTitle(t, res, "Guide: the basics?"), byTitle(t, res, "Tasks")
	if home.Icon != "🏠" || !slices.Equal(home.Tags, []string{"start"}) {
		t.Errorf("home: %q %v", home.Icon, home.Tags)
	}
	pic := assetByKey(res, "attachments/pic.png")
	if pic == nil {
		t.Fatal("no picture")
	}
	contains(t, "home", home.BodyHTML, pageLinkTo(guide), `<div data-type="subpage" data-id="`+guide.Ref+`">`,
		`<div data-type="database" data-id="`+tasks.Ref+`" data-view="table">`, `<img src="/v1/attachments/`+pic.Ref+`" alt="Pic"/>`,
		`<div data-type="callout" data-icon="⚠️" data-tone="orange"><p>Careful</p></div>`,
		`<li data-type="taskItem" data-checked="true"><p>done</p></li>`, `<span data-type="inline-math" data-latex="x^2"></span>`,
		`>a page left out</a>`)
	lacks(t, "home", home.BodyHTML, "#start #start")
	contains(t, "guide", guide.BodyHTML, pageLinkTo(home), ">Start</h2>")
	if tasks.Database == nil || tasks.BodyHTML != "<p>All the tasks.</p>" {
		t.Fatalf("tasks: %+v %s", tasks.Database, tasks.BodyHTML)
	}
	row := tasks.Children[0]
	if row.BodyHTML != "<p>Row text</p>" || fmt.Sprint(row.Props["due"]) != fmt.Sprint(DateValue{Start: "2026-11-06"}) || row.Props["done"] != true || row.Props["points"] != 3.0 {
		t.Errorf("row: %s %v", row.BodyHTML, row.Props)
	}
	same := home.Children[2:]
	if same[0].BodyHTML != "<p>one</p>" || same[1].BodyHTML != "<p>two</p>" {
		t.Errorf("same: %s %s", same[0].BodyHTML, same[1].BodyHTML)
	}
}

func TestExportHTMLRoundTrip(t *testing.T) {
	pages, files := sampleWiki()
	var buf bytes.Buffer
	err := ExportZip(&buf, pages, ExportOptions{Format: FormatHTML, Attachment: func(id string) (string, io.ReadCloser, error) {
		return "pic.png", io.NopCloser(bytes.NewReader(files[id])), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	zipped := readZip(t, buf.Bytes())
	home := zipped["Home.html"]
	contains(t, "Home.html", home, "<!doctype html>", "<title>Home</title>", `<div class="page-header-icon">🏠</div>`,
		`<a href="Home/Guide%20the%20basics.html">Guide</a>`, `<p><a href="Home/Tasks.html">Tasks</a></p>`, `src="attachments/pic.png"`)
	lacks(t, "Home.html", home, "/wiki/", "/v1/attachments")
	contains(t, "Tasks.html", zipped["Home/Tasks.html"], `<td><a href="Tasks/Write%20docs.html">Write docs</a></td><td>Open</td>`)
	contains(t, "guide", zipped["Home/Guide the basics.html"], `<a href="../Home.html">home</a>`)

	res := importOK(t, Options{}, upload("export.zip", buf.Bytes()))
	if got, want := outline(res.Pages, ""), "Home\n  Guide: the basics?\n  Tasks\n    Write docs\n    Ship\n  Same\n  Same\n"; got != want {
		t.Fatalf("tree:\n%s\nwant\n%s", got, want)
	}
	h, g := byTitle(t, res, "Home"), byTitle(t, res, "Guide: the basics?")
	if h.Icon != "🏠" {
		t.Errorf("icon %q", h.Icon)
	}
	contains(t, "home", h.BodyHTML, pageLinkTo(g), `<div data-type="subpage" data-id="`+g.Ref+`">`,
		`<div data-type="callout" data-icon="⚠️" data-tone="orange"><p>Careful</p></div>`, `data-latex="x^2"`)
	contains(t, "guide", g.BodyHTML, pageLinkTo(h))
}

func TestExportFile(t *testing.T) {
	pages, _ := sampleWiki()
	home := pages[0]
	var md, page bytes.Buffer
	if err := ExportFile(&md, home, ExportOptions{Format: FormatMarkdown, BaseURL: "https://app.example.com"}); err != nil {
		t.Fatal(err)
	}
	contains(t, "md", md.String(), "[Guide](https://app.example.com/wiki/", "![Pic](https://app.example.com/v1/attachments/")
	lacks(t, "md", md.String(), "---\n", "[[")
	if err := ExportFile(&page, home, ExportOptions{Format: FormatHTML}); err != nil {
		t.Fatal(err)
	}
	contains(t, "html", page.String(), "<title>Home</title>", "Guide")
	lacks(t, "html", page.String(), "/wiki/")
	if ExportFileName(ExportPage{Title: "a/b: c"}, FormatHTML) != "ab c.html" || ExportFileName(ExportPage{}, FormatMarkdown) != "Untitled.md" {
		t.Error("file names")
	}
	if err := ExportZip(io.Discard, nil, ExportOptions{Format: "pdf"}); err == nil {
		t.Error("an unknown format")
	}
}

// FuzzMarkdown: any Markdown converts without failing, to a body the wiki keeps as it is.
func FuzzMarkdown(f *testing.F) {
	for _, s := range []string{"**a*b**c*", "> [!x]-\n>", "- [ ] a\n  - b\n\n    c", "| a |\n|---|\n| [[b\\|c]] |", "$$\n", "```\n", "![[a.png|10]]", "<aside>\n", "<details>", "[a](<b>)", "_a_b_", "%%", "==a==b==", "---\ntitle: [\n---\n", "\\", "[[#]]", "1. \n2."} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, md string) {
		start := time.Now()
		defer func() {
			if d := time.Since(start); d > 2*time.Second {
				t.Fatalf("%d bytes took %s", len(md), d)
			}
		}()
		res, err := Import([]Upload{upload("Note.md", []byte(md))}, Options{})
		if err != nil {
			return
		}
		walk(res.Pages, func(p *Page) {
			if hd.SanitizeWiki(p.BodyHTML) != p.BodyHTML {
				t.Fatalf("not sanitized: %q -> %q", md, p.BodyHTML)
			}
		})
	})
}

// TestPathologicalMarkdown: openers without closers and deep nesting cost time in
// proportion to the text. A linear parse takes under a second here and a few under the race
// detector; a quadratic one takes minutes, so the budget sits between the two.
func TestPathologicalMarkdown(t *testing.T) {
	for _, unit := range []string{"*a ", "_a ", "**a ", "[a", "`a ", "$a ", "[[a", "![[a", "<a ", "![", "> ", "- ", "1. "} {
		src := strings.Repeat(unit, (1<<20)/len(unit))
		start := time.Now()
		if _, err := Import([]Upload{upload("Note.md", []byte(src))}, Options{}); err != nil && !errors.Is(err, ErrEmpty) {
			t.Fatalf("%q: %v", unit, err)
		}
		if d := time.Since(start); d > 30*time.Second {
			t.Errorf("%q x %d took %s", unit, len(src)/len(unit), d)
		}
	}
}
