package widget_test

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// Contact verification (contracts/api.md "Contact verification").

type verification struct {
	Status   string  `json:"status"`
	Email    *string `json:"email"`
	SentAt   *string `json:"sent_at"`
	ResendAt *string `json:"resend_at"`
}

type verifySession struct {
	session
	Verification verification `json:"verification"`
}

type verifyPage struct {
	Status    string `json:"status"`
	Email     string `json:"email"`
	BrandName string `json:"brand_name"`
}

func startVerify(t *testing.T, e *hdtest.Env, body map[string]any) verifySession {
	t.Helper()
	var s verifySession
	e.Do("POST", "/v1/widget/session", hdtest.Auth{}, body).Want(t, 200).JSON(t, &s)
	return s
}

func requestVerification(t *testing.T, e *hdtest.Env, a hdtest.Auth, resend bool, status int) verification {
	t.Helper()
	var v verification
	r := e.Do("POST", "/v1/widget/verification", a, map[string]any{"resend": resend}).Want(t, status)
	if status == 200 {
		r.JSON(t, &v)
	}
	return v
}

// verifyMails returns the verification emails queued to addr, oldest first.
func verifyMails(t *testing.T, e *hdtest.Env, addr string) []jobs.SystemEmailArgs {
	t.Helper()
	rows, err := e.D.DB.Pool.Query(e.Ctx, `SELECT args FROM river_job WHERE kind = $1 AND args->>'to' = $2 ORDER BY id`,
		jobs.SystemEmailArgs{}.Kind(), addr)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []jobs.SystemEmailArgs
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var m jobs.SystemEmailArgs
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

var tokenInLink = regexp.MustCompile(`/chat/verify#token=([A-Za-z0-9_%\-]+)`)

func linkToken(t *testing.T, m jobs.SystemEmailArgs) string {
	t.Helper()
	got := tokenInLink.FindStringSubmatch(m.Text)
	if got == nil {
		t.Fatalf("no verification link in %q", m.Text)
	}
	tok, err := url.QueryUnescape(got[1])
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func contactVerification(t *testing.T, e *hdtest.Env, wid, cid uuid.UUID) domain.ContactVerification {
	t.Helper()
	c, err := domain.LoadContact(e.Ctx, e.D.DB.Pool, wid, cid)
	if err != nil {
		t.Fatal(err)
	}
	return c.Verification
}

func TestVerificationSendsOneLinkAndLimitsResends(t *testing.T) {
	e, ws := setup(t)
	e.SetWidgetSettings(ws, uuid.Nil, map[string]any{"require_email": true})
	anon := startVerify(t, e, map[string]any{"key": ws.WidgetKey})
	if anon.Verification.Status != "none" {
		t.Fatalf("anonymous: %+v", anon.Verification)
	}
	a := hdtest.Auth{Visitor: anon.VisitorToken}
	// Without an address there is nothing to verify, and nothing is sent.
	if v := requestVerification(t, e, a, false, 200); v.Status != "none" {
		t.Fatalf("no address: %+v", v)
	}

	// The form takes the address: unverified, and no link until the widget asks for one.
	addr := "ada-" + ws.Slug + "@example.com"
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "visitor_token": anon.VisitorToken, "email": addr, "name": "Ada"})
	if s.Verification.Status != "unverified" || s.Verification.Email == nil || *s.Verification.Email != addr || s.Verification.SentAt != nil {
		t.Fatalf("after the form: %+v", s.Verification)
	}
	if got := contactVerification(t, e, ws.ID, s.Contact.ID); got.Status != domain.VerificationUnverified {
		t.Fatalf("contact after the form: %+v", got)
	}

	v := requestVerification(t, e, a, false, 200)
	if v.Status != "unverified" || v.SentAt == nil || v.ResendAt == nil {
		t.Fatalf("first request: %+v", v)
	}
	mails := verifyMails(t, e, addr)
	// It asks to confirm an address, in the brand's email layout, and in English when neither the
	// widget nor the workspace names a language.
	if len(mails) != 1 || !strings.HasPrefix(mails[0].Subject, "Confirm your email address for ") || !strings.Contains(mails[0].HTML, ">Confirm email address</a>") ||
		!strings.HasPrefix(mails[0].HTML, "<!doctype html>") || strings.Contains(mails[0].HTML+mails[0].Text, "account") {
		t.Fatalf("mails: %+v", mails)
	}
	linkToken(t, mails[0])

	// The form sent again, or the widget asking again, sends nothing while the link works.
	if again := requestVerification(t, e, a, false, 200); *again.SentAt != *v.SentAt {
		t.Fatalf("again: %+v", again)
	}
	if n := len(verifyMails(t, e, addr)); n != 1 {
		t.Fatalf("a duplicate went out: %d", n)
	}
	// Resending waits a minute.
	e.Do("POST", "/v1/widget/verification", a, map[string]any{"resend": true}).Want(t, 429)

	e.Exec(`UPDATE contact_email_verifications SET created_at = created_at - interval '2 minutes' WHERE contact_id = $1`, s.Contact.ID)
	// The email speaks the language the widget shows the visitor.
	e.Do("POST", "/v1/widget/verification", a, map[string]any{"resend": true, "locale": "fr-FR"}).Want(t, 200)
	if mails := verifyMails(t, e, addr); len(mails) != 2 || !strings.HasPrefix(mails[1].Subject, "Confirmez votre adresse e-mail pour ") ||
		!strings.Contains(mails[1].Text, "Confirmer l’adresse e-mail: ") {
		t.Fatalf("resend: %+v", mails)
	}

	// Five a day for the address, whichever contact asks.
	e.Exec(`UPDATE contact_email_verifications SET created_at = created_at - interval '2 minutes' WHERE contact_id = $1`, s.Contact.ID)
	for i := 0; i < 3; i++ {
		e.Exec(`INSERT INTO contact_email_verifications (id, workspace_id, contact_id, email, token_hash, created_at, expires_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 day')`,
			ws.ID, s.Contact.ID, addr, crypto.HashToken(crypto.RandomToken(32)))
	}
	e.Do("POST", "/v1/widget/verification", a, map[string]any{"resend": true}).Want(t, 429)
	if n := len(verifyMails(t, e, addr)); n != 2 {
		t.Fatalf("past the daily cap: %d mails", n)
	}
}

