package wiki

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Databases (contracts/wiki.md "Databases"): a page that is a database keeps its
// properties and views; its rows are its subpages, each holding values of the properties.
// Filters, sorts, groups, formulas and rollups are the app's to compute: the API keeps
// the schema and the values, each checked against its type.

// Property types.
var propTypes = []string{"title", "text", "number", "select", "multi_select", "status", "date", "person", "checkbox", "url", "email", "phone",
	"files", "relation", "rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id", "ticket"}

// Types whose value is computed, never stored on a row.
var computedTypes = []string{"title", "rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id"}

var viewTypes = []string{"table", "board", "list", "gallery", "calendar", "timeline", "chart", "form"}

var tones = []string{"gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}

var rollupFns = []string{"show_original", "count", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty",
	"sum", "avg", "median", "min", "max", "range", "earliest", "latest", "checked", "unchecked", "percent_checked"}

var numberFormats = []string{"number", "comma", "percent", "usd", "eur", "gbp", "jpy", "chf", "cad", "aud", "inr", "brl", "huf", "pln"}

var propID = regexp.MustCompile(`^[a-z0-9_]{1,24}$`)

const (
	maxDatabaseBytes = 128 << 10
	maxPropsBytes    = 64 << 10
	maxProperties    = 100
	maxViews         = 50
	maxOptions       = 200
	maxRefs          = 100
)

// DbOption is a choice of a select, multi-select or status property.
type DbOption struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// DbStatusGroup is a status property's group: to do, in progress or complete.
type DbStatusGroup struct {
	ID        string   `json:"id" enum:"todo,doing,done"`
	OptionIDs []string `json:"option_ids"`
}

// DbRollup reads a property of the pages a relation names, and sums them up.
type DbRollup struct {
	Relation string `json:"relation" doc:"The relation property's id"`
	Property string `json:"property" doc:"The property of the related pages"`
	Fn       string `json:"fn"`
}

// DbProperty is a column of a database.
type DbProperty struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Type         string          `json:"type"`
	Options      []DbOption      `json:"options,omitempty"`
	Groups       []DbStatusGroup `json:"groups,omitempty"`
	NumberFormat string          `json:"number_format,omitempty"`
	DateTime     bool            `json:"date_time,omitempty" doc:"A date property's values have a time of day"`
	DatabaseID   *uuid.UUID      `json:"database_id,omitempty" doc:"A relation's database"`
	Rollup       *DbRollup       `json:"rollup,omitempty"`
	Formula      string          `json:"formula,omitempty"`
	Prefix       string          `json:"prefix,omitempty" doc:"A unique id's letters, e.g. TASK"`
	Description  string          `json:"description,omitempty"`
}

// DbView is a way to see a database's rows; the app reads every field.
type DbView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	// The rest belongs to the app: filters, sorts, grouping, visible and ordered columns,
	// widths, date properties, card settings, chart settings, calculations.
	Settings map[string]any `json:"settings,omitempty"`
}

// DbSubItems names the two relations of a database to itself that nest its rows: each row's
// parent item (one at most) and its sub-items. The app keeps the two in step.
type DbSubItems struct {
	Parent   string `json:"parent" doc:"The relation property naming a row's parent item"`
	Children string `json:"children" doc:"The relation property naming a row's sub-items"`
}

// DbDependencies names the two relations of a database to itself that say which rows wait
// on which. The app keeps the two in step.
type DbDependencies struct {
	BlockedBy string `json:"blocked_by" doc:"The relation property naming the rows a row waits on"`
	Blocking  string `json:"blocking" doc:"The relation property naming the rows waiting on a row"`
}

// Database is what a database page keeps: its properties and views, and the next unique id.
type Database struct {
	Properties   []DbProperty    `json:"properties"`
	Views        []DbView        `json:"views"`
	NextID       int             `json:"next_id" doc:"The number the next row's unique id gets"`
	SubItems     *DbSubItems     `json:"sub_items,omitempty" doc:"Rows nest under a parent item"`
	Dependencies *DbDependencies `json:"dependencies,omitempty" doc:"Rows are blocked by other rows"`
}

