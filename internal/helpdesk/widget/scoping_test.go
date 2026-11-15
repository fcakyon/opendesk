package widget_test

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

// A signed-in identity is verified per widget secret: another widget's visitor token does
// not carry a signed-in contact over, and the socket token is bound to the widget's brand.
func TestWidgetIdentityPerWidget(t *testing.T) {
	e, ws := setup(t)
	brand2, _ := addBrand(e, ws, "Shop")
	shopID, shopKey := ids.New(), "wk_"+crypto.RandomString(20)
	sealed, err := e.D.Box.Seal([]byte("shop-secret"))
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`INSERT INTO widgets (id, workspace_id, brand_id, name, key, secret_enc) VALUES ($1, $2, $3, 'Shop', $4, $5)`,
		shopID, ws.ID, brand2, shopKey, sealed)

	// Signed in on the default widget.
	signed := start(t, e, map[string]any{"key": ws.WidgetKey, "user_id": "u-42", "user_hash": crypto.HMACHex([]byte("s3cret"), "u-42")})
	// Its token presented to the shop widget, unverified: a new anonymous contact.
	anon := start(t, e, map[string]any{"key": shopKey, "visitor_token": signed.VisitorToken})
	if anon.Contact.ID == signed.Contact.ID {
		t.Fatal("a signed-in contact carried over to another widget without its secret")
	}
	var verified bool
	e.Scalar(`SELECT verified FROM widget_sessions WHERE token_hash = $1`, &verified, crypto.HashToken(anon.VisitorToken))
	if verified {
		t.Fatal("the new session is verified")
	}
	// Verified with the shop's own secret for the same user: the same contact.
	again := start(t, e, map[string]any{"key": shopKey, "visitor_token": signed.VisitorToken,
		"user_id": "u-42", "user_hash": crypto.HMACHex([]byte("shop-secret"), "u-42")})
	if again.Contact.ID != signed.Contact.ID {
		t.Fatal("verified with the widget's secret, the contact did not carry over")
	}
	// An anonymous visitor still carries over.
	plain := start(t, e, map[string]any{"key": ws.WidgetKey})
	if moved := start(t, e, map[string]any{"key": shopKey, "visitor_token": plain.VisitorToken}); moved.Contact.ID != plain.Contact.ID {
		t.Fatal("anonymous visitor did not carry over")
	}

	// The socket token names the widget's brand.
	c, err := e.D.Tokens.Verify(again.WSToken, auth.PurposeWidgetWS)
	if err != nil || c.Brand != brand2.String() {
		t.Fatalf("ws token brand %v %v", c, err)
	}
	c, err = e.D.Tokens.Verify(signed.WSToken, auth.PurposeWidgetWS)
	if err != nil || c.Brand != ws.BrandID.String() {
		t.Fatalf("default ws token brand %v %v", c, err)
	}
}

// A widget of a private team never shows that team's members.
func TestWidgetPrivateTeamFaces(t *testing.T) {
	e, ws := setup(t)
	team := addTeam(e, ws, "Security", ws.Agent.ID)
	e.Exec(`UPDATE widgets SET team_id = $2 WHERE id = $1`, ws.WidgetID, team)
	e.SetWidgetSettings(ws, ws.WidgetID, map[string]any{"show_team": true})
	faces := func() []any {
		m := e.Do("GET", "/v1/widget/config?key="+ws.WidgetKey, hdtest.Auth{}, nil).Want(t, 200).Map(t)
		f, _ := m["team"].([]any)
		return f
	}
	if len(faces()) != 1 {
		t.Fatal("public team faces")
	}
	e.Exec(`UPDATE teams SET private = true WHERE id = $1`, team)
	if f := faces(); len(f) != 0 {
		t.Fatalf("private team faces %v", f)
	}
}

// Every member reads widget names for inbox filters; nothing else of them.
func TestWidgetSummary(t *testing.T) {
	e, ws := setup(t)
	var out struct {
		Data []map[string]any `json:"data"`
	}
	e.Do("GET", "/v1/widgets/summary", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &out)
	if len(out.Data) != 1 || out.Data[0]["id"] != ws.WidgetID.String() || out.Data[0]["name"] != "Website" ||
		out.Data[0]["brand_id"] != ws.BrandID.String() || len(out.Data[0]) != 3 {
		t.Fatalf("summary %v", out.Data)
	}
	other := e.NewWorkspace()
	e.Do("GET", "/v1/widgets/summary", other.Viewer.As(other), nil).Want(t, 200).JSON(t, &out)
	if len(out.Data) != 1 || out.Data[0]["id"] != other.WidgetID.String() {
		t.Fatalf("other workspace %v", out.Data)
	}
}

// With show_team off (or a private team), visitor-facing messages withhold agent names and avatars.
func TestWidgetWithholdsAgentIdentityWhenShowTeamOff(t *testing.T) {
	e, ws := setup(t)
	s := start(t, e, map[string]any{"key": ws.WidgetKey})
	conv := e.Do("POST", "/v1/widget/conversations", hdtest.Auth{Visitor: s.VisitorToken}, map[string]any{"body": "Hello"}).Want(t, 201).Map(t)
	cid := conv["conversation"].(map[string]any)["id"].(string)
	e.Do("POST", "/v1/tickets/"+cid+"/messages", ws.Agent.As(ws), map[string]any{"kind": "reply", "body_html": "<p>Hi from agent</p>"}).Want(t, 201)

	e.SetWidgetSettings(ws, ws.WidgetID, map[string]any{"show_team": false})
	out := e.Do("GET", "/v1/widget/conversations/"+cid+"/messages", hdtest.Auth{Visitor: s.VisitorToken}, nil).Want(t, 200).Map(t)
	msgs := out["data"].([]any)
	reply := msgs[len(msgs)-1].(map[string]any)
	author := reply["author"].(map[string]any)
	if author["type"] != "user" || author["user"] != nil {
		t.Fatalf("expected user identity withheld, got %+v", author)
	}
	resumed := e.Do("POST", "/v1/widget/session", hdtest.Auth{}, map[string]any{"key": ws.WidgetKey, "visitor_token": s.VisitorToken}).Want(t, 200).Map(t)
	if latest, ok := resumed["unread_latest"].(map[string]any); !ok || latest["author"].(map[string]any)["user"] != nil {
		t.Fatalf("expected unread_latest user identity withheld, got %+v", resumed["unread_latest"])
	}

	e.SetWidgetSettings(ws, ws.WidgetID, map[string]any{"show_team": true})
	out = e.Do("GET", "/v1/widget/conversations/"+cid+"/messages", hdtest.Auth{Visitor: s.VisitorToken}, nil).Want(t, 200).Map(t)
	msgs = out["data"].([]any)
	reply = msgs[len(msgs)-1].(map[string]any)
	author = reply["author"].(map[string]any)
	if author["user"] == nil {
		t.Fatalf("expected user identity visible when show_team is true, got %+v", author)
	}
}
