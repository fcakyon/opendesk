package wikiport

import (
	"html"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Markdown to HTML: CommonMark's blocks and inlines as Obsidian and Notion write them, with
// GitHub's tables, task lists, strikethrough and autolinks, and Obsidian's wikilinks,
// embeds, callouts, highlights, math and comments. The HTML it writes is raw: links still
// name files, and wikilinks and embeds are <a data-wikilink> and <a data-wikiembed>. The
// normalizer (wikihtml.go) resolves them, shapes the blocks the wiki keeps and sanitizes.

type mdOptions struct {
	// breaks turns a single line break inside a paragraph into <br>, as Obsidian shows it.
	breaks bool
}

func markdownToHTML(src string, opt mdOptions) string {
	src = strings.ReplaceAll(src, "\t", "    ")
	lines := strings.Split(stripComments(src), "\n")
	p := mdParser{opt: opt}
	return p.blocks(lines)
}

type mdParser struct {
	opt   mdOptions
	depth int // quotes and lists open around the lines being read
	// budget is how many places emphasis may still look at for its closer in the
	// paragraph being read: a paragraph of openers without closers stays linear.
	budget int
	inSpan int
}

// maxNesting is how many quotes and lists may nest; deeper markers are read as text.
const maxNesting = 16

var (
	fenceOpen   = regexp.MustCompile("^( {0,3})(`{3,}|~{3,})\\s*([^`\\s]*)")
	atxHeading  = regexp.MustCompile(`^ {0,3}(#{1,6})(?:[ ]+(.*?))?(?:[ ]+#+)?[ ]*$`)
	thematic    = regexp.MustCompile(`^ {0,3}((?:\*[ ]*){3,}|(?:-[ ]*){3,}|(?:_[ ]*){3,})$`)
	setext1     = regexp.MustCompile(`^ {0,3}=+[ ]*$`)
	setext2     = regexp.MustCompile(`^ {0,3}-+[ ]*$`)
	listItem    = regexp.MustCompile(`^( {0,3})([-*+]|\d{1,9}[.)])( +|$)`)
	quoteLine   = regexp.MustCompile(`^ {0,3}>`)
	tableDelim  = regexp.MustCompile(`^ {0,3}\|?[ ]*:?-+:?[ ]*(\|[ ]*:?-+:?[ ]*)*\|?[ ]*$`)
	htmlBlock   = regexp.MustCompile(`(?i)^ {0,3}</?(address|article|aside|blockquote|center|details|dialog|div|dl|figure|footer|form|h[1-6]|header|hr|iframe|main|nav|ol|p|pre|script|section|style|summary|table|tbody|td|th|thead|tr|ul|video|audio|img|br|object|embed|noscript|template)(\s|/?>|$)`)
	calloutHead = regexp.MustCompile(`^\[!([A-Za-z][\w-]*)\]([-+]?)[ ]*(.*)$`)
	taskMarker  = regexp.MustCompile(`^\[([ xX])\](?:[ ]+|$)`)
	mathOneLine = regexp.MustCompile(`^ {0,3}\$\$(.+)\$\$[ ]*$`)
	commentRun  = regexp.MustCompile(`(?s)%%.*?%%`)
)

// stripComments drops Obsidian's %%comments%% outside code fences.
func stripComments(src string) string {
	if !strings.Contains(src, "%%") {
		return src
	}
	lines := strings.Split(src, "\n")
	var out, run []string
	flush := func() {
		if len(run) > 0 {
			text := commentRun.ReplaceAllString(strings.Join(run, "\n"), "")
			if i := strings.Index(text, "%%"); i >= 0 { // an unclosed comment runs to the end
				text = text[:i]
			}
			out = append(out, strings.Split(text, "\n")...)
			run = nil
		}
	}
	fence := ""
	for _, l := range lines {
		if fence != "" {
			out = append(out, l)
			if strings.HasPrefix(strings.TrimSpace(l), fence) {
				fence = ""
			}
			continue
		}
		if m := fenceOpen.FindStringSubmatch(l); m != nil {
			flush()
			fence = m[2]
			out = append(out, l)
			continue
		}
		run = append(run, l)
	}
	flush()
	return strings.Join(out, "\n")
}

func indentOf(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

func blank(s string) bool { return strings.TrimSpace(s) == "" }

// dedent removes up to n spaces from the start of a line.
func dedent(s string, n int) string {
	i := 0
	for i < n && i < len(s) && s[i] == ' ' {
		i++
	}
	return s[i:]
}

// startsBlock reports whether a line opens a block that ends a paragraph.
func startsBlock(l string) bool {
	return atxHeading.MatchString(l) || thematic.MatchString(l) || quoteLine.MatchString(l) || fenceOpen.MatchString(l) ||
		strings.HasPrefix(strings.TrimSpace(l), "$$") || htmlBlock.MatchString(l) || startsListItem(l)
}

// startsListItem is a list marker with something after it: an empty item would turn a
// "-" under a paragraph into a list.
func startsListItem(l string) bool {
	m := listItem.FindStringSubmatchIndex(l)
	return m != nil && !blank(l[m[1]:])
}

// blocks renders a run of lines.
func (p *mdParser) blocks(lines []string) string {
	var b strings.Builder
	var para []string
	flush := func() {
		if len(para) > 0 {
			b.WriteString("<p>" + p.inlineLines(para) + "</p>")
			para = nil
		}
	}
	for i := 0; i < len(lines); {
		l := lines[i]
		switch {
		case blank(l):
			flush()
			i++
		case len(para) > 0 && setext1.MatchString(l):
			b.WriteString("<h1>" + p.inline(strings.TrimSpace(strings.Join(para, " "))) + "</h1>")
			para = nil
			i++
		case len(para) > 0 && setext2.MatchString(l):
			b.WriteString("<h2>" + p.inline(strings.TrimSpace(strings.Join(para, " "))) + "</h2>")
			para = nil
			i++
		case len(para) == 0 && indentOf(l) >= 4:
			j := i
			var code []string
			for j < len(lines) && (indentOf(lines[j]) >= 4 || blank(lines[j])) {
				code = append(code, dedent(lines[j], 4))
				j++
			}
			for len(code) > 0 && blank(code[len(code)-1]) {
				code = code[:len(code)-1]
				j--
			}
			b.WriteString("<pre><code>" + html.EscapeString(strings.Join(code, "\n")) + "</code></pre>")
			i = j
		case fenceOpen.MatchString(l):
			flush()
			i = p.fence(&b, lines, i)
		case strings.HasPrefix(strings.TrimSpace(l), "$$"):
			flush()
			i = p.math(&b, lines, i)
		case atxHeading.MatchString(l):
			flush()
			m := atxHeading.FindStringSubmatch(l)
			level := min(len(m[1]), 3)
			tag := "h" + strconv.Itoa(level)
			b.WriteString("<" + tag + ">" + p.inline(strings.TrimSpace(m[2])) + "</" + tag + ">")
			i++
		case thematic.MatchString(l):
			flush()
			b.WriteString("<hr>")
			i++
		case quoteLine.MatchString(l) && p.depth < maxNesting:
			flush()
			i = p.quote(&b, lines, i)
		case (startsListItem(l) || (len(para) == 0 && listItem.MatchString(l))) && p.depth < maxNesting:
			flush()
			i = p.list(&b, lines, i)
		case len(para) == 0 && i+1 < len(lines) && strings.Contains(l, "|") && tableDelim.MatchString(lines[i+1]) && strings.Contains(lines[i+1], "-"):
			i = p.table(&b, lines, i)
		case htmlBlock.MatchString(l):
			flush()
			i = p.htmlBlock(&b, lines, i)
		default:
			para = append(para, l)
			i++
		}
	}
	flush()
	return b.String()
}

func (p *mdParser) fence(b *strings.Builder, lines []string, i int) int {
	m := fenceOpen.FindStringSubmatch(lines[i])
	indent, marker, info := len(m[1]), m[2], strings.ToLower(m[3])
	var code []string
	j := i + 1
	for ; j < len(lines); j++ {
		t := strings.TrimSpace(lines[j])
		if strings.HasPrefix(t, marker[:1]) && strings.Trim(t, marker[:1]) == "" && len(t) >= len(marker) {
			j++
			break
		}
		code = append(code, dedent(lines[j], indent))
	}
	if info == "math" {
		b.WriteString(blockMath(strings.Join(code, "\n")))
		return j
	}
	class := ""
	if lang := codeLanguage(info); lang != "" {
		class = ` class="language-` + lang + `"`
	}
	b.WriteString("<pre><code" + class + ">" + html.EscapeString(strings.Join(code, "\n")) + "</code></pre>")
	return j
}

var langChars = regexp.MustCompile(`^[a-z0-9+#-]{1,30}$`)

// codeLanguage is a fence's language as the wiki keeps it, or "".
func codeLanguage(info string) string {
	info = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(info), "language-"))
	if langChars.MatchString(info) {
		return info
	}
	return ""
}

