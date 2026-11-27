package images

import (
	"context"
	"errors"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// NewFetcher builds the fetcher for an instance.
func NewFetcher(d *deps.Deps) *Fetcher {
	f := &Fetcher{Dev: !d.Cfg.IsProduction()}
	if tok := d.Cfg.LogoDevToken; tok != "" {
		f.LogoURL = func(domain string) string {
			return "https://img.logo.dev/" + url.PathEscape(domain) + "?token=" + url.QueryEscape(tok) + "&size=256&format=png&fallback=404"
		}
	}
	return f
}

// Enqueue queues a picture lookup in tx (deduplicated while one is pending).
func Enqueue(ctx context.Context, tx pgx.Tx, jc domain.Jobs, a jobs.AvatarFetchArgs) error {
	if jc == nil {
		return nil
	}
	_, err := jc.InsertTx(ctx, tx, a, &river.InsertOpts{MaxAttempts: 3,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByPeriod: time.Minute}})
	return err
}

// FetchWorker runs images.fetch_avatar jobs.
type FetchWorker struct {
	river.WorkerDefaults[jobs.AvatarFetchArgs]
	D *deps.Deps
	F *Fetcher
}

func (w *FetchWorker) Timeout(*river.Job[jobs.AvatarFetchArgs]) time.Duration { return time.Minute }

func (w *FetchWorker) Work(ctx context.Context, job *river.Job[jobs.AvatarFetchArgs]) error {
	err := Fetch(ctx, w.D, w.F, job.Args)
	if errors.Is(err, ErrOwnerGone) {
		return nil
	}
	return err
}

// Fetch runs one lookup.
func Fetch(ctx context.Context, d *deps.Deps, f *Fetcher, a jobs.AvatarFetchArgs) error {
	switch a.Owner {
	case OwnerUser:
		return fetchUser(ctx, d, f, a)
	case OwnerContact:
		return fetchContact(ctx, d, f, a)
	case OwnerCompany:
		return fetchCompany(ctx, d, f, a)
	}
	return nil
}

func fetchUser(ctx context.Context, d *deps.Deps, f *Fetcher, a jobs.AvatarFetchArgs) error {
	var src *string
	var remote, val string
	if err := d.DB.Pool.QueryRow(ctx, `SELECT avatar_source, avatar_remote_url, avatar_url FROM users WHERE id = $1`, a.ID).
		Scan(&src, &remote, &val); err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	source := a.Source
	if source == "" {
		source = "oauth"
	}
	// A manual picture is never replaced by the provider's.
	if source == "oauth" && src != nil && *src == "upload" && val != "" {
		return nil
	}
	u := a.URL
	if u == "" {
		u = remote
	}
	if u == "" || u != remote {
		return nil // superseded by a newer picture
	}
	p, err := f.Image(ctx, u, Cover)
	if err != nil {
		if IsMiss(err) || !retryable(err) {
			_, _ = d.DB.Pool.Exec(ctx, `UPDATE users SET avatar_remote_url = '' WHERE id = $1 AND avatar_remote_url = $2 AND avatar_url = ''`, a.ID, u)
			d.Log.Info("user picture not usable", "user_id", a.ID, "err", err)
			return nil
		}
		return err
	}
	return Set(ctx, d, Owner{Type: OwnerUser, ID: a.ID}, p, source, SetOptions{
		Before: func(ctx context.Context, tx pgx.Tx, _ domain.Avatar, cur *string) error {
			if source == "oauth" && cur != nil && *cur == "upload" {
				return errSkip
			}
			return nil
		}})
}

var errSkip = errors.New("images: skipped")

// retryable reports a transient failure worth a River retry (timeouts, resets).
func retryable(err error) bool {
	var ne interface{ Timeout() bool }
	return errors.As(err, &ne) && ne.Timeout()
}

