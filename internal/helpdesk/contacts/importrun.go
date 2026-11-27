package contacts

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/imports"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// importChunk is how many rows one transaction adds; the checkpoint moves with each.
const importChunk = 100

// importBudget is how long one job works before it snoozes to let the queue breathe; the
// next one picks up at the checkpoint.
const importBudget = 4 * time.Minute

// RegisterWorkers adds the contacts import worker.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	river.AddWorker(w, &importWorker{d: d})
}

type importWorker struct {
	river.WorkerDefaults[jobs.ContactImportArgs]
	d *deps.Deps
}

func (w *importWorker) Timeout(*river.Job[jobs.ContactImportArgs]) time.Duration {
	return importBudget + 5*time.Minute
}

func (w *importWorker) Work(ctx context.Context, job *river.Job[jobs.ContactImportArgs]) error {
	return runImport(ctx, w.d, job.Args.ImportID)
}

type importRun struct {
	ImportID              uuid.UUID
	WorkspaceID           uuid.UUID
	UploadID              uuid.UUID
	Mapping               ContactImportMapping
	MatchOn, OnMatch      string
	CreatedBy             *uuid.UUID
	Processed             int
	Created, Updated      int
	Skipped, Failed       int
	Errors                []ContactImportRowError
	status, key, filename string
}

func loadRun(ctx context.Context, d *deps.Deps, id uuid.UUID) (*importRun, error) {
	r := &importRun{ImportID: id}
	var mapping, errs []byte
	err := d.DB.Pool.QueryRow(ctx, `SELECT c.workspace_id, c.upload_id, c.mapping, c.match_on, c.on_match, c.created_by, c.processed,
		c.created, c.updated, c.skipped, c.failed, c.errors, c.status, c.filename, COALESCE(u.storage_key, '')
		FROM contact_imports c LEFT JOIN import_uploads u ON u.id = c.upload_id AND u.workspace_id = c.workspace_id WHERE c.id = $1`, id).
		Scan(&r.WorkspaceID, &r.UploadID, &mapping, &r.MatchOn, &r.OnMatch, &r.CreatedBy, &r.Processed, &r.Created, &r.Updated,
			&r.Skipped, &r.Failed, &errs, &r.status, &r.filename, &r.key)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(mapping, &r.Mapping)
	r.Errors = []ContactImportRowError{}
	_ = json.Unmarshal(errs, &r.Errors)
	return r, nil
}

// principal is the person who started the import, acting as an agent: the import adds what
// an agent could add by hand, and labels follow what that person may create.
func (r *importRun) principal() *auth.Principal {
	p := &auth.Principal{Kind: auth.KindUser, WorkspaceID: r.WorkspaceID, Role: auth.RoleAgent}
	if r.CreatedBy != nil {
		p.UserID = *r.CreatedBy
	}
	return p
}

func runImport(ctx context.Context, d *deps.Deps, id uuid.UUID) error {
	r, err := loadRun(ctx, d, id)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if r.status != statusRunning {
		discardUpload(ctx, d, r)
		return nil
	}
	if r.key == "" {
		return finish(ctx, d, r, statusFailed, "The uploaded file is gone. Upload it again in a new import.")
	}
	file, err := readStored(ctx, d, r.key)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return finish(ctx, d, r, statusFailed, he.Detail)
		}
		return err
	}
	defs, err := domain.LoadFieldDefs(ctx, d.DB.Pool, r.WorkspaceID, domain.FieldEntityContact)
	if err != nil {
		return err
	}
	cols := columnIndex(file.Header)
	deadline := time.Now().Add(importBudget)
	for r.Processed < len(file.Rows) {
		if time.Now().After(deadline) {
			return river.JobSnooze(time.Second)
		}
		cancelled, err := isCancelled(ctx, d, id)
		if err != nil {
			return err
		}
		if cancelled {
			discardUpload(ctx, d, r)
			return nil
		}
		end := min(r.Processed+importChunk, len(file.Rows))
		if err := r.chunk(ctx, d, file, cols, defs, r.Processed, end); err != nil {
			return err
		}
	}
	return finish(ctx, d, r, statusDone, "")
}

func isCancelled(ctx context.Context, d *deps.Deps, id uuid.UUID) (bool, error) {
	var st string
	if err := d.DB.Pool.QueryRow(ctx, `SELECT status FROM contact_imports WHERE id = $1`, id).Scan(&st); err != nil {
		return false, err
	}
	return st != statusRunning, nil
}

// discardUpload removes the file an import has no more use for.
func discardUpload(ctx context.Context, d *deps.Deps, r *importRun) {
	ctx = context.WithoutCancel(ctx)
	if r.key != "" {
		_ = d.Storage.Delete(ctx, r.key)
	}
	_, _ = d.DB.Pool.Exec(ctx, `DELETE FROM import_uploads WHERE workspace_id = $1 AND id = $2`, r.WorkspaceID, r.UploadID)
}