// DateValue is a date property's value: a day or a moment, and an optional end.
type DateValue struct {
	Start string  `json:"start"`
	End   *string `json:"end,omitempty"`
}

// FileValue is a file property's file.
type FileValue struct {
	URL  string `json:"url"`
	Name string `json:"name"`
}

// defaultDatabase is a new database: a title and tags, seen as a table.
func defaultDatabase() Database {
	return Database{
		Properties: []DbProperty{
			{ID: "title", Name: "Name", Type: "title"},
			{ID: "tags", Name: "Tags", Type: "multi_select", Options: []DbOption{}},
		},
		Views:  []DbView{{ID: "table", Name: "Table", Type: "table"}},
		NextID: 1,
	}
}

func dbInvalid(format string, a ...any) error {
	return httpx.E(422, "invalid_database", fmt.Sprintf(format, a...))
}

func shortText(s string, max int) bool {
	return utf8.RuneCountInString(s) <= max && !strings.ContainsAny(s, "\x00")
}

// cleanDatabase checks a database's schema. prev keeps the unique-id counter, which only
// the API moves.
func cleanDatabase(raw json.RawMessage, prev *Database) (Database, error) {
	if len(raw) > maxDatabaseBytes {
		return Database{}, dbInvalid("A database's properties and views hold up to 128 KB.")
	}
	var db Database
	if err := json.Unmarshal(raw, &db); err != nil {
		return Database{}, dbInvalid("The database isn't valid: %s", err.Error())
	}
	if len(db.Properties) == 0 || len(db.Properties) > maxProperties {
		return Database{}, dbInvalid("A database has 1 to 100 properties.")
	}
	if len(db.Views) == 0 || len(db.Views) > maxViews {
		return Database{}, dbInvalid("A database has 1 to 50 views.")
	}
	seen := map[string]bool{}
	titles := 0
	for i := range db.Properties {
		p := &db.Properties[i]
		p.Name = strings.Join(strings.Fields(p.Name), " ")
		if !propID.MatchString(p.ID) || seen[p.ID] {
			return Database{}, dbInvalid("Each property needs its own id of 1 to 24 lowercase letters, digits or _.")
		}
		seen[p.ID] = true
		if p.Name == "" || !shortText(p.Name, 100) {
			return Database{}, dbInvalid("Each property needs a name of 1 to 100 characters.")
		}
		if !slices.Contains(propTypes, p.Type) {
			return Database{}, dbInvalid("%q isn't a property type.", p.Type)
		}
		if p.Type == "title" {
			titles++
		}
		if !shortText(p.Description, 500) || !shortText(p.Prefix, 10) || !shortText(p.Formula, 4000) {
			return Database{}, dbInvalid("A property's description, prefix or formula is too long.")
		}
		switch p.Type {
		case "select", "multi_select", "status":
			if len(p.Options) > maxOptions {
				return Database{}, dbInvalid("A property has up to 200 options.")
			}
			ids := map[string]bool{}
			for j := range p.Options {
				o := &p.Options[j]
				o.Name = strings.Join(strings.Fields(o.Name), " ")
				if !propID.MatchString(o.ID) || ids[o.ID] || o.Name == "" || !shortText(o.Name, 100) || !slices.Contains(tones, o.Color) {
					return Database{}, dbInvalid("Each option needs its own id, a name of 1 to 100 characters and a colour.")
				}
				ids[o.ID] = true
			}
			if p.Type == "status" {
				for _, g := range p.Groups {
					if !slices.Contains([]string{"todo", "doing", "done"}, g.ID) {
						return Database{}, dbInvalid("A status group is todo, doing or done.")
					}
					for _, id := range g.OptionIDs {
						if !ids[id] {
							return Database{}, dbInvalid("A status group names an option the property doesn't have.")
						}
					}
				}
			}
		case "number":
			if p.NumberFormat != "" && !slices.Contains(numberFormats, p.NumberFormat) {
				return Database{}, dbInvalid("%q isn't a number format.", p.NumberFormat)
			}
		case "relation":
			if p.DatabaseID == nil {
				return Database{}, dbInvalid("A relation names the database it relates to.")
			}
		case "rollup":
			if p.Rollup == nil || !slices.Contains(rollupFns, p.Rollup.Fn) || !propID.MatchString(p.Rollup.Relation) || !propID.MatchString(p.Rollup.Property) {
				return Database{}, dbInvalid("A rollup names a relation, a property of the related pages and how to sum them up.")
			}
		}
	}
	if titles != 1 || db.Properties[0].Type != "title" {
		return Database{}, dbInvalid("A database's first property is its title, and it has only one.")
	}
	for _, p := range db.Properties {
		if p.Type == "rollup" {
			i := slices.IndexFunc(db.Properties, func(x DbProperty) bool { return x.ID == p.Rollup.Relation })
			if i < 0 || db.Properties[i].Type != "relation" {
				return Database{}, dbInvalid("A rollup's relation is a relation property of the database.")
			}
		}
	}
	if err := checkPairs(db); err != nil {
		return Database{}, err
	}
	views := map[string]bool{}
	for i := range db.Views {
		v := &db.Views[i]
		v.Name = strings.Join(strings.Fields(v.Name), " ")
		if !propID.MatchString(v.ID) || views[v.ID] || v.Name == "" || !shortText(v.Name, 100) || !slices.Contains(viewTypes, v.Type) {
			return Database{}, dbInvalid("Each view needs its own id, a name of 1 to 100 characters and a type.")
		}
		views[v.ID] = true
	}
	db.NextID = 1
	if prev != nil {
		db.NextID = max(prev.NextID, 1)
	}
	return db, nil
}

