package tickets_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestReplyDraft(t *testing.T) {
	// Uploads are served by the widget area.
	e := hdtest.New(t, tickets.Register, widget.Register)
	ws := e.NewWorkspace()
	tk := createTicket(t, e, ws, map[string]any{"subject": "Draft me", "contact": map[string]any{"email": "d@example.com", "name": "Dee"}})
	path := "/v1/tickets/" + tk.ID.String() + "/reply-draft"
	var got struct{ Draft *tickets.ReplyDraft }

	// Nothing yet.
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft != nil {
		t.Fatalf("draft before saving: %+v", got.Draft)
	}

	// An upload not on a message yet goes with the draft.
	var att struct{ ID uuid.UUID }
	e.Upload("/v1/attachments", ws.Agent.As(ws), "notes.txt", []byte("some notes")).Want(t, 201).JSON(t, &att)
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>Half a reply<script>x</script></p>",
		"attachment_ids": []string{att.ID.String()}}).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || strings.Contains(got.Draft.BodyHTML, "script") || len(got.Draft.Attachments) != 1 || got.Draft.Attachments[0].ID != att.ID {
		t.Fatalf("saved draft: %+v", got.Draft)
	}
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>Half a reply, a bit more</p>",
		"attachment_ids": []string{att.ID.String()}}).Want(t, 200)
	if n := countRows(t, e, `SELECT count(*) FROM ticket_reply_drafts WHERE ticket_id = $1`, tk.ID); n != 1 {
		t.Fatalf("draft rows %d", n)
	}

	// It is the member's alone: a teammate sees none, and keeps their own.
	e.Do("GET", path, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft != nil {
		t.Fatalf("a teammate saw a private draft: %+v", got.Draft)
	}
	e.Do("PUT", path, ws.Admin.As(ws), map[string]any{"body_html": "<p>Mine</p>"}).Want(t, 200)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || !strings.Contains(got.Draft.BodyHTML, "a bit more") {
		t.Fatalf("own draft after a teammate saved: %+v", got.Draft)
	}

	// Another member's upload, a missing ticket, viewers and API keys are refused.
	var theirs struct{ ID uuid.UUID }
	e.Upload("/v1/attachments", ws.Admin.As(ws), "theirs.txt", []byte("x")).Want(t, 201).JSON(t, &theirs)
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>x</p>", "attachment_ids": []string{theirs.ID.String()}}).Want(t, 422)
	e.Do("PUT", "/v1/tickets/999999/reply-draft", ws.Agent.As(ws), map[string]any{"body_html": "<p>x</p>"}).Want(t, 404)
	e.Do("PUT", path, ws.Viewer.As(ws), map[string]any{"body_html": "<p>x</p>"}).Want(t, 403)
	e.Do("GET", path, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeTicketsRead)}, nil).Want(t, 403)

	// The draft's upload outlives the purge of stale uploads, which takes the loose ones.
	e.Exec(`UPDATE attachments SET created_at = now() - interval '3 days' WHERE id = $1`, att.ID)
	loose := ids.New()
	e.Exec(`INSERT INTO attachments (id, workspace_id, filename, size_bytes, storage_key, created_at) VALUES ($1, $2, 'l', 1, 'k', now() - interval '3 days')`, loose, ws.ID)
	if err := tickets.PurgeAttachments(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, e, `SELECT count(*) FROM attachments WHERE id = ANY($1)`, []uuid.UUID{att.ID, loose}); n != 1 {
		t.Fatalf("attachments left after purge: %d", n)
	}

	// Sending the reply clears the author's draft, not a teammate's.
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", ws.Agent.As(ws), map[string]any{"kind": "reply", "body_html": "<p>Sent</p>",
		"attachment_ids": []string{att.ID.String()}}).Want(t, 201)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft != nil {
		t.Fatalf("draft after sending: %+v", got.Draft)
	}
	e.Do("GET", path, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil {
		t.Fatal("a teammate's reply cleared another member's draft")
	}

	// Discarding, and saving nothing, remove it.
	e.Do("DELETE", path, ws.Admin.As(ws), nil).Want(t, 204)
	e.Do("PUT", path, ws.Admin.As(ws), map[string]any{"body_html": "<p>again</p>"}).Want(t, 200)
	e.Do("PUT", path, ws.Admin.As(ws), map[string]any{"body_html": "<p> </p>"}).Want(t, 200).JSON(t, &got)
	if got.Draft != nil || countRows(t, e, `SELECT count(*) FROM ticket_reply_drafts WHERE ticket_id = $1`, tk.ID) != 0 {
		t.Fatalf("an empty save kept a draft: %+v", got.Draft)
	}
}
