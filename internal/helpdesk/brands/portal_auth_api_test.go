package brands_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestPortalAuthSettingsAccessAndLocalDefault(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	path := "/v1/brands/" + ws.BrandID.String()
	var b brands.Brand
	e.Do("GET", path, ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &b)
	if b.PortalAuth.Mode != "local" {
		t.Fatalf("default %q", b.PortalAuth.Mode)
	}
	e.Do("GET", path+"/portal/auth", ws.Viewer.As(ws), nil).Want(t, 403)
	e.Do("GET", path+"/portal/auth", ws.Agent.As(ws), nil).Want(t, 403)
	other := e.NewWorkspace()
	e.Do("GET", path+"/portal/auth", other.Admin.As(other), nil).Want(t, 404)
	sealed, err := e.D.Box.Seal([]byte("private-client-secret"))
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`UPDATE brands SET portal_auth_mode='oidc',portal_oidc_issuer='https://issuer.example',portal_oidc_client_id='private-client-id',portal_oidc_client_secret_enc=$2 WHERE id=$1`, ws.BrandID, sealed)
	var settings struct {
		Mode, Issuer     string
		SecretConfigured bool `json:"secret_configured"`
		CreateContacts   bool `json:"create_contacts"`
	}
	e.Exec(`UPDATE brands SET portal_oidc_create_contacts=true WHERE id=$1`, ws.BrandID)
	res := e.Do("GET", path+"/portal/auth", ws.Admin.As(ws), nil).Want(t, 200)
	res.JSON(t, &settings)
	if settings.Mode != "oidc" || !settings.SecretConfigured || !settings.CreateContacts {
		t.Fatalf("settings %+v", settings)
	}
	raw := string(res.Body)
	if strings.Contains(raw, "private-client-secret") || strings.Contains(raw, "client_secret") {
		t.Fatalf("secret response %s", raw)
	}
	// Creating contacts belongs to a provider sign-in; a local portal refuses it.
	e.Do("PATCH", path, ws.Admin.As(ws), map[string]any{"portal_auth": map[string]any{"mode": "local", "create_contacts": true}}).Want(t, 422)
	e.Do("PATCH", path, ws.Admin.As(ws), map[string]any{"portal_auth": map[string]any{"mode": "local"}}).Want(t, 200)
	e.Do("GET", path+"/portal/auth", ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &settings)
	if settings.Mode != "local" || settings.Issuer != "" || settings.SecretConfigured || settings.CreateContacts {
		t.Fatalf("local clearing %+v", settings)
	}
	e.Do("PATCH", path, ws.Admin.As(ws), map[string]any{"portal_auth": map[string]any{"mode": "oidc", "issuer": "https://127.0.0.1", "client_id": "client", "client_secret": "secret"}}).Want(t, 422)
}

