package customerportal

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

const idpSecret = "idp-client-secret"

// idp is a provider on a local TLS server: discovery, keys and a token endpoint that
// answers any code with an ID token for the claims the test set.
type idp struct {
	srv       *httptest.Server
	key       *rsa.PrivateKey
	claims    map[string]any
	challenge string
	nonce     string
	// aud overrides the audience, for a token issued to another client.
	aud string
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{key: key}
	mux := http.NewServeMux()
	p.srv = httptest.NewTLSServer(mux)
	t.Cleanup(p.srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": p.srv.URL, "authorization_endpoint": p.srv.URL + "/authorize",
			"token_endpoint": p.srv.URL + "/token", "jwks_uri": p.srv.URL + "/jwks", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		user, pass, basic := r.BasicAuth()
		secret := r.PostForm.Get("client_secret")
		if basic {
			secret = pass
			_ = user
		}
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if secret != idpSecret || b64(sum[:]) != p.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		claims := map[string]any{"iss": p.srv.URL, "aud": "portal-client", "exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(), "nonce": p.nonce}
		if p.aud != "" {
			claims["aud"] = p.aud
		}
		for k, v := range p.claims {
			claims[k] = v
		}
		head, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "k1", "typ": "JWT"})
		body, _ := json.Marshal(claims)
		signing := b64(head) + "." + b64(body)
		sum2 := sha256.Sum256([]byte(signing))
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum2[:])
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "unused", "token_type": "Bearer", "id_token": signing + "." + b64(sig)})
	})
	old := oidcClient
	oidcClient = func() *http.Client { return p.srv.Client() }
	t.Cleanup(func() { oidcClient = old })
	return p
}

// useIDP points the brand at the provider.
func useIDP(t *testing.T, e *hdtest.Env, ws hdtest.WS, p *idp, mode string, create bool) {
	t.Helper()
	sealed, err := e.D.Box.Seal([]byte(idpSecret))
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`UPDATE brands SET portal_auth_mode=$2, portal_oidc_issuer=$3, portal_oidc_client_id='portal-client',
        portal_oidc_client_secret_enc=$4, portal_oidc_create_contacts=$5 WHERE id=$1`, ws.BrandID, mode, p.srv.URL, sealed, create)
}

type ssoResult struct {
	Location string
	Cookies  []*http.Cookie
}

func (r ssoResult) error() string {
	u, err := url.Parse(r.Location)
	if err != nil {
		return "unparsable"
	}
	return u.Query().Get("sso_error")
}

func (r ssoResult) cookie(name string) string {
	for _, c := range r.Cookies {
		if c.Name == name && c.MaxAge >= 0 {
			return c.Value
		}
	}
	return ""
}

func ssoPath(ws hdtest.WS, leaf string) string {
	return "/v1/public/help/" + ws.Slug + "/portal/sso/" + leaf
}

// browserSignIn runs start and callback as a browser would. tamper may change the callback's query or cookie.
func browserSignIn(t *testing.T, e *hdtest.Env, ws hdtest.WS, p *idp, claims map[string]any, tamper func(q url.Values, cookie *string)) ssoResult {
	t.Helper()
	start := e.Do("GET", ssoPath(ws, "start")+"?redirect_to="+url.QueryEscape("/portal/"+ws.Slug+"/tickets"), hdtest.Auth{}, nil)
	if start.Status != http.StatusFound {
		t.Fatalf("start status %d: %s", start.Status, start.Body)
	}
	loc, err := url.Parse(start.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(loc.String(), p.srv.URL+"/authorize") {
		return ssoResult{Location: loc.String()}
	}
	q := loc.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("response_type") != "code" || q.Get("client_id") != "portal-client" ||
		q.Get("redirect_uri") != "http://api.test"+ssoPath(ws, "callback") || q.Get("scope") != "openid email profile" {
		t.Fatalf("authorization request %v", q)
	}
	p.challenge, p.nonce, p.claims = q.Get("code_challenge"), q.Get("nonce"), claims
	cookie := ""
	for _, c := range (&http.Response{Header: http.Header{"Set-Cookie": start.Header.Values("Set-Cookie")}}).Cookies() {
		if c.Name == ssoBindCookie {
			cookie = c.Value
		}
	}
	cb := url.Values{"state": {q.Get("state")}, "code": {"code-1"}}
	if tamper != nil {
		tamper(cb, &cookie)
	}
	h := map[string]string{}
	if cookie != "" {
		h["Cookie"] = ssoBindCookie + "=" + cookie
	}
	res := e.Do("GET", ssoPath(ws, "callback")+"?"+cb.Encode(), hdtest.Auth{Header: h}, nil)
	if res.Status != http.StatusFound {
		t.Fatalf("callback status %d: %s", res.Status, res.Body)
	}
	return ssoResult{Location: res.Header.Get("Location"), Cookies: (&http.Response{Header: http.Header{"Set-Cookie": res.Header.Values("Set-Cookie")}}).Cookies()}
}

func claimsFor(subject, email string) map[string]any {
	return map[string]any{"sub": subject, "email": email, "email_verified": true, "name": "Customer Name"}
}

func (r ssoResult) mustSucceed(t *testing.T, ws hdtest.WS) string {
	t.Helper()
	if r.error() != "" || r.Location != "http://app.test/portal/"+ws.Slug+"/tickets" {
		t.Fatalf("sign-in refused: %s", r.Location)
	}
	refresh := r.cookie("od_customer_refresh")
	if refresh == "" {
		t.Fatal("no session cookie")
	}
	return refresh
}

func (r ssoResult) mustFail(t *testing.T, code string) {
	t.Helper()
	if r.error() != code {
		t.Fatalf("want %s, got %s", code, r.Location)
	}
	if r.cookie("od_customer_refresh") != "" {
		t.Fatal("a refused sign-in set a session")
	}
}

func sessionWorks(t *testing.T, e *hdtest.Env, ws hdtest.WS, refresh string, want int) {
	t.Helper()
	res := e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": "od_customer_refresh=" + refresh}},
		map[string]any{"workspace_slug": ws.Slug})
	res.Want(t, want)
	if want == 200 {
		var out authResult
		res.JSON(t, &out)
		e.Do("GET", "/customer-test", hdtest.Auth{Bearer: out.AccessToken}, nil).Want(t, 200)
	}
}