func blockMath(latex string) string {
	latex = strings.TrimSpace(latex)
	if latex == "" {
		return ""
	}
	return `<div data-type="block-math" data-latex="` + html.EscapeString(latex) + `"></div>`
}

// math reads a $$ block: on one line, or up to the line that ends with $$.
func (p *mdParser) math(b *strings.Builder, lines []string, i int) int {
	if m := mathOneLine.FindStringSubmatch(lines[i]); m != nil {
		b.WriteString(blockMath(m[1]))
		return i + 1
	}
	first := strings.TrimPrefix(strings.TrimSpace(lines[i]), "$$")
	body := []string{first}
	j := i + 1
	for ; j < len(lines); j++ {
		t := strings.TrimSpace(lines[j])
		if strings.HasSuffix(t, "$$") {
			body = append(body, strings.TrimSuffix(t, "$$"))
			j++
			break
		}
		body = append(body, lines[j])
	}
	b.WriteString(blockMath(strings.Join(body, "\n")))
	return j
}

// quote reads a block quote, or an Obsidian callout: "> [!type] title", folded with "-"
// or "+" (a toggle).
func (p *mdParser) quote(b *strings.Builder, lines []string, i int) int {
	var inner []string
	j := i
	for ; j < len(lines); j++ {
		l := lines[j]
		if quoteLine.MatchString(l) {
			s := strings.TrimLeft(l, " ")[1:]
			s = strings.TrimPrefix(s, " ")
			inner = append(inner, s)
			continue
		}
		// A lazy line continues the quote's paragraph.
		if !blank(l) && len(inner) > 0 && !blank(inner[len(inner)-1]) && !startsBlock(l) {
			inner = append(inner, l)
			continue
		}
		break
	}
	if m := calloutHead.FindStringSubmatch(strings.TrimSpace(inner[0])); m != nil {
		kind, fold, title := strings.ToLower(m[1]), m[2], strings.TrimSpace(m[3])
		p.depth++
		body := p.blocks(inner[1:])
		p.depth--
		if fold != "" {
			summary := title
			if summary == "" {
				summary = calloutName(kind)
			}
			b.WriteString("<details><summary>" + p.inline(summary) + `</summary><div data-type="detailsContent">` + body + "</div></details>")
			return j
		}
		icon, tone := calloutStyle(kind)
		b.WriteString(`<div data-type="callout" data-icon="` + icon + `" data-tone="` + tone + `">`)
		if title != "" {
			b.WriteString("<p><strong>" + p.inline(title) + "</strong></p>")
		}
		b.WriteString(body + "</div>")
		return j
	}
	p.depth++
	b.WriteString("<blockquote>" + p.blocks(inner) + "</blockquote>")
	p.depth--
	return j
}

