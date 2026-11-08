package widget_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type widgetOut struct {
	ID       string          `json:"id"`
	BrandID  string          `json:"brand_id"`
	Name     string          `json:"name"`
	Key      string          `json:"key"`
	TeamID   *string         `json:"team_id"`
	Secret   string          `json:"secret"`
	Settings json.RawMessage `json:"settings"`
	Install  struct {
		Snippet string `json:"snippet"`
	} `json:"install"`
	SeenAt *string `json:"seen_at"`
}

type topic struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	TeamID *string `json:"team_id"`
}

func (w widgetOut) settings(t *testing.T) (s struct {
	Topics         []topic  `json:"topics"`
	OfflineMessage string   `json:"offline_message"`
	EmailFollowUp  bool     `json:"email_follow_up"`
	Attachments    bool     `json:"attachments"`
	FileTypes      []string `json:"attachment_types"`
	Greeting       string   `json:"greeting"`
	Intro          string   `json:"intro"`
	ChatWelcome    bool     `json:"chat_welcome"`
}) {
	t.Helper()
	if err := json.Unmarshal(w.Settings, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func addTeam(e *hdtest.Env, ws hdtest.WS, name string, members ...uuid.UUID) uuid.UUID {
	id := ids.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name) VALUES ($1, $2, $3)`, id, ws.ID, name)
	for _, m := range members {
		e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, id, m)
	}
	return id
}

func addBrand(e *hdtest.Env, ws hdtest.WS, name string) (uuid.UUID, string) {
	id := ids.New()
	slug := "b-" + strings.ToLower(crypto.RandomString(10))
	e.Exec(`INSERT INTO brands (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)`, id, ws.ID, name, slug)
	return id, slug
}

func TestWidgetsCRUD(t *testing.T) {
	e, ws := setup(t)
	admin := ws.Admin.As(ws)
	other := e.NewWorkspace()
	team := addTeam(e, ws, "Sales")
	foreignTeam := addTeam(e, other, "Sales")
	_, seq := e.Events(ws.ID, 0)

	body := map[string]any{"brand_id": ws.BrandID.String(), "name": "Docs site"}
	e.Do("POST", "/v1/widgets", ws.Agent.As(ws), body).Want(t, 403)
	e.Do("GET", "/v1/widgets", ws.Viewer.As(ws), nil).Want(t, 403)
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": other.BrandID.String(), "name": "X"}).Want(t, 422)
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": ws.BrandID.String(), "name": "X", "team_id": foreignTeam.String()}).Want(t, 422)
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": ws.BrandID.String(), "name": "<b>"}).Want(t, 422)

	admin = e.SignedIn(ws.Admin, false).As(ws)
	var w widgetOut
	r := e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": ws.BrandID.String(), "name": "Docs site", "team_id": team.String(),
		"settings": map[string]any{"greeting": "Docs help", "topics": []map[string]any{{"label": "Billing", "team_id": team.String()}, {"id": "bugs", "label": "Bugs"}}}}).
		Want(t, 201)
	r.JSON(t, &w)
	if r.Header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(w.Secret, "wsec_") || !strings.HasPrefix(w.Key, "wk_") ||
		w.TeamID == nil || *w.TeamID != team.String() {
		t.Fatalf("created %+v", w)
	}
	if w.Install.Snippet != `<script src="http://app.test/widget/v1.js" data-key="`+w.Key+`" data-api="http://api.test" async></script>` {
		t.Fatal(w.Install.Snippet)
	}
	st := w.settings(t)
	if st.Greeting != "Docs help" || !st.EmailFollowUp || !st.Attachments || st.FileTypes == nil || len(st.FileTypes) != 0 || len(st.Topics) != 2 || !strings.HasPrefix(st.Topics[0].ID, "tp_") ||
		st.Topics[1].ID != "bugs" || st.Topics[0].TeamID == nil || st.Topics[1].TeamID != nil {
		t.Fatalf("settings %s", w.Settings)
	}
	var ev string
	e.Scalar(`SELECT data::text FROM events WHERE workspace_id = $1 AND type = 'widget.created'`, &ev, ws.ID)
	if strings.Contains(ev, w.Secret) || strings.Contains(ev, "wsec_") {
		t.Fatal("secret in event")
	}
	var got widgetOut
	e.Do("GET", "/v1/widgets/"+w.ID, admin, nil).Want(t, 200).JSON(t, &got)
	if got.Secret != "" {
		t.Fatal("secret shown again")
	}

	for _, bad := range []map[string]any{
		{"settings": map[string]any{"topics": []map[string]any{{"label": "x"}}}},
		{"settings": map[string]any{"topics": []map[string]any{{"label": "Ok", "team_id": foreignTeam.String()}}}},
		{"settings": map[string]any{"topics": []map[string]any{{"id": "a b", "label": "Ok"}}}},
		{"settings": map[string]any{"topics": []map[string]any{{"id": "a", "label": "One"}, {"id": "a", "label": "Two"}}}},
		{"settings": map[string]any{"topics": []map[string]any{{"label": "1a"}, {"label": "2a"}, {"label": "3a"}, {"label": "4a"},
			{"label": "5a"}, {"label": "6a"}, {"label": "7a"}, {"label": "8a"}, {"label": "9a"}}}},
		{"settings": map[string]any{"offline_message": strings.Repeat("a", 301)}},
		{"settings": map[string]any{"intro": strings.Repeat("a", 201)}},
		{"settings": map[string]any{"intro": "<b>Hi</b>"}},
		{"settings": map[string]any{"attachment_types": []string{"png", "svg"}}},
		{"settings": map[string]any{"attachment_types": []string{"exe"}}},
		{"brand_id": other.BrandID.String()},
		{"team_id": foreignTeam.String()},
	} {
		e.Do("PATCH", "/v1/widgets/"+w.ID, admin, bad).Want(t, 422)
	}
	brand2, _ := addBrand(e, ws, "Shop")
	e.Do("PATCH", "/v1/widgets/"+w.ID, admin, map[string]any{"team_id": nil, "brand_id": brand2.String(), "name": "Shop site",
		"settings": map[string]any{"offline_message": "Back at 9", "intro": "  Ask about orders.\r\nWe reply here.  ", "chat_welcome": false, "email_follow_up": false, "attachments": false, "attachment_types": []string{"pdf", "png", "pdf"}}}).Want(t, 200).JSON(t, &got)
	st = got.settings(t)
	if got.TeamID != nil || got.BrandID != brand2.String() || got.Name != "Shop site" || st.OfflineMessage != "Back at 9" || st.Intro != "Ask about orders.\nWe reply here." || st.ChatWelcome || st.EmailFollowUp ||
		st.Attachments || strings.Join(st.FileTypes, ",") != "png,pdf" ||
		st.Greeting != "Docs help" || len(st.Topics) != 2 {
		t.Fatalf("patched %+v %s", got, got.Settings)
	}
	var list struct{ Data []widgetOut }
	e.Do("GET", "/v1/widgets?brand_id="+brand2.String(), admin, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != w.ID {
		t.Fatalf("list %+v", list)
	}
	e.Do("GET", "/v1/widgets", admin, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 2 || list.Data[0].Key != ws.WidgetKey {
		t.Fatalf("list all %+v", list)
	}

	// The legacy settings route stays on the default brand's widget.
	e.Do("PATCH", "/v1/widget/settings", admin, map[string]any{"greeting": "Main"}).Want(t, 200)
	e.Do("GET", "/v1/widgets/"+w.ID, admin, nil).Want(t, 200).JSON(t, &got)
	if got.settings(t).Greeting != "Docs help" {
		t.Fatal("legacy route wrote another widget")
	}

	// At most 50 widgets per brand.
	for i := 0; i < 49; i++ {
		e.Exec(`INSERT INTO widgets (workspace_id, brand_id, name, key) VALUES ($1, $2, 'W', $3)`, ws.ID, brand2, "wk_"+crypto.RandomString(20))
	}
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": brand2.String(), "name": "One too many"}).Want(t, 422)

	e.Do("DELETE", "/v1/widgets/"+w.ID, admin, nil).Want(t, 204)
	e.Do("GET", "/v1/widgets/"+w.ID, admin, nil).Want(t, 404)
	types, _ := e.Events(ws.ID, seq)
	for _, want := range []string{"widget.created", "widget.updated", "widget.deleted"} {
		if !contains(types, want) {
			t.Fatalf("events %v", types)
		}
	}
	var n int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action IN ('widget.created', 'widget.updated', 'widget.deleted')`, &n, ws.ID)
	if n != 3 {
		t.Fatalf("audit %d", n)
	}
}