func count(e *hdtest.Env, sql string, args ...any) int {
	var n int
	e.Scalar(sql, &n, args...)
	return n
}

func TestSSOSignInLinksVerifiedContactAndOpensSession(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newIDP(t)
	useIDP(t, e, ws, p, "oidc", false)

	refresh := browserSignIn(t, e, ws, p, claimsFor("subject-1", email), nil).mustSucceed(t, ws)
	sessionWorks(t, e, ws, refresh, 200)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1 AND subject='subject-1' AND revoked_at IS NULL AND brand_id=$2`, cid, ws.BrandID); n != 1 {
		t.Fatalf("identity rows %d", n)
	}
	if n := count(e, `SELECT count(*) FROM customer_sessions WHERE contact_id=$1 AND method='oidc'`, cid); n != 1 {
		t.Fatalf("oidc sessions %d", n)
	}
	if n := count(e, `SELECT count(*) FROM customer_credentials WHERE contact_id=$1`, cid); n != 0 {
		t.Fatalf("a provider sign-in created a password row")
	}
	for _, action := range []string{"customer.sso.linked", "customer.sso.login"} {
		if n := count(e, `SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND action=$2`, ws.ID, action); n != 1 {
			t.Fatalf("%s audited %d times", action, n)
		}
	}
	// The link, not the address, identifies the customer on later sign-ins.
	browserSignIn(t, e, ws, p, map[string]any{"sub": "subject-1", "email": "renamed@example.com", "email_verified": false}, nil).mustSucceed(t, ws)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1`, cid); n != 1 {
		t.Fatalf("a second sign-in added a link: %d", n)
	}
}

