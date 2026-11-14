package core

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Keyboard shortcuts (contracts/api.md "Keyboard shortcuts"): the keys a person chose for
// the web app's shortcuts, kept on their own row so they follow them to every device. The
// app owns the list of shortcuts; this checks only the shape of what it stores.

const (
	maxShortcutBytes = 8 << 10
	maxShortcuts     = 300
)

// A shortcut id is "<group>.<name>" in camel case, as the web app's registry names them.
var shortcutID = regexp.MustCompile(`^[a-z][a-zA-Z]{0,30}\.[a-z][a-zA-Z0-9]{0,40}$`)

var namedKeys = map[string]bool{
	"enter": true, "escape": true, "space": true, "tab": true, "backspace": true, "delete": true,
	"arrowup": true, "arrowdown": true, "arrowleft": true, "arrowright": true,
	"home": true, "end": true, "pageup": true, "pagedown": true,
	"f1": true, "f2": true, "f3": true, "f4": true, "f5": true, "f6": true,
	"f7": true, "f8": true, "f9": true, "f10": true, "f11": true, "f12": true,
}

var shortcutMods = []string{"mod", "alt", "shift"}

// validStep is one key press: modifiers once each in the order mod, alt, shift, then a
// key, one printable character or a named key. Shift goes with a letter, digit, ";" or a
// named key; a symbol already carries its shift ("?").
func validStep(step string) (hasMod bool, ok bool) {
	rest, last := step, -1
	var mods []string
	for {
		i := -1
		for j, m := range shortcutMods {
			if strings.HasPrefix(rest, m+"+") && len(rest) > len(m)+1 {
				i = j
				break
			}
		}
		if i < 0 {
			break
		}
		if i <= last {
			return false, false
		}
		last = i
		mods = append(mods, shortcutMods[i])
		rest = rest[len(shortcutMods[i])+1:]
	}
	key := rest
	r := []rune(key)
	if len(r) == 1 {
		if r[0] <= ' ' || r[0] == 0x7f {
			return false, false
		}
	} else if !namedKeys[key] {
		return false, false
	}
	for _, m := range mods {
		if m == "shift" && len(r) == 1 && !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz0123456789;", r[0]) {
			return false, false
		}
	}
	return len(mods) > 0 && mods[0] == "mod", true
}

// validBinding is one or two steps split by one space; a step with mod ends the binding.
func validBinding(b string) bool {
	steps := strings.Split(b, " ")
	if len(steps) == 0 || len(steps) > 2 {
		return false
	}
	for i, s := range steps {
		hasMod, ok := validStep(s)
		if !ok || (hasMod && i < len(steps)-1) {
			return false
		}
	}
	return true
}

// ShortcutBindings maps a shortcut id to the person's keys, or null for one turned off.
type ShortcutBindings map[string]*string

type shortcutsBody struct {
	Bindings ShortcutBindings `json:"bindings" doc:"Shortcut id to the person's keys (\"g p\", \"mod+shift+k\"), or null for a shortcut they turned off. Shortcuts left out use their default keys."`
}

func checkShortcuts(in ShortcutBindings) error {
	if len(in) > maxShortcuts {
		return httpx.Validation("at most 300 shortcuts")
	}
	raw, _ := json.Marshal(in)
	if len(raw) > maxShortcutBytes {
		return httpx.Validation("shortcuts are at most 8 KB")
	}
	for id, keys := range in {
		if !shortcutID.MatchString(id) {
			return httpx.Validation("shortcut ids look like \"go.pages\"")
		}
		if keys != nil && !validBinding(*keys) {
			return httpx.Validation("keys for " + id + " are not a shortcut")
		}
	}
	return nil
}

func loadShortcuts(ctx context.Context, q db.Querier, uid any) (ShortcutBindings, error) {
	out := ShortcutBindings{}
	var raw []byte
	err := q.QueryRow(ctx, `SELECT shortcuts FROM user_workspace_prefs WHERE user_id = $1`, uid).Scan(&raw)
	if db.IsNotFound(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return ShortcutBindings{}, nil
	}
	return out, nil
}

func (s *svc) registerShortcuts(api huma.API) {
	tags := []string{"Account"}

	register(s, api, huma.Operation{OperationID: "get-my-shortcuts", Method: http.MethodGet, Path: "/v1/me/shortcuts",
		Summary: "Get your keyboard shortcuts", Tags: tags,
		Description: "The keys you chose for the web app's shortcuts. Shortcuts left out use their default keys."},
		func(ctx context.Context, _ *struct{}) (*struct{ Body shortcutsBody }, error) {
			p, err := auth.RequireUser(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := loadShortcuts(ctx, s.d.DB.Pool, p.UserID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body shortcutsBody }{shortcutsBody{out}}, nil
		})

	register(s, api, huma.Operation{OperationID: "put-my-shortcuts", Method: http.MethodPut, Path: "/v1/me/shortcuts",
		Summary: "Set your keyboard shortcuts", Tags: tags,
		Description: "Replaces your keys with these (at most 300 shortcuts, 8 KB). An empty object puts every shortcut back on its default keys."},
		func(ctx context.Context, in *struct{ Body shortcutsBody }) (*struct{ Body shortcutsBody }, error) {
			p, err := auth.RequireUser(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body.Bindings
			if b == nil {
				b = ShortcutBindings{}
			}
			if err := checkShortcuts(b); err != nil {
				return nil, err
			}
			raw, err := json.Marshal(b)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if _, err := s.d.DB.Pool.Exec(ctx, `INSERT INTO user_workspace_prefs (user_id, shortcuts, updated_at) VALUES ($1, $2, now())
				ON CONFLICT (user_id) DO UPDATE SET shortcuts = EXCLUDED.shortcuts, updated_at = now()`, p.UserID, raw); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body shortcutsBody }{shortcutsBody{b}}, nil
		})
}