// The first secret is shown only past the owner-level gate (a recent sign-in, a second
// factor when the user has one); otherwise the admin rotates it to see one.
func TestWidgetCreateSecretGate(t *testing.T) {
	e, ws := setup(t)
	create := func(a hdtest.Auth) map[string]any {
		t.Helper()
		return e.Do("POST", "/v1/widgets", a, map[string]any{"brand_id": ws.BrandID.String(), "name": "Site"}).Want(t, 201).Map(t)
	}
	hidden := func(m map[string]any) bool { _, ok := m["secret"]; return !ok && m["secret_available"] == false }
	if m := create(ws.Admin.As(ws)); !hidden(m) {
		t.Fatalf("secret without a recent sign-in: %v", m)
	}
	key := e.APIKey(ws, "settings:write", "settings:read")
	if m := create(hdtest.Auth{Bearer: key}); !hidden(m) {
		t.Fatalf("secret to an API key: %v", m)
	}
	if m := create(e.SignedIn(ws.Admin, false).As(ws)); m["secret_available"] != true || !strings.HasPrefix(m["secret"].(string), "wsec_") {
		t.Fatalf("signed in without 2FA: %v", m)
	}
	e.Exec(`UPDATE users SET totp_enabled = true WHERE id = $1`, ws.Admin.ID)
	if m := create(e.SignedIn(ws.Admin, false).As(ws)); !hidden(m) {
		t.Fatalf("secret without the second factor: %v", m)
	}
	verified := e.SignedIn(ws.Admin, true).As(ws)
	if m := create(verified); m["secret_available"] != true {
		t.Fatalf("second factor verified: %v", m)
	}
	e.Exec(`UPDATE sessions SET created_at = now() - interval '13 hours' WHERE user_id = $1`, ws.Admin.ID)
	if m := create(verified); !hidden(m) {
		t.Fatalf("secret on an old sign-in: %v", m)
	}
}