func miss(ctx context.Context, d *deps.Deps, table string, wid, id uuid.UUID, clearSource string) error {
	return d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var failures int
		var src *string
		if err := tx.QueryRow(ctx, `UPDATE `+table+` SET avatar_failures = avatar_failures + 1, avatar_checked_at = now()
			WHERE workspace_id = $1 AND id = $2 RETURNING avatar_failures, avatar_source`, wid, id).Scan(&failures, &src); err != nil {
			if db.IsNotFound(err) {
				return nil
			}
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE `+table+` SET avatar_retry_at = $3 WHERE workspace_id = $1 AND id = $2`,
			wid, id, time.Now().Add(Backoff(failures))); err != nil {
			return err
		}
		// The source no longer has the picture: drop the copy.
		if clearSource != "" && src != nil && *src == clearSource {
			o := Owner{Type: OwnerContact, ID: id, WorkspaceID: &wid}
			if table == "companies" {
				o.Type = OwnerCompany
			}
			prefix, err := ClearTx(ctx, tx, o, false, SetOptions{})
			if err != nil {
				return err
			}
			if prefix != "" {
				defer Discard(d.Storage, prefix)
			}
			_, err = tx.Exec(ctx, `UPDATE `+table+` SET avatar_retry_at = $3 WHERE workspace_id = $1 AND id = $2`,
				wid, id, time.Now().Add(Backoff(failures)))
			return err
		}
		return nil
	})
}

// idle marks a record as having no source to look up until something changes.
func idle(ctx context.Context, d *deps.Deps, table string, wid, id uuid.UUID) error {
	_, err := d.DB.Pool.Exec(ctx, `UPDATE `+table+` SET avatar_retry_at = NULL, avatar_checked_at = now()
		WHERE workspace_id = $1 AND id = $2`, wid, id)
	return err
}

func workspaceFlag(ctx context.Context, q db.Querier, wid uuid.UUID, key string, def bool) (bool, error) {
	var v *bool
	err := q.QueryRow(ctx, `SELECT (settings ->> $2)::boolean FROM workspaces WHERE id = $1`, wid, key).Scan(&v)
	if err != nil {
		return def, err
	}
	if v == nil {
		return def, nil
	}
	return *v, nil
}

// GravatarEnabled reports settings.gravatar (default off).
func GravatarEnabled(ctx context.Context, q db.Querier, wid uuid.UUID) (bool, error) {
	return workspaceFlag(ctx, q, wid, "gravatar", false)
}

// DomainLogosEnabled reports settings.domain_logos (default on).
func DomainLogosEnabled(ctx context.Context, q db.Querier, wid uuid.UUID) (bool, error) {
	return workspaceFlag(ctx, q, wid, "domain_logos", true)
}

func fetchContact(ctx context.Context, d *deps.Deps, f *Fetcher, a jobs.AvatarFetchArgs) error {
	wid := a.WorkspaceID
	var email *string
	var src *string
	var remote, val string
	var checked *time.Time
	if err := d.DB.Pool.QueryRow(ctx, `SELECT email, avatar_source, avatar_remote_url, avatar_url, avatar_checked_at FROM contacts
		WHERE workspace_id = $1 AND id = $2`, wid, a.ID).Scan(&email, &src, &remote, &val, &checked); err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	cur := ""
	if src != nil {
		cur = *src
	}
	o := Owner{Type: OwnerContact, ID: a.ID, WorkspaceID: &wid}
	// A picture copied from a URL: the manual one (upload) or the widget's.
	if remote != "" && (cur == "upload" || cur == "widget") {
		// An upload is copied once (avatar_checked_at is cleared when its URL changes).
		if cur == "upload" && val != "" && checked != nil {
			return idle(ctx, d, "contacts", wid, a.ID)
		}
		p, err := f.Image(ctx, remote, Cover)
		if err != nil {
			if retryable(err) {
				return err
			}
			d.Log.Info("contact picture not usable", "contact_id", a.ID, "err", err)
			if cur == "upload" {
				_, _ = d.DB.Pool.Exec(ctx, `UPDATE contacts SET avatar_remote_url = '', avatar_source = NULL
					WHERE workspace_id = $1 AND id = $2 AND avatar_remote_url = $3 AND avatar_url = ''`, wid, a.ID, remote)
				return idle(ctx, d, "contacts", wid, a.ID)
			}
			return miss(ctx, d, "contacts", wid, a.ID, "widget")
		}
		return ignoreSkip(Set(ctx, d, o, p, cur, SetOptions{Before: unchanged(remote, "contacts", wid, a.ID)}))
	}
	if cur == "upload" {
		return idle(ctx, d, "contacts", wid, a.ID)
	}
	on, err := GravatarEnabled(ctx, d.DB.Pool, wid)
	if err != nil {
		return err
	}
	if !on || email == nil || *email == "" {
		if cur == "gravatar" {
			if err := Clear(ctx, d, o, false, SetOptions{}); err != nil {
				return err
			}
		}
		return idle(ctx, d, "contacts", wid, a.ID)
	}
	p, err := f.Gravatar(ctx, *email)
	if err != nil {
		if retryable(err) {
			return err
		}
		return miss(ctx, d, "contacts", wid, a.ID, "gravatar")
	}
	return ignoreSkip(Set(ctx, d, o, p, "gravatar", SetOptions{Before: func(ctx context.Context, tx pgx.Tx, _ domain.Avatar, s *string) error {
		if s != nil && (*s == "upload" || *s == "widget") {
			return errSkip // a better picture arrived meanwhile
		}
		return nil
	}}))
}

// unchanged refuses the write when the record's source URL changed meanwhile.
func unchanged(remote, table string, wid, id uuid.UUID) func(context.Context, pgx.Tx, domain.Avatar, *string) error {
	return func(ctx context.Context, tx pgx.Tx, _ domain.Avatar, _ *string) error {
		var now string
		if err := tx.QueryRow(ctx, `SELECT avatar_remote_url FROM `+table+` WHERE workspace_id = $1 AND id = $2`, wid, id).Scan(&now); err != nil {
			return err
		}
		if now != remote {
			return errSkip
		}
		return nil
	}
}

func ignoreSkip(err error) error {
	if errors.Is(err, errSkip) {
		return nil
	}
	return err
}

func fetchCompany(ctx context.Context, d *deps.Deps, f *Fetcher, a jobs.AvatarFetchArgs) error {
	wid := a.WorkspaceID
	var dom string
	var src *string
	if err := d.DB.Pool.QueryRow(ctx, `SELECT domain, avatar_source FROM companies WHERE workspace_id = $1 AND id = $2`, wid, a.ID).
		Scan(&dom, &src); err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	o := Owner{Type: OwnerCompany, ID: a.ID, WorkspaceID: &wid}
	if src != nil && *src == "upload" {
		return idle(ctx, d, "companies", wid, a.ID)
	}
	on, err := DomainLogosEnabled(ctx, d.DB.Pool, wid)
	if err != nil {
		return err
	}
	if !on || !ValidDomain(dom) {
		if src != nil && *src == "domain" {
			if err := Clear(ctx, d, o, false, SetOptions{}); err != nil {
				return err
			}
		}
		return idle(ctx, d, "companies", wid, a.ID)
	}
	p, err := f.DomainLogo(ctx, dom)
	if err != nil {
		if retryable(err) {
			return err
		}
		return miss(ctx, d, "companies", wid, a.ID, "domain")
	}
	return ignoreSkip(Set(ctx, d, o, p, "domain", SetOptions{Before: func(ctx context.Context, tx pgx.Tx, _ domain.Avatar, s *string) error {
		var now string
		if err := tx.QueryRow(ctx, `SELECT domain FROM companies WHERE workspace_id = $1 AND id = $2`, wid, a.ID).Scan(&now); err != nil {
			return err
		}
		if (s != nil && *s == "upload") || now != dom {
			return errSkip
		}
		return nil
	}}))
}

// SweepWorker runs images.sweep: it queues due lookups and removes images nothing
// references any more.
type SweepWorker struct {
	river.WorkerDefaults[jobs.AvatarSweepArgs]
	D *deps.Deps
}

// SweepBatch bounds the lookups queued per run and table.
const SweepBatch = 200

func (w *SweepWorker) Work(ctx context.Context, _ *river.Job[jobs.AvatarSweepArgs]) error {
	if err := Sweep(ctx, w.D); err != nil {
		return err
	}
	return Collect(ctx, w.D)
}

// Sweep queues the contacts and companies whose next lookup is due, and users whose
// provider picture was not copied yet. A due row is leased for an hour.
func Sweep(ctx context.Context, d *deps.Deps) error {
	return d.DB.Tx(ctx, func(tx pgx.Tx) error {
		for _, t := range []struct{ table, owner string }{{"contacts", OwnerContact}, {"companies", OwnerCompany}} {
			rows, err := tx.Query(ctx, `UPDATE `+t.table+` SET avatar_retry_at = now() + interval '1 hour'
				WHERE id IN (SELECT id FROM `+t.table+` WHERE avatar_retry_at <= now() ORDER BY avatar_retry_at LIMIT $1 FOR UPDATE SKIP LOCKED)
				RETURNING workspace_id, id`, SweepBatch)
			if err != nil {
				return err
			}
			type due struct{ wid, id uuid.UUID }
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (due, error) {
				var x due
				return x, r.Scan(&x.wid, &x.id)
			})
			if err != nil {
				return err
			}
			for _, x := range list {
				if err := Enqueue(ctx, tx, d.Jobs, jobs.AvatarFetchArgs{Owner: t.owner, ID: x.id, WorkspaceID: x.wid}); err != nil {
					return err
				}
			}
		}
		rows, err := tx.Query(ctx, `SELECT id, avatar_remote_url, COALESCE(avatar_source, 'oauth') FROM users
			WHERE avatar_url = '' AND avatar_remote_url <> '' LIMIT $1`, SweepBatch)
		if err != nil {
			return err
		}
		type u struct {
			id       uuid.UUID
			url, src string
		}
		users, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (u, error) {
			var x u
			return x, r.Scan(&x.id, &x.url, &x.src)
		})
		if err != nil {
			return err
		}
		for _, x := range users {
			if err := Enqueue(ctx, tx, d.Jobs, jobs.AvatarFetchArgs{Owner: OwnerUser, ID: x.id, URL: x.url, Source: x.src}); err != nil {
				return err
			}
		}
		return nil
	})
}

// Collect deletes images older than an hour that their owner no longer shows, and the
// signature pictures it no longer keeps (signature.go).
func Collect(ctx context.Context, d *deps.Deps) error {
	if err := claimSignatures(ctx, d); err != nil {
		return err
	}
	rows, err := d.DB.Pool.Query(ctx, `DELETE FROM images i WHERE i.id IN (
		SELECT i2.id FROM images i2 WHERE i2.created_at < now() - interval '1 hour' AND NOT CASE i2.owner_type
			WHEN 'user' THEN CASE WHEN i2.slot = '`+SlotSignature+`' THEN `+keptSignature("i2")+`
				ELSE EXISTS (SELECT 1 FROM users u WHERE u.id = i2.owner_id AND u.avatar_url = 'img:' || i2.id) END
			WHEN 'contact' THEN EXISTS (SELECT 1 FROM contacts c WHERE c.id = i2.owner_id AND c.avatar_url = 'img:' || i2.id)
			WHEN 'company' THEN EXISTS (SELECT 1 FROM companies c WHERE c.id = i2.owner_id AND c.avatar_url = 'img:' || i2.id)
			WHEN 'brand' THEN EXISTS (SELECT 1 FROM brands b WHERE b.id = i2.owner_id AND b.images ->> i2.slot = 'img:' || i2.id)
			WHEN 'widget' THEN EXISTS (SELECT 1 FROM widgets g WHERE g.id = i2.owner_id AND g.images ->> i2.slot = 'img:' || i2.id)
			WHEN 'bot' THEN EXISTS (SELECT 1 FROM bots b WHERE b.id = i2.owner_id AND b.avatar = 'img:' || i2.id)
			WHEN 'integration' THEN EXISTS (SELECT 1 FROM integrations x WHERE x.id = i2.owner_id AND x.icon = 'img:' || i2.id)
			ELSE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = i2.owner_id AND (w.avatar_url = 'img:' || i2.id
				OR w.brand_images ->> i2.slot = 'img:' || i2.id))
		END ORDER BY i2.created_at LIMIT 500) RETURNING storage_key`)
	if err != nil {
		return err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, k := range keys {
		Discard(d.Storage, k)
	}
	return nil
}

// RegisterWorkers adds the picture workers.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	river.AddWorker(w, &FetchWorker{D: d, F: NewFetcher(d)})
	river.AddWorker(w, &SweepWorker{D: d})
}

// Periodic sweeps every 5 minutes.
func Periodic() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(5*time.Minute),
		func() (river.JobArgs, *river.InsertOpts) { return jobs.AvatarSweepArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true})}
}
