package panels

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
)

// offered is the actions block a URL answers a lookup with.
const offered = `{"type":"actions","items":[
	{"id":"create_invoice","label":"Create invoice","confirm":"Create an invoice for this order?","inputs":[
		{"name":"amount","label":"Amount","type":"text","required":true,"max_length":10},
		{"name":"reason","label":"Reason","type":"select","options":[{"value":"late","label":"Late"},{"value":"damaged"}],"default":"late"},
		{"name":"note","label":"Note","type":"textarea"}]},
	{"id":"refuse","label":"Refuse","tone":"danger"},
	{"id":"boom","label":"Break"},
	{"id":"denied","label":"Denied"},
	{"id":"create_invoice","label":"Duplicate id"}]}`

func actionServer(t *testing.T, secret func() string) (*httptest.Server, *[]actionRequest, *[]http.Header) {
	t.Helper()
	var mu sync.Mutex
	var seen []actionRequest
	var headers []http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var probe struct {
			Event string `json:"event"`
		}
		_ = json.Unmarshal(body, &probe)
		if r.Header.Get("OD-Panel-Event") != probe.Event {
			t.Errorf("header event %q, body event %q", r.Header.Get("OD-Panel-Event"), probe.Event)
		}
		if probe.Event == "lookup" {
			_, _ = io.WriteString(w, `{"version":2,"cache_seconds":0,"blocks":[{"type":"note","text":"Order S00042"},`+offered+`]}`)
			return
		}
		var req actionRequest
		_ = json.Unmarshal(body, &req)
		sig := r.Header.Get("OD-Signature")
		ts := strings.TrimPrefix(strings.SplitN(sig, ",", 2)[0], "t=")
		if n, _ := strconv.ParseInt(ts, 10, 64); sig != sign([]byte(secret()), n, body) || time.Since(time.Unix(n, 0)) > time.Minute {
			t.Errorf("signature %q does not verify", sig)
		}
		mu.Lock()
		seen = append(seen, req)
		headers = append(headers, r.Header.Clone())
		mu.Unlock()
		switch req.Action.ID {
		case "create_invoice":
			_, _ = io.WriteString(w, `{"message":"Invoice INV-9 created","tone":"success","blocks":[{"type":"note","text":"Invoice INV-9 sent."}]}`)
		case "refuse":
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"message":"An invoice already exists."}`)
		case "denied":
			w.WriteHeader(http.StatusUnauthorized)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen, &headers
}

func TestPanelActions(t *testing.T) {
	e, ws := apiEnv(t)
	var secret string
	srv, seen, headers := actionServer(t, func() string { return secret })
	admin, agent, viewer := ws.Admin.As(ws), ws.Agent.As(ws), ws.Viewer.As(ws)
	var created struct {
		Panel  Panel  `json:"panel"`
		Secret string `json:"secret"`
	}
	e.Do("POST", "/v1/ticket-panels", admin, map[string]any{"kind": "http", "url": srv.URL + "/panel"}).Want(t, 201).JSON(t, &created)
	secret = created.Secret
	tk := newTicket(t, e, agent, "ada@example.com", nil)
	base := "/v1/tickets/" + tk + "/panels/" + created.Panel.ID.String()

	// The answer's actions are cleaned: a duplicate id is dropped.
	d := readPanel(t, e, base, viewer)
	var actions []PanelAction
	for _, b := range d.Blocks {
		actions = append(actions, b.Actions...)
	}
	if len(actions) != 4 || actions[0].ID != "create_invoice" || actions[0].Label != "Create invoice" || actions[0].Confirm == "" || len(actions[0].Inputs) != 3 || actions[1].Tone != "danger" {
		t.Fatalf("actions = %+v", actions)
	}
	in := actions[0].Inputs
	if in[0].MaxLength != 10 || !in[0].Required || in[1].Type != "select" || in[1].Default != "late" || in[1].Options[1].Label != "damaged" || in[2].MaxLength != 500 {
		t.Fatalf("inputs = %+v", in)
	}

	press := func(a hdtest.Auth, body map[string]any) *hdtest.Resp {
		return e.Do("POST", base+"/actions", a, body)
	}
	good := map[string]any{"action": "create_invoice", "inputs": map[string]string{"amount": " 120.00 ", "reason": "damaged", "note": "line1\nline2"}, "locale": "fr"}

	// A viewer, and an API key, may not press it.
	press(viewer, good).Want(t, 403)
	key := e.APIKey(ws, "tickets:write")
	press(hdtest.Auth{Bearer: key, Workspace: ws.ID}, good).Want(t, 403)

	// What the agent filled in is checked against the form the URL asked for.
	for name, body := range map[string]map[string]any{
		"unknown action":   {"action": "nope"},
		"missing required": {"action": "create_invoice", "inputs": map[string]string{"reason": "late"}},
		"unknown input":    {"action": "create_invoice", "inputs": map[string]string{"amount": "1", "extra": "x"}},
		"not an option":    {"action": "create_invoice", "inputs": map[string]string{"amount": "1", "reason": "other"}},
		"too long":         {"action": "create_invoice", "inputs": map[string]string{"amount": "12345678901"}},
		"control char":     {"action": "create_invoice", "inputs": map[string]string{"amount": "1\x07"}},
		"newline in text":  {"action": "create_invoice", "inputs": map[string]string{"amount": "1\n2"}},
	} {
		want := 422
		if name == "unknown action" {
			want = 409
		}
		if r := press(agent, body); r.Status != want {
			t.Errorf("%s: %d %s", name, r.Status, r.Body)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests went out for refused presses", len(*seen))
	}

	var res ActionResult
	press(agent, good).Want(t, 200).JSON(t, &res)
	if !res.OK || res.Message != "Invoice INV-9 created" || res.Tone != "success" || res.Data == nil || len(res.Data.Blocks) != 1 || res.Data.Blocks[0].Text != "Invoice INV-9 sent." {
		t.Fatalf("result = %+v", res)
	}
	if len(*seen) != 1 {
		t.Fatalf("requests = %d", len(*seen))
	}
	got := (*seen)[0]
	if got.Event != "action" || got.PanelID != created.Panel.ID || got.Locale != "fr" || got.Action.Inputs["amount"] != "120.00" || got.Action.Inputs["note"] != "line1\nline2" ||
		got.Agent.Name == "" || got.Agent.Email == "" || got.Ticket.ID.String() != tk || got.Contact.Email != "ada@example.com" || got.RequestID.String() == "" {
		t.Fatalf("request = %+v", got)
	}
	if h := (*headers)[0]; h.Get("OD-Request-Id") != got.RequestID.String() || h.Get("OD-Panel-Id") != created.Panel.ID.String() {
		t.Fatalf("headers = %v", h)
	}

	// It is on the ticket's timeline and in the audit log, without what was filled in.
	var acts struct {
		Data []domain.Activity `json:"data"`
	}
	e.Do("GET", "/v1/tickets/"+tk+"/activities", agent, nil).Want(t, 200).JSON(t, &acts)
	found := 0
	for _, a := range acts.Data {
		if a.Type == ActivityPanelAction {
			found++
			if a.Data["action"] != "create_invoice" || a.Data["ok"] != true || a.Actor.User == nil || strings.Contains(string(mustJSON(a.Data)), "120.00") {
				t.Fatalf("entry = %+v", a)
			}
		}
	}
	var audited int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'ticket_panel.action' AND NOT (data::text LIKE '%120.00%')`, &audited, ws.ID)
	if found != 1 || audited != 1 {
		t.Fatalf("timeline entries %d, audit entries %d", found, audited)
	}

	// The URL's own refusal is shown in its words; an outage and refused credentials say so.
	press(agent, map[string]any{"action": "refuse"}).Want(t, 200).JSON(t, &res)
	if res.OK || res.Message != "An invoice already exists." || res.Tone != "danger" {
		t.Fatalf("refused = %+v", res)
	}
	press(agent, map[string]any{"action": "boom"}).Want(t, 200).JSON(t, &res)
	if res.OK || res.Tone != "danger" || strings.Contains(res.Message, srv.URL) {
		t.Fatalf("outage = %+v", res)
	}
	press(agent, map[string]any{"action": "denied"}).Want(t, 200).JSON(t, &res)
	if res.OK || !strings.Contains(res.Message, "signing secret") {
		t.Fatalf("denied = %+v", res)
	}
	var panels struct {
		Data []Panel `json:"data"`
	}
	e.Do("GET", "/v1/ticket-panels", admin, nil).Want(t, 200).JSON(t, &panels)
	if panels.Data[0].Status != "error" {
		t.Fatalf("a refused signature should mark the panel: %+v", panels.Data[0])
	}
}