// checkPairs makes sure sub-items and dependencies each name two different relation
// properties of the database that relate to the same database, none of them used twice.
func checkPairs(db Database) error {
	var pairs [][2]string
	if s := db.SubItems; s != nil {
		pairs = append(pairs, [2]string{s.Parent, s.Children})
	}
	if d := db.Dependencies; d != nil {
		pairs = append(pairs, [2]string{d.BlockedBy, d.Blocking})
	}
	used := map[string]bool{}
	for _, pair := range pairs {
		var target *uuid.UUID
		for _, id := range pair {
			i := slices.IndexFunc(db.Properties, func(p DbProperty) bool { return p.ID == id })
			if i < 0 || db.Properties[i].Type != "relation" || used[id] {
				return dbInvalid("Sub-items and dependencies each name two relation properties of the database.")
			}
			used[id] = true
			if target != nil && *target != *db.Properties[i].DatabaseID {
				return dbInvalid("Sub-items and dependencies relate the database to itself.")
			}
			target = db.Properties[i].DatabaseID
		}
	}
	return nil
}

// propRefs are the people, related pages (by the database they must be rows of) and
// tickets a row's values name: the caller checks they are of the workspace.
type propRefs struct {
	users, tickets []uuid.UUID
	pages          map[uuid.UUID][]uuid.UUID
}

// cleanProps checks a row's values against its database's properties and merges them into
// cur: a value of null takes it away; values of computed or unknown properties are refused.

func cleanProps(raw json.RawMessage, db Database, cur map[string]any) (map[string]any, propRefs, error) {
	var refs propRefs
	if len(raw) > maxPropsBytes {
		return nil, refs, dbInvalid("A row's values hold up to 64 KB.")
	}
	var in map[string]json.RawMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, refs, dbInvalid("props is an object of property ids to values.")
	}
	out := map[string]any{}
	for k, v := range cur {
		out[k] = v
	}
	byID := map[string]DbProperty{}
	for _, p := range db.Properties {
		byID[p.ID] = p
	}
	for id, v := range in {
		p, ok := byID[id]
		if !ok {
			return nil, refs, dbInvalid("The database has no property %q.", id)
		}
		if slices.Contains(computedTypes, p.Type) {
			return nil, refs, dbInvalid("%s is worked out by the database, not set.", p.Name)
		}
		// A JSON null reaches a RawMessage as nothing at all.
		if len(v) == 0 || string(v) == "null" {
			delete(out, id)
			continue
		}
		val, err := cleanValue(p, v, &refs)
		if err != nil {
			return nil, refs, err
		}
		if list, ok := val.([]uuid.UUID); ok && db.SubItems != nil && id == db.SubItems.Parent && len(list) > 1 {
			return nil, refs, dbInvalid("%s names one parent item at most.", p.Name)
		}
		out[id] = val
	}
	// Values of properties the database no longer has are dropped.
	for k := range out {
		if _, ok := byID[k]; !ok {
			delete(out, k)
		}
	}
	return out, refs, nil
}

