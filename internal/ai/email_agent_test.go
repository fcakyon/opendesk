package ai

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// emailMailbox inserts a mailbox; mode "" leaves email answers off.
func (e *env) emailMailbox(mode string) uuid.UUID {
	e.T.Helper()
	id := ids.New()
	e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, display_name, inbound_kind, forwarding_token, outbound_kind, ai_answers, ai_answers_mode, brand_id)
		VALUES ($1, $2, 'Support', $3, 'Acme Support', 'forwarding', $4, 'system', $5, $6, $7)`, id, e.WS.ID,
		"support-"+crypto.RandomString(6)+"@acme.test", "acme-"+crypto.RandomString(8), mode != "", map[bool]string{true: mode, false: "draft"}[mode != ""],
		e.defaultBrand())
	return id
}

// emailTicket opens an email ticket in the mailbox with a customer's first message.
func (e *env) emailTicket(mailbox uuid.UUID, from, subject, text string) (uuid.UUID, uuid.UUID) {
	e.T.Helper()
	var tid, mid uuid.UUID
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		cid, _, err := domain.UpsertContactByEmail(e.Ctx, tx, e.WS.ID, from, "Jane Doe")
		if err != nil {
			return err
		}
		tk, err := domain.CreateTicket(e.Ctx, tx, domain.NewTicket{WorkspaceID: e.WS.ID, Subject: subject, Channel: domain.ChannelEmail,
			ContactID: &cid, MailboxID: &mailbox})
		if err != nil {
			return err
		}
		tid = tk.ID
		m, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: e.WS.ID, TicketID: tk.ID, Kind: "reply",
			Direction: "inbound", AuthorType: "contact", AuthorContactID: &cid, BodyHTML: "<p>" + text + "</p>", BodyText: text,
			FromEmail: from, Trigger: "none"})
		mid = m.ID
		return err
	})
	if err != nil {
		e.T.Fatal(err)
	}
	return tid, mid
}

// customerReply adds a customer email to a ticket.
func (e *env) customerReply(tid uuid.UUID, text string) uuid.UUID {
	e.T.Helper()
	var mid uuid.UUID
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		m, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: e.WS.ID, TicketID: tid, Kind: "reply",
			Direction: "inbound", AuthorType: "contact", BodyHTML: "<p>" + text + "</p>", BodyText: text, Trigger: "none"})
		mid = m.ID
		return err
	})
	if err != nil {
		e.T.Fatal(err)
	}
	return mid
}

func (e *env) emailAnswer(tid, mid uuid.UUID) {
	e.T.Helper()
	if err := e.S.EmailAnswer(e.Ctx, jobs.AIEmailAnswerArgs{WorkspaceID: e.WS.ID, TicketID: tid, MessageID: mid}); err != nil {
		e.T.Fatalf("email answer: %v", err)
	}
}

func customerEmail() string { return "jane-" + crypto.RandomString(6) + "@customer.test" }

func TestEmailAgent(t *testing.T) {
	e := newEnv(t, opts{billing: true})
	art := e.article("Reset your password", "<p>To reset your password, open the sign-in page and choose Forgot password.</p>", "published")
	if err := e.S.Index(e.Ctx, e.WS.ID, "article", art); err != nil {
		t.Fatal(err)
	}

	// Off by default: nothing happens, no model call.
	off := e.emailMailbox("")
	tid, mid := e.emailTicket(off, customerEmail(), "Password", "How do I reset my password?")
	before := e.F.calls()
	e.emailAnswer(tid, mid)
	if e.F.calls() != before || len(publicMessages(e, tid)) != 1 || e.count(`SELECT count(*) FROM ai_suggested_replies WHERE ticket_id = $1`, tid) != 0 {
		t.Fatal("answered with email answers off")
	}

	// Draft mode: a suggested reply on the ticket, nothing sent.
	draft := e.emailMailbox("draft")
	tid, mid = e.emailTicket(draft, customerEmail(), "Password", "How do I reset my password?")
	_, seq := e.Events(e.WS.ID, 0)
	e.emailAnswer(tid, mid)
	if ms := publicMessages(e, tid); len(ms) != 1 {
		t.Fatalf("draft mode sent a message %+v", ms)
	}
	if n := e.count(`SELECT count(*) FROM river_job WHERE kind = 'email.send_message' AND args->>'workspace_id' = $1`, e.WS.ID.String()); n != 0 {
		t.Fatalf("draft mode queued %d sends", n)
	}
	sys, _ := json.Marshal(e.F.last()["system"])
	if !strings.Contains(string(sys), "support email") || !strings.Contains(userText(e.F.last()), "<customer>") {
		t.Fatal("email prompt not used")
	}
	if tools, _ := e.F.last()["tools"].([]any); len(tools) != 2 {
		t.Fatalf("tools %v", tools)
	}
	var got SuggestedReplyBody
	e.Do("GET", "/v1/tickets/"+tid.String()+"/ai/suggested-reply", e.viewer(), nil).Want(t, 200).JSON(t, &got)
	sr := got.SuggestedReply
	if sr == nil || sr.Status != "pending" || sr.MessageID != mid || !strings.Contains(sr.BodyHTML, "sign-in page") || strings.Contains(sr.BodyHTML, "[1]") ||
		!strings.Contains(sr.BodyHTML, "Best regards") || len(sr.Sources) != 1 {
		t.Fatalf("suggested %+v", sr)
	}
	if types, _ := e.Events(e.WS.ID, seq); !containsStr(types, "ai_suggested_reply.created") {
		t.Fatalf("events %v", types)
	}
	if n := e.count(`SELECT count(*) FROM ai_usage WHERE workspace_id = $1 AND feature = 'answer_email'`, e.WS.ID); n != 1 {
		t.Fatalf("usage %d", n)
	}
	if n := e.count(`SELECT count(*) FROM activities WHERE ticket_id = $1 AND type = 'ai_suggested_reply' AND actor_type = 'ai'`, tid); n != 1 {
		t.Fatalf("activity %d", n)
	}
	// The same job again does nothing.
	before = e.F.calls()
	e.emailAnswer(tid, mid)
	if e.F.calls() != before {
		t.Fatal("handled twice")
	}
	// A viewer cannot send; an agent sends it as Ollie, once.
	sendPath := "/v1/tickets/" + tid.String() + "/ai/suggested-reply/" + sr.ID.String() + "/send"
	e.Do("POST", sendPath, e.viewer(), nil).Want(t, 403)
	var sent domain.Message
	e.Do("POST", sendPath, e.agent(), nil).Want(t, 200).JSON(t, &sent)
	if !sent.AI || sent.Author.Type != "system" || sent.FromName != "Ollie" || sent.DeliveryStatus != "pending" || !strings.Contains(sent.BodyHTML, "sign-in page") {
		t.Fatalf("sent %+v", sent)
	}
	if n := e.count(`SELECT count(*) FROM river_job WHERE kind = 'email.send_message' AND args->>'message_id' = $1`, sent.ID.String()); n != 1 {
		t.Fatal("send not queued through outbound")
	}
	e.Do("POST", sendPath, e.agent(), nil).Want(t, 409)
	e.Do("GET", "/v1/tickets/"+tid.String()+"/ai/suggested-reply", e.agent(), nil).Want(t, 200).JSON(t, &got)
	if got.SuggestedReply != nil {
		t.Fatal("sent suggestion still shown")
	}
	// The next customer email gets a new suggestion; discarding it sends nothing.
	mid2 := e.customerReply(tid, "And on mobile?")
	e.emailAnswer(tid, mid2)
	e.Do("GET", "/v1/tickets/"+tid.String()+"/ai/suggested-reply", e.agent(), nil).Want(t, 200).JSON(t, &got)
	if got.SuggestedReply == nil {
		t.Fatal("no suggestion for the follow-up")
	}
	e.Do("DELETE", "/v1/tickets/"+tid.String()+"/ai/suggested-reply/"+got.SuggestedReply.ID.String(), e.agent(), nil).Want(t, 204)
	e.Do("DELETE", "/v1/tickets/"+tid.String()+"/ai/suggested-reply/"+got.SuggestedReply.ID.String(), e.agent(), nil).Want(t, 204)
	if ms := publicMessages(e, tid); len(ms) != 3 {
		t.Fatalf("messages %d", len(ms))
	}

	// Send mode: Ollie replies through the normal outbound path.
	send := e.emailMailbox("send")
	tid, mid = e.emailTicket(send, customerEmail(), "Password", "How do I reset my password?")
	e.emailAnswer(tid, mid)
	ms := publicMessages(e, tid)
	if len(ms) != 2 || !ms[1].AI || ms[1].Author.Type != "system" || ms[1].FromName != "Ollie" || ms[1].DeliveryStatus != "pending" ||
		!strings.Contains(ms[1].BodyText, "sign-in page") {
		t.Fatalf("send mode %+v", ms)
	}
	if n := e.count(`SELECT count(*) FROM river_job WHERE kind = 'email.send_message' AND args->>'message_id' = $1`, ms[1].ID.String()); n != 1 {
		t.Fatal("reply not queued for sending")
	}
	var act map[string]any
	e.Scalar(`SELECT data FROM activities WHERE ticket_id = $1 AND type = 'ai_answered' AND actor_type = 'ai'`, &act, tid)
	if act["channel"] != "email" {
		t.Fatalf("activity %v", act)
	}

	// The agent hands off: nothing is sent, the ticket waits for the team. An email handoff
	// needs no line first, unlike a chat's: one model call.
	e.F.queue("email", "@tool handoff_to_human {\"reason\":\"refund\"}")
	tid, mid = e.emailTicket(send, customerEmail(), "Refund", "I want my money back for last year")
	before = e.F.calls()
	e.emailAnswer(tid, mid)
	if tk := e.loadTicket(tid); tk.Custom["ai_handoff"] != true || tk.Assignee != nil || len(publicMessages(e, tid)) != 1 || e.F.calls() != before+1 {
		t.Fatalf("handoff %+v", tk.Custom)
	}
	if n := e.count(`SELECT count(*) FROM activities WHERE ticket_id = $1 AND type = 'ai_handoff' AND actor_type = 'ai'`, tid); n != 1 {
		t.Fatalf("handoff activity %d", n)
	}
	// The handoff names the bot that handed over.
	if bot, _ := e.loadTicket(tid).Custom["ai_handoff_bot"].(string); bot == "" ||
		e.count(`SELECT count(*) FROM activities WHERE ticket_id = $1 AND type = 'ai_handoff' AND data->>'bot' = $2`, tid, bot) != 1 {
		t.Fatalf("handoff bot %q", bot)
	}
	// A later email on a handed-off ticket is left to the team.
	before = e.F.calls()
	e.emailAnswer(tid, e.customerReply(tid, "Hello?"))
	if e.F.calls() != before {
		t.Fatal("answered a handed-off ticket")
	}

	// A teammate replied: the agent stays out.
	tid, _ = e.emailTicket(send, customerEmail(), "Password", "How do I reset my password?")
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		_, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: e.WS.ID, TicketID: tid, Kind: "reply", Direction: "outbound",
			AuthorType: "user", AuthorUserID: &e.WS.Agent.ID, BodyHTML: "<p>On it.</p>", BodyText: "On it.", Trigger: "none"})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	mid = e.customerReply(tid, "Thanks, any update?")
	before = e.F.calls()
	e.emailAnswer(tid, mid)
	if e.F.calls() != before || len(publicMessages(e, tid)) != 3 {
		t.Fatal("answered after a teammate replied")
	}

	// Assigned, solved and member-sent tickets are left alone.
	tid, mid = e.emailTicket(send, customerEmail(), "Password", "How do I reset my password?")
	e.Exec(`UPDATE tickets SET assignee_id = $2 WHERE id = $1`, tid, e.WS.Agent.ID)
	tid2, mid2 := e.emailTicket(send, customerEmail(), "Password", "How do I reset my password?")
	e.Exec(`UPDATE tickets SET status = 'solved' WHERE id = $1`, tid2)
	tid3, mid3 := e.emailTicket(send, e.WS.Admin.Email, "Password", "How do I reset my password?")
	before = e.F.calls()
	e.emailAnswer(tid, mid)
	e.emailAnswer(tid2, mid2)
	e.emailAnswer(tid3, mid3)
	if e.F.calls() != before {
		t.Fatal("answered an assigned, solved or member ticket")
	}

	// The report splits by channel.
	var rep AgentReport
	e.Do("GET", "/v1/ai/agent/report", e.admin(), nil).Want(t, 200).JSON(t, &rep)
	if rep.Channels.Email.Replies < 2 || rep.Channels.Email.Suggested != 2 || rep.Channels.Email.SuggestedSent != 1 || rep.Channels.Email.Handoffs != 1 ||
		rep.Channels.Chat.Replies != 0 {
		t.Fatalf("channels %+v", rep.Channels)
	}
}

func TestEmailAgentOutsideHours(t *testing.T) {
	e := newEnv(t, opts{billing: true})
	mb := e.emailMailbox("send")
	e.Exec(`UPDATE mailboxes SET ai_answers_outside_hours = true WHERE id = $1`, mb)
	// Open around the clock: inside business hours, so the agent stays out.
	day := `[{"start":"00:00","end":"24:00"}]`
	e.Exec(`UPDATE workspaces SET settings = jsonb_set(settings, '{business_hours}', $2::jsonb) WHERE id = $1`, e.WS.ID,
		`{"enabled":true,"schedule":{"mon":`+day+`,"tue":`+day+`,"wed":`+day+`,"thu":`+day+`,"fri":`+day+`,"sat":`+day+`,"sun":`+day+`},"holidays":[]}`)
	tid, mid := e.emailTicket(mb, customerEmail(), "Password", "How do I reset my password?")
	before := e.F.calls()
	e.emailAnswer(tid, mid)
	if e.F.calls() != before {
		t.Fatal("answered inside business hours")
	}
	// Today is a holiday: outside business hours, so it answers.
	e.Exec(`UPDATE workspaces SET settings = jsonb_set(settings, '{business_hours,holidays}', $2::jsonb) WHERE id = $1`, e.WS.ID,
		`[{"date":"`+time.Now().UTC().Format(time.DateOnly)+`","name":"Day off"}]`)
	tid, mid = e.emailTicket(mb, customerEmail(), "Password", "How do I reset my password?")
	e.emailAnswer(tid, mid)
	if ms := publicMessages(e, tid); len(ms) != 2 || !ms[1].AI {
		t.Fatalf("not answered outside business hours %+v", ms)
	}
}

func TestEmailAgentOutsideTeamHours(t *testing.T) {
	e := newEnv(t, opts{billing: true})
	mb := e.emailMailbox("send")
	e.Exec(`UPDATE mailboxes SET ai_answers_outside_hours = true WHERE id = $1`, mb)
	// The workspace is open around the clock.
	day := `[{"start":"00:00","end":"24:00"}]`
	e.Exec(`UPDATE workspaces SET settings = jsonb_set(settings, '{business_hours}', $2::jsonb) WHERE id = $1`, e.WS.ID,
		`{"enabled":true,"schedule":{"mon":`+day+`,"tue":`+day+`,"wed":`+day+`,"thu":`+day+`,"fri":`+day+`,"sat":`+day+`,"sun":`+day+`},"holidays":[]}`)
	// The ticket's team keeps its own hours and is closed today.
	team := ids.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, business_hours) VALUES ($1, $2, 'Nights', $3::jsonb)`, team, e.WS.ID,
		`{"enabled":true,"timezone":"","schedule":{"mon":`+day+`,"tue":`+day+`,"wed":`+day+`,"thu":`+day+`,"fri":`+day+`,"sat":`+day+`,"sun":`+day+`},`+
			`"holidays":[{"date":"`+time.Now().UTC().Format(time.DateOnly)+`","name":"Day off"}]}`)
	tid, mid := e.emailTicket(mb, customerEmail(), "Password", "How do I reset my password?")
	e.Exec(`UPDATE tickets SET team_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tid, team)
	e.emailAnswer(tid, mid)
	if ms := publicMessages(e, tid); len(ms) != 2 || !ms[1].AI {
		t.Fatalf("not answered outside the team's hours %+v", ms)
	}
	// A team without hours of its own follows the workspace's: open, so the agent stays out.
	e.Exec(`UPDATE teams SET business_hours = NULL WHERE id = $1`, team)
	tid, mid = e.emailTicket(mb, customerEmail(), "Password", "How do I reset my password?")
	e.Exec(`UPDATE tickets SET team_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tid, team)
	before := e.F.calls()
	e.emailAnswer(tid, mid)
	if e.F.calls() != before {
		t.Fatal("answered inside the workspace's hours")
	}
}

func TestEmailAgentOnJev(t *testing.T) {
	e := newEnv(t, opts{billing: true, jev: true})
	mb := e.emailMailbox("send")
	// Jev says a person is needed: handed off without writing an email.
	e.TS.set("needs_human", noulAns(0.95))
	tid, mid := e.emailTicket(mb, customerEmail(), "Account", "This is the third time I ask, fix my account now")
	before := e.F.calls()
	e.emailAnswer(tid, mid)
	if tk := e.loadTicket(tid); tk.Custom["ai_handoff"] != true || e.F.calls() != before || len(publicMessages(e, tid)) != 1 {
		t.Fatalf("no handoff %+v", tk.Custom)
	}
	e.TS.set("needs_human", noulAns(0.1))
	tid, mid = e.emailTicket(mb, customerEmail(), "Password", "How do I reset my password?")
	e.emailAnswer(tid, mid)
	if ms := publicMessages(e, tid); len(ms) != 2 || !ms[1].AI {
		t.Fatalf("not answered %+v", ms)
	}
}
