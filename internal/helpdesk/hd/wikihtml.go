package hd

import (
	"html"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	xhtml "golang.org/x/net/html"
)

// The wiki's blocks (contracts/wiki.md "Blocks"): data attributes on plain elements, each
// value checked here. Nothing that runs, loads a frame or styles freely survives: embeds
// keep only the link (the app maps it to an allowed player), files only our attachments or
// https, colours only the named tones.
var (
	wikiTone     = regexp.MustCompile(`^(gray|brown|orange|yellow|green|blue|purple|pink|red)$`)
	wikiDivTypes = regexp.MustCompile(`^(callout|columns|column|file|video|audio|bookmark|embed|toc|subpage|database|block-math|detailsContent|tickets|transclusion|button|footnotes|footnote)$`)
	wikiSpanType = regexp.MustCompile(`^(mention|inline-math)$`)
	wikiSrc      = regexp.MustCompile(`^(?i:https://[^\s"'<>]+|/v1/attachments/[0-9a-fA-F-]{36}(\?[^\s"'<>]*)?)$`)
	httpsURL     = regexp.MustCompile(`^(?i:https://[^\s"'<>]+)$`)
	shortText    = regexp.MustCompile(`^[^\x00-\x1f\x7f]{0,500}$`)
	latexText    = regexp.MustCompile(`^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$`)
	emojiText    = regexp.MustCompile(`^[^\x00-\x1f\x7f<>"'&]{1,16}$`)
	integer      = regexp.MustCompile(`^[0-9]{1,9}$`)
	mimeType     = regexp.MustCompile(`^[\w.+-]{1,60}/[\w.+-]{1,60}$`)
	isoDay       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	// A date mention: a day, a day and a time on the writer's clock, or an instant.
	isoWhen   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$`)
	codeLang  = regexp.MustCompile(`^language-[a-z0-9+#-]{1,30}$`)
	colWidths = regexp.MustCompile(`^\d{1,5}(,\d{1,5}){0,63}$`)
	pixels    = regexp.MustCompile(`^\d{1,5}px$`)
	// Where a mention of a ticket or a contact points: the app's own route for it, nothing else.
	mentionHref = map[string]*regexp.Regexp{
		"ticket":  regexp.MustCompile(`^/tickets/[0-9]{1,18}$`),
		"contact": regexp.MustCompile(`^/contacts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`),
	}
	relValue = regexp.MustCompile(`^[a-z ]{1,64}$`)
	// A button block (contracts/wiki.md "Blocks"): what it says and what it does.
	buttonLabel  = regexp.MustCompile(`^[^\x00-\x1f\x7f]{1,100}$`)
	buttonAction = regexp.MustCompile(`^(template|todo|link|row)$`)
	// A new row's values by property id, read by the app as data: one JSON object.
	buttonProps = regexp.MustCompile(`^\{[^\x00-\x1f\x7f]{0,1000}\}$`)

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
	// table of contents, subpages, equations, toggles' content, synced blocks, buttons and
	// the footnotes list.
	p.AllowAttrs("data-type").Matching(wikiDivTypes).OnElements("div")
	p.AllowAttrs("data-icon").Matching(emojiText).OnElements("div")
	p.AllowAttrs("data-tone").Matching(wikiTone).OnElements("div")
	p.AllowAttrs("data-src").Matching(wikiSrc).OnElements("div")
	p.AllowAttrs("data-name", "data-title", "data-description").Matching(shortText).OnElements("div")
	p.AllowAttrs("data-size", "data-height").Matching(integer).OnElements("div")
	p.AllowAttrs("data-mime").Matching(mimeType).OnElements("div")
	p.AllowAttrs("data-url", "data-image").Matching(httpsURL).OnElements("div")
	p.AllowAttrs("data-id").Matching(uuidAttr).OnElements("div")
	// A database inside a page: which database, and which of its views shows.
	p.AllowAttrs("data-view").Matching(regexp.MustCompile(`^[a-z0-9_]{1,24}$`)).OnElements("div")
	p.AllowAttrs("data-latex").Matching(latexText).OnElements("div", "span")
	// The tickets block: a saved view's open tickets (data-id), how many show.
	p.AllowAttrs("data-limit").Matching(integer).OnElements("div")
	// A synced block: another page (data-id), or one block or heading's section of it.
	p.AllowAttrs("data-block").Matching(uuidAttr).OnElements("div")
	// A button: its label, its action and what the action needs (data-url, data-title above).
	p.AllowAttrs("data-label").Matching(buttonLabel).OnElements("div")
	p.AllowAttrs("data-action").Matching(buttonAction).OnElements("div")
	p.AllowAttrs("data-template", "data-database").Matching(uuidAttr).OnElements("div")
	p.AllowAttrs("data-props").Matching(buttonProps).OnElements("div")
	// Footnotes: a reference in the text and its note in the list at the page's end.
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^footnote$`)).OnElements("sup")
	p.AllowAttrs("data-note").Matching(uuidAttr).OnElements("sup", "div")
	// A toggle heading: a toggle whose summary is a heading of that level.
	p.AllowAttrs("data-heading").Matching(regexp.MustCompile(`^[123]$`)).OnElements("details")

	// Inline: people (the rich policy's), equations, links to pages, tickets and contacts,
	// dates, highlights. A ticket or contact link is reduced further by mentionLinks.
	p.AllowAttrs("data-type").Matching(wikiSpanType).OnElements("span")
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^(page|ticket|contact)$`)).OnElements("a")
	p.AllowAttrs("data-id", "data-block").Matching(uuidAttr).OnElements("a")
	p.AllowAttrs("data-type").Matching(regexp.MustCompile(`^date$`)).OnElements("time")
	p.AllowAttrs("datetime").Matching(isoWhen).OnElements("time")
	// Collaboration (contracts/wiki.md "Comments", "Reminders"): a run of text an inline
	// comment thread is on, and a date that reminds someone.
	p.AllowAttrs("data-comment").Matching(uuidAttr).OnElements("span")
	p.AllowAttrs("data-reminder").Matching(uuidAttr).OnElements("time")

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
	return strings.TrimSpace(mentionLinks(wikiPolicy.Sanitize(raw)))
}

