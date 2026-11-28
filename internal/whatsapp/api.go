package whatsapp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Bounds on a pasted credential: Meta documents no limit, these keep a pasted blob from
// being sealed, sent to Meta or logged.
const (
	maxMetaIDLength        = 64
	maxMetaTokenLength     = 1000
	maxAPIVersionLength    = 32
	maxVerifyTokenLength   = 200
	maxRefusalDetailRunes  = 300
	whatsappConnectionType = "whatsapp_connection"
)

// Meta's ids are numbers and a Graph API version is vN.N; all three go into Graph URL paths.
var (
	metaIDPattern     = regexp.MustCompile(`^[0-9]+$`)
	apiVersionPattern = regexp.MustCompile(`^v[0-9]{1,3}\.[0-9]{1,3}$`)
)

// credentialsInput is the credentials an admin pastes to connect a number. verify_token and
// api_version are filled in when empty.
type credentialsInput struct {
	PhoneNumberID string `json:"phone_number_id" maxLength:"64" doc:"The number's Meta phone number ID"`
	WABAID        string `json:"waba_id" maxLength:"64" doc:"The WhatsApp Business account ID"`
	AccessToken   string `json:"access_token" maxLength:"1000" doc:"The Meta system-user access token"`
	AppSecret     string `json:"app_secret" maxLength:"200" doc:"The Meta app secret that signs deliveries"`
	VerifyToken   string `json:"verify_token,omitempty" maxLength:"200" doc:"The token the webhook handshake echoes; one is generated when empty"`
	APIVersion    string `json:"api_version,omitempty" maxLength:"32" doc:"The Graph API version; the default one when empty"`
}

// connectionSetup is a credentials input checked and filled in: what the connection is and
// what it stores sealed.
type connectionSetup struct {
	PhoneNumberID string
	WABAID        string
	APIVersion    string
	Credentials   Credentials
}

// createConnectionBody is the body of a new connection.
type createConnectionBody struct {
	Name        string           `json:"name,omitempty" maxLength:"80" doc:"The connection's name in settings; the number's verified name when empty"`
	BrandID     string           `json:"brand_id,omitempty" doc:"The brand the connection's tickets belong to; the workspace's default brand when empty"`
	Credentials credentialsInput `json:"credentials"`
}

// updateConnectionBody changes a connection. Empty fields stay as they are.
type updateConnectionBody struct {
	Name        *string           `json:"name,omitempty" maxLength:"80" doc:"The connection's name in settings"`
	Credentials *credentialsInput `json:"credentials,omitempty" doc:"Replacement credentials for the same phone number; they are checked with Meta before they are stored"`
}

// connectionList is the settings list: connections, never credentials.
type connectionList struct {
	Data []ConnectionView `json:"data"`
}

