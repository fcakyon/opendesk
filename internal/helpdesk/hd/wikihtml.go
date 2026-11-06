package hd

import (
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
)

// The wiki's blocks (contracts/wiki.md "Blocks"): data attributes on plain elements, each
// value checked here. Nothing that runs, loads a frame or styles freely survives: embeds
// keep only the link (the app maps it to an allowed player), files only our attachments or
// https, colours only the named tones.
var (
	wikiTone     = regexp.MustCompile(`^(gray|brown|orange|yellow|green|blue|purple|pink|red)$`)
	wikiDivTypes = regexp.MustCompile(`^(callout|columns|column|file|video|audio|bookmark|embed|toc|subpage|block-math|detailsContent)$`)
	wikiSpanType = regexp.MustCompile(`^(mention|inline-math)$`)
	wikiSrc      = regexp.MustCompile(`^(?i:https://[^\s"'<>]+|/v1/attachments/[0-9a-fA-F-]{36}(\?[^\s"'<>]*)?)$`)
	httpsURL     = regexp.MustCompile(`^(?i:https://[^\s"'<>]+)$`)
	shortText    = regexp.MustCompile(`^[^\x00-\x1f\x7f]{0,500}$`)
	latexText    = regexp.MustCompile(`^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$`)
	emojiText    = regexp.MustCompile(`^[^\x00-\x1f\x7f<>"'&]{1,16}$`)
	integer      = regexp.MustCompile(`^[0-9]{1,9}$`)
	mimeType     = regexp.MustCompile(`^[\w.+-]{1,60}/[\w.+-]{1,60}$`)
	isoDay       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	codeLang     = regexp.MustCompile(`^language-[a-z0-9+#-]{1,30}$`)
	colWidths    = regexp.MustCompile(`^\d{1,5}(,\d{1,5}){0,63}$`)
	pixels       = regexp.MustCompile(`^\d{1,5}px$`)

	wikiPolicy = newWikiPolicy()
)

func newWikiPolicy() *bluemonday.Policy {
	p := newRichPolicy()
	// A to-do's checkbox is the app's to draw: its <label> goes with what is in it.
	p.SkipElementsContent("label")
	blocks := []string{"p", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "table", "img", "div", "details", "hr"}
	p.AllowElements("hr", "div", "details", "summary", "mark", "time", "table", "thead", "tbody", "tr", "th", "td", "colgroup", "col")
	p.AllowAttrs("data-block-id").Matching(uuidAttr).OnElements(blocks...)

	// Colours of a block or of a run of text.
	p.AllowAttrs("data-color").Matching(wikiTone).OnElements("p", "h1", "h2", "h3", "li", "ul", "ol", "blockquote", "details", "span")
	p.AllowAttrs("data-bg").Matching(wikiTone).OnElements("p", "h1", "h2", "h3", "li", "ul", "ol", "blockquote", "details", "mark")
	p.AllowStyles("text-align").MatchingEnum("left", "center", "right", "justify").OnElements("p", "h1", "h2", "h3")

	// To-do lists.
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^taskList$`)).OnElements("ul")
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^taskItem$`)).OnElements("li")
	p.AllowAttrs("data-checked").Matching(regexp.MustCompile(`^(true|false)$`)).OnElements("li")

	// Blocks drawn by the app: callouts, columns, files, media, bookmarks, embeds, the
	// table of contents, subpages, equations, toggles' content.
	p.AllowAttrs("data-type").Matching(wikiDivTypes).OnElements("div")
	p.AllowAttrs("data-icon").Matching(emojiText).OnElements("div")
	p.AllowAttrs("data-tone").Matching(wikiTone).OnElements("div")
	p.AllowAttrs("data-src").Matching(wikiSrc).OnElements("div")
	p.AllowAttrs("data-name", "data-title", "data-description").Matching(shortText).OnElements("div")
	p.AllowAttrs("data-size", "data-height").Matching(integer).OnElements("div")
	p.AllowAttrs("data-mime").Matching(mimeType).OnElements("div")
	p.AllowAttrs("data-url", "data-image").Matching(httpsURL).OnElements("div")
	p.AllowAttrs("data-id").Matching(uuidAttr).OnElements("div")
	p.AllowAttrs("data-latex").Matching(latexText).OnElements("div", "span")

	// Inline: people (the rich policy's), equations, links to pages, dates, highlights.
	p.AllowAttrs("data-type").Matching(wikiSpanType).OnElements("span")
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^page$`)).OnElements("a")
	p.AllowAttrs("data-id", "data-block").Matching(uuidAttr).OnElements("a")
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^date$`)).OnElements("time")
	p.AllowAttrs("datetime").Matching(isoDay).OnElements("time")

	// Images: width (percent of the column), alignment, caption.
	p.AllowAttrs("data-width").Matching(integer).OnElements("img")
	p.AllowAttrs("data-align").Matching(regexp.MustCompile(`^(left|center|right)$`)).OnElements("img")
	p.AllowAttrs("data-caption").Matching(shortText).OnElements("img")

	// Code blocks keep their language; tables their spans and column widths.
	p.AllowAttrs("class").Matching(codeLang).OnElements("code")
	p.AllowAttrs("colspan", "rowspan").Matching(integer).OnElements("th", "td")
	p.AllowAttrs("colwidth").Matching(colWidths).OnElements("th", "td")
	p.AllowStyles("width", "min-width").Matching(pixels).OnElements("col", "table")
	return p
}

// WikiSrc reports a link the wiki may load in place: https, or one of our attachments.
func WikiSrc(s string) bool { return wikiSrc.MatchString(s) }

// SanitizeWiki reduces a wiki page body to the rich-text allowlist and the wiki's blocks.
func SanitizeWiki(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	return strings.TrimSpace(wikiPolicy.Sanitize(raw))
}
