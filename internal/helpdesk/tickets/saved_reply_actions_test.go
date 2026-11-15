package tickets_test

import (
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/resources"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

// A saved reply's actions apply to the ticket only when a message naming it is sent: labels
// added (created if missing) and removed, the team, the assignee; a reply sent without naming
// it changes nothing, and bad actions are refused when the saved reply is saved.
func TestSavedReplyActions(t *testing.T) {
	e := hdtest.New(t, tickets.Register, resources.Register)
	ws := e.NewWorkspace()
	admin, agent := ws.Admin.As(ws), ws.Agent.As(ws)
	team := addTeam(t, e, ws, ws.Agent.ID)

	var r struct {
		ID      string         `json:"id"`
		Actions map[string]any `json:"actions"`
	}
	e.Do("POST", "/v1/saved-replies", admin, map[string]any{"title": "Damage claim", "body_html": "<p>Please send photos.</p>",
		"actions": map[string]any{"add_tags": []string{"claim-follow-up", " claim-follow-up", "damaged"}, "remove_tags": []string{"PRODUCT", "damaged"},
			"team_id": team.String(), "assignee_id": ws.Agent.ID.String()}}).Want(t, 201).JSON(t, &r)
	if got := r.Actions["add_tags"].([]any); len(got) != 2 {
		t.Fatalf("add_tags not cleaned: %v", got)
	}
	if got := r.Actions["remove_tags"].([]any); len(got) != 1 || got[0] != "PRODUCT" {
		t.Fatalf("a label both added and removed is only added: %v", got)
	}
	e.Do("POST", "/v1/saved-replies", admin, map[string]any{"title": "Bad team", "body_html": "<p>x</p>",
		"actions": map[string]any{"team_id": "01a1661c-0000-7000-8000-000000000000"}}).Want(t, 422)

	tags := func(tk domain.Ticket) []string {
		var out []string
		for _, l := range getTicket(t, e, ws, tk.ID).Tags {
			out = append(out, l.Name)
		}
		return out
	}
	newTicket := func() domain.Ticket {
		tk := createTicket(t, e, ws, map[string]any{"channel": "api", "kind": "note", "contact": map[string]any{"email": "ada@example.com"}})
		e.Do("PATCH", "/v1/tickets/"+tk.ID.String(), agent, map[string]any{"add_tags": []string{"PRODUCT"}}).Want(t, 200)
		return tk
	}

	// Sent without naming it: nothing happens.
	plain := newTicket()
	e.Do("POST", "/v1/tickets/"+plain.ID.String()+"/messages", agent, map[string]any{"kind": "reply", "body_html": "<p>Please send photos.</p>"}).Want(t, 201)
	if got := tags(plain); !slices.Equal(got, []string{"PRODUCT"}) {
		t.Fatalf("tags without the saved reply: %v", got)
	}

	// Sent with it: labels, team and assignee follow.
	tk := newTicket()
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", agent, map[string]any{"kind": "reply", "body_html": "<p>Please send photos.</p>",
		"saved_reply_ids": []string{r.ID, "not-a-uuid"}}).Want(t, 201)
	got := tags(tk)
	slices.Sort(got)
	if !slices.Equal(got, []string{"claim-follow-up", "damaged"}) {
		t.Fatalf("tags after the saved reply: %v", got)
	}
	after := getTicket(t, e, ws, tk.ID)
	if after.TeamID == nil || *after.TeamID != team || after.Assignee == nil || after.Assignee.ID != ws.Agent.ID {
		t.Fatalf("team %v assignee %+v", after.TeamID, after.Assignee)
	}

	// Editing clears them with {}.
	var cleared struct {
		Actions map[string]any `json:"actions"`
	}
	e.Do("PATCH", "/v1/saved-replies/"+r.ID, admin, map[string]any{"actions": map[string]any{}}).Want(t, 200).JSON(t, &cleared)
	if len(cleared.Actions) != 0 {
		t.Fatalf("actions not cleared: %v", cleared.Actions)
	}
}

// A saved reply's actions go no further than its sender may: a missing label is created only
// when they may create labels (settings.label_creation), and a private team's reply they do not
// see does nothing.
func TestSavedReplyActionsSenderLimits(t *testing.T) {
	e := hdtest.New(t, tickets.Register, resources.Register)
	ws := e.NewWorkspace()
	admin, agent := ws.Admin.As(ws), ws.Agent.As(ws)
	private := addTeam(t, e, ws, ws.Admin.ID)
	e.Exec(`UPDATE teams SET private = true WHERE id = $1`, private)

	var open, hidden struct {
		ID string `json:"id"`
	}
	e.Do("POST", "/v1/saved-replies", admin, map[string]any{"title": "New label", "body_html": "<p>x</p>",
		"actions": map[string]any{"add_tags": []string{"never-seen"}}}).Want(t, 201).JSON(t, &open)
	e.Do("POST", "/v1/saved-replies", admin, map[string]any{"title": "Private", "body_html": "<p>x</p>", "team_id": private.String(),
		"actions": map[string]any{"assignee_id": ws.Admin.ID.String()}}).Want(t, 201).JSON(t, &hidden)

	e.SetSettings(ws, map[string]any{"label_creation": "admins"})
	tk := createTicket(t, e, ws, map[string]any{"channel": "api", "kind": "note", "contact": map[string]any{"email": "ada@example.com"}})
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", agent, map[string]any{"kind": "reply", "body_html": "<p>x</p>",
		"saved_reply_ids": []string{open.ID, hidden.ID}}).Want(t, 201)
	after := getTicket(t, e, ws, tk.ID)
	if len(after.Tags) != 0 {
		t.Fatalf("an agent created a label through a saved reply: %v", after.Tags)
	}
	if after.Assignee != nil {
		t.Fatalf("a hidden saved reply assigned the ticket: %+v", after.Assignee)
	}

	// An admin may create the label.
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", admin, map[string]any{"kind": "reply", "body_html": "<p>x</p>",
		"saved_reply_ids": []string{open.ID}}).Want(t, 201)
	if got := getTicket(t, e, ws, tk.ID).Tags; len(got) != 1 || got[0].Name != "never-seen" {
		t.Fatalf("tags after the admin's reply: %v", got)
	}
}
