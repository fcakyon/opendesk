// Package whatsapp connects a workspace's WhatsApp Business number (Meta Cloud API) to the
// helpdesk as a customer channel (contracts/whatsapp.md). Inbound messages open tickets and
// agent replies go back out through the same graph API. The engine owns connections, sealed
// credentials, webhook verification, delivery and every ticket write; the Meta protocol
// lives in client.go and the webhook payload in types.go.
package whatsapp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/jobs"
)

const (
	// maxWebhookBody bounds one Meta delivery. A delivery holds a few messages, never media.
	maxWebhookBody = 1 << 20
	// webhookPerMinute bounds what one connection's URL takes in once verified: Meta retries
	// with backoff, so this is far above a busy number and keeps a flood out of the queue.
	webhookPerMinute = 600
	// badHooksPerMinute bounds the requests one address sends that fail verification.
	badHooksPerMinute = 30
	// eventRetention is how long an applied delivery's id is kept to recognize Meta's
	// retries (the prune job), so a replay older than that is dropped.
	eventRetention = 7 * 24 * time.Hour
	// maxTextRunes is Meta's cap on a text message body.
	maxTextRunes = 4096
	// defaultAPIVersion is the Graph API version a connection uses unless it names another.
	defaultAPIVersion = "v26.0"
)

// Service is the WhatsApp channel engine of one set of dependencies.
type Service struct {
	d    *deps.Deps
	http *http.Client
	// graphURL replaces the Graph API host in tests; empty is Meta's.
	graphURL string
}

var services sync.Map

// For returns the engine for d.
func For(d *deps.Deps) *Service {
	if got, ok := services.Load(d); ok {
		return got.(*Service)
	}
	got, _ := services.LoadOrStore(d, New(d))
	return got.(*Service)
}

// New builds an engine. Provider API clients have a 15-second timeout and do not follow
// redirects; their URLs are constants, never user input.
func New(d *deps.Deps) *Service {
	return &Service{d: d, http: &http.Client{Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// client is the Graph API client the engine calls Meta with.
func (s *Service) client() *Client {
	c := NewClient(s.http)
	c.SetBaseURL(s.graphURL)
	return c
}

// Register mounts the engine's API and its public Meta webhook.
func Register(d *deps.Deps, api huma.API, r chi.Router) { For(d).Register(api, r) }

// RegisterWorkers adds the engine's River workers.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	s := For(d)
	river.AddWorker(w, &inboundWorker{s: s})
	river.AddWorker(w, &sendWorker{s: s})
	river.AddWorker(w, &pruneWorker{s: s})
	river.AddWorker(w, &templateSyncWorker{s: s})
}

// Periodic adds the engine's periodic jobs.
func Periodic(*deps.Deps) []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(6*time.Hour),
			func() (river.JobArgs, *river.InsertOpts) { return jobs.WhatsAppPruneArgs{}, nil }, nil),
		// Templates Meta paused or rejected must stop being offered without an admin syncing.
		river.NewPeriodicJob(river.PeriodicInterval(6*time.Hour),
			func() (river.JobArgs, *river.InsertOpts) { return jobs.WhatsAppTemplateSyncArgs{}, nil }, nil),
	}
}

// Background starts nothing that outlives a request: every job is River's.
func Background(context.Context, *deps.Deps) {}

// Register mounts the WhatsApp API and the Meta webhook.
func (s *Service) Register(api huma.API, r chi.Router) {
	s.registerAPI(api, r)
	s.registerTemplateAPI(api, r)
	s.registerTicketAPI(api)
	r.Get("/v1/whatsapp/hooks/{connection}", s.verifyWebhook)
	r.Post("/v1/whatsapp/hooks/{connection}", s.webhook)
}

// Credentials is what a connection stores sealed: the Meta system-user token, the app secret
// that signs its deliveries and the verify token its webhook handshake echoes.
type Credentials struct {
	AccessToken string `json:"access_token"`
	AppSecret   string `json:"app_secret"`
	VerifyToken string `json:"verify_token"`
}

// Account is the Graph API identity a send goes out from.
type Account struct {
	PhoneNumberID string
	WABAID        string
	AccessToken   string
	APIVersion    string
}