func TestVerificationLinkVerifiesOnConfirmOnly(t *testing.T) {
	e, ws := setup(t)
	addr := "grace-" + ws.Slug + "@example.com"
	anon := startVerify(t, e, map[string]any{"key": ws.WidgetKey})
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "visitor_token": anon.VisitorToken, "email": addr})
	a := hdtest.Auth{Visitor: s.VisitorToken}
	requestVerification(t, e, a, false, 200)
	tok := linkToken(t, verifyMails(t, e, addr)[0])

	// Reading the link (a mail scanner, or the page loading) changes nothing.
	var p verifyPage
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200).JSON(t, &p)
	if p.Status != "pending" || p.Email != addr || p.BrandName == "" {
		t.Fatalf("page: %+v", p)
	}
	if got := contactVerification(t, e, ws.ID, s.Contact.ID); got.Status != domain.VerificationUnverified {
		t.Fatalf("read verified the contact: %+v", got)
	}
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": "nope"}).Want(t, 404)

	_, since := e.Events(ws.ID, 0)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200).JSON(t, &p)
	if p.Status != "verified" {
		t.Fatalf("confirm: %+v", p)
	}
	got := contactVerification(t, e, ws.ID, s.Contact.ID)
	if got.Status != domain.VerificationVerified || got.Via == nil || *got.Via != domain.VerifiedViaEmail || got.VerifiedAt == nil {
		t.Fatalf("contact after confirm: %+v", got)
	}
	types, _ := e.Events(ws.ID, since)
	if strings.Join(types, ",") != "contact.updated,contact.verified" {
		t.Fatalf("events: %v", types)
	}
	// The widget's copy goes to the visitor's contact topic, and says only that they are verified.
	var topics []string
	var data map[string]any
	e.Scalar(`SELECT topics FROM events WHERE workspace_id = $1 AND type = 'contact.verified'`, &topics, ws.ID)
	e.Scalar(`SELECT data FROM events WHERE workspace_id = $1 AND type = 'contact.verified'`, &data, ws.ID)
	wantTopic := "contact:" + ws.ID.String() + ":" + s.Contact.ID.String() + ":" + ws.BrandID.String()
	if !strings.Contains(strings.Join(topics, " "), wantTopic) || data["contact_id"] != s.Contact.ID.String() || data["merged"] != false || len(data) != 3 {
		t.Fatalf("contact.verified: %v %v", topics, data)
	}

	// The widget sees it, and no more emails go out.
	if v := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "visitor_token": s.VisitorToken}); v.Verification.Status != "verified" {
		t.Fatalf("session after confirm: %+v", v.Verification)
	}
	if v := requestVerification(t, e, a, true, 200); v.Status != "verified" {
		t.Fatalf("request after confirm: %+v", v)
	}
	if n := len(verifyMails(t, e, addr)); n != 1 {
		t.Fatalf("mailed a verified visitor: %d", n)
	}
	// Opening the link again says it is verified; confirming again changes nothing.
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200).JSON(t, &p)
	if p.Status != "verified" {
		t.Fatalf("reopened: %+v", p)
	}
	_, since = e.Events(ws.ID, 0)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200)
	if types, _ := e.Events(ws.ID, since); len(types) != 0 {
		t.Fatalf("confirming twice published %v", types)
	}

	// A changed address is not verified until it is confirmed in turn, and the old link is dead.
	e.Exec(`UPDATE contacts SET email = $2 WHERE id = $1`, s.Contact.ID, "other-"+addr)
	if got := contactVerification(t, e, ws.ID, s.Contact.ID); got.Status != domain.VerificationUnverified {
		t.Fatalf("after the address changed: %+v", got)
	}
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 404)
}

