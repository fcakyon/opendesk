// Package brands is what customers see (contracts/teams.md): a workspace's brands, each
// with a help center and any number of chat widgets. Every workspace has exactly one
// default brand, created with the workspace and kept in step with its settings.
package brands

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/ai/bots"
	"github.com/useopendesk/opendesk/internal/config"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/images"
)

// Limits per workspace (contracts/teams.md "Limits").
const (
	MaxBrands          = 50
	MaxWidgetsPerBrand = 50
	maxNameRunes       = 60
	maxTitleRunes      = 100
)

// BrandHelpCenter is a brand's public help center (contracts/teams.md "Help center addresses").
type BrandHelpCenter struct {
	Enabled    bool        `json:"enabled"`
	Title      string      `json:"title"`
	URL        string      `json:"url" doc:"Where the help center is: the active custom domain, else default_url"`
	DefaultURL string      `json:"default_url" doc:"https://<slug>.<HELP_DOMAIN>, or <base>/help/<slug> without HELP_DOMAIN (APP_URL when the binary serves the web app, else API_URL)"`
	Domain     *HelpDomain `json:"domain" doc:"The help center's custom domain"`
}

// BrandImages are a brand's pictures (brands.images).
type BrandImages struct {
	Logo              domain.Avatar `json:"logo"`
	HelpCenterLogo    domain.Avatar `json:"help_center_logo"`
	HelpCenterFavicon domain.Avatar `json:"help_center_favicon"`
}

// PortalAuth is the non-sensitive authentication mode visible on a brand.
type PortalAuth struct {
	Mode string `json:"mode"`
}

// Brand is Brand from contracts/teams.md.
type Brand struct {
	PortalAuth       PortalAuth      `json:"portal_auth"`
	ID               uuid.UUID       `json:"id"`
	Name             string          `json:"name"`
	Slug             string          `json:"slug" doc:"Help center path, 3..40 of a-z, 0-9 and -"`
	IsDefault        bool            `json:"is_default"`
	Color            string          `json:"color" doc:"#rrggbb, or empty for the workspace brand_color"`
	Locale           string          `json:"locale" doc:"BCP 47, or empty for the workspace locale"`
	HelpCenter       BrandHelpCenter `json:"help_center"`
	Images           BrandImages     `json:"images"`
	DefaultMailboxID *uuid.UUID      `json:"default_mailbox_id" doc:"The brand's oldest active address"`
	MailboxCount     int             `json:"mailbox_count"`
	WidgetCount      int             `json:"widget_count"`
	Position         int             `json:"position"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

const brandSelect = `SELECT b.id, b.name, b.slug, b.is_default, b.color, b.locale, b.help_center_enabled, b.help_center_title, b.images,
	(SELECT m.id FROM mailboxes m WHERE m.workspace_id = b.workspace_id AND m.brand_id = b.id AND m.status <> 'disabled'
		ORDER BY (m.status = 'active') DESC, m.created_at, m.id LIMIT 1),
	(SELECT count(*) FROM mailboxes m WHERE m.workspace_id = b.workspace_id AND m.brand_id = b.id),
	(SELECT count(*) FROM widgets g WHERE g.workspace_id = b.workspace_id AND g.brand_id = b.id),
	b.position, b.created_at, b.updated_at, b.portal_auth_mode,
	hd.hostname, hd.token, hd.status, hd.problem, hd.txt_ok, hd.cname_ok, hd.checked_at, hd.verified_at, hd.created_at
FROM brands b LEFT JOIN help_domains hd ON hd.brand_id = b.id`

func scan(row pgx.Row, cfg *config.Config) (Brand, error) {
	var b Brand
	var imgs map[string]string
	var dom domainRow
	err := row.Scan(&b.ID, &b.Name, &b.Slug, &b.IsDefault, &b.Color, &b.Locale, &b.HelpCenter.Enabled, &b.HelpCenter.Title, &imgs,
		&b.DefaultMailboxID, &b.MailboxCount, &b.WidgetCount, &b.Position, &b.CreatedAt, &b.UpdatedAt, &b.PortalAuth.Mode,
		&dom.hostname, &dom.token, &dom.status, &dom.problem, &dom.txtOK, &dom.cnameOK, &dom.checkedAt, &dom.verifiedAt, &dom.createdAt)
	if err != nil {
		return b, err
	}
	b.HelpCenter.Domain = dom.domain(cfg)
	b.HelpCenter.DefaultURL = cfg.HelpCenterURL(b.Slug)
	b.HelpCenter.URL = HelpCenterURL(cfg, b.Slug, b.HelpCenter.Domain.activeHost())
	b.Images = BrandImages{Logo: domain.Avatar(imgs["logo"]), HelpCenterLogo: domain.Avatar(imgs["help_center_logo"]),
		HelpCenterFavicon: domain.Avatar(imgs["help_center_favicon"])}
	return b, nil
}

// HelpCenterURL is where the help center of a brand slug is: https://<activeHost> when
// the brand has an active custom domain, else its default address.
func HelpCenterURL(cfg *config.Config, slug, activeHost string) string {
	if activeHost != "" {
		return "https://" + activeHost
	}
	return cfg.HelpCenterURL(slug)
}

// ActiveHostSQL selects the active custom domain of the brand whose id is the SQL
// expression brandID, or NULL.
func ActiveHostSQL(brandID string) string {
	return `(SELECT hdx.hostname FROM help_domains hdx WHERE hdx.brand_id = ` + brandID + ` AND hdx.status = 'active')`
}

// Load returns a brand of the workspace.
func Load(ctx context.Context, q db.Querier, cfg *config.Config, wid, id uuid.UUID) (Brand, error) {
	return scan(q.QueryRow(ctx, brandSelect+` WHERE b.workspace_id = $1 AND b.id = $2`, wid, id), cfg)
}

// List returns the workspace's brands, default first, then by position.
func List(ctx context.Context, q db.Querier, cfg *config.Config, wid uuid.UUID) ([]Brand, error) {
	rows, err := q.Query(ctx, brandSelect+` WHERE b.workspace_id = $1 ORDER BY b.is_default DESC, b.position, b.name, b.id`, wid)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Brand, error) { return scan(r, cfg) })
	if out == nil {
		out = []Brand{}
	}
	return out, err
}

// DefaultID returns the workspace's default brand.
func DefaultID(ctx context.Context, q db.Querier, wid uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM brands WHERE workspace_id = $1 AND is_default`, wid).Scan(&id)
	return id, err
}

