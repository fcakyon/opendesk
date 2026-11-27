package contacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/imports/csvfile"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// Contact imports (contracts/imports.md "Contacts"): a CSV file of people is uploaded, its
// columns are mapped to contact fields, and a job adds the people in chunks while the
// directory stays usable. A person who is already there is found by email or by external id.

const (
	matchEmail      = "email"
	matchExternalID = "external_id"

	onMatchSkip      = "skip"
	onMatchFill      = "fill"
	onMatchOverwrite = "overwrite"

	statusRunning   = "running"
	statusDone      = "done"
	statusFailed    = "failed"
	statusCancelled = "cancelled"
)

// maxRowErrors bounds the failed rows an import keeps to show; the count is exact.
const maxRowErrors = 50

// ContactImportMapping names the CSV column that fills each contact field ("" leaves it unset).
type ContactImportMapping struct {
	Name       string `json:"name,omitempty" maxLength:"200"`
	Email      string `json:"email,omitempty" maxLength:"200"`
	Phone      string `json:"phone,omitempty" maxLength:"200"`
	Company    string `json:"company,omitempty" maxLength:"200" doc:"A company's name; one that does not exist yet is created"`
	ExternalID string `json:"external_id,omitempty" maxLength:"200"`
	Notes      string `json:"notes,omitempty" maxLength:"200"`
	Labels     string `json:"labels,omitempty" maxLength:"200" doc:"Labels separated by commas, semicolons or bars; ones that do not exist yet are created where the person may"`
	// Fields maps a custom field's key to its column.
	Fields map[string]string `json:"fields,omitempty" maxProperties:"50"`
}

func (m ContactImportMapping) columns() []string {
	out := []string{m.Name, m.Email, m.Phone, m.Company, m.ExternalID, m.Notes, m.Labels}
	for _, c := range m.Fields {
		out = append(out, c)
	}
	return out
}

type ContactImportColumn struct {
	Name    string   `json:"name"`
	Samples []string `json:"samples"`
}

type ContactImportUpload struct {
	UploadID  uuid.UUID             `json:"upload_id"`
	Filename  string                `json:"filename"`
	Rows      int                   `json:"rows"`
	Columns   []ContactImportColumn `json:"columns"`
	Suggested ContactImportMapping  `json:"suggested"`
}

type ContactImportRowError struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// ContactImport is one run of a file into the directory.
type ContactImport struct {
	ID         uuid.UUID               `json:"id"`
	Filename   string                  `json:"filename"`
	Status     string                  `json:"status" enum:"running,done,failed,cancelled"`
	MatchOn    string                  `json:"match_on" enum:"email,external_id"`
	OnMatch    string                  `json:"on_match" enum:"skip,fill,overwrite"`
	Total      int                     `json:"total"`
	Processed  int                     `json:"processed"`
	Created    int                     `json:"created"`
	Updated    int                     `json:"updated"`
	Skipped    int                     `json:"skipped"`
	Failed     int                     `json:"failed"`
	Errors     []ContactImportRowError `json:"errors" doc:"The first rows that could not be imported, with the line each is on"`
	Error      string                  `json:"error" doc:"Why the import stopped, when it failed"`
	CreatedAt  time.Time               `json:"created_at"`
	FinishedAt *time.Time              `json:"finished_at"`
}

const importCols = `id, filename, status, match_on, on_match, total, processed, created, updated, skipped, failed, errors, error, created_at, finished_at`

func scanImport(r pgx.Row) (ContactImport, error) {
	var x ContactImport
	var errs []byte
	if err := r.Scan(&x.ID, &x.Filename, &x.Status, &x.MatchOn, &x.OnMatch, &x.Total, &x.Processed, &x.Created, &x.Updated,
		&x.Skipped, &x.Failed, &errs, &x.Error, &x.CreatedAt, &x.FinishedAt); err != nil {
		return x, err
	}
	x.Errors = []ContactImportRowError{}
	_ = json.Unmarshal(errs, &x.Errors)
	return x, nil
}

type contactImportStartBody struct {
	UploadID uuid.UUID            `json:"upload_id"`
	Mapping  ContactImportMapping `json:"mapping"`
	MatchOn  string               `json:"match_on" enum:"email,external_id" doc:"What tells that a person is already in the directory"`
	OnMatch  string               `json:"on_match" enum:"skip,fill,overwrite" doc:"skip leaves them alone, fill sets only what they have empty, overwrite sets every mapped value the file has"`
}

type contactImportForm struct {
	File huma.FormFile `form:"file" required:"true" doc:"A .csv file, at most 50 MB"`
}

