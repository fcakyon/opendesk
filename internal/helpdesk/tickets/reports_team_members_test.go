package tickets_test

// settings.reports_team_members: in the reports, a team is its people. On the Agents report's
// fixture (reports_agents_test.go): Billing has Bea as a member and Carl as an observer, and
// most tickets have no team.

import (
	"reflect"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestReportsTeamMembers(t *testing.T) {
	e, _ := newEnv(t)
	f := seedAgents(t, e)
	ws := f.ws
	anna, bea, carl := ws.Agent.ID, f.bea.ID, f.carl.ID
	n := 6 // seedAgents' last ticket number
	ticket := func(assignee *uuid.UUID, team *uuid.UUID, created string, firstReply, solved any) uuid.UUID {
		n++
		id := ids.New()
		status := "open"
		if solved != nil {
			status = "solved"
		}
		e.Exec(`INSERT INTO tickets (id, workspace_id, number, brand_id, channel, assignee_id, team_id, status, created_at, first_responded_at, solved_at)
			VALUES ($1, $2, $3, $4, 'email', $5, $6, $7, $8, $9, $10)`, id, ws.ID, n, ws.BrandID, assignee, team, status, created, firstReply, solved)
		return id
	}
	// t4 (seedAgents): Billing's, Bea's, open, first response 20 min.
	// t7: Bea's without a team, solved, first response 30 min, with her reply.
	t7 := ticket(&bea, nil, "2026-03-15T10:00:00Z", "2026-03-15T10:30:00Z", "2026-03-15T12:00:00Z")
	e.Exec(`INSERT INTO messages (workspace_id, ticket_id, kind, direction, author_type, author_user_id, created_at)
		VALUES ($1, $2, 'reply', 'outbound', 'user', $3, '2026-03-15T10:30:00Z')`, ws.ID, t7, bea)
	// t8: Billing's, held by Anna, who is not on it; open.
	t8 := ticket(&anna, &f.team, "2026-03-16T09:00:00Z", nil, nil)
	// t9: Bea's without a team, open. t10: Carl's (an observer) without a team, open.
	t9 := ticket(&bea, nil, "2026-03-20T09:00:00Z", nil, nil)
	ticket(&carl, nil, "2026-03-21T09:00:00Z", nil, nil)
	// t11: nobody's, open.
	ticket(nil, nil, "2026-03-22T09:00:00Z", nil, nil)
	var t4 uuid.UUID
	e.Scalar(`SELECT id FROM tickets WHERE workspace_id = $1 AND number = 4`, &t4, ws.ID)

	overview := func(query string) tickets.ReportOverview {
		t.Helper()
		var o tickets.ReportOverview
		e.Do("GET", "/v1/reports/overview?"+query, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &o)
		return o
	}
	team := "&team_id=" + f.team.String()

	// Off (the default): the team's tickets are those routed to it, t4 and t8, and the Agents
	// report lists its members and whoever worked them.
	if o := overview(march + team); o.Created != 2 || o.OpenNow != 2 || len(o.ByAgent) != 2 {
		t.Fatalf("routed team overview %+v", o)
	}
	if r := agentsReport(t, e, ws.Admin.As(ws), march+team); rowOf(t, r, anna) == nil {
		t.Fatalf("routed team rows %+v", r.Data)
	}

	e.SetSettings(ws, map[string]any{"reports_team_members": true})

	// The overview: Billing's tickets (t4, t8) and its members' (t7, t9), not the observer's.
	o := overview(march + team)
	if o.Created != 4 || o.Solved != 1 || o.OpenNow != 3 || !eq(o.FirstResponseP50Minutes, 25) || !eq(o.ResolutionP50Minutes, 120) {
		t.Fatalf("team overview %+v", o)
	}
	created := 0
	for _, d := range o.ByDay {
		created += d.Created
	}
	if created != 4 || o.ByChannel["email"] != 4 || o.BySeverity["none"] != 4 {
		t.Fatalf("team breakdowns by_day %d channel %v severity %v", created, o.ByChannel, o.BySeverity)
	}
	// by_agent: the team's members only (not Anna, who holds t8), with their tickets.
	if len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != bea || o.ByAgent[0].Solved != 1 {
		t.Fatalf("team by_agent %+v", o.ByAgent)
	}
	// by_team still groups those tickets by their team: Billing's two and the two without one.
	byTeam := map[string]int{}
	for _, r := range o.ByTeam {
		k := "none"
		if r.TeamID != nil {
			k = r.TeamID.String()
		}
		byTeam[k] = r.Created
	}
	if len(byTeam) != 2 || byTeam[f.team.String()] != 2 || byTeam["none"] != 2 {
		t.Fatalf("team by_team %+v", o.ByTeam)
	}
	// team_id=none keeps its meaning: the tickets without a team (t1, t2, t7, t9, t10, t11 created in March).
	if o := overview(march + "&team_id=none"); o.Created != 6 || o.OpenNow != 3 {
		t.Fatalf("no team overview %+v", o)
	}
	// With another filter: the brand narrows the team's tickets as before.
	if o := overview(march + team + "&brand_id=" + f.brand.String()); o.Created != 0 {
		t.Fatalf("team and brand overview %+v", o)
	}

	// The Agents report: Bea alone, with the very figures she has without the filter.
	all := agentsReport(t, e, ws.Admin.As(ws), march)
	r := agentsReport(t, e, ws.Admin.As(ws), march+team)
	if len(r.Data) != 1 || r.Data[0].User.ID != bea {
		t.Fatalf("team rows %+v", r.Data)
	}
	if want := rowOf(t, all, bea); !reflect.DeepEqual(r.Data[0], *want) || want.Assigned != 3 || want.Solved != 1 || want.Replies != 2 {
		t.Fatalf("team bea %+v, without the filter %+v", r.Data[0], *want)
	}
	// The brand still narrows the figures: Bea's row as the brand alone gives it.
	brand := "&brand_id=" + f.brand.String()
	byBrand := agentsReport(t, e, ws.Admin.As(ws), march+brand)
	r = agentsReport(t, e, ws.Admin.As(ws), march+team+brand)
	if len(r.Data) != 1 || !reflect.DeepEqual(r.Data[0], *rowOf(t, byBrand, bea)) || r.Data[0].Assigned != 0 {
		t.Fatalf("team and brand rows %+v", r.Data)
	}
	// team_id=none still narrows the tickets: the work on tickets without a team.
	r = agentsReport(t, e, ws.Admin.As(ws), march+"&team_id=none")
	if b := rowOf(t, r, bea); b == nil || b.Assigned != 2 || rowOf(t, r, anna) == nil {
		t.Fatalf("no team rows %+v", r.Data)
	}
	// A member who is not an admin: their own row, on the team or not.
	if r := agentsReport(t, e, f.bea.As(ws), march+team); len(r.Data) != 1 || r.Data[0].User.ID != bea {
		t.Fatalf("bea's own team row %+v", r)
	}
	if r := agentsReport(t, e, ws.Agent.As(ws), march+team); len(r.Data) != 0 {
		t.Fatalf("anna's team rows %+v", r.Data)
	}

	// A person picked too (assignee_id). Bea, a member: her tickets among the team's (t4, t7,
	// t9), and in Agents her row alone, as without either filter.
	who := func(id uuid.UUID) string { return "&assignee_id=" + id.String() }
	if o := overview(march + team + who(bea)); o.Created != 3 || o.Solved != 1 || o.OpenNow != 2 || len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != bea {
		t.Fatalf("team and bea overview %+v", o)
	}
	if r := agentsReport(t, e, ws.Admin.As(ws), march+team+who(bea)); len(r.Data) != 1 || !reflect.DeepEqual(r.Data[0], *rowOf(t, all, bea)) {
		t.Fatalf("team and bea rows %+v", r.Data)
	}
	if r := agentsReport(t, e, f.bea.As(ws), march+team+who(bea)); len(r.Data) != 1 || r.Data[0].User.ID != bea {
		t.Fatalf("bea's own team and bea rows %+v", r.Data)
	}
	// Anna, not on the team: the team's ticket she holds (t8) counts, but neither by_agent nor
	// Agents has a row for her, as with the team alone.
	if o := overview(march + team + who(anna)); o.Created != 1 || o.OpenNow != 1 || len(o.ByAgent) != 0 {
		t.Fatalf("team and anna overview %+v", o)
	}
	if r := agentsReport(t, e, ws.Admin.As(ws), march+team+who(anna)); len(r.Data) != 0 {
		t.Fatalf("team and anna rows %+v", r.Data)
	}
	// Carl only observes the team: nothing.
	if o := overview(march + team + who(carl)); o.Created != 0 || o.OpenNow != 0 {
		t.Fatalf("team and carl overview %+v", o)
	}
	if r := agentsReport(t, e, ws.Admin.As(ws), march+team+who(carl)); len(r.Data) != 0 {
		t.Fatalf("team and carl rows %+v", r.Data)
	}

	// The ticket list behind the page's open-work cards: team_members adds the members' tickets.
	open := "status=open,pending,on_hold&team_id=" + f.team.String()
	if got := idsOf(list(t, e, ws.Admin.As(ws), open)); !sameSet(got, []uuid.UUID{t4, t8}) {
		t.Fatalf("team list %v", got)
	}
	if got := idsOf(list(t, e, ws.Admin.As(ws), open+"&team_members=true")); !sameSet(got, []uuid.UUID{t4, t8, t9}) {
		t.Fatalf("team and members list %v", got)
	}
	if got := idsOf(list(t, e, ws.Admin.As(ws), "team_members=true&team_id=none&assignee="+bea.String())); !sameSet(got, []uuid.UUID{t7, t9}) {
		t.Fatalf("no team with members list %v", got)
	}
}
