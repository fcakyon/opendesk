package core

import (
	"strings"
	"testing"
)

func TestValidBinding(t *testing.T) {
	for _, ok := range []string{"k", "?", "g p", "mod+k", "mod+shift+p", "alt+shift+n", "shift+s", "f2", "mod+shift+arrowup", "mod+[", `mod+\`, "mod++", "g ?"} {
		if !validBinding(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{"", " ", "shift+mod+k", "mod+mod+k", "mod+", "shift+?", "g p q", "mod+k p", "ctrl+k", "foo", "g  p", "\x00"} {
		if validBinding(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestShortcutsRoutes(t *testing.T) {
	e := newEnv(t)
	u, _ := e.signup("keys")
	// Nothing chosen yet: every shortcut on its default keys.
	r := u.do("GET", "/v1/me/shortcuts", nil)
	if b, _ := r.Body["bindings"].(map[string]any); r.Status != 200 || b == nil || len(b) != 0 {
		t.Fatalf("defaults: %d %s", r.Status, r.Raw)
	}
	r = u.do("PUT", "/v1/me/shortcuts", map[string]any{"bindings": map[string]any{"go.pages": "g o", "go.wiki": nil}})
	if r.Status != 200 {
		t.Fatalf("put: %d %s", r.Status, r.Raw)
	}
	r = u.do("GET", "/v1/me/shortcuts", nil)
	b, _ := r.Body["bindings"].(map[string]any)
	if b["go.pages"] != "g o" || len(b) != 2 {
		t.Fatalf("kept: %s", r.Raw)
	}
	if v, ok := b["go.wiki"]; !ok || v != nil {
		t.Fatalf("turned off: %s", r.Raw)
	}
	// The other workspace prefs on the same row stay as they were.
	if r := u.do("GET", "/v1/me/workspace-prefs", nil); r.Status != 200 {
		t.Fatalf("prefs: %d %s", r.Status, r.Raw)
	}

	for name, body := range map[string]map[string]any{
		"bad keys": {"go.pages": "shift+mod+p"},
		"bad id":   {"Go Pages": "g p"},
		"too many": manyShortcuts(301),
		"too big":  {"go.pages": "g p", "x.y": strings.Repeat("a", 9000)},
	} {
		if r := u.do("PUT", "/v1/me/shortcuts", map[string]any{"bindings": body}); r.Status != 422 {
			t.Errorf("%s: %d %s", name, r.Status, r.Raw)
		}
	}
	// Someone else's keys stay theirs; signed out, nothing.
	o, _ := e.signup("other")
	if r := o.do("GET", "/v1/me/shortcuts", nil); len(r.Body["bindings"].(map[string]any)) != 0 {
		t.Fatalf("leaked: %s", r.Raw)
	}
	if r := e.client().do("GET", "/v1/me/shortcuts", nil); r.Status != 401 {
		t.Fatalf("anonymous: %d", r.Status)
	}
	// Empty puts every shortcut back.
	if r := u.do("PUT", "/v1/me/shortcuts", map[string]any{"bindings": map[string]any{}}); r.Status != 200 || len(r.Body["bindings"].(map[string]any)) != 0 {
		t.Fatalf("reset: %d %s", r.Status, r.Raw)
	}
}

func manyShortcuts(n int) map[string]any {
	out := map[string]any{}
	for i := range n {
		out["go.x"+strings.Repeat("a", i%40)+string(rune('A'+i/40))] = "g p"
	}
	return out
}