// mentionLinks reduces each link to a ticket or a contact in sanitized HTML to what the
// app draws it from: its type, the record's id and the app's route for it
// (`<a data-type="ticket" data-id="<uuid>" href="/tickets/<number>">`), with the policy's
// rel. Any other href or attribute goes; without an id it is a plain link. Everything
// else is copied as it is.
func mentionLinks(clean string) string {
	if !strings.Contains(clean, `data-type="ticket"`) && !strings.Contains(clean, `data-type="contact"`) {
		return clean
	}
	var b strings.Builder
	z := xhtml.NewTokenizer(strings.NewReader(clean))
	for {
		tt := z.Next()
		if tt == xhtml.ErrorToken {
			return b.String()
		}
		if tt != xhtml.StartTagToken {
			b.Write(z.Raw())
			continue
		}
		// Token unescapes attribute values in the tokenizer's buffer: keep the bytes first.
		raw := append([]byte(nil), z.Raw()...)
		tok := z.Token()
		var kind, id, href, rel string
		for _, a := range tok.Attr {
			switch a.Key {
			case "data-type":
				kind = a.Val
			case "data-id":
				id = a.Val
			case "href":
				href = a.Val
			case "rel":
				rel = a.Val
			}
		}
		shape, ok := mentionHref[kind]
		if tok.Data != "a" || !ok {
			b.Write(raw)
			continue
		}
		b.WriteString("<a")
		if uuidAttr.MatchString(id) {
			b.WriteString(` data-type="` + kind + `" data-id="` + html.EscapeString(id) + `"`)
		}
		if shape.MatchString(href) {
			b.WriteString(` href="` + html.EscapeString(href) + `"`)
			if relValue.MatchString(rel) {
				b.WriteString(` rel="` + rel + `"`)
			}
		}
		b.WriteString(">")
	}
}
