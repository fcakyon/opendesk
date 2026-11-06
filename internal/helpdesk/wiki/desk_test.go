package wiki_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

func addTicket(e *hdtest.Env, ws hdtest.WS, number int, team *uuid.UUID) uuid.UUID {
	id := uuid.New()
	e.Exec(`INSERT INTO tickets (id, workspace_id, number, brand_id, channel, team_id) VALUES ($1, $2, $3, $4, 'email', $5)`,
		id, ws.ID, number, ws.BrandID, team)
	return id
}

func ticketLink(id uuid.UUID, number int) string {
	return fmt.Sprintf(`<a data-type="ticket" data-id="%s" href="/tickets/%d">#%d Refund stuck</a>`, id, number, number)
}

func ticketPages(t *testing.T, e *hdtest.Env, a hdtest.Auth, ref string) []string {
	t.Helper()
	var out struct{ Data []node }
	e.Do("GET", "/v1/tickets/"+ref+"/wiki", a, nil).Want(t, 200).JSON(t, &out)
	got := []string{}
	for _, n := range out.Data {
		got = append(got, n.ID)
	}
	return got
}

// A page's ticket mentions are kept from its body as it is saved; a ticket lists the pages
// that mention it, as far as the caller may see them.
func TestTicketWikiPages(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws, other := e.NewWorkspace(), e.NewWorkspace()
	agent, admin, viewer := ws.Agent.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)

	tk := addTicket(e, ws, 101, nil)
	theirs := addTicket(e, other, 101, nil)
	links := func(page string) []uuid.UUID {
		t.Helper()
		var out []uuid.UUID
		e.Scalar(`SELECT COALESCE(array_agg(ticket_id ORDER BY ticket_id), '{}') FROM wiki_ticket_links WHERE page_id = $1`, &out, page)
		return out
	}

	// Created: only the workspace's own tickets count; another workspace's and unknown ids are left out.
	runbook := create(t, e, agent, map[string]any{"title": "Refund runbook",
		"body_html": "<p>See " + ticketLink(tk, 101) + " and " + ticketLink(theirs, 101) + " and " + ticketLink(uuid.New(), 9) + "</p>"})
	if got := links(runbook.ID); !slices.Equal(got, []uuid.UUID{tk}) {
		t.Fatalf("links on create %v", got)
	}
	if got := ticketPages(t, e, viewer, tk.String()); !slices.Equal(got, []string{runbook.ID}) {
		t.Fatalf("pages %v", got)
	}

	// Updated: a page that starts mentioning it shows first (newest edit first).
	notes := create(t, e, agent, map[string]any{"title": "Notes", "body_html": "<p>nothing yet</p>"})
	e.Do("PATCH", "/v1/wiki/pages/"+notes.ID, agent, map[string]any{"body_html": "<p>" + ticketLink(tk, 101) + "</p>"}).Want(t, 200)
	if got := ticketPages(t, e, viewer, tk.String()); !slices.Equal(got, []string{notes.ID, runbook.ID}) {
		t.Fatalf("after update %v", got)
	}
	// The number works as people write it.
	for _, ref := range []string{"%23101", "101"} {
		if got := ticketPages(t, e, viewer, ref); len(got) != 2 {
			t.Fatalf("%s: %v", ref, got)
		}
	}

	// A mention taken out leaves the list; restoring the revision that had it brings it back.
	e.Do("PATCH", "/v1/wiki/pages/"+runbook.ID, admin, map[string]any{"body_html": "<p>rewritten</p>"}).Want(t, 200)
	if got := links(runbook.ID); len(got) != 0 {
		t.Fatalf("links after the mention went %v", got)
	}
	var revs struct {
		Data []struct {
			ID     string `json:"id"`
			Author *struct {
				ID string `json:"id"`
			} `json:"author"`
		}
	}
	e.Do("GET", "/v1/wiki/pages/"+runbook.ID+"/revisions", agent, nil).Want(t, 200).JSON(t, &revs)
	restored := false
	for _, r := range revs.Data {
		if r.Author != nil && r.Author.ID == ws.Agent.ID.String() {
			e.Do("POST", "/v1/wiki/pages/"+runbook.ID+"/revisions/"+r.ID+"/restore", agent, nil).Want(t, 200)
			restored = true
			break
		}
	}
	if !restored {
		t.Fatalf("no revision of the agent's %+v", revs.Data)
	}
	if got := links(runbook.ID); !slices.Equal(got, []uuid.UUID{tk}) {
		t.Fatalf("links after restore %v", got)
	}

	// Someone's private page shows to them alone; a trashed page to no one.
	mine := create(t, e, agent, map[string]any{"title": "My notes", "space": "private", "body_html": "<p>" + ticketLink(tk, 101) + "</p>"})
	if got := ticketPages(t, e, agent, tk.String()); !slices.Contains(got, mine.ID) {
		t.Fatalf("own private page missing %v", got)
	}
	if got := ticketPages(t, e, viewer, tk.String()); slices.Contains(got, mine.ID) {
		t.Fatalf("someone else's private page listed %v", got)
	}
	e.Do("POST", "/v1/wiki/pages/"+notes.ID+"/trash", agent, nil).Want(t, 200)
	if got := ticketPages(t, e, agent, tk.String()); slices.Contains(got, notes.ID) || len(got) != 2 {
		t.Fatalf("trashed page listed %v", got)
	}

	// A ticket of a private team is not found for someone off the team, as everywhere.
	secret := uuid.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Billing', true)`, secret, ws.ID)
	e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, secret, ws.Agent.ID)
	hidden := addTicket(e, ws, 102, &secret)
	escalation := create(t, e, agent, map[string]any{"title": "Escalation", "body_html": "<p>" + ticketLink(hidden, 102) + "</p>"})
	e.Do("GET", "/v1/tickets/"+hidden.String()+"/wiki", viewer, nil).Want(t, 404)
	e.Do("GET", "/v1/tickets/%23102/wiki", viewer, nil).Want(t, 404)
	if got := ticketPages(t, e, agent, "102"); !slices.Equal(got, []string{escalation.ID}) {
		t.Fatalf("team member %v", got)
	}

	// Another workspace's ticket and a missing one are not found.
	e.Do("GET", "/v1/tickets/"+theirs.String()+"/wiki", viewer, nil).Want(t, 404)
	e.Do("GET", "/v1/tickets/999/wiki", viewer, nil).Want(t, 404)

	// An API key needs both scopes, and sees no private page.
	e.Do("GET", "/v1/tickets/101/wiki", hdtest.Auth{Bearer: e.APIKey(ws, "tickets:read")}, nil).Want(t, 403)
	e.Do("GET", "/v1/tickets/101/wiki", hdtest.Auth{Bearer: e.APIKey(ws, "wiki:read")}, nil).Want(t, 403)
	if got := ticketPages(t, e, hdtest.Auth{Bearer: e.APIKey(ws, "tickets:read", "wiki:read")}, "101"); !slices.Equal(got, []string{runbook.ID}) {
		t.Fatalf("api key %v", got)
	}

	// A deleted page takes its mentions with it.
	e.Do("DELETE", "/v1/wiki/pages/"+notes.ID, agent, nil).Want(t, 204)
	var left int
	e.Scalar(`SELECT count(*) FROM wiki_ticket_links WHERE page_id = $1`, &left, notes.ID)
	if left != 0 {
		t.Fatalf("links of a deleted page %d", left)
	}
}