// calloutStyle is the wiki's icon and tone for an Obsidian callout type. A note is the
// wiki's plain callout, as wikiconv writes one.
func calloutStyle(kind string) (icon, tone string) {
	switch kind {
	case "abstract", "summary", "tldr":
		return "📋", "blue"
	case "info":
		return "ℹ️", "blue"
	case "todo":
		return "☑️", "blue"
	case "tip", "hint", "important":
		return "💡", "green"
	case "success", "check", "done":
		return "✅", "green"
	case "question", "help", "faq":
		return "❓", "yellow"
	case "warning", "caution", "attention":
		return "⚠️", "orange"
	case "failure", "fail", "missing":
		return "❌", "red"
	case "danger", "error":
		return "⛔", "red"
	case "bug":
		return "🐞", "red"
	case "example":
		return "📎", "purple"
	case "quote", "cite":
		return "💬", "gray"
	}
	return "💡", "gray"
}

func calloutName(kind string) string {
	if kind == "" {
		return "Note"
	}
	r, n := utf8.DecodeRuneInString(kind)
	return string(unicode.ToUpper(r)) + kind[n:]
}

type mdItem struct {
	ordered bool
	task    bool
	checked bool
	lines   []string
}

// list reads consecutive items of one list. Items whose text starts with [ ] or [x] are
// to-dos: a run of them is a task list.
func (p *mdParser) list(b *strings.Builder, lines []string, i int) int {
	var items []mdItem
	j := i
	ordered := false
	for j < len(lines) {
		m := listItem.FindStringSubmatch(lines[j])
		if m == nil {
			break
		}
		isOrdered := !strings.ContainsAny(m[2], "-*+")
		if len(items) > 0 && isOrdered != ordered {
			break
		}
		ordered = isOrdered
		content := len(m[0])
		if blank(lines[j][content:]) {
			content = len(m[1]) + len(m[2]) + 1
		} else if len(m[3]) > 4 { // a marker followed by 5+ spaces starts indented code
			content = len(m[1]) + len(m[2]) + 1
		}
		it := mdItem{ordered: isOrdered, lines: []string{lines[j][min(content, len(lines[j])):]}}
		j++
		for j < len(lines) {
			l := lines[j]
			if blank(l) {
				// A blank line continues the item when what follows is indented under it.
				k := j
				for k < len(lines) && blank(lines[k]) {
					k++
				}
				if k < len(lines) && indentOf(lines[k]) >= content {
					for ; j < k; j++ {
						it.lines = append(it.lines, "")
					}
					continue
				}
				break
			}
			if indentOf(l) >= content {
				it.lines = append(it.lines, dedent(l, content))
				j++
				continue
			}
			if listItem.MatchString(l) || startsBlock(l) || blank(it.lines[len(it.lines)-1]) {
				break
			}
			it.lines = append(it.lines, strings.TrimLeft(l, " ")) // lazy continuation
			j++
		}
		if tm := taskMarker.FindStringSubmatch(it.lines[0]); tm != nil {
			it.task, it.checked = true, tm[1] != " "
			it.lines[0] = it.lines[0][len(tm[0]):]
		}
		items = append(items, it)
		// Blank lines between items keep one list.
		k := j
		for k < len(lines) && blank(lines[k]) {
			k++
		}
		if k < len(lines) && k > j && listItem.MatchString(lines[k]) && indentOf(lines[k]) < 4 {
			j = k
		}
	}
	for s := 0; s < len(items); {
		e := s
		for e < len(items) && items[e].task == items[s].task {
			e++
		}
		switch {
		case items[s].task:
			b.WriteString(`<ul data-type="taskList">`)
		case items[s].ordered:
			b.WriteString("<ol>")
		default:
			b.WriteString("<ul>")
		}
		for _, it := range items[s:e] {
			if it.task {
				b.WriteString(`<li data-type="taskItem" data-checked="` + strconv.FormatBool(it.checked) + `">`)
			} else {
				b.WriteString("<li>")
			}
			p.depth++
			b.WriteString(p.blocks(it.lines) + "</li>")
			p.depth--
		}
		switch {
		case items[s].task:
			b.WriteString("</ul>")
		case items[s].ordered:
			b.WriteString("</ol>")
		default:
			b.WriteString("</ul>")
		}
		s = e
	}
	return j
}