// PrimaryWidgetSQL selects the default brand's first widget of workspace $1: the widget
// /v1/widget/settings and Workspace.widget_key stand for.
const PrimaryWidgetSQL = `SELECT g.id FROM widgets g JOIN brands b ON b.id = g.brand_id AND b.is_default
	WHERE g.workspace_id = $1 ORDER BY g.position, g.created_at, g.id LIMIT 1`

// PrimaryWidgetID returns the default brand's first widget, or pgx.ErrNoRows.
func PrimaryWidgetID(ctx context.Context, q db.Querier, wid uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, PrimaryWidgetSQL, wid).Scan(&id)
	return id, err
}

// PrimaryWidget returns the default brand's first widget, uuid.Nil when it has none. Read
// it before a write that may change it and hand it to MirrorPrimaryWidget.
func PrimaryWidget(ctx context.Context, q db.Querier, wid uuid.UUID) (uuid.UUID, error) {
	id, err := PrimaryWidgetID(ctx, q, wid)
	if db.IsNotFound(err) {
		return uuid.Nil, nil
	}
	return id, err
}

// MirrorPrimaryWidget copies the default brand's first widget's settings to
// workspaces.settings.widget, where workspace-wide readers (the AI agent's name) find them.
// When that widget is no longer before (PrimaryWidget read before the write), the
// workspace's widget_key changed: it publishes workspace.updated.
func MirrorPrimaryWidget(ctx context.Context, tx pgx.Tx, wid, before uuid.UUID) error {
	if err := mirrorPrimaryWidget(ctx, tx, wid); err != nil {
		return err
	}
	after, err := PrimaryWidget(ctx, tx, wid)
	if err != nil || after == before {
		return err
	}
	return PublishWorkspace(ctx, tx, wid)
}

func mirrorPrimaryWidget(ctx context.Context, tx pgx.Tx, wid uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE workspaces SET settings = jsonb_set(settings, '{widget}',
		COALESCE((SELECT g.settings FROM widgets g WHERE g.id = (`+PrimaryWidgetSQL+`)), settings -> 'widget', '{}'::jsonb), true)
		WHERE id = $1`, wid)
	return err
}

// PublishWorkspace publishes workspace.updated: its widget key, help center settings and
// pictures read the default brand and its first widget. The workspace hook is core's.
func PublishWorkspace(ctx context.Context, tx pgx.Tx, wid uuid.UUID) error {
	return images.Changed(ctx, tx, images.Owner{Type: images.OwnerWorkspace, ID: wid, WorkspaceID: &wid})
}

// Check confirms a referenced brand belongs to the workspace (422 otherwise).
func Check(ctx context.Context, q db.Querier, wid, id uuid.UUID) error {
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM brands WHERE workspace_id = $1 AND id = $2)`, wid, id).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return httpx.Validation("brand not found in this workspace")
	}
	return nil
}

