package tickets_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/resources"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// A live chat goes to one online member who takes chats (holds the chat skill), by the chat
// rule: at creation when no bot answers, at the bot's hand-over when one does. Away, offline and
// members without the skill are never picked; emails are left to their own rules; a chat with an
// assignee keeps them; nobody eligible leaves it unassigned until the visitor writes again.
func TestChatAssign(t *testing.T) {
	e := hdtest.New(t, tickets.Register, resources.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)

	chatSkill := ids.New()
	e.Exec(`INSERT INTO skills (id, workspace_id, name) VALUES ($1, $2, 'Chat')`, chatSkill, ws.ID)
	for _, u := range []uuid.UUID{ws.Admin.ID, ws.Agent.ID} {
		e.Exec(`INSERT INTO member_skills (workspace_id, user_id, skill_id) VALUES ($1, $2, $3)`, ws.ID, u, chatSkill)
	}
	takers := map[uuid.UUID]bool{ws.Admin.ID: true, ws.Agent.ID: true}
	availability := func(u uuid.UUID, a string) {
		e.Exec(`UPDATE members SET availability = $3 WHERE workspace_id = $1 AND user_id = $2`, ws.ID, u, a)
	}
	assignee := func(tid uuid.UUID) *uuid.UUID {
		var a *uuid.UUID
		e.Scalar(`SELECT assignee_id FROM tickets WHERE id = $1`, &a, tid)
		return a
	}
	chat := func() uuid.UUID {
		t.Helper()
		return customerTicket(t, e, ws, domain.NewTicket{Channel: domain.ChannelChat, WidgetID: &ws.WidgetID})
	}
	handoff := func(tid uuid.UUID) {
		t.Helper()
		if err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
			_, err := hd.MarkAIHandoff(e.Ctx, tx, ws.ID, tid, "ai", hd.HandoffBot{Name: "Ollie"})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	notified := func(tid uuid.UUID, typ string) []uuid.UUID {
		t.Helper()
		rows, err := e.D.DB.Pool.Query(e.Ctx, `SELECT user_id FROM notifications WHERE ticket_id = $1 AND type = $2 ORDER BY user_id`, tid, typ)
		if err != nil {
			t.Fatal(err)
		}
		got, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	// Off by default: chats follow the workspace rule (none here).
	var a map[string]any
	e.Do("GET", "/v1/assignment", admin, nil).Want(t, 200).JSON(t, &a)
	if a["chat_mode"] != "none" || a["chat_skill_id"] != nil {
		t.Fatalf("defaults: chat_mode %v, chat_skill_id %v", a["chat_mode"], a["chat_skill_id"])
	}
	if got := assignee(chat()); got != nil {
		t.Fatalf("rule off: chat assigned to %v", *got)
	}

	// The rule is checked, then set.
	e.Do("PATCH", "/v1/assignment", admin, map[string]any{"chat_skill_id": ids.New().String()}).Want(t, 422)
	e.Do("PATCH", "/v1/assignment", ws.Agent.As(ws), map[string]any{"chat_mode": "load_balanced"}).Want(t, 403)
	e.Do("PATCH", "/v1/assignment", admin, map[string]any{"chat_mode": "load_balanced", "chat_skill_id": chatSkill.String()}).Want(t, 200).JSON(t, &a)
	if a["chat_mode"] != "load_balanced" || a["chat_skill_id"] != chatSkill.String() || a["mode"] != "none" {
		t.Fatalf("after setting: %v", a)
	}

	// No bot: a new chat goes at once to a chat-taker, never the owner (no skill), with the
	// assigned entry (system, via chat) and the assigned notification naming the channel.
	first := chat()
	got := assignee(first)
	if got == nil || !takers[*got] {
		t.Fatalf("first chat assigned to %v, want a chat-taker", got)
	}
	var via, actor, channel string
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT data->>'via', actor_type FROM activities WHERE ticket_id = $1 AND type = 'assigned'`, first).Scan(&via, &actor); err != nil {
		t.Fatal(err)
	}
	if via != "chat" || actor != "system" {
		t.Fatalf("assigned activity via %q by %q", via, actor)
	}
	e.Scalar(`SELECT data->>'channel' FROM notifications WHERE ticket_id = $1 AND type = 'assigned' AND user_id = $2`, &channel, first, *got)
	if channel != "chat" {
		t.Fatalf("assigned notification channel %q", channel)
	}
	// Load balanced: the next chat goes to the other chat-taker, who has fewer open tickets.
	second := chat()
	if g := assignee(second); g == nil || *g == *got || !takers[*g] {
		t.Fatalf("second chat assigned to %v, first to %v", g, *got)
	}

	// Away and offline chat-takers are not picked, nor the online owner without the skill.
	availability(ws.Admin.ID, "offline")
	availability(ws.Agent.ID, "away")
	waiting := chat()
	if g := assignee(waiting); g != nil {
		t.Fatalf("nobody eligible, yet assigned to %v", *g)
	}
	// An email is left to its own rules, even with a chat-taker online.
	availability(ws.Agent.ID, "online")
	mb := addMailbox(t, e, ws)
	if g := assignee(customerTicket(t, e, ws, domain.NewTicket{Channel: domain.ChannelEmail, MailboxID: &mb})); g != nil {
		t.Fatalf("an email was assigned to %v", *g)
	}
	// The visitor writes again: the waiting chat goes to the chat-taker now online.
	if err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		_, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: ws.ID, TicketID: waiting, Kind: "reply", Direction: "inbound",
			AuthorType: "contact", BodyHTML: "<p>Anyone?</p>", BodyText: "Anyone?", Trigger: jobs.TriggerCustomerReplied})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	runTriggers(t, e, ws.ID)
	if g := assignee(waiting); g == nil || *g != ws.Agent.ID {
		t.Fatalf("after the visitor's next message: %v, want the agent", g)
	}

	// The answer bot takes chats: none is assigned at creation (it would silence the bot).
	withAI(t, e)
	e.SetSettings(ws, map[string]any{"ai": map[string]any{"enabled": true, "widget_answers": true}})
	botChat := chat()
	if g := assignee(botChat); g != nil {
		t.Fatalf("a chat the bot answers was assigned at creation to %v", *g)
	}
	// It hands over: the chat goes to the online chat-taker, who alone hears (assigned).
	handoff(botChat)
	if g := assignee(botChat); g == nil || *g != ws.Agent.ID {
		t.Fatalf("after the hand-over: %v, want the agent", g)
	}
	if n := notified(botChat, "ai_handoff"); len(n) != 0 {
		t.Fatalf("ai_handoff also sent to %v", n)
	}
	if n := notified(botChat, "assigned"); len(n) != 1 || n[0] != ws.Agent.ID {
		t.Fatalf("assigned sent to %v", n)
	}
	var handedOff bool
	e.Scalar(`SELECT COALESCE((custom->>'ai_handoff')::boolean, false) FROM tickets WHERE id = $1`, &handedOff, botChat)
	if !handedOff {
		t.Fatal("the hand-over was not recorded")
	}

	// A hand-over with nobody free leaves the chat unassigned and tells the team, as before.
	availability(ws.Agent.ID, "offline")
	lonely := chat()
	handoff(lonely)
	if g := assignee(lonely); g != nil {
		t.Fatalf("nobody free, yet assigned to %v", *g)
	}
	if n := notified(lonely, "ai_handoff"); len(n) == 0 {
		t.Fatal("nobody told of the hand-over")
	}

	// A chat someone has keeps them.
	availability(ws.Agent.ID, "online")
	held := chat()
	e.Do("PATCH", "/v1/tickets/"+held.String(), admin, map[string]any{"assignee_id": ws.Owner.ID.String()}).Want(t, 200)
	handoff(held)
	if g := assignee(held); g == nil || *g != ws.Owner.ID {
		t.Fatalf("the hand-over took the owner's chat: %v", g)
	}

	// Turned off: chats are left to the other rules again.
	e.Do("PATCH", "/v1/assignment", admin, map[string]any{"chat_mode": "none", "chat_skill_id": ""}).Want(t, 200).JSON(t, &a)
	if a["chat_mode"] != "none" || a["chat_skill_id"] != nil {
		t.Fatalf("after turning off: %v", a)
	}
	e.SetSettings(ws, map[string]any{"ai": map[string]any{"enabled": false}})
	if g := assignee(chat()); g != nil {
		t.Fatalf("rule off again: assigned to %v", *g)
	}
}
