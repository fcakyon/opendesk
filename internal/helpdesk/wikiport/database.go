package wikiport

import (
	"encoding/csv"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Database is a database page's schema as contracts/wiki.md "Databases" stores it: its
// JSON is what the wiki's PATCH and POST take as `database`.
type Database struct {
	Properties []Property `json:"properties"`
	Views      []View     `json:"views"`
	NextID     int        `json:"next_id"`
}

// Property is a database's column.
type Property struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Type         string        `json:"type"`
	Options      []Option      `json:"options,omitempty"`
	Groups       []StatusGroup `json:"groups,omitempty"`
	NumberFormat string        `json:"number_format,omitempty"`
	DateTime     bool          `json:"date_time,omitempty"`
	Prefix       string        `json:"prefix,omitempty"`
}

// Option is a choice of a select, multi-select or status property.
type Option struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// StatusGroup is a status property's group of options: todo, doing or done.
type StatusGroup struct {
	ID        string   `json:"id"`
	OptionIDs []string `json:"option_ids"`
}

// View is a way the app shows the rows; its settings are the app's.
type View struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	Settings map[string]any `json:"settings,omitempty"`
}

// DateValue is a date property's value: a day (YYYY-MM-DD) or a moment (RFC 3339), and
// an optional end.
type DateValue struct {
	Start string `json:"start"`
	End   string `json:"end,omitempty"`
}

const maxProperties = 100

type csvTable struct {
	header []string
	rows   [][]string
}

func (imp *importer) readCSV(n *node) {
	text := decodeText(n.src.data)
	r := csv.NewReader(strings.NewReader(text))
	r.Comma = sniffComma(text)
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil || len(records) == 0 || len(records[0]) == 0 {
		imp.skip(n.src.path, "unreadable")
		n.kind = "folder" // a page holding the rows' pages, without a table
		return
	}
	t := &csvTable{header: records[0]}
	for i := range t.header {
		t.header[i] = strings.TrimSpace(t.header[i])
	}
	for _, rec := range records[1:] {
		if slices.ContainsFunc(rec, func(s string) bool { return strings.TrimSpace(s) != "" }) {
			t.rows = append(t.rows, rec)
		}
	}
	n.table = t
}

// sniffComma picks the separator the header line uses most, outside quotes.
func sniffComma(text string) rune {
	line, _, _ := strings.Cut(text, "\n")
	counts := map[rune]int{}
	quoted := false
	for _, c := range line {
		switch {
		case c == '"':
			quoted = !quoted
		case !quoted && (c == ',' || c == ';' || c == '\t'):
			counts[c]++
		}
	}
	best := ','
	for _, c := range []rune{';', '\t'} {
		if counts[c] > counts[best] {
			best = c
		}
	}
	return best
}

// databases makes each CSV's page a database: its schema from the columns, a row page for
// each record, matched by title to the pages in its folder (Notion's row pages) so a row
// keeps its text and its subpages.
func (imp *importer) databases() {
	for _, n := range slices.Clone(imp.all) {
		if n.kind != "csv" || n.table == nil {
			continue
		}
		t := n.table
		header := t.header
		if len(header) > maxProperties {
			imp.skip(n.Key, "columns_dropped")
			header = header[:maxProperties]
		}
		props, convert := inferSchema(header, t.rows)
		n.Database = &Database{Properties: props, Views: []View{{ID: "table", Name: "Table", Type: "table"}}, NextID: 1}
		// The pages in its folder, by title.
		byTitle := map[string][]*node{}
		for _, k := range n.kids {
			key := strings.ToLower(k.Title)
			byTitle[key] = append(byTitle[key], k)
		}
		for i, rec := range t.rows {
			title := ""
			if len(rec) > 0 {
				title = foldTitle(cleanRelation(rec[0]))
			}
			var row *node
			if list := byTitle[strings.ToLower(title)]; len(list) > 0 {
				row, byTitle[strings.ToLower(title)] = list[0], list[1:]
			} else {
				row = imp.newNode(nil, "row", fmt.Sprintf("%s#row-%d", n.Key, i+1))
				row.parent = n
				row.name = title
				n.kids = append(n.kids, row)
			}
			row.Title = title
			row.row = i
			row.cols = header
			row.Props = convert(rec)
		}
	}
}

