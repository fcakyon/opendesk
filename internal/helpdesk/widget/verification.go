package widget

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/config"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/emails"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/helpsite"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/templates"
)

// A chat visitor verifies the address they gave in the widget with a link we email them
// (contracts/api.md "Contact verification"). The chat goes on either way: verification only
// tells the team the visitor owns the address.
const (
	// verifyLinkTTL is how long a link works.
	verifyLinkTTL = 48 * time.Hour
	// verifyResendAfter is the shortest wait between two links to one contact.
	verifyResendAfter = time.Minute
	// verifyPerDay caps the links of one contact, and those to one address across the
	// workspace's contacts, in 24 hours: typing someone else's address in many chats
	// never floods their inbox.
	verifyPerDay = 5
	// verifyPerIP caps the links one address asks for in an hour, whatever the session.
	verifyPerIP = 10
	// visitorVerifyRequests caps a session's requests a minute, sent or not.
	visitorVerifyRequests = 10
)

// visitorVerification is the visitor's side of their contact's verification.
type visitorVerification struct {
	Status   string     `json:"status" enum:"verified,unverified,none" doc:"verified: the visitor confirmed their address, or is signed in with identity verification; unverified: they gave an address that is not confirmed yet; none: no address"`
	Email    *string    `json:"email" doc:"While unverified: the address a link goes to"`
	SentAt   *time.Time `json:"sent_at" doc:"While unverified: when the newest link that still works was sent; null when none works"`
	ResendAt *time.Time `json:"resend_at" doc:"While unverified: the earliest time another link can be sent"`
}

var errVerifyTooSoon = httpx.E(http.StatusTooManyRequests, "verification_too_soon", "A verification email was sent a moment ago. Try again a little later.")

// verificationOf reads the visitor side of the contact's verification at now.
func verificationOf(ctx context.Context, q db.Querier, wid uuid.UUID, c domain.Contact, now time.Time) (visitorVerification, error) {
	v := visitorVerification{Status: c.Verification.Status}
	if v.Status != domain.VerificationUnverified {
		return v, nil
	}
	addr := domain.ClaimedEmail(c)
	v.Email = &addr
	var sent *time.Time
	if err := q.QueryRow(ctx, `SELECT max(created_at) FROM contact_email_verifications
		WHERE workspace_id = $1 AND contact_id = $2 AND email = $3 AND used_at IS NULL AND expires_at > $4`,
		wid, c.ID, addr, now).Scan(&sent); err != nil {
		return v, err
	}
	v.SentAt = sent
	at, err := nextVerification(ctx, q, wid, c.ID, addr, now)
	if err != nil {
		return v, err
	}
	v.ResendAt = &at
	return v, nil
}

// nextVerification is the earliest time another link may go to the contact at addr: a minute
// after their last one, and within verifyPerDay a day for the contact and for the address.
func nextVerification(ctx context.Context, q db.Querier, wid, cid uuid.UUID, addr string, now time.Time) (time.Time, error) {
	since := now.Add(-24 * time.Hour)
	times := func(sql string, args ...any) ([]time.Time, error) {
		rows, err := q.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowTo[time.Time])
	}
	mine, err := times(`SELECT created_at FROM contact_email_verifications WHERE workspace_id = $1 AND contact_id = $2 AND created_at > $3
		ORDER BY created_at`, wid, cid, since)
	if err != nil {
		return now, err
	}
	theirs, err := times(`SELECT created_at FROM contact_email_verifications WHERE workspace_id = $1 AND email = $2 AND created_at > $3
		ORDER BY created_at`, wid, addr, since)
	if err != nil {
		return now, err
	}
	at := now
	later := func(t time.Time) {
		if t.After(at) {
			at = t
		}
	}
	if n := len(mine); n > 0 {
		later(mine[n-1].Add(verifyResendAfter))
	}
	if n := len(mine); n >= verifyPerDay {
		later(mine[n-verifyPerDay].Add(24 * time.Hour))
	}
	if n := len(theirs); n >= verifyPerDay {
		later(theirs[n-verifyPerDay].Add(24 * time.Hour))
	}
	return at, nil
}