func TestVerificationMergesTheDuplicate(t *testing.T) {
	e, ws := setup(t)
	addr := "kim-" + ws.Slug + "@example.com"
	// Kim is a contact already (they emailed before), with a conversation of their own.
	var kim uuid.UUID
	e.Scalar(`INSERT INTO contacts (id, workspace_id, email, name) VALUES (gen_random_uuid(), $1, $2, 'Kim') RETURNING id`, &kim, ws.ID, addr)

	// A visitor types Kim's address: they get a contact of their own, the address only a claim.
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "email": addr})
	if s.Contact.ID == kim || s.Contact.Email != nil || s.Verification.Status != "unverified" {
		t.Fatalf("visitor: %+v %+v", s.Contact, s.Verification)
	}
	a := hdtest.Auth{Visitor: s.VisitorToken}
	chat := e.Do("POST", "/v1/widget/conversations", a, map[string]any{"body": "Where is my order?"}).Want(t, 201).Map(t)
	chatID := chat["conversation"].(map[string]any)["id"].(string)
	requestVerification(t, e, a, false, 200)
	tok := linkToken(t, verifyMails(t, e, addr)[0])

	_, since := e.Events(ws.ID, 0)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200)

	// The visitor was Kim: their contact merged into Kim's, chat and all, and Kim is verified.
	var left int
	e.Scalar(`SELECT count(*) FROM contacts WHERE id = $1`, &left, s.Contact.ID)
	var owner uuid.UUID
	e.Scalar(`SELECT contact_id FROM tickets WHERE id = $1`, &owner, uuid.MustParse(chatID))
	if left != 0 || owner != kim {
		t.Fatalf("merge: visitor left %d, chat now on %v", left, owner)
	}
	got := contactVerification(t, e, ws.ID, kim)
	if got.Status != domain.VerificationVerified || got.Via == nil || *got.Via != domain.VerifiedViaEmail {
		t.Fatalf("kim: %+v", got)
	}
	c, err := domain.LoadContact(e.Ctx, e.D.DB.Pool, ws.ID, kim)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Custom["widget_email"]; ok || c.Email == nil || *c.Email != addr {
		t.Fatalf("kim after the merge: %+v %v", c.Custom, c.Email)
	}
	types, _ := e.Events(ws.ID, since)
	if strings.Join(types, ",") != "contact.deleted,contact.updated,ticket.updated,contact.verified" {
		t.Fatalf("events: %v", types)
	}
	var data map[string]any
	e.Scalar(`SELECT data FROM events WHERE workspace_id = $1 AND type = 'contact.verified'`, &data, ws.ID)
	if data["contact_id"] != s.Contact.ID.String() || data["merged"] != true {
		t.Fatalf("contact.verified: %v", data)
	}
	var audited int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'contact.merged' AND entity_id = $2`, &audited, ws.ID, kim)
	if audited != 1 {
		t.Fatalf("audit: %d", audited)
	}

	// The browser that typed the address is not proven to be Kim's: its session ended, so it
	// never reads Kim's conversations.
	e.Do("GET", "/v1/widget/conversations", a, nil).Want(t, 401)
	// The link still says the address is verified.
	var p verifyPage
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 200).JSON(t, &p)
	if p.Status != "verified" {
		t.Fatalf("reopened: %+v", p)
	}
}

func TestVerificationKeepsApartWhatCannotMerge(t *testing.T) {
	e, ws := setup(t)
	addr := "lee-" + ws.Slug + "@example.com"
	var lee uuid.UUID
	e.Scalar(`INSERT INTO contacts (id, workspace_id, email, name, blocked) VALUES (gen_random_uuid(), $1, $2, 'Lee', true) RETURNING id`, &lee, ws.ID, addr)
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "email": addr})
	requestVerification(t, e, hdtest.Auth{Visitor: s.VisitorToken}, false, 200)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": linkToken(t, verifyMails(t, e, addr)[0])}).Want(t, 200)
	// A blocked contact and one that is not stay two: the visitor is verified on their own.
	if got := contactVerification(t, e, ws.ID, s.Contact.ID); got.Status != domain.VerificationVerified {
		t.Fatalf("visitor: %+v", got)
	}
	if got := contactVerification(t, e, ws.ID, lee); got.Status == domain.VerificationVerified {
		t.Fatalf("blocked contact verified: %+v", got)
	}
	e.Do("GET", "/v1/widget/conversations", hdtest.Auth{Visitor: s.VisitorToken}, nil).Want(t, 200)
}

func TestVerificationLinkExpires(t *testing.T) {
	e, ws := setup(t)
	addr := "lin-" + ws.Slug + "@example.com"
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "email": addr})
	requestVerification(t, e, hdtest.Auth{Visitor: s.VisitorToken}, false, 200)
	tok := linkToken(t, verifyMails(t, e, addr)[0])
	e.Exec(`UPDATE contact_email_verifications SET created_at = now() - interval '49 hours', expires_at = now() - interval '1 hour'
		WHERE contact_id = $1`, s.Contact.ID)
	e.Do("POST", "/v1/public/chat-verification", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 404)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": tok}).Want(t, 404)
	if got := contactVerification(t, e, ws.ID, s.Contact.ID); got.Status != domain.VerificationUnverified {
		t.Fatalf("expired link verified: %+v", got)
	}
	// The visitor can ask for a fresh one at once: none works any more.
	if v := requestVerification(t, e, hdtest.Auth{Visitor: s.VisitorToken}, false, 200); v.SentAt == nil {
		t.Fatalf("fresh link: %+v", v)
	}
}

func TestVerificationByIdentity(t *testing.T) {
	e, ws := setup(t)
	hash := crypto.HMACHex([]byte("s3cret"), "user-9")
	addr := "sam-" + ws.Slug + "@example.com"
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "user_id": "user-9", "user_hash": hash, "email": addr})
	if s.Verification.Status != "verified" {
		t.Fatalf("signed-in session: %+v", s.Verification)
	}
	got := contactVerification(t, e, ws.ID, s.Contact.ID)
	if got.Via == nil || *got.Via != domain.VerifiedViaIdentity {
		t.Fatalf("contact: %+v", got)
	}
	if v := requestVerification(t, e, hdtest.Auth{Visitor: s.VisitorToken}, true, 200); v.Status != "verified" {
		t.Fatalf("request: %+v", v)
	}
	if n := len(verifyMails(t, e, addr)); n != 0 {
		t.Fatalf("mailed a signed-in visitor: %d", n)
	}
	// An address the host page sends without user_hash proves nothing.
	anon := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "email": "page-" + addr})
	if anon.Verification.Status != "unverified" {
		t.Fatalf("unsigned address: %+v", anon.Verification)
	}
}

func TestVerificationMergeKeepsProof(t *testing.T) {
	e, ws := setup(t)
	addr := "mo-" + ws.Slug + "@example.com"
	s := startVerify(t, e, map[string]any{"key": ws.WidgetKey, "email": addr})
	requestVerification(t, e, hdtest.Auth{Visitor: s.VisitorToken}, false, 200)
	e.Do("POST", "/v1/public/chat-verification/confirm", hdtest.Auth{}, map[string]any{"token": linkToken(t, verifyMails(t, e, addr)[0])}).Want(t, 200)

	var into uuid.UUID
	e.Scalar(`INSERT INTO contacts (id, workspace_id, email, name) VALUES (gen_random_uuid(), $1, $2, 'Mo') RETURNING id`, &into, ws.ID, "mo.work-"+ws.Slug+"@example.com")
	tx, err := e.D.DB.Pool.Begin(e.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(e.Ctx)
	if _, err := domain.MergeContacts(e.Ctx, tx, ws.ID, s.Contact.ID, into); err != nil {
		t.Fatal(err)
	}
	c, err := domain.LoadContact(e.Ctx, tx, ws.ID, into)
	if err != nil {
		t.Fatal(err)
	}
	if c.Verification.Status != domain.VerificationVerified || *c.Verification.Via != domain.VerifiedViaEmail {
		t.Fatalf("merged: %+v (emails %v)", c.Verification, c.Emails)
	}
}