const maxUploadBody = csvfile.MaxBytes + 1<<20

// Column names people use for each field, normalized (csvfile.NormHeader); an export's own
// headers come first, so an exported file maps itself.
var importAliases = []struct {
	field   string
	aliases []string
}{
	{"email", []string{"email", "email address", "e mail", "primary email", "mail", "contact email"}},
	{"name", []string{"name", "full name", "contact name", "customer name", "display name", "customer", "contact"}},
	{"phone", []string{"phone", "phone number", "telephone", "mobile", "mobile phone", "tel", "cell"}},
	{"company", []string{"company", "company name", "organization", "organisation", "org", "account"}},
	{"external_id", []string{"external id", "externalid", "customer id", "contact id", "user id", "id", "reference"}},
	{"notes", []string{"notes", "note", "comments", "about", "description"}},
	{"labels", []string{"labels", "tags", "label", "tag", "groups", "segments"}},
}

// suggestImportMapping guesses the column of each field from the header names. A column is
// used for one field only; aliases earlier in a field's list win.
func suggestImportMapping(header []string, defs domain.FieldDefs) ContactImportMapping {
	normed := make([]string, len(header))
	for i, h := range header {
		normed[i] = csvfile.NormHeader(h)
	}
	used := map[int]bool{}
	pick := func(aliases ...string) string {
		for _, a := range aliases {
			if i := slices.Index(normed, a); i >= 0 && !used[i] {
				used[i] = true
				return header[i]
			}
		}
		return ""
	}
	var m ContactImportMapping
	for _, f := range importAliases {
		c := pick(f.aliases...)
		switch f.field {
		case "email":
			m.Email = c
		case "name":
			m.Name = c
		case "phone":
			m.Phone = c
		case "company":
			m.Company = c
		case "external_id":
			m.ExternalID = c
		case "notes":
			m.Notes = c
		case "labels":
			m.Labels = c
		}
	}
	for key, f := range defs {
		if f.Archived || f.Type == domain.FieldUser {
			continue
		}
		if c := pick(csvfile.NormHeader(f.Name), csvfile.NormHeader(key)); c != "" {
			if m.Fields == nil {
				m.Fields = map[string]string{}
			}
			m.Fields[key] = c
		}
	}
	return m
}

// checkImportMapping refuses a mapping that names a missing column or a field that is not
// there, and one the people cannot be told apart by.
func checkImportMapping(b contactImportStartBody, header []string, defs domain.FieldDefs) error {
	for _, c := range b.Mapping.columns() {
		if c != "" && !slices.Contains(header, c) {
			return httpx.Validation("The file has no column called " + hd.Excerpt(c, 60) + ".")
		}
	}
	for key, c := range b.Mapping.Fields {
		f, ok := defs[key]
		if !ok || f.Archived || f.Type == domain.FieldUser {
			return httpx.Validation("There is no custom field " + hd.Excerpt(key, 40) + " to fill.")
		}
		if c == "" {
			return httpx.Validation("Pick a column for each custom field you map.")
		}
	}
	m := b.Mapping
	if m.Email == "" && m.Name == "" {
		return httpx.Validation("Map at least a name or an email column.")
	}
	if b.MatchOn == matchEmail && m.Email == "" {
		return httpx.Validation("Map an email column to find people by email.")
	}
	if b.MatchOn == matchExternalID && m.ExternalID == "" {
		return httpx.Validation("Map an external id column to find people by it.")
	}
	return nil
}