func TestPortalRelinkAuthorization(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	contact := ids.New()
	e.Exec(`INSERT INTO contacts (id,workspace_id,name,email) VALUES ($1,$2,'Customer','customer@example.com')`, contact, ws.ID)
	path := "/v1/brands/" + ws.BrandID.String() + "/portal/relink-authorizations"
	body := map[string]any{"contact_id": contact}
	e.Do("POST", path, ws.Admin.As(ws), body).Want(t, 403)
	e.Do("POST", path, e.SignedIn(ws.Agent, false).As(ws), body).Want(t, 403)
	admin := e.SignedIn(ws.Admin, false).As(ws)
	var result struct {
		ID        uuid.UUID
		ExpiresAt time.Time `json:"expires_at"`
	}
	e.Do("POST", path, admin, body).Want(t, 201).JSON(t, &result)
	if result.ID == uuid.Nil || time.Until(result.ExpiresAt) > 15*time.Minute || time.Until(result.ExpiresAt) < 14*time.Minute {
		t.Fatalf("authorization %+v", result)
	}
	first := result.ID
	e.Do("POST", path, admin, body).Want(t, 201).JSON(t, &result)
	var revoked bool
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT revoked_at IS NOT NULL FROM customer_oidc_relink_authorizations WHERE id=$1`, first).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("replacement revoked=%v error=%v", revoked, err)
	}
	e.Do("POST", path, admin, map[string]any{"contact_id": ids.New()}).Want(t, 404)
	other := e.NewWorkspace()
	e.Do("POST", path, e.SignedIn(other.Admin, false).As(other), body).Want(t, 422)
	e.Exec(`UPDATE contacts SET blocked=true WHERE id=$1`, contact)
	e.Do("POST", path, admin, body).Want(t, 422)
	e.Exec(`UPDATE contacts SET blocked=false WHERE id=$1`, contact)
	e.Exec(`UPDATE users SET totp_enabled=true WHERE id=$1`, ws.Admin.ID)
	e.Do("POST", path, admin, body).Want(t, 403)
	e.Do("POST", path, e.SignedIn(ws.Admin, true).As(ws), body).Want(t, 201)
}

func TestPortalSettingsValidationDoesNotReflectSecrets(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	for _, request := range []struct {
		method, path string
		body         map[string]any
	}{
		{"POST", "/v1/brands", map[string]any{"portal_auth": map[string]any{"client_secret": "never-reflect-this"}}},
		{"PATCH", "/v1/brands/" + ws.BrandID.String(), map[string]any{"portal_auth": map[string]any{"client_secret": "never-reflect-this"}}},
		{"PATCH", "/v1/brands/" + ws.BrandID.String(), map[string]any{"portal_auth": map[string]any{"mode": "oidc", "client_secret": strings.Repeat("never-reflect-this", 1000)}}},
	} {
		response := e.Do(request.method, request.path, ws.Admin.As(ws), request.body).Want(t, 422)
		if strings.Contains(string(response.Body), "never-reflect-this") {
			t.Fatalf("validation reflected credentials: %s", response.Body)
		}
		if !strings.Contains(string(response.Body), "location") || !strings.Contains(string(response.Body), "message") {
			t.Fatalf("missing field errors: %s", response.Body)
		}
	}
}

func TestPortalOIDCOwnershipSurvivesBrandDeletion(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	var origin brands.Brand
	e.Do("POST", "/v1/brands", ws.Admin.As(ws), map[string]any{"name": "Original portal"}).Want(t, 201).JSON(t, &origin)
	contact, otherContact := ids.New(), ids.New()
	e.Exec(`INSERT INTO contacts (id,workspace_id,name,email) VALUES ($1,$2,'Original owner','original@example.com'),($3,$2,'Other owner','other@example.com')`, contact, ws.ID, otherContact)
	for _, subject := range []string{"active-subject", "revoked-subject"} {
		e.Exec(`INSERT INTO customer_oidc_identities (id,workspace_id,brand_id,contact_id,issuer,subject,email,revoked_at)
            VALUES ($1,$2,$3,$4,'https://issuer.example',$5,'original@example.com',CASE WHEN $5='revoked-subject' THEN now() END)`, ids.New(), ws.ID, origin.ID, contact, subject)
	}
	e.Do("DELETE", "/v1/brands/"+origin.ID.String(), ws.Admin.As(ws), nil).Want(t, 204)
	for _, subject := range []string{"active-subject", "revoked-subject"} {
		var storedContact uuid.UUID
		var brand *uuid.UUID
		var revoked bool
		err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT contact_id,brand_id,revoked_at IS NOT NULL FROM customer_oidc_identities
            WHERE workspace_id=$1 AND issuer='https://issuer.example' AND subject=$2`, ws.ID, subject).Scan(&storedContact, &brand, &revoked)
		if err != nil || storedContact != contact || brand != nil || revoked != (subject == "revoked-subject") {
			t.Fatalf("retained ownership for %s: contact=%v brand=%v revoked=%v error=%v", subject, storedContact, brand, revoked, err)
		}
		_, err = e.D.DB.Pool.Exec(e.Ctx, `INSERT INTO customer_oidc_identities (id,workspace_id,brand_id,contact_id,issuer,subject,email)
            VALUES ($1,$2,$3,$4,'https://issuer.example',$5,'other@example.com')`, ids.New(), ws.ID, ws.BrandID, otherContact, subject)
		if !db.IsUniqueViolation(err, "") {
			t.Fatalf("retained %s must prevent remapping: %v", subject, err)
		}
	}
	// The originating brand is one of the identity's own workspace's brands.
	other := e.NewWorkspace()
	_, err := e.D.DB.Pool.Exec(e.Ctx, `INSERT INTO customer_oidc_identities (id,workspace_id,brand_id,contact_id,issuer,subject,email)
        VALUES ($1,$2,$3,$4,'https://issuer.example','foreign-brand','other@example.com')`, ids.New(), ws.ID, other.BrandID, otherContact)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("an identity took another workspace's brand: %v", err)
	}
}