// inferSchema reads each column's type from its values: checkbox (Yes/No), number, date
// (Notion's "Month D, YYYY", with a time, ranges with "→"), URL, email, select, multi-select
// (comma lists), status (a "Status" column); anything else is text, as are people and
// relations, which can't be matched to members and pages here.
func inferSchema(header []string, rows [][]string) ([]Property, func([]string) map[string]any) {
	props := make([]Property, len(header))
	used := map[string]bool{"title": true}
	for i, name := range header {
		name = foldTitle(name)
		if name == "" {
			name = "Column " + strconv.Itoa(i+1)
		}
		name = truncateRunes(name, 100)
		if i == 0 {
			props[0] = Property{ID: "title", Name: name, Type: "title"}
			continue
		}
		var vals []string
		for _, r := range rows {
			if i < len(r) {
				if v := strings.TrimSpace(r[i]); v != "" {
					vals = append(vals, v)
				}
			}
		}
		p := inferColumn(name, vals, len(rows))
		p.ID = uniqueID(propSlug(name), used)
		p.Name = name
		props[i] = p
	}
	convert := func(rec []string) map[string]any {
		out := map[string]any{}
		for i, p := range props {
			if i == 0 || i >= len(rec) {
				continue
			}
			if v, ok := cellValue(p, strings.TrimSpace(rec[i])); ok {
				out[p.ID] = v
			}
		}
		return out
	}
	return props, convert
}

func inferColumn(name string, vals []string, rows int) Property {
	if len(vals) == 0 {
		return Property{Type: "text"}
	}
	all := func(ok func(string) bool) bool {
		return !slices.ContainsFunc(vals, func(v string) bool { return !ok(v) })
	}
	switch {
	case all(func(v string) bool { _, ok := parseCheckbox(v); return ok }):
		return Property{Type: "checkbox"}
	case all(func(v string) bool { _, ok := parseNumber(v); return ok }):
		return Property{Type: "number"}
	case all(func(v string) bool { _, ok := parseDate(v); return ok }):
		p := Property{Type: "date"}
		p.DateTime = slices.ContainsFunc(vals, func(v string) bool { d, _ := parseDate(v); return strings.Contains(d.Start, "T") })
		return p
	case all(isWebURL):
		return Property{Type: "url"}
	case all(emailish.MatchString):
		return Property{Type: "email"}
	}
	lower := strings.ToLower(name)
	var tokens []string
	multi := false
	for _, v := range vals {
		parts := splitList(cleanRelation(v))
		multi = multi || len(parts) > 1
		tokens = append(tokens, parts...)
	}
	distinct := uniqueStrings(tokens)
	short := all(func(v string) bool { return len([]rune(v)) <= 100 }) && !slices.ContainsFunc(distinct, func(s string) bool { return len([]rune(s)) > 60 })
	people := containsAny(lower, "owner", "assign", "person", "people", "created by", "edited by", "author", "member", "user", "reviewer")
	if !short || len(distinct) > 200 || looksLinked(vals) || people {
		return Property{Type: "text"}
	}
	hinted := func(words ...string) bool {
		return slices.ContainsFunc(words, func(w string) bool { return strings.Contains(lower, w) })
	}
	repeats := len(distinct) < len(tokens)
	switch {
	case lower == "status" && !multi:
		return statusProperty(distinct)
	case multi && (repeats || hinted("tag", "label", "categor", "topic", "keyword")):
		return Property{Type: "multi_select", Options: options(distinct)}
	case !multi && (repeats && len(distinct) <= max(2, rows/2) || hinted("type", "kind", "priority", "categor", "stage", "level", "status", "tag")):
		return Property{Type: "select", Options: options(distinct)}
	}
	return Property{Type: "text"}
}

// looksLinked is a column of people or pages: Notion writes relations as links to the
// related pages' files, and people as names: kept as text.
func looksLinked(vals []string) bool {
	return slices.ContainsFunc(vals, func(v string) bool { return relationRef.MatchString(v) })
}

var (
	relationRef = regexp.MustCompile(`\((?:[^()]*\.md|https://www\.notion\.so/[^()]*)\)`)
	emailish    = regexp.MustCompile(`^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]+$`)
)

// cleanRelation drops the file or Notion link Notion writes after a related page's name.
func cleanRelation(v string) string {
	return strings.TrimSpace(regexp.MustCompile(`\s*`+relationRef.String()).ReplaceAllString(v, ""))
}

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func uniqueStrings(list []string) []string {
	var out []string
	for _, s := range list {
		if !slices.ContainsFunc(out, func(o string) bool { return strings.EqualFold(o, s) }) {
			out = append(out, s)
		}
	}
	return out
}

func options(names []string) []Option {
	out := make([]Option, len(names))
	for i, n := range names {
		out[i] = Option{ID: "o" + strconv.Itoa(i+1), Name: truncateRunes(n, 100), Color: tones[i%len(tones)]}
	}
	return out
}