func TestPanelActionScope(t *testing.T) {
	e, ws := apiEnv(t)
	srv, seen, _ := actionServer(t, func() string { return "" })
	admin, agent := ws.Admin.As(ws), ws.Agent.As(ws)
	var created struct {
		Panel Panel `json:"panel"`
	}
	e.Do("POST", "/v1/ticket-panels", admin, map[string]any{"kind": "http", "url": srv.URL + "/panel"}).Want(t, 201).JSON(t, &created)
	tk := newTicket(t, e, agent, "ada@example.com", nil)
	path := "/v1/tickets/" + tk + "/panels/" + created.Panel.ID.String() + "/actions"
	// Another workspace reaches neither the panel nor the ticket.
	other := e.NewWorkspace()
	e.Do("POST", path, other.Agent.As(other), map[string]any{"action": "refuse"}).Want(t, 404)
	// A disabled panel is gone.
	e.Do("PATCH", "/v1/ticket-panels/"+created.Panel.ID.String(), admin, map[string]any{"enabled": false}).Want(t, 200)
	e.Do("POST", path, agent, map[string]any{"action": "refuse"}).Want(t, 404)
	// A Shopify panel has no actions.
	e.Do("PATCH", "/v1/ticket-panels/"+created.Panel.ID.String(), admin, map[string]any{"enabled": true}).Want(t, 200)
	e.Exec(`UPDATE ticket_panels SET kind = 'shopify', target = 'x.myshopify.com' WHERE id = $1`, created.Panel.ID)
	e.Do("POST", path, agent, map[string]any{"action": "refuse"}).Want(t, 422)
	if len(*seen) != 0 {
		t.Fatalf("%d requests went out", len(*seen))
	}
}