// Publish sends brand.created or brand.updated with the brand.
func Publish(ctx context.Context, tx pgx.Tx, cfg *config.Config, wid, id uuid.UUID, typ string) error {
	b, err := Load(ctx, tx, cfg, wid, id)
	if err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: typ, Data: map[string]any{"brand": b}})
	return err
}

// Widget keys and secrets.

// NewWidgetKey returns a public widget key.
func NewWidgetKey() string { return "wk_" + crypto.RandomString(24) }

// Sealer encrypts a secret at rest (deps.Deps.Box).
type Sealer interface {
	Seal(plain []byte) ([]byte, error)
}

// NewWidgetSecret returns a widget's identity secret and its sealed form. The widget
// verifies user_hash = hex(HMAC-SHA256(secret, user_id)) with the plaintext as key.
func NewWidgetSecret(box Sealer) (string, []byte, error) {
	secret := "wsec_" + crypto.RandomToken(32)
	sealed, err := box.Seal([]byte(secret))
	return secret, sealed, err
}

// Defaults are a new workspace's default brand and widget.
type Defaults struct {
	BrandID   uuid.UUID
	WidgetID  uuid.UUID
	WidgetKey string
}

// CreateDefaults creates a new workspace's default brand (its slug is the workspace slug,
// so the help center's address names the workspace) and its first widget, "Website",
// with widgetKey and a fresh identity secret.
func CreateDefaults(ctx context.Context, tx pgx.Tx, box Sealer, wid uuid.UUID, name, slug, helpCenterTitle, widgetKey string) (Defaults, error) {
	d := Defaults{BrandID: ids.New(), WidgetID: ids.New(), WidgetKey: widgetKey}
	if d.WidgetKey == "" {
		d.WidgetKey = NewWidgetKey()
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		name = strings.TrimSpace(string([]rune(name)[:maxNameRunes]))
	}
	if _, err := tx.Exec(ctx, `INSERT INTO brands (id, workspace_id, name, slug, is_default, help_center_enabled, help_center_title)
		VALUES ($1, $2, $3, $4, true, true, $5)`, d.BrandID, wid, name, slug, helpCenterTitle); err != nil {
		return d, fmt.Errorf("create default brand: %w", err)
	}
	_, sealed, err := NewWidgetSecret(box)
	if err != nil {
		return d, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO widgets (id, workspace_id, brand_id, name, key, secret_enc) VALUES ($1, $2, $3, 'Website', $4, $5)`,
		d.WidgetID, wid, d.BrandID, d.WidgetKey, sealed); err != nil {
		return d, fmt.Errorf("create default widget: %w", err)
	}
	// Every workspace answers as a default bot (contracts/bots.md).
	if err := bots.EnsureDefault(ctx, tx, wid); err != nil {
		return d, fmt.Errorf("create default bot: %w", err)
	}
	return d, nil
}

// SyncDefault applies workspace settings that the default brand mirrors (brand_color,
// locale, help_center_enabled, help_center_title) and publishes brand.updated. Keys not in
// patch are left alone.
func SyncDefault(ctx context.Context, tx pgx.Tx, cfg *config.Config, wid uuid.UUID, patch map[string]any) error {
	var color, locale, title *string
	var enabled *bool
	if v, ok := patch["brand_color"].(string); ok {
		v = strings.ToLower(v)
		color = &v
	}
	if v, ok := patch["locale"].(string); ok {
		locale = &v
	}
	if v, ok := patch["help_center_title"].(string); ok {
		title = &v
	}
	if v, ok := patch["help_center_enabled"].(bool); ok {
		enabled = &v
	}
	if color == nil && locale == nil && title == nil && enabled == nil {
		return nil
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `UPDATE brands SET color = COALESCE($2, color), locale = COALESCE($3, locale),
		help_center_title = COALESCE($4, help_center_title), help_center_enabled = COALESCE($5, help_center_enabled), updated_at = now()
		WHERE workspace_id = $1 AND is_default RETURNING id`, wid, color, locale, title, enabled).Scan(&id)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return Publish(ctx, tx, cfg, wid, id, "brand.updated")
}

// SlugTaken reports whether a help center slug is used by any brand.
func SlugTaken(ctx context.Context, q db.Querier, slug string, except *uuid.UUID) (bool, error) {
	var taken bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM brands WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2))`, slug, except).Scan(&taken)
	return taken, err
}

