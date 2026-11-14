package brands

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/netsafe"
)

func TestPortalDiscoveryValidation(t *testing.T) {
	var issuer string
	var status = 200
	var redirect bool
	var raw string
	var metadata map[string]string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tenant/.well-known/openid-configuration" {
			t.Errorf("unexpected discovery path %q", r.URL.Path)
		}
		if redirect {
			w.Header().Set("Location", issuer)
			w.WriteHeader(302)
			return
		}
		w.WriteHeader(status)
		if raw != "" {
			_, _ = w.Write([]byte(raw))
			return
		}
		_ = json.NewEncoder(w).Encode(metadata)
	}))
	defer server.Close()
	issuer = server.URL + "/tenant"
	good := func() map[string]string {
		return map[string]string{"issuer": issuer, "authorization_endpoint": server.URL + "/authorize", "token_endpoint": server.URL + "/token", "jwks_uri": server.URL + "/jwks"}
	}
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, test := range []struct {
		name   string
		change func()
		valid  bool
	}{
		{"valid", func() {}, true},
		{"issuer mismatch", func() { metadata["issuer"] += "/wrong" }, false},
		{"missing endpoint", func() { delete(metadata, "token_endpoint") }, false},
		{"non HTTPS endpoint", func() { metadata["jwks_uri"] = "http://127.0.0.1/keys" }, false},
		{"private endpoint", func() { metadata["token_endpoint"] = "https://169.254.169.254/token" }, false},
		{"endpoint credentials", func() { metadata["token_endpoint"] = "https://user:password@127.0.0.1/token" }, false},
		{"redirect", func() { redirect = true }, false},
		{"failure status", func() { status = 500 }, false},
		{"invalid JSON", func() { raw = "{" }, false},
		{"oversized metadata", func() { raw = strings.Repeat(" ", (1<<20)+1) }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			status, redirect, raw = 200, false, ""
			metadata = good()
			test.change()
			err := validatePortalDiscovery(context.Background(), client, netsafe.Guard{Dev: true}, issuer)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v, error=%v", test.valid, err)
			}
		})
	}
}

func TestPortalDiscoveryRefusesUnsafeIssuer(t *testing.T) {
	for _, issuer := range []string{"http://localhost", "https://127.0.0.1", "https://169.254.169.254", "https://user:secret@example.com", "https://example.com?query=1", "https://example.com#fragment"} {
		t.Run(issuer, func(t *testing.T) {
			if err := validatePortalDiscovery(context.Background(), netsafe.Client(false, 0), netsafe.Guard{}, issuer); err == nil {
				t.Fatal("unsafe issuer accepted")
			}
		})
	}
}

func TestPortalAuthInputValidation(t *testing.T) {
	h := &handler{}
	empty := ""
	for _, in := range []*portalAuthIn{
		{Mode: "unsupported"},
		{Mode: "local", Issuer: "https://issuer.example"},
		{Mode: "local", ClientID: "client"},
		{Mode: "local", ClientSecret: &empty},
		{Mode: "oidc"},
		{Mode: "local_and_oidc", ClientID: "client", ClientSecret: &empty},
	} {
		if _, err := h.validatePortalAuth(context.Background(), in); err == nil {
			t.Fatalf("accepted invalid config %+v", in)
		}
	}
	if result, err := h.validatePortalAuth(context.Background(), nil); err != nil || result != nil {
		t.Fatalf("nil config: %v %v", result, err)
	}
	if result, err := h.validatePortalAuth(context.Background(), &portalAuthIn{Mode: "local"}); err != nil || result.Mode != "local" {
		t.Fatalf("local config: %v %v", result, err)
	}
	data, err := json.Marshal(Brand{PortalAuth: PortalAuth{Mode: "oidc"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"issuer", "client_id", "client_secret"} {
		if strings.Contains(string(data), field) {
			t.Fatalf("brand response exposes %s", field)
		}
	}
}

func TestPortalValidationRedaction(t *testing.T) {
	problem := &httpx.Error{Errors: []*huma.ErrorDetail{{Message: "required property mode is missing", Location: "body.portal_auth", Value: map[string]any{"client_secret": "private-secret"}}}}
	redactPortalValidation(problem)
	data, err := json.Marshal(problem)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "private-secret") || !strings.Contains(string(data), "body.portal_auth") || !strings.Contains(string(data), "required property mode is missing") {
		t.Fatalf("unsafe or unhelpful error: %s", data)
	}
}

type portalHumaContext interface{ huma.Context }

type portalTestContext struct {
	portalHumaContext
	operation huma.Operation
}

func (c portalTestContext) Operation() *huma.Operation { return &c.operation }

type portalTestAPI struct{ huma.API }

func (portalTestAPI) Transform(_ huma.Context, _ string, value any) (any, error) { return value, nil }

func TestPortalValidationTransformScope(t *testing.T) {
	api := portalSettingsAPI{API: portalTestAPI{}}
	for _, id := range []string{"create-brand", "update-brand", "delete-brand", "get-brand"} {
		problem := &httpx.Error{Errors: []*huma.ErrorDetail{{Message: "safe field message", Location: "body.name", Value: "chosen value"}}}
		result, err := api.Transform(portalTestContext{operation: huma.Operation{OperationID: id}}, "422", problem)
		if err != nil || result != problem {
			t.Fatalf("transform %s: %v %v", id, result, err)
		}
		wantRedacted := id == "create-brand" || id == "update-brand"
		if (problem.Errors[0].Value == nil) != wantRedacted || problem.Errors[0].Message != "safe field message" || problem.Errors[0].Location != "body.name" {
			t.Fatalf("transform scope %s: %+v", id, problem.Errors[0])
		}
	}
}
