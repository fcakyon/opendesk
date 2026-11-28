package whatsapp_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/resources"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/whatsapp"
)

func TestMain(m *testing.M) { hdtest.Main(m) }

const (
	phoneID   = "1000001"
	wabaID    = "2000001"
	token     = "meta-token"
	appSecret = "app-secret"
	customer  = "4915123456789"
)

// fakeMeta is the part of the Graph API the engine talks to.
type fakeMeta struct {
	mu      sync.Mutex
	numbers map[string]bool // phone number ids the WABA holds
	sent    []map[string]any
	uploads int
}

func (f *fakeMeta) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"Invalid OAuth access token.","code":190}}`))
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // v26.0, id, [edge]
		switch {
		case r.Method == http.MethodGet && len(parts) == 2:
			_, _ = w.Write([]byte(`{"display_phone_number":"+1 555-0100","verified_name":"Margin Support"}`))
		case r.Method == http.MethodGet && len(parts) == 3 && parts[1] == wabaID && parts[2] == "phone_numbers":
			var data []map[string]string
			for id := range f.numbers {
				data = append(data, map[string]string{"id": id})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		case r.Method == http.MethodPost && len(parts) == 3 && parts[2] == "messages":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			body["from_number"] = parts[1]
			f.sent = append(f.sent, body)
			_, _ = fmt.Fprintf(w, `{"messages":[{"id":"wamid.out%d"}]}`, len(f.sent))
		case r.Method == http.MethodPost && len(parts) == 3 && parts[2] == "media":
			_, _ = io.Copy(io.Discard, r.Body)
			f.uploads++
			_, _ = fmt.Fprintf(w, `{"id":"media-%d"}`, f.uploads)
		default:
			t.Errorf("unexpected Graph API request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func (f *fakeMeta) last(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		t.Fatal("nothing was sent to Meta")
	}
	return f.sent[len(f.sent)-1]
}

func (f *fakeMeta) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

type harness struct {
	e    *hdtest.Env
	ws   hdtest.WS
	s    *whatsapp.Service
	f    *fakeMeta
	conn whatsapp.ConnectionView
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := &fakeMeta{numbers: map[string]bool{phoneID: true}}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	var s *whatsapp.Service
	e := hdtest.New(t, tickets.Register, resources.Register, func(d *deps.Deps, api huma.API, r chi.Router) {
		s = whatsapp.New(d)
		s.SetGraphURL(srv.URL)
		whatsapp.Install(d, s)
		s.Register(api, r)
	})
	ws := e.NewWorkspace()
	h := &harness{e: e, ws: ws, s: s, f: f}
	h.conn = h.connect(t, phoneID)
	return h
}

func (h *harness) connect(t *testing.T, number string) whatsapp.ConnectionView {
	t.Helper()
	var c whatsapp.ConnectionView
	h.e.Do("POST", "/v1/whatsapp/connections", h.ws.Admin.As(h.ws), map[string]any{"credentials": map[string]string{
		"phone_number_id": number, "waba_id": wabaID, "access_token": token, "app_secret": appSecret}}).Want(t, 201).JSON(t, &c)
	return c
}

func sign(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// post sends body to a connection's webhook with the signature header sig ("" for none).
func (h *harness) post(t *testing.T, conn uuid.UUID, body []byte, sig string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", h.e.Srv.URL+"/v1/whatsapp/hooks/"+conn.String(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if sig != "" {
		req.Header.Set("X-Hub-Signature-256", sig)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func delivery(number string, value map[string]any) []byte {
	value["messaging_product"] = "whatsapp"
	value["metadata"] = map[string]string{"display_phone_number": "15550100", "phone_number_id": number}
	body, _ := json.Marshal(map[string]any{"object": "whatsapp_business_account", "entry": []any{
		map[string]any{"id": wabaID, "changes": []any{map[string]any{"field": "messages", "value": value}}}}})
	return body
}

func messageBody(number, id, from, text string) []byte {
	return delivery(number, map[string]any{
		"contacts": []any{map[string]any{"wa_id": from, "profile": map[string]string{"name": "Ana Souza"}}},
		"messages": []any{map[string]any{"from": from, "id": id, "timestamp": strconv.FormatInt(time.Now().Unix(), 10),
			"type": "text", "text": map[string]string{"body": text}}},
	})
}

func statusBody(number, wamid, status string) []byte {
	return delivery(number, map[string]any{"statuses": []any{map[string]any{"id": wamid, "status": status,
		"timestamp": strconv.FormatInt(time.Now().Unix(), 10), "recipient_id": customer}}})
}

// deliver posts a signed delivery and runs what it queued.
func (h *harness) deliver(t *testing.T, body []byte) {
	t.Helper()
	if got := h.post(t, h.conn.ID, body, sign(body, appSecret)); got != 200 {
		t.Fatalf("webhook answered %d", got)
	}
	h.drain(t)
}

// drain runs the queued inbound deliveries, sends and ticket triggers until none are left.
func (h *harness) drain(t *testing.T) {
	t.Helper()
	for i := 0; i < 20; i++ {
		n := 0
		for _, raw := range h.e.Jobs(jobs.WhatsAppInboundArgs{}.Kind(), h.ws.ID) {
			var a jobs.WhatsAppInboundArgs
			_ = json.Unmarshal(raw, &a)
			if err := h.s.ProcessInbound(h.e.Ctx, a); err != nil {
				t.Fatalf("inbound: %v", err)
			}
			n++
		}
		for _, raw := range h.e.Jobs(jobs.WhatsAppSendArgs{}.Kind(), h.ws.ID) {
			var a jobs.WhatsAppSendArgs
			_ = json.Unmarshal(raw, &a)
			if err := h.s.Send(h.e.Ctx, a); err != nil {
				t.Fatalf("send: %v", err)
			}
			n++
		}
		for _, raw := range h.e.Jobs(jobs.TicketTriggerArgs{}.Kind(), h.ws.ID) {
			var a jobs.TicketTriggerArgs
			_ = json.Unmarshal(raw, &a)
			if err := tickets.RunTrigger(h.e.Ctx, h.e.D, a); err != nil {
				t.Fatalf("trigger %s: %v", a.Trigger, err)
			}
			n++
		}
		if n == 0 {
			return
		}
	}
	t.Fatal("jobs did not settle")
}

// ticket is the customer's latest WhatsApp ticket.
func (h *harness) ticket(t *testing.T) domain.Ticket {
	t.Helper()
	var id uuid.UUID
	h.e.Scalar(`SELECT t.id FROM whatsapp_tickets wt JOIN tickets t ON t.id = wt.ticket_id
		WHERE wt.workspace_id = $1 AND wt.wa_id = $2 ORDER BY t.created_at DESC LIMIT 1`, &id, h.ws.ID, customer)
	var tk domain.Ticket
	h.e.Do("GET", "/v1/tickets/"+id.String(), h.ws.Agent.As(h.ws), nil).Want(t, 200).JSON(t, &tk)
	return tk
}

func (h *harness) messages(t *testing.T, tid uuid.UUID) []domain.Message {
	t.Helper()
	var out struct {
		Data []domain.Message `json:"data"`
	}
	h.e.Do("GET", "/v1/tickets/"+tid.String()+"/messages", h.ws.Agent.As(h.ws), nil).Want(t, 200).JSON(t, &out)
	return out.Data
}

func (h *harness) message(t *testing.T, tid, id uuid.UUID) domain.Message {
	t.Helper()
	for _, m := range h.messages(t, tid) {
		if m.ID == id {
			return m
		}
	}
	t.Fatal("message not found")
	return domain.Message{}
}

func (h *harness) reply(t *testing.T, as hdtest.User, tid uuid.UUID, text string) *hdtest.Resp {
	t.Helper()
	return h.e.Do("POST", "/v1/tickets/"+tid.String()+"/messages", as.As(h.ws), map[string]any{"kind": "reply", "body_html": "<p>" + text + "</p>"})
}

func (h *harness) state(t *testing.T, as hdtest.User, tid uuid.UUID) whatsapp.TicketState {
	t.Helper()
	var st whatsapp.TicketState
	h.e.Do("GET", "/v1/tickets/"+tid.String()+"/whatsapp", as.As(h.ws), nil).Want(t, 200).JSON(t, &st)
	return st
}

func wantCode(t *testing.T, r *hdtest.Resp, code string) {
	t.Helper()
	if !strings.Contains(string(r.Body), `"`+code+`"`) {
		t.Fatalf("want %s, got %d %s", code, r.Status, r.Body)
	}
}

func TestWebhookSignature(t *testing.T) {
	h := newHarness(t)
	body := messageBody(phoneID, "wamid.in1", customer, "Hello")
	for name, sig := range map[string]string{"unsigned": "", "wrong secret": sign(body, "other"), "not hex": "sha256=zz", "no prefix": hex.EncodeToString([]byte("x"))} {
		if got := h.post(t, h.conn.ID, body, sig); got != http.StatusUnauthorized {
			t.Errorf("%s: %d", name, got)
		}
	}
	// A signature over another body is no signature for this one.
	if got := h.post(t, h.conn.ID, body, sign(messageBody(phoneID, "wamid.in2", customer, "Other"), appSecret)); got != http.StatusUnauthorized {
		t.Errorf("signed for another body: %d", got)
	}
	var n int
	h.e.Scalar(`SELECT count(*) FROM whatsapp_inbound_events WHERE workspace_id = $1`, &n, h.ws.ID)
	if n != 0 {
		t.Fatalf("%d deliveries stored from refused requests", n)
	}
	if got := h.post(t, uuid.New(), body, sign(body, appSecret)); got != http.StatusNotFound {
		t.Fatalf("unknown connection: %d", got)
	}
	if got := h.post(t, h.conn.ID, body, sign(body, appSecret)); got != 200 {
		t.Fatalf("signed delivery: %d", got)
	}
	// Meta's retry of the same delivery is acknowledged and stored once.
	if got := h.post(t, h.conn.ID, body, sign(body, appSecret)); got != 200 {
		t.Fatalf("retried delivery: %d", got)
	}
	h.e.Scalar(`SELECT count(*) FROM whatsapp_inbound_events WHERE workspace_id = $1`, &n, h.ws.ID)
	if n != 1 {
		t.Fatalf("%d deliveries stored, want 1", n)
	}
	// The verification handshake echoes the challenge only for the connection's verify token.
	res, err := http.Get(h.e.Srv.URL + "/v1/whatsapp/hooks/" + h.conn.ID.String() + "?" + url.Values{
		"hub.mode": {"subscribe"}, "hub.verify_token": {"guess"}, "hub.challenge": {"42"}}.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("handshake with a wrong verify token: %d", res.StatusCode)
	}
}

func TestInboundOpensOneTicket(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "My invoice is wrong"))
	tk := h.ticket(t)
	if tk.Channel != domain.ChannelWhatsApp || tk.Subject != "My invoice is wrong" || tk.Contact == nil || tk.Contact.Name != "Ana Souza" {
		t.Fatalf("ticket %+v", tk)
	}
	h.deliver(t, messageBody(phoneID, "wamid.in2", customer, "Still there?"))
	// A message Meta delivers twice in different deliveries is added once.
	h.deliver(t, messageBody(phoneID, "wamid.in2", customer, "Still there?"))
	ms := h.messages(t, tk.ID)
	if len(ms) != 2 || ms[0].Direction != "inbound" || ms[1].BodyText != "Still there?" {
		t.Fatalf("messages %+v", ms)
	}
	// A number this workspace has not connected is not taken from a delivery that names it.
	h.deliver(t, messageBody("1000999", "wamid.in3", customer, "Wrong number"))
	var n int
	h.e.Scalar(`SELECT count(*) FROM messages WHERE workspace_id = $1 AND provider_message_id = 'wamid.in3'`, &n, h.ws.ID)
	if n != 0 {
		t.Fatal("a message to a number that is not connected was applied")
	}
	h.e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id = $1 AND channel = 'whatsapp'`, &n, h.ws.ID)
	if n != 1 {
		t.Fatalf("%d tickets, want 1", n)
	}
	// Once solved, the next message opens a new ticket.
	h.e.Do("PATCH", "/v1/tickets/"+tk.ID.String(), h.ws.Agent.As(h.ws), map[string]any{"status": "solved"}).Want(t, 200)
	h.deliver(t, messageBody(phoneID, "wamid.in4", customer, "One more thing"))
	h.e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id = $1 AND channel = 'whatsapp'`, &n, h.ws.ID)
	if n != 2 {
		t.Fatalf("%d tickets, want 2", n)
	}
}

func TestReplyWindowAndReceipts(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "Hi"))
	tk := h.ticket(t)
	st := h.state(t, h.ws.Viewer, tk.ID)
	if st.ConnectionID == nil || *st.ConnectionID != h.conn.ID || !st.WindowOpen || st.WindowClosesAt == nil {
		t.Fatalf("state %+v", st)
	}
	var msg domain.Message
	h.reply(t, h.ws.Agent, tk.ID, "Looking now").Want(t, 201).JSON(t, &msg)
	if msg.DeliveryStatus != "pending" {
		t.Fatalf("queued reply is %q", msg.DeliveryStatus)
	}
	h.drain(t)
	sent := h.f.last(t)
	if sent["to"] != customer || sent["type"] != "text" || sent["from_number"] != phoneID {
		t.Fatalf("sent %+v", sent)
	}
	if text, _ := sent["text"].(map[string]any); text["body"] != "Looking now" {
		t.Fatalf("sent text %+v", sent["text"])
	}
	status := func() any { return h.message(t, tk.ID, msg.ID).DeliveryMeta["provider_status"] }
	if status() != "sent" {
		t.Fatalf("status %v", status())
	}
	// Meta's receipts arrive out of order: a status only moves forward.
	h.deliver(t, statusBody(phoneID, "wamid.out1", "read"))
	h.deliver(t, statusBody(phoneID, "wamid.out1", "delivered"))
	h.deliver(t, statusBody(phoneID, "wamid.out1", "failed"))
	if got := h.message(t, tk.ID, msg.ID); got.DeliveryMeta["provider_status"] != "read" || got.DeliveryStatus != "sent" {
		t.Fatalf("after read, delivered and failed: %v %s", got.DeliveryMeta["provider_status"], got.DeliveryStatus)
	}

	// 25 hours later the window is closed: no free-form reply, a template still goes out.
	h.e.Exec(`UPDATE whatsapp_contacts SET last_inbound_at = now() - interval '25 hours' WHERE workspace_id = $1`, h.ws.ID)
	if st := h.state(t, h.ws.Agent, tk.ID); st.WindowOpen || st.ConnectionID == nil {
		t.Fatalf("state after 25 h %+v", st)
	}
	wantCode(t, h.reply(t, h.ws.Agent, tk.ID, "Hello again").Want(t, 422), "whatsapp_window_closed")
	tpl := h.template(t, h.conn.ID, "", "")
	h.e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/whatsapp-template", h.ws.Agent.As(h.ws),
		map[string]any{"template_id": tpl, "params": map[string]string{"1": "Ana"}}).Want(t, 201).JSON(t, &msg)
	if msg.BodyText != "Hi Ana, did our answer help?" {
		t.Fatalf("template body %q", msg.BodyText)
	}
	h.drain(t)
	if sent := h.f.last(t); sent["type"] != "template" || sent["to"] != customer {
		t.Fatalf("sent %+v", sent)
	}
	// A reply written while the window was open is refused by the send once it closed.
	h.e.Exec(`UPDATE whatsapp_contacts SET last_inbound_at = now() WHERE workspace_id = $1`, h.ws.ID)
	h.reply(t, h.ws.Agent, tk.ID, "Late").Want(t, 201).JSON(t, &msg)
	h.e.Exec(`UPDATE whatsapp_contacts SET last_inbound_at = now() - interval '25 hours' WHERE workspace_id = $1`, h.ws.ID)
	before := h.f.count()
	h.drain(t)
	if got := h.message(t, tk.ID, msg.ID); got.DeliveryStatus != "failed" || h.f.count() != before {
		t.Fatalf("a reply after the window closed: %s, %d sends", got.DeliveryStatus, h.f.count()-before)
	}
}

// template stores an approved template on the connection; header is its header type.
func (h *harness) template(t *testing.T, conn uuid.UUID, header, name string) string {
	t.Helper()
	if name == "" {
		name = "follow_up"
	}
	id := uuid.New()
	h.e.Exec(`INSERT INTO whatsapp_templates (id, workspace_id, connection_id, name, language, category, status, header_type, body_content)
		VALUES ($1,$2,$3,$4,'en','UTILITY','APPROVED',$5,'Hi {{1}}, did our answer help?')`, id, h.ws.ID, conn, name, header)
	return id.String()
}

func TestReconnectKeepsTickets(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "Hi"))
	tk := h.ticket(t)
	h.e.Do("DELETE", "/v1/whatsapp/connections/"+h.conn.ID.String(), h.ws.Admin.As(h.ws), nil).Want(t, 204)
	if st := h.state(t, h.ws.Agent, tk.ID); st.ConnectionID != nil {
		t.Fatalf("state while disconnected %+v", st)
	}
	wantCode(t, h.reply(t, h.ws.Agent, tk.ID, "Hello").Want(t, 409), "whatsapp_disconnected")
	// Connected again (a new connection for the same number): the ticket and its window carry on.
	h.conn = h.connect(t, phoneID)
	st := h.state(t, h.ws.Agent, tk.ID)
	if st.ConnectionID == nil || *st.ConnectionID != h.conn.ID || !st.WindowOpen {
		t.Fatalf("state after reconnecting %+v", st)
	}
	var msg domain.Message
	h.reply(t, h.ws.Agent, tk.ID, "Back again").Want(t, 201).JSON(t, &msg)
	h.drain(t)
	if got := h.message(t, tk.ID, msg.ID); got.DeliveryStatus != "sent" || h.f.last(t)["to"] != customer {
		t.Fatalf("reply after reconnecting: %+v", got)
	}
	// The customer's next message joins the same ticket through the new connection.
	h.deliver(t, messageBody(phoneID, "wamid.in2", customer, "Thanks"))
	if again := h.ticket(t); again.ID != tk.ID {
		t.Fatal("a reconnect split the conversation into a new ticket")
	}
}

func TestPermissions(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "Hi"))
	tk := h.ticket(t)
	creds := map[string]string{"phone_number_id": "1000002", "waba_id": wabaID, "access_token": token, "app_secret": appSecret}
	h.e.Do("POST", "/v1/whatsapp/connections", h.ws.Agent.As(h.ws), map[string]any{"credentials": creds}).Want(t, 403)
	h.e.Do("POST", "/v1/whatsapp/connections", h.ws.Admin.As(h.ws), map[string]any{"credentials": creds}).Want(t, 422) // not on the WABA
	bad := map[string]string{"phone_number_id": "../me", "waba_id": wabaID, "access_token": token, "app_secret": appSecret}
	h.e.Do("POST", "/v1/whatsapp/connections", h.ws.Admin.As(h.ws), map[string]any{"credentials": bad}).Want(t, 422)
	bad = map[string]string{"phone_number_id": phoneID, "waba_id": wabaID, "access_token": token, "app_secret": appSecret, "api_version": "v1/../x"}
	h.e.Do("POST", "/v1/whatsapp/connections", h.ws.Admin.As(h.ws), map[string]any{"credentials": bad}).Want(t, 422)
	h.e.Do("DELETE", "/v1/whatsapp/connections/"+h.conn.ID.String(), h.ws.Agent.As(h.ws), nil).Want(t, 403)
	for _, u := range []hdtest.User{h.ws.Agent, h.ws.Admin} {
		body := string(h.e.Do("GET", "/v1/whatsapp/connections", u.As(h.ws), nil).Want(t, 200).Body)
		if strings.Contains(body, token) || strings.Contains(body, appSecret) {
			t.Fatal("credentials are read back")
		}
		if u == h.ws.Agent && strings.Contains(body, "/v1/whatsapp/hooks/") {
			t.Fatal("an agent reads the webhook URL")
		}
	}
	h.reply(t, h.ws.Viewer, tk.ID, "Hello").Want(t, 403)
	h.e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/whatsapp-template", h.ws.Viewer.As(h.ws),
		map[string]any{"template_id": h.template(t, h.conn.ID, "", "")}).Want(t, 403)
	other := h.e.NewWorkspace()
	h.e.Do("GET", "/v1/tickets/"+tk.ID.String()+"/whatsapp", other.Admin.As(other), nil).Want(t, 404)
	h.e.Do("DELETE", "/v1/whatsapp/connections/"+h.conn.ID.String(), other.Admin.As(other), nil).Want(t, 404)
}

func TestPrivateTeamTicket(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "Hi"))
	tk := h.ticket(t)
	team := uuid.New()
	h.e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1,$2,'Legal',true)`, team, h.ws.ID)
	h.e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1,$2)`, team, h.ws.Admin.ID)
	h.e.Exec(`UPDATE tickets SET team_id = $2 WHERE id = $1`, tk.ID, team)
	tpl := h.template(t, h.conn.ID, "", "")
	h.e.Do("GET", "/v1/tickets/"+tk.ID.String()+"/whatsapp", h.ws.Agent.As(h.ws), nil).Want(t, 404)
	h.reply(t, h.ws.Agent, tk.ID, "Hello").Want(t, 404)
	h.e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/whatsapp-template", h.ws.Agent.As(h.ws),
		map[string]any{"template_id": tpl, "params": map[string]string{"1": "Ana"}}).Want(t, 404)
	// A member of the team works it as usual.
	h.state(t, h.ws.Admin, tk.ID)
	h.reply(t, h.ws.Admin, tk.ID, "Hello").Want(t, 201)
}

// file stores an attachment uploaded by user, on message when it is set.
func (h *harness) file(t *testing.T, user uuid.UUID, message *uuid.UUID) string {
	t.Helper()
	id := uuid.New()
	key := "workspaces/" + h.ws.ID.String() + "/attachments/" + id.String()
	content := []byte("%PDF-1.4 the invoice")
	if err := h.e.D.Storage.Put(h.e.Ctx, key, bytes.NewReader(content), int64(len(content)), "application/pdf"); err != nil {
		t.Fatal(err)
	}
	h.e.Exec(`INSERT INTO attachments (id, workspace_id, filename, content_type, size_bytes, storage_key, uploaded_by, message_id)
		VALUES ($1,$2,'invoice.pdf','application/pdf',$3,$4,$5,$6)`, id, h.ws.ID, len(content), key, user, message)
	return id.String()
}

func TestTemplateHeaderFile(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, messageBody(phoneID, "wamid.in1", customer, "Hi"))
	tk := h.ticket(t)
	tpl := h.template(t, h.conn.ID, "DOCUMENT", "invoice_ready")
	send := func(file string) *hdtest.Resp {
		return h.e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/whatsapp-template", h.ws.Agent.As(h.ws),
			map[string]any{"template_id": tpl, "params": map[string]string{"1": "Ana"}, "header_media_id": file})
	}
	// A file on a private team's ticket the agent cannot see.
	var hidden domain.Ticket
	h.e.Do("POST", "/v1/tickets", h.ws.Admin.As(h.ws), map[string]any{"subject": "Legal", "channel": "api", "kind": "note", "body_html": "<p>Contract</p>"}).Want(t, 201).JSON(t, &hidden)
	team := uuid.New()
	h.e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1,$2,'Legal',true)`, team, h.ws.ID)
	h.e.Exec(`UPDATE tickets SET team_id = $2 WHERE id = $1`, hidden.ID, team)
	var note uuid.UUID
	h.e.Scalar(`SELECT id FROM messages WHERE ticket_id = $1 LIMIT 1`, &note, hidden.ID)
	wantCode(t, send(h.file(t, h.ws.Admin.ID, &note)).Want(t, 422), "whatsapp_template_file_missing")
	// Someone else's upload that no message holds yet.
	wantCode(t, send(h.file(t, h.ws.Admin.ID, nil)).Want(t, 422), "whatsapp_template_file_missing")
	if h.f.count() != 0 {
		t.Fatal("a refused file was sent")
	}

	// The agent's own upload goes out and the template reply holds it.
	own := h.file(t, h.ws.Agent.ID, nil)
	var msg domain.Message
	send(own).Want(t, 201).JSON(t, &msg)
	if len(msg.Attachments) != 1 || msg.Attachments[0].ID.String() != own {
		t.Fatalf("the template reply holds %+v", msg.Attachments)
	}
	h.drain(t)
	sent := h.f.last(t)
	if sent["type"] != "template" || h.f.uploads != 1 {
		t.Fatalf("sent %+v after %d uploads", sent, h.f.uploads)
	}
	// A file already on this ticket can fill the header again.
	send(own).Want(t, 201)
	h.drain(t)
	if h.f.uploads != 2 || h.f.count() != 2 {
		t.Fatalf("%d uploads, %d sends", h.f.uploads, h.f.count())
	}
}