// Validation.

var (
	slugRe     = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	slugStrip  = regexp.MustCompile(`[^a-z0-9]+`)
	hexColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	localeRe   = regexp.MustCompile(`^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$`)
)

// reservedSlugs are help center paths a brand may not take: words that read as the
// product's own pages or could be mistaken for them.
var reservedSlugs = []string{"about", "account", "admin", "administrator", "api", "app", "apps", "articles", "assets",
	"auth", "billing", "blog", "cdn", "collections", "config", "dashboard", "docs", "download", "email", "help",
	"helpdesk", "home", "inbox", "index", "login", "logout", "mail", "new", "null", "oauth", "opendesk", "public",
	"register", "root", "search", "security", "settings", "signin", "signup", "socket", "static", "status",
	"system", "undefined", "widget", "www"}

// CleanSlug checks a chosen help center slug: 3..40 of a-z, 0-9 and single dashes, not reserved.
func CleanSlug(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) < 3 || len(s) > 40 || !slugRe.MatchString(s) {
		return "", httpx.Validation("slug must be 3 to 40 lowercase letters, digits and single dashes")
	}
	if slices.Contains(reservedSlugs, s) {
		return "", httpx.E(422, "slug_reserved", "That address is reserved. Pick another one.")
	}
	return s, nil
}

// ErrSlugTaken answers a slug another brand uses.
var ErrSlugTaken = httpx.E(409, "slug_taken", "That help center address is taken. Pick another one.")

// slugFrom derives a slug from a name: ASCII letters and digits, dash separated, 3..40.
func slugFrom(name string) string {
	s := strings.ToLower(name)
	var b strings.Builder
	for _, r := range s {
		if r < 128 {
			b.WriteRune(r)
		}
	}
	out := strings.Trim(slugStrip.ReplaceAllString(b.String(), "-"), "-")
	if len(out) > 33 {
		out = strings.Trim(out[:33], "-")
	}
	if len(out) < 3 || slices.Contains(reservedSlugs, out) {
		out = strings.Trim(out+"-help", "-")
	}
	if len(out) < 3 {
		out = "help-" + strings.ToLower(crypto.RandomString(6))
	}
	return out
}

// pickSlug returns the requested slug (409 slug_taken when used), or one derived from name.
func pickSlug(ctx context.Context, q db.Querier, requested *string, name string, except *uuid.UUID) (string, error) {
	if requested != nil && strings.TrimSpace(*requested) != "" {
		slug, err := CleanSlug(*requested)
		if err != nil {
			return "", err
		}
		taken, err := SlugTaken(ctx, q, slug, except)
		if err != nil {
			return "", err
		}
		if taken {
			return "", ErrSlugTaken
		}
		return slug, nil
	}
	base := slugFrom(name)
	slug := base
	for i := 0; i < 10; i++ {
		taken, err := SlugTaken(ctx, q, slug, except)
		if err != nil {
			return "", err
		}
		if !taken {
			return slug, nil
		}
		slug = base + "-" + strings.ToLower(crypto.RandomString(4))
	}
	return "", ErrSlugTaken
}

// cleanBrandName passes a brand name through displayname: 1..60 characters.
func cleanBrandName(s string) (string, error) {
	n, err := displayname.Validate("Brand name", s, displayname.Workspace, false)
	if err != nil {
		return "", err
	}
	if utf8.RuneCountInString(n) > maxNameRunes {
		return "", httpx.Validation(fmt.Sprintf("Brand name must be %d characters or less.", maxNameRunes))
	}
	return n, nil
}

func cleanColor(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s != "" && !hexColorRe.MatchString(s) {
		return "", httpx.Validation("color must be a hex colour like #1a2b3c")
	}
	return strings.ToLower(s), nil
}

func cleanLocale(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s != "" && !localeRe.MatchString(s) {
		return "", httpx.Validation("locale must be a language tag like en or pt-BR")
	}
	return s, nil
}

func cleanTitle(s string) (string, error) {
	t := displayname.Normalize(s)
	if utf8.RuneCountInString(t) > maxTitleRunes || strings.ContainsAny(t, "<>`") || strings.IndexFunc(t, unicode.IsControl) >= 0 {
		return "", httpx.Validation("help_center.title must be 100 characters or less, without markup")
	}
	return t, nil
}