// sendVerification creates a link for the contact's address and queues its email in tx, in
// lang (the widget's language) else the brand's or the workspace's.
func (h *handler) sendVerification(ctx context.Context, tx pgx.Tx, g widgetRow, cid uuid.UUID, addr, lang string, now time.Time) error {
	token := crypto.RandomToken(32)
	if _, err := tx.Exec(ctx, `INSERT INTO contact_email_verifications (id, workspace_id, contact_id, widget_id, email, token_hash, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ids.New(), g.WorkspaceID, cid, g.ID, addr, crypto.HashToken(token), now, now.Add(verifyLinkTTL)); err != nil {
		return err
	}
	// The token rides in the fragment, which browsers never send to a server.
	link := emails.SiteFrom(h.d.Cfg).App("/chat/verify") + "#token=" + url.QueryEscape(token)
	for _, l := range []string{lang, g.BrandLocale, g.WSSettings.Locale} {
		if lang = helpsite.MatchLocale(l); lang != "" {
			break
		}
	}
	subject, m, err := verificationEmail(ctx, tx, h.d.Cfg, g, lang, link, now)
	if err != nil {
		return err
	}
	_, err = h.d.Jobs.InsertTx(ctx, tx, jobs.SystemEmailArgs{To: addr, Subject: subject, HTML: m.HTML, Text: m.Text},
		&river.InsertOpts{Queue: jobs.QueueEmail, MaxAttempts: 8})
	return err
}

// verificationEmail is the link's email: the words of the customer-facing catalogs in lang
// (chat_verify.email_*), in the brand's email layout (contracts/templates.md "Email design").
func verificationEmail(ctx context.Context, q db.Querier, cfg *config.Config, g widgetRow, lang, link string, now time.Time) (string, templates.Email, error) {
	brandID := g.BrandID
	tc, err := templates.Load(ctx, q, cfg, templates.Ref{WorkspaceID: g.WorkspaceID, BrandID: &brandID, Now: now})
	if err != nil {
		return "", templates.Email{}, err
	}
	design, err := templates.LoadDesign(ctx, q, g.WorkspaceID, g.BrandID)
	if err != nil {
		return "", templates.Email{}, err
	}
	brand := tc.BrandName
	if brand == "" {
		brand = g.BrandName
	}
	t := func(key string) string {
		return helpsite.T(lang, "chat_verify."+key, "brand", brand, "hours", int(verifyLinkTTL/time.Hour))
	}
	accent := design.Layout.Accent
	if !templates.ValidColor(accent) {
		accent = tc.BrandColor
	}
	dir := "ltr"
	if helpsite.RTL(lang) {
		dir = "rtl"
	}
	p := func(s string) string { return "<p>" + html.EscapeString(s) + "</p>" }
	body := `<div dir="` + dir + `">` + `<p><strong>` + html.EscapeString(t("title")) + `</strong></p>` +
		p(t("email_intro")) + p(t("email_meanwhile")) +
		`<p style="margin:20px 0"><a href="` + html.EscapeString(link) + `" style="display:inline-block;padding:10px 18px;border:2px solid ` + accent +
		`;border-radius:8px;background-color:#FFFFFF;color:#0A0A0A;text-decoration:none;font-weight:600">` + html.EscapeString(t("button")) + `</a></p>` +
		p(t("email_expiry")) + `<p style="font-size:13px;color:#737373">` + html.EscapeString(t("email_reason")) + `</p></div>`
	text := strings.Join([]string{t("title"), t("email_intro"), t("email_meanwhile"), t("button") + ": " + link, t("email_expiry"), t("email_reason")}, "\n\n")
	return t("email_subject"), tc.RenderEmail(design, templates.Parts{Content: body, ContentText: text}), nil
}

// chatVerificationPage is what the verification page shows of a link.
type chatVerificationPage struct {
	Status      string `json:"status" enum:"pending,verified" doc:"pending: confirming verifies the address; verified: it is already"`
	Email       string `json:"email" doc:"The address the link confirms"`
	BrandName   string `json:"brand_name"`
	BrandColor  string `json:"brand_color" doc:"#rrggbb, or empty"`
	Locale      string `json:"locale" doc:"The brand's language, else the workspace's (BCP 47); empty when not set"`
	LocaleFixed bool   `json:"locale_fixed" doc:"The page always uses locale, whatever the visitor's browser"`
}

// verifyLink is a link row with what its page shows.
type verifyLink struct {
	id, wid, cid uuid.UUID
	email        string
	expires      time.Time
	used         *time.Time
	page         chatVerificationPage
}

var errVerifyLink = httpx.E(http.StatusNotFound, "invalid_link", "This link has expired or was already used.")

// loadVerifyLink finds an open link by token: not expired, its contact not blocked and
// still going by the address it confirms. lock takes the link and its contact for update.
func loadVerifyLink(ctx context.Context, q db.Querier, token string, lock bool) (verifyLink, domain.Contact, error) {
	var l verifyLink
	if token == "" || len(token) > 200 {
		return l, domain.Contact{}, errVerifyLink
	}
	var wsRaw []byte
	var brandName, brandColor, brandLocale *string
	sql := `SELECT v.id, v.workspace_id, v.contact_id, v.email::text, v.expires_at, v.used_at, w.name, w.settings, b.name, b.color, b.locale
		FROM contact_email_verifications v JOIN workspaces w ON w.id = v.workspace_id
		LEFT JOIN widgets g ON g.id = v.widget_id LEFT JOIN brands b ON b.id = g.brand_id
		WHERE v.token_hash = $1 AND w.suspended_at IS NULL`
	if lock {
		sql += ` FOR UPDATE OF v`
	}
	var wsName string
	err := q.QueryRow(ctx, sql, crypto.HashToken(token)).Scan(&l.id, &l.wid, &l.cid, &l.email, &l.expires, &l.used, &wsName, &wsRaw,
		&brandName, &brandColor, &brandLocale)
	if db.IsNotFound(err) {
		return l, domain.Contact{}, errVerifyLink
	}
	if err != nil {
		return l, domain.Contact{}, err
	}
	if lock {
		if _, err := q.Exec(ctx, `SELECT 1 FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, l.wid, l.cid); err != nil {
			return l, domain.Contact{}, err
		}
	}
	c, err := domain.LoadContact(ctx, q, l.wid, l.cid)
	if db.IsNotFound(err) {
		return l, c, errVerifyLink
	}
	if err != nil {
		return l, c, err
	}
	if c.Blocked || !domain.HasAddress(c, l.email) {
		return l, c, errVerifyLink
	}
	verified := c.Verification.Status == domain.VerificationVerified
	// A used or expired link still answers that its address is verified, never that it can be.
	if !verified && (l.used != nil || !time.Now().Before(l.expires)) {
		return l, c, errVerifyLink
	}
	st := hd.ParseSettings(wsRaw)
	p := &l.page
	p.Status, p.Email = "pending", l.email
	if verified {
		p.Status = "verified"
	}
	p.BrandName, p.BrandColor, p.Locale = wsName, st.BrandColor, st.Locale
	if brandName != nil {
		p.BrandName = *brandName
	}
	if brandColor != nil && hexColor.MatchString(*brandColor) {
		p.BrandColor = *brandColor
	}
	if brandLocale != nil && *brandLocale != "" {
		p.Locale = *brandLocale
	}
	p.LocaleFixed = st.LocaleFixed && p.Locale != ""
	return l, c, nil
}

// visitorTopics are the contact topics of each brand where the contact has a widget session.
func visitorTopics(ctx context.Context, tx pgx.Tx, wid, cid uuid.UUID) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT g.brand_id FROM widget_sessions s JOIN widgets g ON g.id = s.widget_id
		WHERE s.workspace_id = $1 AND s.contact_id = $2`, wid, cid)
	if err != nil {
		return nil, err
	}
	brandIDs, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	topics := make([]string, 0, len(brandIDs))
	for _, b := range brandIDs {
		topics = append(topics, events.ContactTopic(wid, cid, b))
	}
	return topics, nil
}

// mergeVerified folds the visitor's contact into the contact that holds the address they just
// verified, when another one does: while the address was unproven the widget kept the visitor
// apart, with the address as their claim (custom.widget_email); proven, the visitor is that
// person, and their contact a duplicate. It returns the contact that stays (uuid.Nil when none
// merged) and the tickets that moved to it. A merge the contacts refuse (one blocked, two
// external ids) leaves them apart. Like any merge it ends the visitor's widget sessions: the
// browser that typed the address is not proven to be the one that opened the link, so it never
// reads the stayer's conversations.
func mergeVerified(ctx context.Context, tx pgx.Tx, wid, cid uuid.UUID, addr string) (uuid.UUID, []uuid.UUID, error) {
	var owner uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM (
			SELECT id, created_at FROM contacts WHERE workspace_id = $1 AND email = $2 AND id <> $3
			UNION ALL
			SELECT c.id, c.created_at FROM contact_emails e JOIN contacts c ON c.workspace_id = e.workspace_id AND c.id = e.contact_id
				WHERE e.workspace_id = $1 AND e.email = $2 AND e.contact_id <> $3
		) o ORDER BY created_at, id LIMIT 1`, wid, addr, cid).Scan(&owner)
	if db.IsNotFound(err) {
		return uuid.Nil, nil, nil
	}
	if err != nil {
		return uuid.Nil, nil, err
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	defer sp.Rollback(ctx) //nolint:errcheck // a no-op once committed
	// The visitor's links go with them, so an opened link still says the address is verified.
	if _, err := sp.Exec(ctx, `UPDATE contact_email_verifications SET contact_id = $3 WHERE workspace_id = $1 AND contact_id = $2`,
		wid, cid, owner); err != nil {
		return uuid.Nil, nil, err
	}
	moved, err := domain.MergeContacts(ctx, sp, wid, cid, owner)
	var refused *httpx.Error
	if errors.As(err, &refused) {
		return uuid.Nil, nil, nil
	}
	if err != nil {
		return uuid.Nil, nil, err
	}
	// The claim came over with the visitor's custom keys; it is the stayer's own address.
	if _, err := sp.Exec(ctx, `UPDATE contacts SET custom = custom - 'widget_email'
		WHERE workspace_id = $1 AND id = $2 AND lower(custom->>'widget_email') = lower($3)`, wid, owner, addr); err != nil {
		return uuid.Nil, nil, err
	}
	return owner, moved, sp.Commit(ctx)
}

// verifiedEvents merges a verified duplicate (mergeVerified), then tells the team what changed
// (contact.updated, or for a merge contact.deleted, contact.updated and ticket.updated like the
// merge route) and the visitor's widgets that they are verified (contact.verified on the contact
// topic of each brand where they had a session; merged: their session ended).
func verifiedEvents(ctx context.Context, tx pgx.Tx, wid, cid uuid.UUID, addr string) error {
	topics, err := visitorTopics(ctx, tx, wid, cid)
	if err != nil {
		return err
	}
	stay, moved, err := mergeVerified(ctx, tx, wid, cid, addr)
	if err != nil {
		return err
	}
	merged := stay != uuid.Nil
	if !merged {
		stay = cid
	} else {
		if err := audit.Log(ctx, tx, nil, wid, "contact.merged", "contact", &stay,
			map[string]any{"from": cid, "tickets": len(moved), "reason": "email_verified"}); err != nil {
			return err
		}
		if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "contact.deleted", Data: map[string]any{"contact_id": cid}}); err != nil {
			return err
		}
	}
	if err := publishContact(ctx, tx, wid, stay, "contact.updated"); err != nil {
		return err
	}
	for _, id := range moved {
		if err := domain.PublishTicketUpdated(ctx, tx, wid, id, []string{"contact_id"}); err != nil {
			return err
		}
	}
	if len(topics) == 0 {
		return nil
	}
	c, err := domain.LoadContact(ctx, tx, wid, stay)
	if err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "contact.verified", Visibility: events.VisibilityPublic,
		Topics: topics, Data: map[string]any{"contact_id": cid, "verification": c.Verification, "merged": merged}})
	return err
}

func (h *handler) registerVerification(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "widget-request-verification", Method: http.MethodPost, Path: "/v1/widget/verification",
		Summary: "Email the visitor a link to verify their address", Tags: []string{"Widget"},
		Description: "The widget calls this after the visitor gives their address in its email form. An unverified visitor gets one link at a " +
			"time: while one still works, nothing is sent again unless resend is true. A verified visitor, or one without an address, gets " +
			"nothing. Resending waits a minute after the last link, and one contact, or one address, gets at most 5 links a day " +
			"(429 verification_too_soon before resend_at). The chat goes on whether or not the visitor verifies."},
		func(ctx context.Context, in *struct {
			Origin string `header:"Origin"`
			Body   struct {
				Resend bool   `json:"resend,omitempty" doc:"Send another link although one still works"`
				Locale string `json:"locale,omitempty" maxLength:"35" doc:"The language the widget shows the visitor (BCP 47), which the email uses; else the brand's, else the workspace's"`
			}
		}) (*struct{ Body visitorVerification }, error) {
			p, g, err := h.visitorWidget(ctx, in.Origin)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := h.allowWrite(p, "verify", visitorVerifyRequests); err != nil {
				return nil, err
			}
			now := time.Now()
			var out visitorVerification
			err = h.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				// One decision per contact at a time: two tabs never send two links.
				if _, err := tx.Exec(ctx, `SELECT 1 FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, p.ContactID); err != nil {
					return err
				}
				c, err := domain.LoadContact(ctx, tx, p.WorkspaceID, p.ContactID)
				if err != nil {
					return err
				}
				if c.Blocked {
					return httpx.E(http.StatusForbidden, "blocked", "This conversation is not available.")
				}
				if out, err = verificationOf(ctx, tx, p.WorkspaceID, c, now); err != nil {
					return err
				}
				if out.Status != domain.VerificationUnverified || (out.SentAt != nil && !in.Body.Resend) {
					return nil
				}
				if out.ResendAt != nil && out.ResendAt.After(now) {
					return errVerifyTooSoon
				}
				if !h.d.Limiter.Allow("widget:verify:"+clientIP(ctx), verifyPerIP, time.Hour) {
					return httpx.RateLimited()
				}
				if err := h.sendVerification(ctx, tx, g, c.ID, *out.Email, in.Body.Locale, now); err != nil {
					return err
				}
				out, err = verificationOf(ctx, tx, p.WorkspaceID, c, now)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body visitorVerification }{out}, nil
		})

	mw := huma.Middlewares{h.withClientIP}
	// The link's token rides in the body, never the URL, where proxies and logs keep it.
	huma.Register(api, huma.Operation{OperationID: "get-chat-verification", Method: http.MethodPost, Path: "/v1/public/chat-verification",
		Summary: "Read a chat verification link", Tags: []string{"Public"}, Security: []map[string][]string{}, Middlewares: mw,
		Description: "What the verification page shows before the visitor confirms: reading the link changes nothing, so a mail " +
			"scanner that opens it verifies no one. An expired or used link, or one whose address the contact no longer has, is 404 invalid_link."},
		func(ctx context.Context, in *struct {
			Body struct {
				Token string `json:"token" maxLength:"200"`
			}
		}) (*struct{ Body chatVerificationPage }, error) {
			if !h.d.Limiter.Allow("chat-verify:"+clientIP(ctx), 60, time.Minute) {
				return nil, httpx.RateLimited()
			}
			l, _, err := loadVerifyLink(ctx, h.d.DB.Pool, in.Body.Token, false)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body chatVerificationPage }{l.page}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "confirm-chat-verification", Method: http.MethodPost, Path: "/v1/public/chat-verification/confirm",
		Summary: "Verify a chat visitor's address", Tags: []string{"Public"}, Security: []map[string][]string{}, Middlewares: mw,
		Description: "Marks the link's contact verified for its address (verification.via email), uses up their open links to it, and " +
			"publishes contact.updated and contact.verified. Confirming an address that is already verified changes nothing."},
		func(ctx context.Context, in *struct {
			Body struct {
				Token string `json:"token" maxLength:"200"`
			}
		}) (*struct{ Body chatVerificationPage }, error) {
			if !h.d.Limiter.Allow("chat-verify:"+clientIP(ctx), 30, time.Minute) {
				return nil, httpx.RateLimited()
			}
			var out chatVerificationPage
			err := h.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				l, _, err := loadVerifyLink(ctx, tx, in.Body.Token, true)
				if err != nil {
					return err
				}
				out = l.page
				out.Status = "verified"
				changed, err := domain.MarkEmailVerified(ctx, tx, l.wid, l.cid, l.email)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE contact_email_verifications SET used_at = now()
					WHERE workspace_id = $1 AND contact_id = $2 AND email = $3 AND used_at IS NULL`, l.wid, l.cid, l.email); err != nil {
					return err
				}
				if !changed {
					return nil
				}
				return verifiedEvents(ctx, tx, l.wid, l.cid, l.email)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body chatVerificationPage }{out}, nil
		})
}