func limitBody(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		r, w := humachi.Unwrap(ctx)
		if r.ContentLength > maxUploadBody {
			_ = huma.WriteErr(api, ctx, http.StatusRequestEntityTooLarge, "CSV files can be at most 50 MB.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
		next(ctx)
	}
}

// readUpload reads a workspace's stored upload and parses it.
func readUpload(ctx context.Context, d *deps.Deps, wid, id uuid.UUID) (string, *csvfile.File, error) {
	var key, filename string
	err := d.DB.Pool.QueryRow(ctx, `SELECT storage_key, filename FROM import_uploads WHERE workspace_id = $1 AND id = $2`, wid, id).Scan(&key, &filename)
	if db.IsNotFound(err) {
		return "", nil, httpx.E(http.StatusNotFound, "not_found", "The uploaded file is gone. Upload it again.")
	}
	if err != nil {
		return "", nil, err
	}
	f, err := readStored(ctx, d, key)
	if err != nil {
		return "", nil, err
	}
	return filename, f, nil
}

func readStored(ctx context.Context, d *deps.Deps, key string) (*csvfile.File, error) {
	rc, err := d.Storage.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	raw, err := io.ReadAll(io.LimitReader(rc, csvfile.MaxBytes+1))
	if err != nil {
		return nil, err
	}
	f, err := csvfile.Parse(raw)
	if err != nil {
		return nil, httpx.E(http.StatusUnprocessableEntity, "csv_unreadable", err.Error())
	}
	return f, nil
}

func upload(ctx context.Context, d *deps.Deps, p *auth.Principal, f huma.FormFile) (ContactImportUpload, error) {
	if f.Size > csvfile.MaxBytes {
		return ContactImportUpload{}, httpx.E(http.StatusRequestEntityTooLarge, "too_large", "CSV files can be at most 50 MB.")
	}
	filename := hd.CleanFilename(f.Filename)
	if ext := strings.ToLower(filepath.Ext(filename)); ext != ".csv" && ext != ".tsv" && ext != ".txt" {
		return ContactImportUpload{}, httpx.E(http.StatusUnprocessableEntity, "file_type_refused", "Upload a .csv file. Spreadsheets can save one with File, then Download or Export, as CSV.")
	}
	raw, err := io.ReadAll(io.LimitReader(f.File, csvfile.MaxBytes+1))
	if err != nil {
		return ContactImportUpload{}, err
	}
	if len(raw) > csvfile.MaxBytes {
		return ContactImportUpload{}, httpx.E(http.StatusRequestEntityTooLarge, "too_large", "CSV files can be at most 50 MB.")
	}
	if len(raw) == 0 {
		return ContactImportUpload{}, httpx.Validation("the file is empty")
	}
	parsed, err := csvfile.Parse(raw)
	if err != nil {
		return ContactImportUpload{}, httpx.E(http.StatusUnprocessableEntity, "csv_unreadable", err.Error())
	}
	defs, err := domain.LoadFieldDefs(ctx, d.DB.Pool, p.WorkspaceID, domain.FieldEntityContact)
	if err != nil {
		return ContactImportUpload{}, err
	}
	sum := sha256.Sum256(raw)
	id := ids.New()
	key := "workspaces/" + p.WorkspaceID.String() + "/imports/" + id.String() + ".csv"
	if err := d.Storage.Put(ctx, key, bytes.NewReader(raw), int64(len(raw)), "text/csv"); err != nil {
		return ContactImportUpload{}, err
	}
	if _, err := d.DB.Pool.Exec(ctx, `INSERT INTO import_uploads (id, workspace_id, storage_key, filename, sha256, size_bytes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, p.WorkspaceID, key, filename, hex.EncodeToString(sum[:]), len(raw), p.ActorUserID()); err != nil {
		_ = d.Storage.Delete(context.WithoutCancel(ctx), key)
		return ContactImportUpload{}, err
	}
	out := ContactImportUpload{UploadID: id, Filename: filename, Rows: len(parsed.Rows), Columns: []ContactImportColumn{}, Suggested: suggestImportMapping(parsed.Header, defs)}
	for i, h := range parsed.Header {
		col := ContactImportColumn{Name: h, Samples: []string{}}
		for _, rec := range parsed.Rows {
			if len(col.Samples) >= 3 {
				break
			}
			if i < len(rec) {
				if v := importCell(rec[i]); v != "" {
					col.Samples = append(col.Samples, hd.Excerpt(v, 80))
				}
			}
		}
		out.Columns = append(out.Columns, col)
	}
	return out, nil
}

// publishImport announces an import's progress to the person who started it.
func publishImport(ctx context.Context, tx pgx.Tx, wid uuid.UUID, by *uuid.UUID, x ContactImport) error {
	if by == nil {
		return nil
	}
	_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "contact_import.updated", Users: []uuid.UUID{*by},
		Data: map[string]any{"import": x}})
	return err
}

func registerImport(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "upload-contact-import", Method: http.MethodPost, Path: "/v1/contacts/import/upload",
		Summary: "Upload a CSV file of people", Tags: []string{"Contacts"}, DefaultStatus: http.StatusCreated, MaxBodyBytes: maxUploadBody,
		Middlewares: huma.Middlewares{limitBody(api)},
		Description: "UTF-8 or UTF-16 with a byte order mark, separated by commas, semicolons or tabs, with a header row. Answers its columns, a few values of each and the mapping guessed from the headers."},
		func(ctx context.Context, in *struct {
			RawBody huma.MultipartFormFiles[contactImportForm]
		}) (*struct{ Body ContactImportUpload }, error) {
			if in.RawBody.Form != nil {
				defer func(f *multipart.Form) { _ = f.RemoveAll() }(in.RawBody.Form)
			}
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			data := in.RawBody.Data()
			if data == nil || !data.File.IsSet || data.File.File == nil {
				return nil, httpx.Validation("file is required")
			}
			defer data.File.Close()
			if !d.Limiter.Allow("contacts:import:upload:"+p.WorkspaceID.String(), 20, time.Hour) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many uploads. Try again later.")
			}
			out, err := upload(ctx, d, p, data.File)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactImportUpload }{out}, nil
		})

	huma.Register(api, op("start-contact-import", http.MethodPost, "/v1/contacts/imports", "Import people from an uploaded file", "Contacts", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body contactImportStartBody }) (*struct{ Body ContactImport }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			if !slices.Contains([]string{matchEmail, matchExternalID}, b.MatchOn) || !slices.Contains([]string{onMatchSkip, onMatchFill, onMatchOverwrite}, b.OnMatch) {
				return nil, httpx.Validation("match_on and on_match are required")
			}
			filename, file, err := readUpload(ctx, d, p.WorkspaceID, b.UploadID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			defs, err := domain.LoadFieldDefs(ctx, d.DB.Pool, p.WorkspaceID, domain.FieldEntityContact)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := checkImportMapping(b, file.Header, defs); err != nil {
				return nil, err
			}
			var x ContactImport
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var running int
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM contact_imports WHERE workspace_id = $1 AND status = 'running'`, p.WorkspaceID).Scan(&running); err != nil {
					return err
				}
				if running >= 2 {
					return httpx.Conflict("Two imports are already running. Wait for one to finish.")
				}
				mapping, _ := json.Marshal(b.Mapping)
				id := ids.New()
				var err error
				x, err = scanImport(tx.QueryRow(ctx, `INSERT INTO contact_imports (id, workspace_id, upload_id, filename, mapping, match_on, on_match, total, created_by)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING `+importCols, id, p.WorkspaceID, b.UploadID, filename, mapping, b.MatchOn, b.OnMatch, len(file.Rows), p.ActorUserID()))
				if err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "contact.import_started", "contact_import", &id,
					map[string]any{"rows": len(file.Rows), "match_on": b.MatchOn, "on_match": b.OnMatch}); err != nil {
					return err
				}
				if _, err := d.Jobs.InsertTx(ctx, tx, jobs.ContactImportArgs{ImportID: id}, &river.InsertOpts{MaxAttempts: 10}); err != nil {
					return err
				}
				return publishImport(ctx, tx, p.WorkspaceID, p.ActorUserID(), x)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactImport }{x}, nil
		})

	huma.Register(api, op("list-contact-imports", http.MethodGet, "/v1/contacts/imports", "List contact imports", "Contacts", 0),
		func(ctx context.Context, _ *struct{}) (*struct {
			Body struct {
				Data []ContactImport `json:"data"`
			}
		}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT `+importCols+` FROM contact_imports WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ContactImport, error) { return scanImport(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct {
				Body struct {
					Data []ContactImport `json:"data"`
				}
			}{}
			out.Body.Data = list
			return out, nil
		})

	huma.Register(api, op("get-contact-import", http.MethodGet, "/v1/contacts/imports/{id}", "Get a contact import", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ContactImport }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Import")
			if err != nil {
				return nil, err
			}
			x, err := scanImport(d.DB.Pool.QueryRow(ctx, `SELECT `+importCols+` FROM contact_imports WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id))
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Import")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactImport }{x}, nil
		})

	huma.Register(api, op("cancel-contact-import", http.MethodPost, "/v1/contacts/imports/{id}/cancel", "Stop a contact import", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ContactImport }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Import")
			if err != nil {
				return nil, err
			}
			var x ContactImport
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var by *uuid.UUID
				x, err = scanImport(tx.QueryRow(ctx, `UPDATE contact_imports SET status = 'cancelled', finished_at = now(), updated_at = now()
					WHERE workspace_id = $1 AND id = $2 AND status = 'running' RETURNING `+importCols, p.WorkspaceID, id))
				if db.IsNotFound(err) {
					cur, err := scanImport(tx.QueryRow(ctx, `SELECT `+importCols+` FROM contact_imports WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id))
					if db.IsNotFound(err) {
						return httpx.NotFound("Import")
					}
					x = cur
					return err
				}
				if err != nil {
					return err
				}
				if err := tx.QueryRow(ctx, `SELECT created_by FROM contact_imports WHERE id = $1`, id).Scan(&by); err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "contact.import_cancelled", "contact_import", &id, nil); err != nil {
					return err
				}
				return publishImport(ctx, tx, p.WorkspaceID, by, x)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactImport }{x}, nil
		})
}
