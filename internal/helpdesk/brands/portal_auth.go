package brands

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/netsafe"
)

type portalAuthIn struct {
	Mode         string  `json:"mode" enum:"local,oidc,local_and_oidc"`
	Issuer       string  `json:"issuer,omitempty" maxLength:"2000"`
	ClientID     string  `json:"client_id,omitempty" maxLength:"500"`
	ClientSecret *string `json:"client_secret,omitempty" maxLength:"8192" writeOnly:"true"`
	// CreateContacts lets a first sign-in of someone with no contact create one.
	CreateContacts bool `json:"create_contacts,omitempty" doc:"Create a contact for a verified sign-in that matches none; off, only existing contacts sign in"`
}

type portalAuthSettings struct {
	Mode             string `json:"mode"`
	Issuer           string `json:"issuer"`
	ClientID         string `json:"client_id"`
	SecretConfigured bool   `json:"secret_configured"`
	CreateContacts   bool   `json:"create_contacts"`
}

func invalidPortalOIDC() error {
	return httpx.E(422, "invalid_oidc_config", "Enter a valid HTTPS OIDC issuer and client configuration.")
}

// validatePortalDiscovery bounds the complete discovery and DNS budget. The guarded
// client pins public addresses when dialing and refuses redirects, including HTTPS downgrades.
func validatePortalDiscovery(ctx context.Context, client *http.Client, guard netsafe.Guard, issuer string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return invalidPortalOIDC()
	}
	if _, err := guard.ValidateURL(ctx, issuer); err != nil {
		return invalidPortalOIDC()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(issuer, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		return invalidPortalOIDC()
	}
	resp, err := client.Do(req)
	if err != nil {
		return invalidPortalOIDC()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return invalidPortalOIDC()
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return invalidPortalOIDC()
	}
	var metadata struct {
		Issuer        string `json:"issuer"`
		Authorization string `json:"authorization_endpoint"`
		Token         string `json:"token_endpoint"`
		JWKS          string `json:"jwks_uri"`
	}
	if json.Unmarshal(data, &metadata) != nil || metadata.Issuer != issuer {
		return invalidPortalOIDC()
	}
	for _, endpoint := range []string{metadata.Authorization, metadata.Token, metadata.JWKS} {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Scheme != "https" || parsed.Fragment != "" {
			return invalidPortalOIDC()
		}
		if _, err := guard.ValidateURL(ctx, endpoint); err != nil {
			return invalidPortalOIDC()
		}
	}
	return nil
}

func (h *handler) validatePortalAuth(ctx context.Context, in *portalAuthIn) (*portalAuthIn, error) {
	if in == nil {
		return nil, nil
	}
	v := *in
	v.Issuer, v.ClientID = strings.TrimSpace(v.Issuer), strings.TrimSpace(v.ClientID)
	if v.Mode != "local" && v.Mode != "oidc" && v.Mode != "local_and_oidc" {
		return nil, invalidPortalOIDC()
	}
	if v.Mode == "local" {
		if v.Issuer != "" || v.ClientID != "" || v.ClientSecret != nil || v.CreateContacts {
			return nil, invalidPortalOIDC()
		}
		return &v, nil
	}
	if v.ClientID == "" || (v.ClientSecret != nil && strings.TrimSpace(*v.ClientSecret) == "") {
		return nil, invalidPortalOIDC()
	}
	client := netsafe.Client(false, 10*time.Second)
	defer client.CloseIdleConnections()
	if err := validatePortalDiscovery(ctx, client, netsafe.Guard{}, v.Issuer); err != nil {
		return nil, err
	}
	return &v, nil
}

func (h *handler) savePortalAuth(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID, in *portalAuthIn) error {
	var issuer, clientID string
	var secret []byte
	if err := tx.QueryRow(ctx, `SELECT portal_oidc_issuer, portal_oidc_client_id, portal_oidc_client_secret_enc
        FROM brands WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, p.WorkspaceID, id).Scan(&issuer, &clientID, &secret); err != nil {
		return err
	}
	if in.Mode == "local" {
		secret = nil
	} else if in.ClientSecret != nil {
		var err error
		secret, err = h.d.Box.Seal([]byte(*in.ClientSecret))
		if err != nil {
			return err
		}
	} else if issuer != in.Issuer || clientID != in.ClientID || len(secret) == 0 {
		return httpx.E(422, "oidc_secret_required", "Enter the client secret for this provider configuration.")
	}
	if _, err := tx.Exec(ctx, `UPDATE brands SET portal_auth_mode=$3, portal_oidc_issuer=$4,
        portal_oidc_client_id=$5, portal_oidc_client_secret_enc=$6, portal_oidc_create_contacts=$7, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
		p.WorkspaceID, id, in.Mode, in.Issuer, in.ClientID, secret, in.CreateContacts); err != nil {
		return err
	}
	if err := audit.Log(ctx, tx, p, p.WorkspaceID, "brand.portal_auth_updated", "brand", &id, map[string]any{"mode": in.Mode}); err != nil {
		return err
	}
	_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "brand.portal_auth_updated", Admins: true, Data: map[string]any{"brand_id": id}})
	return err
}