var (
	isoDay   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	emailish = regexp.MustCompile(`^[^\s@]{1,64}@[^\s@]{1,255}$`)
	phoneish = regexp.MustCompile(`^[0-9+()./\s-]{1,40}$`)
)

func cleanValue(p DbProperty, v json.RawMessage, refs *propRefs) (any, error) {
	bad := func() error { return dbInvalid("%s doesn't take that value.", p.Name) }
	optionIDs := func() []string {
		ids := make([]string, len(p.Options))
		for i, o := range p.Options {
			ids[i] = o.ID
		}
		return ids
	}
	ids := func() ([]uuid.UUID, error) {
		var list []string
		if json.Unmarshal(v, &list) != nil || len(list) > maxRefs {
			return nil, bad()
		}
		out := make([]uuid.UUID, 0, len(list))
		for _, s := range list {
			id, err := uuid.Parse(s)
			if err != nil {
				return nil, bad()
			}
			if !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
		return out, nil
	}
	switch p.Type {
	case "text", "url", "email", "phone":
		var s string
		if json.Unmarshal(v, &s) != nil {
			return nil, bad()
		}
		s = strings.TrimSpace(s)
		limit := map[string]int{"text": 10000, "url": 2000, "email": 320, "phone": 40}[p.Type]
		if !shortText(s, limit) {
			return nil, dbInvalid("%s holds up to %d characters.", p.Name, limit)
		}
		switch {
		case s == "":
			return nil, nil
		case p.Type == "url":
			u, err := url.Parse(s)
			if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
				return nil, dbInvalid("%s takes a web address.", p.Name)
			}
		case p.Type == "email" && !emailish.MatchString(s):
			return nil, dbInvalid("%s takes an email address.", p.Name)
		case p.Type == "phone" && !phoneish.MatchString(s):
			return nil, dbInvalid("%s takes a phone number.", p.Name)
		}
		return s, nil
	case "number":
		var n float64
		if json.Unmarshal(v, &n) != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return nil, bad()
		}
		return n, nil
	case "checkbox":
		var b bool
		if json.Unmarshal(v, &b) != nil {
			return nil, bad()
		}
		return b, nil
	case "select", "status":
		var s string
		if json.Unmarshal(v, &s) != nil || !slices.Contains(optionIDs(), s) {
			return nil, bad()
		}
		return s, nil
	case "multi_select":
		var list []string
		if json.Unmarshal(v, &list) != nil || len(list) > maxOptions {
			return nil, bad()
		}
		out := []string{}
		for _, s := range list {
			if !slices.Contains(optionIDs(), s) {
				return nil, bad()
			}
			if !slices.Contains(out, s) {
				out = append(out, s)
			}
		}
		return out, nil
	case "date":
		var d DateValue
		if json.Unmarshal(v, &d) != nil || !validDate(d.Start) || (d.End != nil && !validDate(*d.End)) {
			return nil, dbInvalid("%s takes a day (YYYY-MM-DD) or a moment (RFC 3339), and an end.", p.Name)
		}
		return d, nil
	case "files":
		var list []FileValue
		if json.Unmarshal(v, &list) != nil || len(list) > 50 {
			return nil, bad()
		}
		for i := range list {
			if !hd.WikiSrc(list[i].URL) || !shortText(list[i].Name, 255) {
				return nil, dbInvalid("%s takes uploaded files or https links.", p.Name)
			}
		}
		return list, nil
	case "person":
		list, err := ids()
		refs.users = append(refs.users, list...)
		return list, err
	case "relation":
		list, err := ids()
		if refs.pages == nil {
			refs.pages = map[uuid.UUID][]uuid.UUID{}
		}
		refs.pages[*p.DatabaseID] = append(refs.pages[*p.DatabaseID], list...)
		return list, err
	case "ticket":
		list, err := ids()
		refs.tickets = append(refs.tickets, list...)
		return list, err
	}
	return nil, bad()
}