func TestSSORefusals(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newIDP(t)
	useIDP(t, e, ws, p, "oidc", false)

	browserSignIn(t, e, ws, p, map[string]any{"sub": "s-unverified", "email": email, "email_verified": false}, nil).mustFail(t, "email_unverified")
	browserSignIn(t, e, ws, p, map[string]any{"sub": "s-noemail"}, nil).mustFail(t, "email_unverified")
	browserSignIn(t, e, ws, p, claimsFor("s-stranger", "stranger@example.com"), nil).mustFail(t, "unknown_customer")
	if n := count(e, `SELECT count(*) FROM contacts WHERE workspace_id=$1 AND email='stranger@example.com'`, ws.ID); n != 0 {
		t.Fatal("a refused sign-in created a contact")
	}

	browserSignIn(t, e, ws, p, claimsFor("s-state", email), func(q url.Values, _ *string) { q.Set("state", "garbage") }).mustFail(t, "invalid_state")
	browserSignIn(t, e, ws, p, claimsFor("s-bind", email), func(_ url.Values, c *string) { *c = "" }).mustFail(t, "invalid_state")
	browserSignIn(t, e, ws, p, claimsFor("s-bind2", email), func(_ url.Values, c *string) { *c = "someone-elses" }).mustFail(t, "invalid_state")
	browserSignIn(t, e, ws, p, claimsFor("s-denied", email), func(q url.Values, _ *string) { q.Set("error", "access_denied") }).mustFail(t, "access_denied")
	browserSignIn(t, e, ws, p, claimsFor("s-nonce", email), func(_ url.Values, _ *string) { p.nonce = "another-nonce" }).mustFail(t, "provider_error")
	p.aud = "another-client"
	browserSignIn(t, e, ws, p, claimsFor("s-aud", email), nil).mustFail(t, "provider_error")
	p.aud = ""
	browserSignIn(t, e, ws, p, map[string]any{"sub": "s-iss", "iss": "https://elsewhere.example", "email": email, "email_verified": true}, nil).mustFail(t, "provider_error")
	browserSignIn(t, e, ws, p, map[string]any{"sub": "s-exp", "exp": time.Now().Add(-time.Hour).Unix(), "email": email, "email_verified": true}, nil).mustFail(t, "provider_error")
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE workspace_id=$1`, ws.ID); n != 0 {
		t.Fatalf("refused sign-ins left %d links", n)
	}

	e.Exec(`UPDATE contacts SET blocked=true WHERE id=$1`, cid)
	browserSignIn(t, e, ws, p, claimsFor("s-blocked", email), nil).mustFail(t, "blocked")
	e.Exec(`UPDATE contacts SET blocked=false WHERE id=$1`, cid)

	// A state minted for one browser's sign-in cannot be replayed in another's callback twice over:
	// the code is the provider's to spend, and the cookie binds the browser.
	if n := count(e, `SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND action='customer.sso.login.failed'`, ws.ID); n < 10 {
		t.Fatalf("failed sign-ins audited %d times", n)
	}
	raw := count(e, `SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND (data::text LIKE '%garbage%' OR data::text LIKE '%'||$2||'%')`, ws.ID, email)
	if raw != 0 {
		t.Fatal("the audit log holds the provider's claims")
	}
}

func TestSSOCreatesContactOnlyWhenTheBrandAllowsIt(t *testing.T) {
	e, ws, _, _ := portalEnv(t)
	p := newIDP(t)
	useIDP(t, e, ws, p, "oidc", true)
	refresh := browserSignIn(t, e, ws, p, claimsFor("s-new", "new.person@example.com"), nil)
	refresh.location(t, ws)
	var name string
	e.Scalar(`SELECT name FROM contacts WHERE workspace_id=$1 AND email='new.person@example.com'`, &name, ws.ID)
	if name != "Customer Name" {
		t.Fatalf("created contact name %q", name)
	}
	sessionWorks(t, e, ws, refresh.cookie("od_customer_refresh"), 200)
}

func (r ssoResult) location(t *testing.T, ws hdtest.WS) { t.Helper(); r.mustSucceed(t, ws) }

func TestSSORelinkNeedsAnAdminsAuthorization(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newIDP(t)
	useIDP(t, e, ws, p, "oidc", false)
	browserSignIn(t, e, ws, p, claimsFor("s-first", email), nil).mustSucceed(t, ws)

	// Another subject of the same provider with the same address must not take the contact over.
	browserSignIn(t, e, ws, p, claimsFor("s-second", email), nil).mustFail(t, "relink_required")

	e.Exec(`INSERT INTO customer_oidc_relink_authorizations(id,workspace_id,brand_id,contact_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')`,
		ids.New(), ws.ID, ws.BrandID, cid)
	browserSignIn(t, e, ws, p, claimsFor("s-second", email), nil).mustSucceed(t, ws)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1 AND subject='s-first' AND revoked_at IS NOT NULL`, cid); n != 1 {
		t.Fatalf("the replaced link was not revoked: %d", n)
	}
	// One authorization, one relink; and the revoked subject stays refused.
	browserSignIn(t, e, ws, p, claimsFor("s-third", email), nil).mustFail(t, "relink_required")
	browserSignIn(t, e, ws, p, claimsFor("s-first", email), nil).mustFail(t, "identity_revoked")

	// An expired authorization does not count.
	e.Exec(`UPDATE customer_oidc_identities SET revoked_at=now() WHERE contact_id=$1 AND revoked_at IS NULL`, cid)
	e.Exec(`UPDATE contacts SET customer_oidc_relink_required=true WHERE id=$1`, cid)
	e.Exec(`INSERT INTO customer_oidc_relink_authorizations(id,workspace_id,brand_id,contact_id,created_at,expires_at) VALUES($1,$2,$3,$4,now()-interval '1 hour',now()-interval '1 minute')`,
		ids.New(), ws.ID, ws.BrandID, cid)
	browserSignIn(t, e, ws, p, claimsFor("s-fourth", email), nil).mustFail(t, "relink_required")
	e.Exec(`UPDATE customer_oidc_relink_authorizations SET revoked_at=now() WHERE contact_id=$1 AND used_at IS NULL`, cid)
	e.Exec(`INSERT INTO customer_oidc_relink_authorizations(id,workspace_id,brand_id,contact_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')`,
		ids.New(), ws.ID, ws.BrandID, cid)
	browserSignIn(t, e, ws, p, claimsFor("s-fourth", email), nil).mustSucceed(t, ws)
	var required bool
	e.Scalar(`SELECT customer_oidc_relink_required FROM contacts WHERE id=$1`, &required, cid)
	if required {
		t.Fatal("a relink left the contact asking for another")
	}
}