// connection is one workspace's WhatsApp number, credentials still sealed.
type connection struct {
	ID             uuid.UUID
	WorkspaceID    uuid.UUID
	BrandID        uuid.UUID
	Name           string
	PhoneNumberID  string
	WABAID         string
	DisplayPhone   string
	VerifiedName   string
	APIVersion     string
	Status         string
	LastError      string
	LastEventAt    *time.Time
	CreatedBy      *uuid.UUID
	CreatedAt      time.Time
	UpdatedAt      time.Time
	credentialsEnc []byte
}

// ConnectionView is one connection as the settings API shows it: no credentials, ever.
type ConnectionView struct {
	ID            uuid.UUID  `json:"id"`
	WorkspaceID   uuid.UUID  `json:"workspace_id"`
	BrandID       uuid.UUID  `json:"brand_id"`
	Name          string     `json:"name"`
	PhoneNumberID string     `json:"phone_number_id"`
	WABAID        string     `json:"waba_id"`
	DisplayPhone  string     `json:"display_phone_number"`
	VerifiedName  string     `json:"verified_name"`
	APIVersion    string     `json:"api_version"`
	Status        string     `json:"status" enum:"connected,error"`
	LastError     string     `json:"last_error"`
	LastEventAt   *time.Time `json:"last_event_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	// WebhookURL is only set for admins: it is the URL Meta's app points at this connection.
	WebhookURL string `json:"webhook_url,omitempty"`
}

// view is a connection without its credentials. showWebhook adds the URL only admins may see.
func (s *Service) view(c connection, showWebhook bool) ConnectionView {
	v := ConnectionView{ID: c.ID, WorkspaceID: c.WorkspaceID, BrandID: c.BrandID, Name: c.Name,
		PhoneNumberID: c.PhoneNumberID, WABAID: c.WABAID, DisplayPhone: c.DisplayPhone,
		VerifiedName: c.VerifiedName, APIVersion: c.APIVersion, Status: c.Status,
		LastError: c.LastError, LastEventAt: c.LastEventAt, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
	if showWebhook {
		v.WebhookURL = s.webhookURL(c)
	}
	return v
}

// webhookURL is the URL Meta's app points at for this connection.
func (s *Service) webhookURL(c connection) string {
	return strings.TrimRight(s.d.Cfg.APIURL, "/") + "/v1/whatsapp/hooks/" + c.ID.String()
}

// openCredentials unseals a connection's credentials.
func (s *Service) openCredentials(c connection) (Credentials, error) {
	var creds Credentials
	if len(c.credentialsEnc) == 0 {
		return creds, httpx.E(http.StatusConflict, "whatsapp_not_configured", "This WhatsApp connection has no credentials yet.")
	}
	raw, err := s.d.Box.Open(c.credentialsEnc)
	if err != nil {
		return creds, err
	}
	if err := json.Unmarshal(raw, &creds); err != nil {
		return creds, err
	}
	return creds, nil
}

// sealCredentials encrypts a connection's credentials with d.Box.
func (s *Service) sealCredentials(creds Credentials) ([]byte, error) { return s.d.Box.SealJSON(creds) }

// account returns the Graph API identity of a connection and its credentials.
func (s *Service) account(c connection) (Account, Credentials, error) {
	creds, err := s.openCredentials(c)
	if err != nil {
		return Account{}, Credentials{}, err
	}
	version := c.APIVersion
	if version == "" {
		version = defaultAPIVersion
	}
	return Account{PhoneNumberID: c.PhoneNumberID, WABAID: c.WABAID, AccessToken: creds.AccessToken, APIVersion: version}, creds, nil
}

// requireAdminUser admits a workspace admin signed in as a person: connecting a number hands
// customer messages to Meta, so an API key never does it (as the phone and support channels do).
func requireAdminUser(ctx context.Context) (*auth.Principal, error) {
	p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if p.Kind != auth.KindUser {
		return nil, httpx.Forbidden()
	}
	return p, nil
}

// pruneWorker removes applied deliveries past eventRetention.
type pruneWorker struct {
	river.WorkerDefaults[jobs.WhatsAppPruneArgs]
	s *Service
}

func (w *pruneWorker) Work(ctx context.Context, _ *river.Job[jobs.WhatsAppPruneArgs]) error {
	return pruneEvents(ctx, w.s.d.DB.Pool)
}
