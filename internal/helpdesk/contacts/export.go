package contacts

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// maxExport bounds the people one export holds; a larger selection is split by narrowing the
// filter.
const maxExport = 50_000

type contactExportBody struct {
	IDs   []string       `json:"ids,omitempty" maxItems:"1000" doc:"The people to export"`
	Query *contactFilter `json:"query,omitempty" doc:"The People list's filters, instead of ids"`
}

type contactExportOut struct {
	ContentType        string `header:"Content-Type"`
	ContentDisposition string `header:"Content-Disposition"`
	CacheControl       string `header:"Cache-Control"`
	Body               []byte
}

// exportColumns are the fixed columns of an export, in order. An import reads the same
// headers back, so an export can be edited and imported again.
var exportColumns = []string{"Name", "Email", "Other emails", "Phone", "Company", "External ID", "Notes", "Labels", "Blocked", "Created"}

// csvFormulaStarts are the first characters that make a spreadsheet run a cell as a formula.
const csvFormulaStarts = "=+-@\t\r"

// csvCell neutralizes a value a spreadsheet would run as a formula.
func csvCell(s string) string {
	if s != "" && strings.ContainsRune(csvFormulaStarts, rune(s[0])) {
		return "'" + s
	}
	return s
}

// csvUncell reads back a value csvCell neutralized, so an exported file imports as it was.
func csvUncell(s string) string {
	if len(s) > 1 && s[0] == '\'' && strings.ContainsRune(csvFormulaStarts, rune(s[1])) {
		return s[1:]
	}
	return s
}

func fieldText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		parts := make([]string, 0, len(x))
		for _, e := range x {
			parts = append(parts, fieldText(e))
		}
		return strings.Join(parts, "; ")
	}
	return fmt.Sprint(v)
}

// writeContactsCSV renders people as CSV: the fixed columns, then a column for each custom
// field the workspace defines.
func writeContactsCSV(list []domain.Contact, defs domain.FieldDefs) []byte {
	keys := make([]string, 0, len(defs))
	for k := range defs {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := defs[keys[i]], defs[keys[j]]
		if a.Position != b.Position {
			return a.Position < b.Position
		}
		return a.Key < b.Key
	})
	var buf bytes.Buffer
	buf.WriteString("\xEF\xBB\xBF")
	w := csv.NewWriter(&buf)
	head := append([]string{}, exportColumns...)
	for _, k := range keys {
		head = append(head, defs[k].Name)
	}
	_ = w.Write(head)
	for _, c := range list {
		email := ""
		if c.Email != nil {
			email = *c.Email
		}
		company, ext := "", ""
		if c.Company != nil {
			company = c.Company.Name
		}
		if c.ExternalID != nil {
			ext = *c.ExternalID
		}
		tags := make([]string, 0, len(c.Tags))
		for _, t := range c.Tags {
			tags = append(tags, t.Name)
		}
		rec := []string{c.Name, email, strings.Join(c.Emails, "; "), c.Phone, company, ext, c.Notes,
			strings.Join(tags, "; "), strconv.FormatBool(c.Blocked), c.CreatedAt.UTC().Format(time.RFC3339)}
		for _, k := range keys {
			rec = append(rec, fieldText(c.Fields[k]))
		}
		for i := range rec {
			rec[i] = csvCell(rec[i])
		}
		_ = w.Write(rec)
	}
	w.Flush()
	return buf.Bytes()
}

func registerExport(d *deps.Deps, api huma.API) {
	huma.Register(api, op("export-contacts", http.MethodPost, "/v1/contacts/export", "Export contacts as CSV", "Contacts", 0),
		func(ctx context.Context, in *struct{ Body contactExportBody }) (*contactExportOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			if (len(b.IDs) == 0) == (b.Query == nil) {
				return nil, httpx.Validation("send either ids or query")
			}
			if !d.Limiter.Allow("contacts:export:"+p.WorkspaceID.String(), 30, time.Hour) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many exports. Try again later.")
			}
			var list []domain.Contact
			var defs domain.FieldDefs
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var where string
				var args []any
				if b.Query != nil {
					var err error
					if where, args, err = b.Query.where(ctx, tx, p); err != nil {
						return err
					}
				} else {
					want, err := workspaceIDs(ctx, tx, "contacts", "Contact", p.WorkspaceID, b.IDs)
					if err != nil {
						return err
					}
					where, args = ` WHERE ct.workspace_id = $1 AND ct.id = ANY($2)`, []any{p.WorkspaceID, want}
				}
				rows, err := tx.Query(ctx, domain.ContactSelect+where+` ORDER BY ct.created_at DESC, ct.id LIMIT `+strconv.Itoa(maxExport+1), args...)
				if err != nil {
					return err
				}
				if list, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Contact, error) { return domain.ScanContact(r) }); err != nil {
					return err
				}
				if len(list) > maxExport {
					return httpx.E(422, "too_many_records", "That filter matches more than 50,000 people. Narrow it and try again.")
				}
				if defs, err = domain.LoadFieldDefs(ctx, tx, p.WorkspaceID, domain.FieldEntityContact); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "contact.exported", "contact", nil, map[string]any{"count": len(list)})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			name := "people-" + time.Now().UTC().Format("2006-01-02") + ".csv"
			return &contactExportOut{ContentType: "text/csv; charset=utf-8", ContentDisposition: `attachment; filename="` + name + `"`,
				CacheControl: "no-store", Body: writeContactsCSV(list, defs)}, nil
		})
}