func finish(ctx context.Context, d *deps.Deps, r *importRun, status, msg string) error {
	var x ContactImport
	err := d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		x, err = scanImport(tx.QueryRow(ctx, `UPDATE contact_imports SET status = $2, error = $3, finished_at = now(), updated_at = now()
			WHERE id = $1 AND status = 'running' RETURNING `+importCols, r.ImportID, status, msg))
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		meta := map[string]any{"created": x.Created, "updated": x.Updated, "skipped": x.Skipped, "failed": x.Failed}
		if err := audit.Log(ctx, tx, r.principal(), r.WorkspaceID, "contact.import_"+status, "contact_import", &r.ImportID, meta); err != nil {
			return err
		}
		return publishImport(ctx, tx, r.WorkspaceID, r.CreatedBy, x)
	})
	if err != nil {
		return err
	}
	discardUpload(ctx, d, r)
	return nil
}

func columnIndex(header []string) map[string]int {
	m := make(map[string]int, len(header))
	for i, h := range header {
		if _, ok := m[h]; !ok {
			m[h] = i
		}
	}
	return m
}

// chunk adds rows [from, to) in one transaction, each in a savepoint of its own so a row
// that cannot be saved fails alone, and moves the checkpoint with them.
func (r *importRun) chunk(ctx context.Context, d *deps.Deps, f *imports.CSVFile, cols map[string]int, defs domain.FieldDefs, from, to int) error {
	next := *r
	next.Errors = append([]ContactImportRowError{}, r.Errors...)
	var x ContactImport
	err := d.DB.Tx(ctx, func(tx pgx.Tx) error {
		next = *r
		next.Errors = append([]ContactImportRowError{}, r.Errors...)
		p := r.principal()
		for i := from; i < to; i++ {
			sp, err := tx.Begin(ctx)
			if err != nil {
				return err
			}
			outcome, err := next.row(ctx, d, sp, p, f.Rows[i], cols, defs)
			if err != nil {
				_ = sp.Rollback(ctx)
				if ctx.Err() != nil {
					return ctx.Err()
				}
				next.Failed++
				if len(next.Errors) < maxRowErrors {
					next.Errors = append(next.Errors, ContactImportRowError{Line: f.Lines[i], Message: rowMessage(err)})
				}
				continue
			}
			if err := sp.Commit(ctx); err != nil {
				return err
			}
			switch outcome {
			case "created":
				next.Created++
			case "updated":
				next.Updated++
			default:
				next.Skipped++
			}
		}
		next.Processed = to
		errs, _ := json.Marshal(next.Errors)
		var err error
		x, err = scanImport(tx.QueryRow(ctx, `UPDATE contact_imports SET processed = $2, created = $3, updated = $4, skipped = $5, failed = $6,
			errors = $7, updated_at = now() WHERE id = $1 AND status = 'running' RETURNING `+importCols,
			r.ImportID, next.Processed, next.Created, next.Updated, next.Skipped, next.Failed, errs))
		if err != nil {
			return err
		}
		return publishImport(ctx, tx, r.WorkspaceID, r.CreatedBy, x)
	})
	if db.IsNotFound(err) {
		// Stopped while this chunk ran: the chunk is undone with the transaction.
		return nil
	}
	if err != nil {
		return err
	}
	*r = next
	return nil
}

// rowMessage is what a failed row shows: a typed refusal's own words, never an internal error.
func rowMessage(err error) string {
	var he *httpx.Error
	if errors.As(err, &he) && he.Detail != "" {
		return he.Detail
	}
	slog.Warn("contact import row failed", "err", err)
	return "This row could not be saved."
}

func (r *importRun) cell(rec []string, cols map[string]int, col string) string {
	if col == "" {
		return ""
	}
	i, ok := cols[col]
	if !ok || i >= len(rec) {
		return ""
	}
	return importCell(rec[i])
}

// importCell is a cell's value as an import takes it.
func importCell(s string) string {
	return strings.TrimSpace(csvUncell(strings.TrimSpace(s)))
}