// registerAPI mounts the WhatsApp settings API: connections, their health, and the Meta app
// callback each connection receives its deliveries on.
func (s *Service) registerAPI(api huma.API, _ chi.Router) {
	tags := []string{"WhatsApp"}

	huma.Register(api, huma.Operation{OperationID: "list-whatsapp-connections", Method: http.MethodGet,
		Path: "/v1/whatsapp/connections", Tags: tags, Summary: "List WhatsApp connections"},
		func(ctx context.Context, _ *struct{}) (*struct{ Body connectionList }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeSettingsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := listConnections(ctx, s.d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct{ Body connectionList }{connectionList{Data: []ConnectionView{}}}
			showWebhook := p.Role.AtLeast(auth.RoleAdmin)
			for _, c := range list {
				out.Body.Data = append(out.Body.Data, s.view(c, showWebhook))
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-whatsapp-connection", Method: http.MethodPost,
		Path: "/v1/whatsapp/connections", Tags: tags, Summary: "Connect a WhatsApp number", DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body createConnectionBody }) (*struct{ Body ConnectionView }, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			setup, err := cleanConnectionSetup(in.Body.Credentials, nil)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var brandID *uuid.UUID
			if raw := strings.TrimSpace(in.Body.BrandID); raw != "" {
				id, err := uuid.Parse(raw)
				if err != nil {
					return nil, httpx.Validation("brand_id is not a valid id.")
				}
				if err := s.requireWorkspaceBrand(ctx, p.WorkspaceID, id); err != nil {
					return nil, err
				}
				brandID = &id
			}
			acct := Account{PhoneNumberID: setup.PhoneNumberID, WABAID: setup.WABAID,
				AccessToken: setup.Credentials.AccessToken, APIVersion: setup.APIVersion}
			info, _, err := s.probeCredentials(ctx, acct)
			if err != nil {
				return nil, err
			}
			sealed, err := s.sealCredentials(setup.Credentials)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			name := strings.TrimSpace(in.Body.Name)
			if name == "" {
				name = displayname.CleanOr(info.VerifiedName, displayname.Workspace, "WhatsApp")
			} else if name, err = displayname.Validate("Name", name, displayname.Workspace, false); err != nil {
				return nil, httpx.Wrap(err)
			}
			now := time.Now().UTC()
			c := connection{ID: ids.New(), WorkspaceID: p.WorkspaceID, Name: name,
				PhoneNumberID: setup.PhoneNumberID, WABAID: setup.WABAID,
				DisplayPhone: strings.TrimSpace(info.DisplayPhoneNumber),
				VerifiedName: displayname.CleanOr(info.VerifiedName, displayname.Workspace, ""),
				APIVersion:   setup.APIVersion, Status: "connected", CreatedBy: &p.UserID,
				CreatedAt: now, UpdatedAt: now, credentialsEnc: sealed}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				brand, err := domain.ResolveBrand(ctx, tx, p.WorkspaceID, brandID, nil, nil)
				if err != nil {
					return err
				}
				c.BrandID = brand
				if err := insertConnection(ctx, tx, c); err != nil {
					return err
				}
				if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID,
					Type: "whatsapp_connection.created", Admins: true,
					Data: map[string]any{"whatsapp_connection": s.view(c, true)}}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "whatsapp.connected", whatsappConnectionType, &c.ID,
					map[string]any{"phone_number_id": c.PhoneNumberID})
			})
			if db.IsUniqueViolation(err, "") {
				return nil, httpx.Conflict("This workspace already has a WhatsApp connection for that phone number.")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ConnectionView }{s.view(c, true)}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-whatsapp-connection", Method: http.MethodPatch,
		Path: "/v1/whatsapp/connections/{id}", Tags: tags, Summary: "Update a WhatsApp connection"},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body updateConnectionBody
		}) (*struct{ Body ConnectionView }, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			c, err := s.loadWorkspaceConnection(ctx, p.WorkspaceID, in.ID)
			if err != nil {
				return nil, err
			}
			if in.Body.Name == nil && in.Body.Credentials == nil {
				return &struct{ Body ConnectionView }{s.view(c, true)}, nil
			}
			var name string
			nameGiven := in.Body.Name != nil
			if nameGiven {
				if name, err = displayname.Validate("Name", strings.TrimSpace(*in.Body.Name), displayname.Workspace, false); err != nil {
					return nil, httpx.Wrap(err)
				}
			}
			var (
				upd    *connectionSetup
				probed AccountInfo
				sealed []byte
			)
			if in.Body.Credentials != nil {
				old, err := s.openCredentials(c)
				if err != nil {
					return nil, httpx.Wrap(err)
				}
				fresh, err := cleanConnectionSetup(*in.Body.Credentials, &old)
				if err != nil {
					return nil, httpx.Wrap(err)
				}
				if fresh.PhoneNumberID != c.PhoneNumberID {
					return nil, httpx.Validation("These credentials belong to a different phone number. Disconnect this connection and connect the other number instead.")
				}
				acct := Account{PhoneNumberID: fresh.PhoneNumberID, WABAID: fresh.WABAID,
					AccessToken: fresh.Credentials.AccessToken, APIVersion: fresh.APIVersion}
				info, _, err := s.probeCredentials(ctx, acct)
				if err != nil {
					return nil, err
				}
				if sealed, err = s.sealCredentials(fresh.Credentials); err != nil {
					return nil, httpx.Wrap(err)
				}
				upd, probed = &fresh, info
			}
			var out connection
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				cur, err := loadConnection(ctx, tx, p.WorkspaceID, c.ID)
				if err != nil {
					return err
				}
				if nameGiven {
					cur.Name = name
				}
				if upd != nil {
					cur.PhoneNumberID = upd.PhoneNumberID
					cur.WABAID = upd.WABAID
					cur.APIVersion = upd.APIVersion
					cur.DisplayPhone = strings.TrimSpace(probed.DisplayPhoneNumber)
					cur.VerifiedName = displayname.CleanOr(probed.VerifiedName, displayname.Workspace, "")
					cur.Status, cur.LastError = "connected", ""
					cur.credentialsEnc = sealed
				}
				cur.UpdatedAt = time.Now().UTC()
				if err := updateConnection(ctx, tx, cur); err != nil {
					return err
				}
				if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID,
					Type: "whatsapp_connection.updated", Admins: true,
					Data: map[string]any{"whatsapp_connection": s.view(cur, true)}}); err != nil {
					return err
				}
				changes := map[string]any{}
				if nameGiven {
					changes["name"] = name
				}
				if upd != nil {
					changes["credentials"] = "replaced"
				}
				out = cur
				return audit.Log(ctx, tx, p, p.WorkspaceID, "whatsapp.updated", whatsappConnectionType, &cur.ID, changes)
			})
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("WhatsApp connection")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ConnectionView }{s.view(out, true)}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "test-whatsapp-connection", Method: http.MethodPost,
		Path: "/v1/whatsapp/connections/{id}/test", Tags: tags, Summary: "Test a WhatsApp connection",
		Description: "Checks the connection's credentials with Meta and records the outcome, so a token Meta no longer accepts shows as an error in settings."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ConnectionView }, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			c, err := s.loadWorkspaceConnection(ctx, p.WorkspaceID, in.ID)
			if err != nil {
				return nil, err
			}
			acct, _, err := s.account(c)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			info, refusal, err := s.probeCredentials(ctx, acct)
			if err != nil {
				if _, serr := s.recordProbe(ctx, p, c.ID, "error", refusal, nil); serr != nil {
					return nil, httpx.Wrap(serr)
				}
				return nil, err
			}
			c, err = s.recordProbe(ctx, p, c.ID, "connected", "", &info)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ConnectionView }{s.view(c, true)}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-whatsapp-connection", Method: http.MethodDelete,
		Path: "/v1/whatsapp/connections/{id}", Tags: tags, Summary: "Disconnect a WhatsApp number",
		Description: "Removes the connection. Tickets its messages opened stay.", DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			c, err := s.loadWorkspaceConnection(ctx, p.WorkspaceID, in.ID)
			if err != nil {
				return nil, err
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				cur, err := loadConnection(ctx, tx, p.WorkspaceID, c.ID)
				if err != nil {
					return err
				}
				if err := deleteConnection(ctx, tx, p.WorkspaceID, cur.ID); err != nil {
					return err
				}
				if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID,
					Type: "whatsapp_connection.deleted", Admins: true,
					Data: map[string]any{"whatsapp_connection_id": cur.ID}}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "whatsapp.disconnected", whatsappConnectionType, &cur.ID,
					map[string]any{"phone_number_id": cur.PhoneNumberID})
			})
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("WhatsApp connection")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{}{}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "subscribe-whatsapp-webhook", Method: http.MethodPost,
		Path: "/v1/whatsapp/connections/{id}/subscribe", Tags: tags, Summary: "Subscribe the WhatsApp webhook",
		Description: "Points the Meta app's callback at this connection, so Meta starts delivering its messages to opendesk."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ConnectionView }, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			c, err := s.loadWorkspaceConnection(ctx, p.WorkspaceID, in.ID)
			if err != nil {
				return nil, err
			}
			acct, creds, err := s.account(c)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := s.client().SubscribeWebhook(ctx, acct, s.webhookURL(c), creds.VerifyToken); err != nil {
				if msg := metaRefusal(err); msg != "" {
					s.d.Log.Info("whatsapp webhook subscription refused", "connection_id", c.ID, "detail", msg)
					return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_subscribe_refused",
						"Meta refused the webhook subscription: "+msg)
				}
				s.d.Log.Warn("whatsapp webhook not subscribed", "connection_id", c.ID, "err", err)
				return nil, httpx.E(http.StatusBadGateway, "whatsapp_subscribe_failed",
					"Couldn't reach Meta to subscribe this webhook. Try again in a moment.")
			}
			if c, err = s.recordProbe(ctx, p, c.ID, "connected", "", nil); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ConnectionView }{s.view(c, true)}, nil
		})
}