func TestSSOSessionEndsWithTheContactsAddressOrBlock(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newIDP(t)
	useIDP(t, e, ws, p, "oidc", false)

	refresh := browserSignIn(t, e, ws, p, claimsFor("s-end", email), nil).mustSucceed(t, ws)
	e.Exec(`UPDATE contacts SET blocked=true WHERE id=$1`, cid)
	sessionWorks(t, e, ws, refresh, 401)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1 AND revoked_at IS NULL`, cid); n != 0 {
		t.Fatalf("a blocked contact kept %d links", n)
	}
	e.Exec(`UPDATE contacts SET blocked=false WHERE id=$1`, cid)

	// A contact that lost its link links again only with an admin's authorization.
	relinked := func(subject string) string {
		t.Helper()
		browserSignIn(t, e, ws, p, claimsFor(subject, email), nil).mustFail(t, "relink_required")
		e.Exec(`INSERT INTO customer_oidc_relink_authorizations(id,workspace_id,brand_id,contact_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')`,
			ids.New(), ws.ID, ws.BrandID, cid)
		return browserSignIn(t, e, ws, p, claimsFor(subject, email), nil).mustSucceed(t, ws)
	}
	refresh = relinked("s-end")
	e.Exec(`UPDATE contacts SET email=$2 WHERE id=$1`, cid, "moved-"+uuid.NewString()+"@example.com")
	sessionWorks(t, e, ws, refresh, 401)

	// Turning the provider off ends its sessions at the next refresh.
	e.Exec(`UPDATE contacts SET email=$2 WHERE id=$1`, cid, email)
	refresh = relinked("s-back")
	sessionWorks(t, e, ws, refresh, 200)
	e.Exec(`UPDATE brands SET portal_auth_mode='local', portal_oidc_issuer='', portal_oidc_client_id='', portal_oidc_client_secret_enc=NULL WHERE id=$1`, ws.BrandID)
	sessionWorks(t, e, ws, refresh, 401)
}

func TestSSOHonoursTheBrandsMode(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	p := newIDP(t)

	// A local portal has no provider sign-in.
	res := e.Do("GET", ssoPath(ws, "start"), hdtest.Auth{}, nil)
	if res.Status != http.StatusFound || !strings.Contains(res.Header.Get("Location"), "sso_error=sso_unavailable") {
		t.Fatalf("local start: %d %s", res.Status, res.Header.Get("Location"))
	}

	useIDP(t, e, ws, p, "oidc", false)
	var cfg struct {
		AuthMode string `json:"auth_mode"`
	}
	e.Do("GET", base(ws)+"/config", hdtest.Auth{}, nil).Want(t, 200).JSON(t, &cfg)
	if cfg.AuthMode != "oidc" {
		t.Fatalf("config auth_mode %q", cfg.AuthMode)
	}
	// Provider only: no password sign-in, no password link.
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 403)
	e.Do("POST", base(ws)+"/auth/forgot", hdtest.Auth{}, map[string]any{"email": email}).Want(t, 204)
	if jobs := e.Jobs("customer_portal_forgot", ws.ID); len(jobs) != 0 {
		t.Fatalf("a provider-only portal queued %d password links", len(jobs))
	}

	// Either way: the provider works and the password route still answers as before.
	useIDP(t, e, ws, p, "local_and_oidc", false)
	browserSignIn(t, e, ws, p, claimsFor("s-both", email), nil).mustSucceed(t, ws)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 401)
}

func TestSSOReturnPathStaysInsideThePortal(t *testing.T) {
	home := "/portal/acme"
	for raw, want := range map[string]string{
		"":                                 home,
		"/portal/acme":                     home,
		"/portal/acme/tickets/12":          "/portal/acme/tickets/12",
		"/portal/acme?x=1":                 "/portal/acme?x=1",
		"/portal/acmeevil":                 home,
		"/portal/other/tickets":            home,
		"//evil.example/portal/acme":       home,
		"https://evil.example/portal/acme": home,
		"/portal/acme/../../admin":         home,
		"/portal/acme\\@evil":              home,
		"/app/tickets":                     home,
	} {
		if got := ssoReturnPath("acme", raw); got != want {
			t.Errorf("%q -> %q, want %q", raw, got, want)
		}
	}
}
