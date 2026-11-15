package email

import (
	"net/http"
	"testing"

	"github.com/useopendesk/opendesk/internal/crypto"
)

// helpDeskMail is a supplier help desk's answer: written by a person, marked automatic.
func helpDeskMail(to, subject, extra string) string {
	return "From: Support <service@supplier.test>\r\nTo: " + to + "\r\nSubject: " + subject + "\r\n" +
		"Message-ID: <hd" + crypto.RandomString(10) + "@supplier.test>\r\n" + extra + "\r\nThe replacement ships on Monday.\r\n"
}

func TestKeepAutomaticMail(t *testing.T) {
	w := newWorld(t)
	m := w.mailbox(InboundForwarding, OutboundSystem, nil)
	const subject = "Re: Issue with order 1042"

	// Off (the default): dropped without a ticket.
	if st, reason := w.inbound(w.receive(m, helpDeskMail(m.Email, subject, "Auto-Submitted: auto-generated\r\n"))); st != "ignored" || reason != "auto_submitted" {
		t.Fatalf("off: %s %s, want ignored auto_submitted", st, reason)
	}

	mustExec(t, w.d, `UPDATE mailboxes SET keep_automatic_mail = true WHERE id = $1`, m.ID)
	m, err := loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Generated or bulk mail becomes a ticket nothing automatic answers, a help desk's reply
	// among them (Zendesk marks a person's answer auto-generated).
	for _, extra := range []string{
		"Auto-Submitted: auto-generated\r\n",
		"Precedence: bulk\r\n",
		"Auto-Submitted: auto-generated\r\nX-Auto-Response-Suppress: All\r\nX-Mailer: Zendesk Mailer\r\n",
	} {
		in := w.receive(m, helpDeskMail(m.Email, subject, extra))
		if st, reason := w.inbound(in); st != "processed" {
			t.Fatalf("%q: %s %s, want processed", extra, st, reason)
		}
		var noAuto bool
		if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT no_auto_reply FROM messages WHERE inbound_email_id = $1`, in).Scan(&noAuto); err != nil {
			t.Fatal(err)
		}
		if !noAuto {
			t.Fatalf("%q: kept automatic mail may be answered automatically", extra)
		}
		if msg := w.messageFor(in); msg.FromEmail != "service@supplier.test" {
			t.Fatalf("%q: from %q, want the help desk", extra, msg.FromEmail)
		}
	}
	// An autoresponder stays noise: auto-replied, a loop marker, and an out-of-office, which
	// Exchange marks auto-generated.
	for _, c := range []struct{ subject, extra, reason string }{
		{subject, "Auto-Submitted: auto-replied\r\n", "auto_submitted"},
		{subject, "Auto-Submitted: auto-generated\r\nX-Autoreply: yes\r\n", "auto_submitted"},
		{subject, "Precedence: auto_reply\r\n", "precedence"},
		{"Automatisch antwoord: Issue with order 1042", "Auto-Submitted: auto-generated\r\nX-Auto-Response-Suppress: All\r\n" +
			"X-MS-Exchange-Generated-Message-Source: Mailbox Rules Agent\r\nX-MS-Exchange-Inbox-Rules-Loop: service@supplier.test\r\n", "auto_submitted"},
		{"Automatic reply: Issue with order 1042", "Auto-Submitted: auto-generated\r\n", "auto_submitted"},
	} {
		if st, reason := w.inbound(w.receive(m, helpDeskMail(m.Email, c.subject, c.extra))); st != "ignored" || reason != c.reason {
			t.Fatalf("%q %q: %s %s, want ignored %s", c.subject, c.extra, st, reason, c.reason)
		}
	}
}

func TestKeepAutomaticMailAPI(t *testing.T) {
	w := newWorld(t)
	m := w.mailbox(InboundForwarding, OutboundSystem, nil)
	srv := w.api(w.admin)
	var out Mailbox
	if code := doJSON(t, http.MethodPatch, srv.URL+"/v1/mailboxes/"+m.ID.String(), map[string]any{"keep_automatic_mail": true}, &out); code != 200 || !out.KeepAutomaticMail {
		t.Fatalf("patch: %d %v", code, out.KeepAutomaticMail)
	}
	if n := w.count(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'mailbox.updated' AND data->'changes' ? 'keep_automatic_mail' AND data->>'keep_automatic_mail' = 'true'`, w.wid); n != 1 {
		t.Fatalf("audit %d", n)
	}
	if code := doJSON(t, http.MethodPatch, srv.URL+"/v1/mailboxes/"+m.ID.String(), map[string]any{"keep_automatic_mail": false}, &out); code != 200 || out.KeepAutomaticMail {
		t.Fatalf("off: %d %v", code, out.KeepAutomaticMail)
	}
}