// loadWorkspaceConnection reads one connection by id, scoped to a workspace: another
// workspace's connection is a 404.
func (s *Service) loadWorkspaceConnection(ctx context.Context, wid uuid.UUID, raw string) (connection, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return connection{}, httpx.NotFound("WhatsApp connection")
	}
	c, err := loadConnection(ctx, s.d.DB.Pool, wid, id)
	if db.IsNotFound(err) {
		return c, httpx.NotFound("WhatsApp connection")
	}
	if err != nil {
		return c, httpx.Wrap(err)
	}
	return c, nil
}

// requireWorkspaceBrand refuses a brand that is not this workspace's; the default brand is
// used only when the request names none.
func (s *Service) requireWorkspaceBrand(ctx context.Context, wid, brandID uuid.UUID) error {
	var ok bool
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM brands WHERE workspace_id = $1 AND id = $2)`,
		wid, brandID).Scan(&ok); err != nil {
		return httpx.Wrap(err)
	}
	if !ok {
		return httpx.Validation("brand_id is not a brand of this workspace")
	}
	return nil
}

// cleanConnectionSetup checks a pasted credentials input and fills in what it leaves empty:
// the API version (the default) and the verify token (a fresh one, or the one old holds).
func cleanConnectionSetup(in credentialsInput, old *Credentials) (connectionSetup, error) {
	out := connectionSetup{
		PhoneNumberID: strings.TrimSpace(in.PhoneNumberID),
		WABAID:        strings.TrimSpace(in.WABAID),
		APIVersion:    strings.TrimSpace(in.APIVersion),
		Credentials: Credentials{
			AccessToken: strings.TrimSpace(in.AccessToken),
			AppSecret:   strings.TrimSpace(in.AppSecret),
			VerifyToken: strings.TrimSpace(in.VerifyToken),
		},
	}
	if out.PhoneNumberID == "" || out.WABAID == "" || out.Credentials.AccessToken == "" || out.Credentials.AppSecret == "" {
		return connectionSetup{}, httpx.Validation("Provide the phone number ID, WhatsApp Business account ID, access token and app secret.")
	}
	switch {
	case len(out.PhoneNumberID) > maxMetaIDLength,
		len(out.WABAID) > maxMetaIDLength,
		len(out.Credentials.AccessToken) > maxMetaTokenLength,
		len(out.Credentials.AppSecret) > maxMetaTokenLength,
		len(out.Credentials.VerifyToken) > maxVerifyTokenLength,
		len(out.APIVersion) > maxAPIVersionLength:
		return connectionSetup{}, httpx.Validation("One of these credentials is too long.")
	}
	if !metaIDPattern.MatchString(out.PhoneNumberID) || !metaIDPattern.MatchString(out.WABAID) {
		return connectionSetup{}, httpx.Validation("The phone number ID and WhatsApp Business account ID are numbers. Copy them from WhatsApp > API Setup in your Meta app.")
	}
	if out.APIVersion != "" && !apiVersionPattern.MatchString(out.APIVersion) {
		return connectionSetup{}, httpx.Validation("The API version looks like v23.0. Leave it empty to use the default.")
	}
	if out.Credentials.VerifyToken == "" && old != nil {
		out.Credentials.VerifyToken = old.VerifyToken
	}
	if out.Credentials.VerifyToken == "" {
		token, err := newWebhookVerifyToken()
		if err != nil {
			return connectionSetup{}, err
		}
		out.Credentials.VerifyToken = token
	}
	if out.APIVersion == "" {
		out.APIVersion = defaultAPIVersion
	}
	return out, nil
}

// newWebhookVerifyToken is the 32-character hex string Meta's webhook handshake echoes.
func newWebhookVerifyToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// probeCredentials checks credentials at Meta. info is the account Meta answered with; a
// refusal is returned as the 422 the API answers with, whose wording (never a credential)
// is also what last_error records.
func (s *Service) probeCredentials(ctx context.Context, acct Account) (info AccountInfo, refusal string, err error) {
	info, err = s.client().ValidateCredentials(ctx, acct)
	if err == nil {
		return info, "", nil
	}
	refused := httpx.E(http.StatusUnprocessableEntity, "whatsapp_credentials_refused",
		"Meta rejected these credentials.")
	if msg := metaRefusal(err); msg != "" {
		refused.Detail = "Meta rejected these credentials: " + msg
	}
	s.d.Log.Info("whatsapp credentials refused", "phone_number_id", acct.PhoneNumberID, "detail", refused.Detail)
	return AccountInfo{}, refused.Detail, refused
}

// metaRefusal is what Meta said about a refused request, safe to show and log: Meta's own
// wording never echoes the credentials.
func metaRefusal(err error) string {
	var me *MetaAPIError
	if errors.As(err, &me) {
		if msg := strings.TrimSpace(me.UserMsg); msg != "" {
			return clipRunes(msg, maxRefusalDetailRunes)
		}
		if msg := strings.TrimSpace(me.Message); msg != "" {
			return clipRunes(msg, maxRefusalDetailRunes)
		}
	}
	return ""
}

// clipRunes cuts s to n runes, so a provider's message fits a response and a column.
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// recordProbe stores what a credentials check or a webhook subscription found: the
// connection's health and, when Meta answered, the number's display name. The rejected
// credentials themselves are never stored.
func (s *Service) recordProbe(ctx context.Context, p *auth.Principal, id uuid.UUID, status, lastError string, info *AccountInfo) (connection, error) {
	var out connection
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		c, err := loadConnection(ctx, tx, p.WorkspaceID, id)
		if err != nil {
			return err
		}
		c.Status, c.LastError, c.UpdatedAt = status, lastError, time.Now().UTC()
		if info != nil {
			c.DisplayPhone = strings.TrimSpace(info.DisplayPhoneNumber)
			c.VerifiedName = displayname.CleanOr(info.VerifiedName, displayname.Workspace, "")
		}
		if err := updateConnection(ctx, tx, c); err != nil {
			return err
		}
		if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID,
			Type: "whatsapp_connection.updated", Admins: true,
			Data: map[string]any{"whatsapp_connection": s.view(c, true)}}); err != nil {
			return err
		}
		out = c
		return nil
	})
	if db.IsNotFound(err) {
		return out, httpx.NotFound("WhatsApp connection")
	}
	return out, err
}