func TestWidgetPublicPerBrand(t *testing.T) {
	e, ws := setup(t)
	admin := e.SignedIn(ws.Admin, false).As(ws)
	team := addTeam(e, ws, "Support", ws.Agent.ID)
	brand2, slug2 := addBrand(e, ws, "Shop")
	e.Exec(`UPDATE brands SET help_center_enabled = true, color = '#00aa00' WHERE id = $1`, brand2)

	var w widgetOut
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": brand2.String(), "name": "Shop", "team_id": team.String(),
		"settings": map[string]any{"topics": []map[string]any{{"id": "orders", "label": "Orders", "team_id": team.String()}},
			"offline_message": "We are away", "intro": "Ask about your order", "allowed_origins": []string{"https://shop.example"}}}).Want(t, 201).JSON(t, &w)
	shop := map[string]string{"Origin": "https://shop.example"}

	// Config shows the widget's brand, topics and hours.
	e.Do("GET", "/v1/widget/config?key="+w.Key, hdtest.Auth{Header: map[string]string{"Origin": "https://evil.example"}}, nil).Want(t, 403)
	m := e.Do("GET", "/v1/widget/config?key="+w.Key, hdtest.Auth{Header: shop}, nil).Want(t, 200).Map(t)
	brand, _ := m["brand"].(map[string]any)
	topics, _ := m["topics"].([]any)
	faces, _ := m["team"].([]any)
	if m["title"] != "Shop" || m["workspace_name"] != "Shop" || brand["name"] != "Shop" || brand["color"] != "#00aa00" ||
		m["help_center_url"] != "http://app.test/help/"+slug2 || m["open"] != true || m["offline_message"] != "We are away" || m["intro"] != "Ask about your order" || m["chat_welcome"] != true || m["language"] != "" ||
		len(topics) != 1 || len(faces) != 1 {
		t.Fatalf("config %v", m)
	}
	if tp := topics[0].(map[string]any); tp["id"] != "orders" || tp["label"] != "Orders" || tp["team_id"] != nil {
		t.Fatalf("topic %v", tp)
	}
	// The workspace's fixed language reaches the widget.
	e.Exec(`UPDATE workspaces SET settings = settings || '{"locale": "tr", "locale_fixed": true}' WHERE id = $1`, ws.ID)
	if m := e.Do("GET", "/v1/widget/config?key="+w.Key, hdtest.Auth{Header: shop}, nil).Want(t, 200).Map(t); m["language"] != "tr" || m["locale"] != "tr" {
		t.Fatalf("fixed language %v %v", m["language"], m["locale"])
	}
	e.Exec(`UPDATE teams SET business_hours = '{"enabled": true, "schedule": {}}' WHERE id = $1`, team)
	m = e.Do("GET", "/v1/widget/config?key="+w.Key, hdtest.Auth{Header: shop}, nil).Want(t, 200).Map(t)
	if m["open"] != false {
		t.Fatalf("closed team %v", m)
	}
	// The default widget follows the workspace's hours, which are off.
	m = e.Do("GET", "/v1/widget/config?key="+ws.WidgetKey, hdtest.Auth{}, nil).Want(t, 200).Map(t)
	if m["open"] != true || m["title"] != "Acme "+ws.Slug || m["help_center_url"] != "" {
		t.Fatalf("default config %v", m)
	}

	// Each widget verifies with its own secret.
	defaultHash := crypto.HMACHex([]byte("s3cret"), "user-1")
	e.Do("POST", "/v1/widget/session", hdtest.Auth{Header: shop}, map[string]any{"key": w.Key, "user_id": "user-1", "user_hash": defaultHash}).Want(t, 401)
	s := start(t, e, map[string]any{"key": ws.WidgetKey, "email": "v@example.com"})
	var shopSess session
	e.Do("POST", "/v1/widget/session", hdtest.Auth{Header: shop}, map[string]any{"key": w.Key, "visitor_token": s.VisitorToken,
		"user_id": "user-1", "user_hash": crypto.HMACHex([]byte(w.Secret), "user-1")}).Want(t, 200).JSON(t, &shopSess)

	// The same visitor moving to another widget keeps the contact on a session of that widget.
	var moved session
	e.Do("POST", "/v1/widget/session", hdtest.Auth{Header: shop}, map[string]any{"key": w.Key, "visitor_token": s.VisitorToken}).
		Want(t, 200).JSON(t, &moved)
	if moved.Contact.ID != s.Contact.ID || moved.VisitorToken == s.VisitorToken {
		t.Fatalf("moved %+v", moved)
	}
	var seen bool
	e.Scalar(`SELECT seen_at IS NOT NULL FROM widgets WHERE id = $1`, &seen, uuid.MustParse(w.ID))
	if !seen {
		t.Fatal("seen_at not set")
	}

	va := hdtest.Auth{Visitor: moved.VisitorToken, Header: shop}
	e.Do("POST", "/v1/widget/conversations", va, map[string]any{"body": "Where is my order?", "topic_id": "nope"}).Want(t, 422)
	var created struct {
		Conversation struct {
			ID uuid.UUID `json:"id"`
		} `json:"conversation"`
	}
	e.Do("POST", "/v1/widget/conversations", va, map[string]any{"body": "Where is my order?", "topic_id": "orders",
		"page_url": "https://shop.example/orders/42#top"}).Want(t, 201).JSON(t, &created)
	var brandID, widgetID, teamID uuid.UUID
	var pageURL, via string
	e.Scalar(`SELECT brand_id FROM tickets WHERE id = $1`, &brandID, created.Conversation.ID)
	e.Scalar(`SELECT widget_id FROM tickets WHERE id = $1`, &widgetID, created.Conversation.ID)
	e.Scalar(`SELECT team_id FROM tickets WHERE id = $1`, &teamID, created.Conversation.ID)
	e.Scalar(`SELECT page_url FROM tickets WHERE id = $1`, &pageURL, created.Conversation.ID)
	e.Scalar(`SELECT routed->>'via' FROM tickets WHERE id = $1`, &via, created.Conversation.ID)
	if brandID != brand2 || widgetID.String() != w.ID || teamID != team || pageURL != "https://shop.example/orders/42" || via != "topic" {
		t.Fatal(brandID, widgetID, teamID, pageURL, via)
	}
	var topicID, topicLabel string
	e.Scalar(`SELECT routed->>'topic_id' FROM tickets WHERE id = $1`, &topicID, created.Conversation.ID)
	e.Scalar(`SELECT routed->>'topic_label' FROM tickets WHERE id = $1`, &topicLabel, created.Conversation.ID)
	if topicID != "orders" || topicLabel != "Orders" {
		t.Fatalf("routed topic %q %q", topicID, topicLabel)
	}

	// The default brand's widget lists the default brand's chats only, for the same contact.
	da := hdtest.Auth{Visitor: s.VisitorToken}
	var own struct {
		Conversation struct {
			ID uuid.UUID `json:"id"`
		} `json:"conversation"`
	}
	e.Do("POST", "/v1/widget/conversations", da, map[string]any{"body": "Hi from the main site"}).Want(t, 201).JSON(t, &own)
	e.Scalar(`SELECT brand_id FROM tickets WHERE id = $1`, &brandID, own.Conversation.ID)
	if brandID != ws.BrandID {
		t.Fatal("default widget brand", brandID)
	}
	var list struct {
		Data []struct {
			ID uuid.UUID `json:"id"`
		} `json:"data"`
	}
	e.Do("GET", "/v1/widget/conversations", da, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != own.Conversation.ID {
		t.Fatalf("default list %+v", list)
	}
	e.Do("GET", "/v1/widget/conversations", va, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != created.Conversation.ID {
		t.Fatalf("shop list %+v", list)
	}
	e.Do("GET", "/v1/widget/conversations/"+created.Conversation.ID.String()+"/messages", da, nil).Want(t, 404)

	// Turning a widget off closes its sessions' routes, not the other widget's.
	e.SetWidgetSettings(ws, uuid.MustParse(w.ID), map[string]any{"enabled": false})
	e.Do("GET", "/v1/widget/conversations", va, nil).Want(t, 403)
	e.Do("GET", "/v1/widget/config?key="+w.Key, hdtest.Auth{Header: shop}, nil).Want(t, 404)
	e.Do("GET", "/v1/widget/conversations", da, nil).Want(t, 200)
}

func TestWidgetForwardsFullMessagesPrivately(t *testing.T) {
	e, ws := setup(t)
	admin := ws.Admin.As(ws)
	recipient := "owner-" + ws.ID.String() + "@example.com"
	patch := map[string]any{"settings": map[string]any{"forward_email": recipient}}
	e.Do("PATCH", "/v1/widgets/"+ws.WidgetID.String(), ws.Agent.As(ws), patch).Want(t, 403)
	e.Do("PATCH", "/v1/widgets/"+ws.WidgetID.String(), admin,
		map[string]any{"settings": map[string]any{"forward_email": "invalid"}}).Want(t, 422)
	e.Do("PATCH", "/v1/widgets/"+ws.WidgetID.String(), admin, patch).Want(t, 200)
	config := e.Do("GET", "/v1/widget/config?key="+ws.WidgetKey, hdtest.Auth{}, nil).Want(t, 200)
	if strings.Contains(string(config.Body), recipient) || strings.Contains(string(config.Body), "forward_email") {
		t.Fatal("public widget config exposed the forwarding recipient")
	}
	visitor := start(t, e, map[string]any{"key": ws.WidgetKey, "name": "Visitor", "email": "visitor@example.com"})
	va := hdtest.Auth{Visitor: visitor.VisitorToken}
	body := strings.Repeat("A complete message. ", 50) + "<script>alert(1)</script>"
	var created struct {
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
	}
	response := e.Do("POST", "/v1/widget/conversations", va, map[string]any{"body": body}).Want(t, 201)
	response.JSON(t, &created)
	if strings.Contains(string(response.Body), recipient) {
		t.Fatal("visitor response exposed the forwarding recipient")
	}
	e.Do("POST", "/v1/widget/conversations/"+created.Conversation.ID+"/messages", va, map[string]any{"body": "Second message"}).Want(t, 201)
	var raw []byte
	e.Scalar(`SELECT jsonb_agg(args ORDER BY id) FROM river_job WHERE kind = 'mail.system' AND args->>'to' = $1`, &raw, recipient)
	var messages []struct {
		To, Text, HTML string
		Headers        map[string]string
	}
	if err := json.Unmarshal(raw, &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Headers["Reply-To"] != "visitor@example.com" || messages[0].To != recipient || !strings.Contains(messages[0].Text, body) || !strings.Contains(messages[1].Text, "Second message") {
		t.Fatalf("forwarded messages did not preserve both full bodies: %s", raw)
	}
	if strings.Contains(messages[0].HTML, "<script>") || !strings.Contains(messages[0].HTML, "&lt;script&gt;") {
		t.Fatal("forwarded HTML did not escape visitor markup")
	}
	other := e.NewWorkspace()
	otherRecipient := "owner-" + other.ID.String() + "@example.com"
	e.Do("PATCH", "/v1/widgets/"+other.WidgetID.String(), other.Admin.As(other), map[string]any{"settings": map[string]any{"forward_email": otherRecipient}}).Want(t, 200)
	ov := start(t, e, map[string]any{"key": other.WidgetKey})
	e.Do("POST", "/v1/widget/conversations", hdtest.Auth{Visitor: ov.VisitorToken}, map[string]any{"body": "Other workspace"}).Want(t, 201)
	var otherBody string
	e.Scalar(`SELECT args->>'text' FROM river_job WHERE kind = 'mail.system' AND args->>'to' = $1`, &otherBody, otherRecipient)
	if !strings.Contains(otherBody, "Other workspace") || strings.Contains(otherBody, body) {
		t.Fatal("the second recipient did not receive only its own message")
	}
	e.Do("PATCH", "/v1/widgets/"+ws.WidgetID.String(), admin, map[string]any{"settings": map[string]any{"forward_email": ""}}).Want(t, 200)
	e.Do("POST", "/v1/widget/conversations/"+created.Conversation.ID+"/messages", va, map[string]any{"body": "Forwarding is now off"}).Want(t, 201)
	var count int
	e.Scalar(`SELECT count(*) FROM river_job WHERE kind = 'mail.system' AND args->>'to' = $1`, &count, recipient)
	if count != 2 {
		t.Fatalf("disabled or unrelated widget forwarded a message: %d", count)
	}
}
