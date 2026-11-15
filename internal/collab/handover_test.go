package collab

import (
	"testing"
)

// An admin makes a ticket mailbox of an account they connected; nobody else's, and nobody below
// admin. The mailbox reads the address with the account's own connection from new mail on, and
// the account goes unless they keep it.
func TestAPIUseAccountForTickets(t *testing.T) {
	w := newWorld(t)
	mine := w.account(w.owner, ProviderGoogle, VisibilityPrivate, Audience{})
	kept := w.account(w.owner, ProviderMicrosoft, VisibilityPrivate, Audience{})
	theirs := w.account(w.agent, ProviderGoogle, VisibilityShared, Audience{Everyone: true})
	path := func(a *accountRow) string { return "/v1/collab/accounts/" + a.ID.String() + "/use-for-tickets" }

	own := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	if st := doJSON(t, "POST", w.api(w.agent).URL+path(own), map[string]any{}, nil); st != 403 {
		t.Fatalf("an agent: %d, want 403", st)
	}
	if st := doJSON(t, "POST", w.api(w.owner).URL+path(theirs), map[string]any{}, nil); st != 404 {
		t.Fatalf("someone else's shared account: %d, want 404", st)
	}

	srv := w.api(w.owner)
	var out struct {
		MailboxID      string `json:"mailbox_id"`
		AccountRemoved bool   `json:"account_removed"`
	}
	if st := doJSON(t, "POST", srv.URL+path(mine), map[string]any{"name": "Support"}, &out); st != 201 || !out.AccountRemoved {
		t.Fatalf("hand over: %d %+v", st, out)
	}
	var inbound, client, grant, start, addr string
	var sealed []byte
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT inbound_kind, config->>'oauth_client', config->>'oauth_grant', config->>'sync_start', email, credentials_enc
		FROM mailboxes WHERE workspace_id = $1 AND id = $2`, w.wid, out.MailboxID).Scan(&inbound, &client, &grant, &start, &addr, &sealed); err != nil {
		t.Fatal(err)
	}
	if inbound != "google" || client != "collab" || grant != "api" || start != "new" || addr != mine.Email {
		t.Fatalf("mailbox %s %s %s %s %s", inbound, client, grant, start, addr)
	}
	var creds struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := w.d.Box.OpenJSON(sealed, &creds); err != nil || creds.RefreshToken != "rt" {
		t.Fatalf("mailbox credentials: %v %q", err, creds.RefreshToken)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id = $1`, mine.ID); n != 0 {
		t.Fatalf("the account stayed: %d", n)
	}
	if n := w.count(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'mailbox.created_from_collab'`, w.wid); n != 1 {
		t.Fatalf("audit = %d", n)
	}

	// Kept: the account stays beside its mailbox; the same address twice is refused.
	var e apiError
	if st := doJSON(t, "POST", srv.URL+path(kept), map[string]any{"keep_account": true}, &e); st != 201 {
		t.Fatalf("keep: %d %+v", st, e)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id = $1`, kept.ID); n != 1 {
		t.Fatalf("the kept account is gone")
	}
	if st := doJSON(t, "POST", srv.URL+path(kept), map[string]any{"keep_account": true}, nil); st != 409 {
		t.Fatalf("the same address again: %d, want 409", st)
	}
}