func validDate(s string) bool {
	if isoDay.MatchString(s) {
		_, err := time.Parse(time.DateOnly, s)
		return err == nil
	}
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

// checkRefs makes sure a row's values name only the workspace's members, rows of the
// related databases the viewer may see, and tickets the viewer may see.
func checkRefs(ctx context.Context, tx pgx.Tx, v Viewer, wid uuid.UUID, refs propRefs) error {
	if len(refs.users) > 0 {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM members WHERE workspace_id = $1 AND user_id = ANY($2)`, wid, refs.users).Scan(&n); err != nil {
			return err
		}
		if n != len(uniq(refs.users)) {
			return dbInvalid("A person property names someone who isn't a member of this workspace.")
		}
	}
	me, hidden := v.args()
	for db, pages := range refs.pages {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM wiki_pages p WHERE p.workspace_id = $1 AND p.parent_id = $2 AND p.id = ANY($3)
			AND p.deleted_at IS NULL AND NOT p.template AND `+seesSQL("p", 4, 5), wid, db, pages, me, hidden).Scan(&n); err != nil {
			return err
		}
		if n != len(uniq(pages)) {
			return dbInvalid("A relation names a page that isn't a row of its database.")
		}
	}
	if len(refs.tickets) > 0 {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM tickets t WHERE t.workspace_id = $1 AND t.id = ANY($2)
			AND (t.team_id IS NULL OR NOT t.team_id = ANY($3::uuid[]))`, wid, refs.tickets, hidden).Scan(&n); err != nil {
			return err
		}
		if n != len(uniq(refs.tickets)) {
			return dbInvalid("A ticket property names a ticket that isn't in this workspace.")
		}
	}
	return nil
}

func uniq(ids []uuid.UUID) []uuid.UUID {
	out := []uuid.UUID{}
	for _, id := range ids {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// nextRowNumbers gives a new row of db its unique ids (one per unique id property) and
// moves the database's counter.
func nextRowNumbers(ctx context.Context, tx pgx.Tx, wid, dbID uuid.UUID, db *Database, props map[string]any) error {
	has := false
	for _, p := range db.Properties {
		if p.Type == "unique_id" {
			props[p.ID] = db.NextID
			has = true
		}
	}
	if !has {
		return nil
	}
	db.NextID++
	_, err := tx.Exec(ctx, `UPDATE wiki_pages SET database = jsonb_set(database, '{next_id}', to_jsonb($3::int)) WHERE workspace_id = $1 AND id = $2`, wid, dbID, db.NextID)
	return err
}

// numberRows gives every row of a database a unique id it lacks for the unique id
// properties ids (added after the rows were), oldest first, and moves the counter.
func numberRows(ctx context.Context, tx pgx.Tx, wid, dbID uuid.UUID, db *Database, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM wiki_pages WHERE workspace_id = $1 AND parent_id = $2 AND NOT template ORDER BY created_at, id`, wid, dbID)
	list, err := collectIDs(rows, err)
	if err != nil {
		return err
	}
	for _, row := range list {
		for _, prop := range ids {
			if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET props = jsonb_set(props, ARRAY[$3::text], to_jsonb($4::int)) WHERE workspace_id = $1 AND id = $2 AND NOT props ? $3`,
				wid, row, prop, db.NextID); err != nil {
				return err
			}
		}
		db.NextID++
	}
	return nil
}