func (h *handler) registerPortalAuth(api huma.API) {
	huma.Register(api, op("get-brand-portal-auth", http.MethodGet, "/v1/brands/{id}/portal/auth", "Get portal authentication settings", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body portalAuthSettings }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Brand")
			if err != nil {
				return nil, err
			}
			var settings portalAuthSettings
			err = h.d.DB.Pool.QueryRow(ctx, `SELECT portal_auth_mode, portal_oidc_issuer, portal_oidc_client_id,
                portal_oidc_client_secret_enc IS NOT NULL, portal_oidc_create_contacts FROM brands WHERE workspace_id=$1 AND id=$2`, p.WorkspaceID, id).
				Scan(&settings.Mode, &settings.Issuer, &settings.ClientID, &settings.SecretConfigured, &settings.CreateContacts)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Brand")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body portalAuthSettings }{settings}, nil
		})
	huma.Register(api, op("authorize-brand-portal-relink", http.MethodPost, "/v1/brands/{id}/portal/relink-authorizations", "Authorize one customer identity relink", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				ContactID uuid.UUID `json:"contact_id"`
			}
		}) (*struct{ Body portalRelinkAuthorization }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			passes, err := auth.PassesStepUp(ctx, h.d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if !passes {
				return nil, httpx.E(403, "reauth_required", "Sign in again with your second factor, if enabled, to authorize a relink.")
			}
			id, err := hd.ParseID(in.ID, "Brand")
			if err != nil {
				return nil, err
			}
			result := portalRelinkAuthorization{ID: ids.New(), BrandID: id, ContactID: in.Body.ContactID}
			err = h.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := Check(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				// The contact lock serializes authorization replacement with contact changes and consumption.
				var blocked bool
				if err := tx.QueryRow(ctx, `SELECT blocked FROM contacts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, p.WorkspaceID, result.ContactID).Scan(&blocked); err != nil {
					if db.IsNotFound(err) {
						return httpx.NotFound("Contact")
					}
					return err
				}
				if blocked {
					return httpx.Validation("A blocked contact cannot relink an identity.")
				}
				if _, err := tx.Exec(ctx, `UPDATE customer_oidc_relink_authorizations SET revoked_at=now()
                    WHERE workspace_id=$1 AND brand_id=$2 AND contact_id=$3 AND used_at IS NULL AND revoked_at IS NULL`, p.WorkspaceID, id, result.ContactID); err != nil {
					return err
				}
				if err := tx.QueryRow(ctx, `INSERT INTO customer_oidc_relink_authorizations (id,workspace_id,brand_id,contact_id,actor_id,expires_at)
                    VALUES ($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING expires_at`, result.ID, p.WorkspaceID, id, result.ContactID, p.UserID).Scan(&result.ExpiresAt); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "customer.oidc_relink_authorized", "contact", &result.ContactID, map[string]any{"brand_id": id, "authorization_id": result.ID})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body portalRelinkAuthorization }{result}, nil
		})
}

type portalRelinkAuthorization struct {
	ID        uuid.UUID `json:"id"`
	BrandID   uuid.UUID `json:"brand_id"`
	ContactID uuid.UUID `json:"contact_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// portalSettingsAPI keeps validation errors useful without reflecting a body that
// can contain a provider credential. Other brand operations use normal errors.
type portalSettingsAPI struct{ huma.API }

func (a portalSettingsAPI) Transform(ctx huma.Context, status string, value any) (any, error) {
	if id := ctx.Operation().OperationID; id == "create-brand" || id == "update-brand" {
		redactPortalValidation(value)
	}
	return a.API.Transform(ctx, status, value)
}

func redactPortalValidation(value any) {
	switch problem := value.(type) {
	case *httpx.Error:
		for _, detail := range problem.Errors {
			detail.Value = nil
		}
	case *huma.ErrorModel:
		for _, detail := range problem.Errors {
			detail.Value = nil
		}
	}
}