// statusProperty sorts a status column's options into to do, in progress and done by name.
func statusProperty(names []string) Property {
	p := Property{Type: "status", Options: options(names)}
	groups := map[string][]string{}
	for _, o := range p.Options {
		l := strings.ToLower(o.Name)
		g := "todo"
		switch {
		case containsAny(l, "not started", "to do", "todo", "backlog"):
		case containsAny(l, "done", "complete", "closed", "finished", "resolved", "shipped", "archived"):
			g = "done"
		case containsAny(l, "progress", "doing", "started", "review", "active", "working", "blocked"):
			g = "doing"
		}
		groups[g] = append(groups[g], o.ID)
	}
	for _, g := range []string{"todo", "doing", "done"} {
		p.Groups = append(p.Groups, StatusGroup{ID: g, OptionIDs: append([]string{}, groups[g]...)})
	}
	return p
}

func containsAny(s string, words ...string) bool {
	return slices.ContainsFunc(words, func(w string) bool { return strings.Contains(s, w) })
}

var nonID = regexp.MustCompile(`[^a-z0-9]+`)

func propSlug(name string) string {
	s := strings.Trim(nonID.ReplaceAllString(strings.ToLower(name), "_"), "_")
	if len(s) > 20 {
		s = strings.TrimRight(s[:20], "_")
	}
	if s == "" {
		s = "prop"
	}
	return s
}

func uniqueID(base string, used map[string]bool) string {
	id := base
	for i := 2; used[id]; i++ {
		id = base + "_" + strconv.Itoa(i)
	}
	used[id] = true
	return id
}

// cellValue is a cell's value as the property stores it; false for none.
func cellValue(p Property, v string) (any, bool) {
	if v == "" {
		return nil, false
	}
	switch p.Type {
	case "checkbox":
		b, ok := parseCheckbox(v)
		return b, ok
	case "number":
		f, ok := parseNumber(v)
		return f, ok
	case "date":
		d, ok := parseDate(v)
		return d, ok
	case "select", "status":
		for _, o := range p.Options {
			if strings.EqualFold(o.Name, cleanRelation(v)) {
				return o.ID, true
			}
		}
		return nil, false
	case "multi_select":
		var ids []string
		for _, part := range splitList(cleanRelation(v)) {
			for _, o := range p.Options {
				if strings.EqualFold(o.Name, part) && !slices.Contains(ids, o.ID) {
					ids = append(ids, o.ID)
				}
			}
		}
		return ids, len(ids) > 0
	case "url":
		return truncateRunes(v, 2000), isWebURL(v)
	case "email":
		return v, emailish.MatchString(v) && len(v) <= 320
	}
	return truncateRunes(cleanRelation(v), 10000), true
}

func parseCheckbox(v string) (bool, bool) {
	switch strings.ToLower(v) {
	case "yes", "true", "checked", "✓", "☑":
		return true, true
	case "no", "false", "unchecked", "☐":
		return false, true
	}
	return false, false
}

var numberText = regexp.MustCompile(`^-?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$`)

func parseNumber(v string) (float64, bool) {
	if !numberText.MatchString(v) {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", ""), 64)
	return f, err == nil && !math.IsInf(f, 0) && !math.IsNaN(f)
}

var (
	dateLayouts = []string{"January 2, 2006", "Jan 2, 2006", "2006-01-02", "2006/01/02", "01/02/2006", "2 January 2006", "January 2006"}
	timeLayouts = []string{"January 2, 2006 3:04 PM", "January 2, 2006 15:04", "Jan 2, 2006 3:04 PM", "2006-01-02 15:04", "2006-01-02T15:04", "2006/01/02 15:04", "01/02/2006 3:04 PM"}
	zoneNote    = regexp.MustCompile(`\s*\((?:GMT|UTC)[^)]*\)$`)
)

// parseDate reads a date as Notion and spreadsheets write it, or a range "start → end".
// A time without a zone is taken as UTC.
func parseDate(v string) (DateValue, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "@")
	start, end, ranged := strings.Cut(v, "→")
	s, ok := parseMoment(start)
	if !ok {
		return DateValue{}, false
	}
	d := DateValue{Start: s}
	if ranged {
		e, ok := parseMoment(end)
		if !ok {
			return DateValue{}, false
		}
		d.End = e
	}
	return d, true
}

func parseMoment(v string) (string, bool) {
	v = zoneNote.ReplaceAllString(strings.TrimSpace(v), "")
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC().Format(time.RFC3339), true
	}
	for _, l := range timeLayouts {
		if t, err := time.Parse(l, v); err == nil {
			return t.Format("2006-01-02T15:04:05Z"), true
		}
	}
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, v); err == nil {
			return t.Format(time.DateOnly), true
		}
	}
	return "", false
}

func isWebURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && !strings.ContainsAny(v, " \n")
}