// row adds or updates the person one row describes and says which it did.
func (r *importRun) row(ctx context.Context, d *deps.Deps, tx pgx.Tx, p *auth.Principal, rec []string, cols map[string]int, defs domain.FieldDefs) (string, error) {
	m := r.Mapping
	email, ext := r.cell(rec, cols, m.Email), r.cell(rec, cols, m.ExternalID)
	body := contactWriteBody{}
	if email != "" {
		body.Email = Nullable[string]{Set: true, Value: email}
	}
	if v := r.cell(rec, cols, m.Name); v != "" {
		body.Name = &v
	}
	if v := r.cell(rec, cols, m.Phone); v != "" {
		body.Phone = &v
	}
	if v := r.cell(rec, cols, m.Notes); v != "" {
		body.Notes = &v
	}
	if ext != "" {
		body.ExternalID = Nullable[string]{Set: true, Value: ext}
	}
	for _, l := range strings.FieldsFunc(r.cell(rec, cols, m.Labels), func(c rune) bool { return c == ',' || c == ';' || c == '|' }) {
		if l = strings.TrimSpace(l); l != "" {
			body.AddTags = append(body.AddTags, l)
		}
	}
	if len(body.AddTags) > 50 {
		body.AddTags = body.AddTags[:50]
	}
	for key, col := range m.Fields {
		if v := r.cell(rec, cols, col); v != "" {
			val, err := fieldValue(defs[key], v)
			if err != nil {
				return "", err
			}
			if body.Fields == nil {
				body.Fields = map[string]any{}
			}
			body.Fields[key] = val
		}
	}

	var id *uuid.UUID
	var err error
	switch {
	case r.MatchOn == matchEmail && email != "":
		id, err = findByEmail(ctx, tx, r.WorkspaceID, email)
	case r.MatchOn == matchExternalID && ext != "":
		id, err = findByExternalID(ctx, tx, r.WorkspaceID, ext)
	}
	if err != nil {
		return "", err
	}
	company := r.cell(rec, cols, m.Company)
	if id == nil {
		if company != "" {
			if err := setCompany(ctx, tx, p, &body, company); err != nil {
				return "", err
			}
		}
		_, err := insertContact(ctx, d, tx, p, &body)
		return "created", err
	}
	if r.OnMatch == onMatchSkip {
		return "skipped", nil
	}
	cur, err := domain.LoadContact(ctx, tx, r.WorkspaceID, *id)
	if err != nil {
		return "", err
	}
	if r.OnMatch == onMatchFill {
		fillOnly(&body, cur)
	}
	if company != "" && (r.OnMatch == onMatchOverwrite || cur.Company == nil) {
		if err := setCompany(ctx, tx, p, &body, company); err != nil {
			return "", err
		}
	}
	if _, err := patchContact(ctx, d, tx, p, *id, &body); err != nil {
		return "", err
	}
	return "updated", nil
}

// fillOnly drops what the person already has from a patch, so a file fills the gaps and
// never changes what the team wrote. Labels are added either way.
func fillOnly(b *contactWriteBody, c domain.Contact) {
	if c.Email != nil {
		b.Email = Nullable[string]{}
	}
	if c.Name != "" {
		b.Name = nil
	}
	if c.Phone != "" {
		b.Phone = nil
	}
	if c.Notes != "" {
		b.Notes = nil
	}
	if c.ExternalID != nil {
		b.ExternalID = Nullable[string]{}
	}
	for k := range b.Fields {
		if _, ok := c.Fields[k]; ok {
			delete(b.Fields, k)
		}
	}
}

func findByEmail(ctx context.Context, tx pgx.Tx, wid uuid.UUID, email string) (*uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM contacts WHERE workspace_id = $1 AND lower(email) = lower($2)
		UNION ALL SELECT contact_id FROM contact_emails WHERE workspace_id = $1 AND lower(email) = lower($2) LIMIT 1`, wid, email).Scan(&id)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func findByExternalID(ctx context.Context, tx pgx.Tx, wid uuid.UUID, ext string) (*uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM contacts WHERE workspace_id = $1 AND external_id = $2`, wid, ext).Scan(&id)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

// setCompany points the body at the company called name, creating it when there is none.
func setCompany(ctx context.Context, tx pgx.Tx, p *auth.Principal, b *contactWriteBody, name string) error {
	name = strings.TrimSpace(name)
	if len(name) > 200 {
		return httpx.Validation("Company names can be at most 200 characters.")
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM companies WHERE workspace_id = $1 AND lower(name) = lower($2)`, p.WorkspaceID, name).Scan(&id)
	if db.IsNotFound(err) {
		id = ids.New()
		if _, err := tx.Exec(ctx, `INSERT INTO companies (id, workspace_id, name, domain, external_id, notes, custom, fields) VALUES ($1,$2,$3,'',NULL,'','{}','{}')`,
			id, p.WorkspaceID, name); err != nil {
			return companyUniqueErr(err)
		}
		co, err := loadCompany(ctx, tx, p.WorkspaceID, id)
		if err != nil {
			return err
		}
		if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "company.created", Data: map[string]any{"company": co}}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	b.CompanyID = Nullable[string]{Set: true, Value: id.String()}
	return nil
}

// fieldValue turns a cell into what a custom field of that type takes.
func fieldValue(f domain.CustomField, s string) (any, error) {
	bad := func(what string) error {
		return httpx.Validation(f.Name + " must be " + what + ".")
	}
	switch f.Type {
	case domain.FieldNumber:
		n, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
		if err != nil {
			return nil, bad("a number")
		}
		return n, nil
	case domain.FieldCheckbox:
		switch strings.ToLower(s) {
		case "true", "yes", "y", "1", "x", "checked":
			return true, nil
		case "false", "no", "n", "0", "":
			return false, nil
		}
		return nil, bad("yes or no")
	case domain.FieldSelect:
		return optionID(f, s), nil
	case domain.FieldMultiSelect:
		var out []any
		for _, part := range strings.FieldsFunc(s, func(c rune) bool { return c == ',' || c == ';' || c == '|' }) {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, optionID(f, part))
			}
		}
		return out, nil
	}
	return s, nil
}

// optionID finds a select option by its label (or id), so a file can say "Gold".
func optionID(f domain.CustomField, s string) string {
	for _, o := range f.Options {
		if strings.EqualFold(o.Label, s) || o.ID == s {
			return o.ID
		}
	}
	return s
}