func TestActionBlocksAreCleaned(t *testing.T) {
	s := &Service{}
	raw := func(v string) []json.RawMessage { return []json.RawMessage{json.RawMessage(v)} }
	blocks := s.cleanBlocks(raw(`{"type":"actions","items":[
		{"id":"ok","label":"Fine"},
		{"id":"bad id!","label":"Bad id"},
		{"id":"nolabel","label":""},
		{"id":"badform","label":"Bad form","inputs":[{"name":"X","label":"Upper","type":"text"}]},
		{"id":"emptyselect","label":"Empty select","inputs":[{"name":"s","label":"S","type":"select","options":[]}]},
		{"id":"typeless","label":"Typeless","inputs":[{"name":"s","label":"S","type":"date"}]},
		{"id":"five","label":"Too many","inputs":[{"name":"a","label":"A","type":"text"},{"name":"b","label":"B","type":"text"},{"name":"c","label":"C","type":"text"},{"name":"d","label":"D","type":"text"},{"name":"e","label":"E","type":"text"}]},
		{"id":"dup","label":"One","inputs":[{"name":"a","label":"A","type":"text"},{"name":"a","label":"Again","type":"text"}]},
		{"id":"after","label":"After","tone":"danger"}]}`))
	if len(blocks) != 1 || len(blocks[0].Actions) != 2 || blocks[0].Actions[0].ID != "ok" || blocks[0].Actions[1].ID != "after" || blocks[0].Actions[1].Tone != "danger" {
		t.Fatalf("actions = %+v", blocks)
	}
	if got := s.cleanBlocks(raw(`{"type":"actions","items":[{"id":"x","label":"1"},{"id":"y","label":"2"},{"id":"z","label":"3"},{"id":"w","label":"4"},{"id":"v","label":"5"}]}`)); len(got[0].Actions) != maxActions {
		t.Fatalf("more than %d actions: %+v", maxActions, got)
	}
	// Two blocks may not offer one id.
	two := s.cleanBlocks([]json.RawMessage{
		json.RawMessage(`{"type":"actions","items":[{"id":"x","label":"1"}]}`),
		json.RawMessage(`{"type":"actions","items":[{"id":"x","label":"2"}]}`)})
	if len(two) != 1 {
		t.Fatalf("blocks = %+v", two)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