// table reads a GitHub table: a header row, the delimiter row, then rows up to a blank line.
func (p *mdParser) table(b *strings.Builder, lines []string, i int) int {
	head := splitRow(lines[i])
	b.WriteString("<table><tbody><tr>")
	for _, c := range head {
		b.WriteString("<th><p>" + p.inline(c) + "</p></th>")
	}
	b.WriteString("</tr>")
	j := i + 2
	for ; j < len(lines) && !blank(lines[j]) && strings.Contains(lines[j], "|"); j++ {
		cells := splitRow(lines[j])
		b.WriteString("<tr>")
		for k := range head {
			c := ""
			if k < len(cells) {
				c = cells[k]
			}
			b.WriteString("<td><p>" + p.inline(c) + "</p></td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return j
}

// splitRow splits a table row on pipes outside code, wikilinks and escapes.
func splitRow(l string) []string {
	l = strings.TrimSpace(l)
	l = strings.TrimPrefix(l, "|")
	if strings.HasSuffix(l, "|") && !strings.HasSuffix(l, `\|`) {
		l = l[:len(l)-1]
	}
	var cells []string
	var cur strings.Builder
	code, wiki := false, 0
	for i := 0; i < len(l); i++ {
		c := l[i]
		switch {
		case c == '\\' && i+1 < len(l) && l[i+1] == '|':
			if wiki > 0 {
				cur.WriteString(`\|`) // [[note\|alias]]: the wikilink reads it
			} else {
				cur.WriteByte('|')
			}
			i++
			continue
		case c == '`':
			code = !code
		case !code && strings.HasPrefix(l[i:], "[["):
			wiki++
		case !code && wiki > 0 && strings.HasPrefix(l[i:], "]]"):
			wiki--
		case c == '|' && !code && wiki == 0:
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

// htmlBlock passes HTML through to the sanitizer. <aside> and <details>, which Notion
// writes around Markdown, hold Markdown up to their closing tag.
func (p *mdParser) htmlBlock(b *strings.Builder, lines []string, i int) int {
	l := strings.TrimSpace(lines[i])
	lower := strings.ToLower(l)
	for _, tag := range []string{"aside", "details"} {
		if !strings.HasPrefix(lower, "<"+tag) {
			continue
		}
		depth := 0
		var inner []string
		j := i
		for ; j < len(lines); j++ {
			t := strings.ToLower(lines[j])
			depth += strings.Count(t, "<"+tag)
			depth -= strings.Count(t, "</"+tag+">")
			inner = append(inner, lines[j])
			if depth <= 0 {
				j++
				break
			}
		}
		text := strings.Join(inner, "\n")
		open := strings.Index(text, ">")
		closeAt := strings.LastIndex(strings.ToLower(text), "</"+tag+">")
		if open < 0 || closeAt < open {
			break
		}
		body := text[open+1 : closeAt]
		summary := ""
		if tag == "details" {
			if m := summaryTag.FindStringSubmatchIndex(body); m != nil {
				summary = body[m[2]:m[3]]
				body = body[:m[0]] + body[m[1]:]
			}
			b.WriteString("<details><summary>" + p.inline(strings.TrimSpace(summary)) + "</summary>" + p.blocks(strings.Split(body, "\n")) + "</details>")
		} else {
			b.WriteString("<aside>" + p.blocks(strings.Split(body, "\n")) + "</aside>")
		}
		return j
	}
	j := i
	for ; j < len(lines) && !blank(lines[j]); j++ {
		b.WriteString(lines[j] + "\n")
	}
	return j
}

var summaryTag = regexp.MustCompile(`(?is)<summary[^>]*>(.*?)</summary>`)

// inlineLines renders a paragraph's lines: a line ending in two spaces or a backslash
// breaks, and so does every line in Obsidian.
func (p *mdParser) inlineLines(lines []string) string {
	var b strings.Builder
	for i, l := range lines {
		l = strings.TrimLeft(l, " ")
		last := i == len(lines)-1
		hard := strings.HasSuffix(l, "  ") || (strings.HasSuffix(l, `\`) && !strings.HasSuffix(l, `\\`))
		if hard && !last {
			l = strings.TrimSuffix(strings.TrimRight(l, " "), `\`)
		}
		b.WriteString(strings.TrimRight(l, " "))
		if !last {
			if hard || p.opt.breaks {
				b.WriteString("\n<br>\n")
			} else {
				b.WriteString("\n")
			}
		}
	}
	// Breaks were written as markup: keep them out of the inline parser's text.
	parts := strings.Split(b.String(), "\n<br>\n")
	for i := range parts {
		parts[i] = p.inline(parts[i])
	}
	return strings.Join(parts, "<br>")
}

var (
	entityRef   = regexp.MustCompile(`^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});`)
	inlineTag   = regexp.MustCompile(`^</?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>` + "`" + `]+))?)*\s*/?>`)
	autolinkRe  = regexp.MustCompile(`^<((?:https?|mailto):[^\s<>]+)>`)
	bareURL     = regexp.MustCompile(`^https?://[^\s<>]+`)
	asciiPunct  = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
	trailingURL = ".,:;!?\"'*_~"
)

// inline renders a span of Markdown text.
func (p *mdParser) inline(s string) string {
	if p.inSpan == 0 {
		p.budget = 8*len(s) + 4096
	}
	p.inSpan++
	defer func() { p.inSpan-- }()
	var b strings.Builder
	text := func(t string) { b.WriteString(html.EscapeString(t)) }
	for i := 0; i < len(s); {
		c := s[i]
		rest := s[i:]
		switch {
		case c == '\\' && i+1 < len(s) && strings.IndexByte(asciiPunct, s[i+1]) >= 0:
			text(s[i+1 : i+2])
			i += 2
			continue
		case c == '`':
			if out, n, ok := codeSpan(rest); ok {
				b.WriteString(out)
				i += n
				continue
			}
			n := len(rest) - len(strings.TrimLeft(rest, "`"))
			text(rest[:n])
			i += n
			continue
		case c == '!' && strings.HasPrefix(rest, "![["):
			if end := strings.Index(rest[:min(len(rest), maxSpan)], "]]"); end > 3 {
				target, label := splitWikilink(rest[3:end])
				b.WriteString(`<a data-wikiembed="` + html.EscapeString(target) + `">` + html.EscapeString(label) + `</a>`)
				i += end + 2
				continue
			}
		case c == '[' && strings.HasPrefix(rest, "[["):
			if end := strings.Index(rest[:min(len(rest), maxSpan)], "]]"); end > 2 {
				target, label := splitWikilink(rest[2:end])
				if label == "" {
					label = wikilinkLabel(target)
				}
				b.WriteString(`<a data-wikilink="` + html.EscapeString(target) + `">` + html.EscapeString(label) + `</a>`)
				i += end + 2
				continue
			}
		case c == '!' && strings.HasPrefix(rest, "!["):
			if label, dest, n, ok := linkParts(rest[1:]); ok {
				b.WriteString(`<img src="` + html.EscapeString(dest) + `" alt="` + html.EscapeString(plainLabel(label)) + `">`)
				i += n + 1
				continue
			}
		case c == '[':
			if label, dest, n, ok := linkParts(rest); ok {
				b.WriteString(`<a href="` + html.EscapeString(dest) + `">` + p.inline(label) + `</a>`)
				i += n
				continue
			}
		case c == '<':
			if m := autolinkRe.FindStringSubmatch(rest); m != nil {
				b.WriteString(`<a href="` + html.EscapeString(m[1]) + `">` + html.EscapeString(strings.TrimPrefix(m[1], "mailto:")) + `</a>`)
				i += len(m[0])
				continue
			}
			if m := inlineTag.FindString(rest); m != "" {
				b.WriteString(m) // raw HTML: the sanitizer decides what stays
				i += len(m)
				continue
			}
		case c == '&':
			if m := entityRef.FindString(rest); m != "" {
				b.WriteString(m)
				i += len(m)
				continue
			}
		case c == 'h' && (i == 0 || !isWordByte(s[i-1])) && bareURL.MatchString(rest):
			u := bareURL.FindString(rest)
			u = strings.TrimRight(u, trailingURL)
			if strings.HasSuffix(u, ")") && strings.Count(u, "(") < strings.Count(u, ")") {
				u = u[:len(u)-1]
			}
			b.WriteString(`<a href="` + html.EscapeString(u) + `">` + html.EscapeString(u) + `</a>`)
			i += len(u)
			continue
		case c == '$':
			if latex, n, ok := inlineMath(s, i); ok {
				b.WriteString(`<span data-type="inline-math" data-latex="` + html.EscapeString(latex) + `"></span>`)
				i += n
				continue
			}
		case c == '*' || c == '_' || c == '~' || c == '=':
			if out, n, ok := p.emphasis(s, i); ok {
				b.WriteString(out)
				i += n
				continue
			}
			n := len(rest) - len(strings.TrimLeft(rest, string(c)))
			text(rest[:n])
			i += n
			continue
		}
		_, size := utf8.DecodeRuneInString(rest)
		text(rest[:size])
		i += size
	}
	return b.String()
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}

func codeSpan(s string) (string, int, bool) {
	s = s[:min(len(s), maxSpan)]
	n := len(s) - len(strings.TrimLeft(s, "`"))
	ticks := s[:n]
	for j := n; j < len(s); {
		k := strings.Index(s[j:], ticks)
		if k < 0 {
			return "", 0, false
		}
		k += j
		end := k + n
		if end < len(s) && s[end] == '`' { // a longer run isn't the closer
			j = end + len(s[end:]) - len(strings.TrimLeft(s[end:], "`"))
			continue
		}
		code := strings.ReplaceAll(s[n:k], "\n", " ")
		if len(code) > 1 && code[0] == ' ' && code[len(code)-1] == ' ' && strings.Trim(code, " ") != "" {
			code = code[1 : len(code)-1]
		}
		return "<code>" + html.EscapeString(code) + "</code>", end, true
	}
	return "", 0, false
}

// inlineMath reads $latex$ (or $$latex$$ in a line) as Obsidian does: no space just
// inside the dollars, and no digit right after the closing one, so prices stay text.
func inlineMath(s string, i int) (string, int, bool) {
	delim := "$"
	if strings.HasPrefix(s[i:], "$$") {
		delim = "$$"
	}
	start := i + len(delim)
	if start >= len(s) || s[start] == ' ' || s[start] == '$' {
		return "", 0, false
	}
	for j := start; j < min(len(s), i+maxSpan); j++ {
		if s[j] == '\\' {
			j++
			continue
		}
		if !strings.HasPrefix(s[j:], delim) {
			continue
		}
		if s[j-1] == ' ' {
			return "", 0, false
		}
		end := j + len(delim)
		if delim == "$" && end < len(s) && s[end] >= '0' && s[end] <= '9' {
			return "", 0, false
		}
		return s[start:j], end - i, true
	}
	return "", 0, false
}

// maxSpan bounds how far an inline construct looks for its end, so a paragraph full of
// openers without closers costs time in proportion to its length.
const maxSpan = 1024

// emphasis reads **strong**, __strong__, *em*, _em_, ~~strike~~ and ==highlight== at i.
func (p *mdParser) emphasis(s string, i int) (string, int, bool) {
	c := s[i]
	run := len(s[i:]) - len(strings.TrimLeft(s[i:], string(c)))
	var delim, open, closeTag string
	switch {
	case c == '~' && run == 2:
		delim, open, closeTag = "~~", "<s>", "</s>"
	case c == '=' && run == 2:
		delim, open, closeTag = "==", "<mark>", "</mark>"
	case (c == '*' || c == '_') && run >= 2:
		delim, open, closeTag = s[i:i+2], "<strong>", "</strong>"
	case c == '*' || c == '_':
		delim, open, closeTag = s[i:i+1], "<em>", "</em>"
	default:
		return "", 0, false
	}
	start := i + len(delim)
	if start >= len(s) || s[start] == ' ' || s[start] == '\n' {
		return "", 0, false
	}
	if c == '_' && i > 0 && isWordByte(s[i-1]) {
		return "", 0, false // snake_case
	}
	limit := min(len(s), i+maxSpan)
	for j := start + 1; j <= limit-len(delim); j++ {
		next := strings.IndexAny(s[j:limit], string(c)+"`\\")
		if p.budget--; next < 0 || p.budget < 0 {
			break
		}
		j += next
		if j > limit-len(delim) {
			break
		}
		switch s[j] {
		case '`':
			if _, n, ok := codeSpan(s[j:limit]); ok {
				j += n - 1
				continue
			}
		case '\\':
			j++
			continue
		}
		if s[j] != c {
			continue
		}
		r := len(s[j:]) - len(strings.TrimLeft(s[j:], string(c)))
		prev := s[j-1]
		// A run after a space opens: skip what it wraps (*a **b** c*).
		if prev == ' ' || prev == '\n' {
			if r != len(delim) && j+r < len(s) && s[j+r] != ' ' {
				if end := strings.Index(s[j+r:limit], s[j:j+r]); end >= 0 {
					j += r + end + r - 1
					continue
				}
			}
			j += r - 1
			continue
		}
		if r < len(delim) {
			j += r - 1
			continue
		}
		// The closer is the end of its run: ***a*** is <strong><em>a</em></strong>.
		k := j + r - len(delim)
		if c == '_' && k+len(delim) < len(s) && isWordByte(s[k+len(delim)]) {
			j += r - 1
			continue
		}
		inner := s[start:k]
		if strings.TrimSpace(inner) == "" {
			return "", 0, false
		}
		return open + p.inline(inner) + closeTag, k + len(delim) - i, true
	}
	return "", 0, false
}

// linkParts reads [label](destination "title") at the start of s.
func linkParts(s string) (label, dest string, n int, ok bool) {
	s = s[:min(len(s), maxSpan)]
	if !strings.Contains(s, "](") {
		return "", "", 0, false
	}
	depth := 0
	end := -1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '`':
			if _, m, ok := codeSpan(s[i:]); ok {
				i += m - 1
			}
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 || end+1 >= len(s) || s[end+1] != '(' {
		return "", "", 0, false
	}
	label = s[1:end]
	rest := s[end+2:]
	if strings.HasPrefix(rest, "<") {
		k := strings.IndexByte(rest, '>')
		if k < 0 {
			return "", "", 0, false
		}
		dest = rest[1:k]
		after := strings.TrimLeft(rest[k+1:], " ")
		c := strings.IndexByte(after, ')')
		if c < 0 {
			return "", "", 0, false
		}
		return label, dest, end + 2 + len(rest) - len(after) + c + 1, true
	}
	depth = 0
	k := 0
	for ; k < len(rest); k++ {
		ch := rest[k]
		if ch == '\\' {
			k++
			continue
		}
		if ch == '(' {
			depth++
		}
		if ch == ')' {
			if depth == 0 {
				break
			}
			depth--
		}
		if ch == ' ' || ch == '\n' {
			break
		}
	}
	dest = rest[:min(k, len(rest))]
	tail := rest[min(k, len(rest)):]
	c := strings.IndexByte(tail, ')')
	if c < 0 {
		return "", "", 0, false
	}
	if t := strings.TrimSpace(tail[:c]); t != "" && !(t[0] == '"' || t[0] == '\'' || t[0] == '(') {
		return "", "", 0, false
	}
	return label, unescapeDest(dest), end + 2 + k + c + 1, true
}

func unescapeDest(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && strings.IndexByte(asciiPunct, s[i+1]) >= 0 {
			i++
		}
		b.WriteByte(s[i])
	}
	return html.UnescapeString(b.String())
}

// plainLabel is an image's alt text: its label without Markdown.
func plainLabel(s string) string {
	return strings.NewReplacer(`\`, "", "*", "", "_", "", "`", "").Replace(s)
}

// splitWikilink is a wikilink's target and alias ("Note#Heading|alias").
func splitWikilink(s string) (target, alias string) {
	s = strings.ReplaceAll(s, `\|`, "|")
	if k := strings.IndexByte(s, '|'); k >= 0 {
		return strings.TrimSpace(s[:k]), strings.TrimSpace(s[k+1:])
	}
	return strings.TrimSpace(s), ""
}

// wikilinkLabel is what Obsidian shows for a link without an alias: the note, and the
// heading after ">".
func wikilinkLabel(target string) string {
	note, heading, _ := strings.Cut(target, "#")
	note = strings.TrimSuffix(path.Base(note), ".md")
	heading = strings.TrimPrefix(heading, "^")
	switch {
	case note == "":
		return heading
	case heading == "":
		return note
	}
	return note + " > " + heading
}
