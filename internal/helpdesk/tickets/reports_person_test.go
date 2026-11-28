package tickets_test

// The reports narrowed to one person, on the Agents report's fixture (reports_agents_test.go).

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestReportsPersonFilter(t *testing.T) {
	e, _ := newEnv(t)
	f := seedAgents(t, e)
	ws := f.ws
	anna, bea := ws.Agent.ID.String(), f.bea.ID.String()
	overview := func(a hdtest.Auth, query string) tickets.ReportOverview {
		t.Helper()
		var o tickets.ReportOverview
		e.Do("GET", "/v1/reports/overview?"+query, a, nil).Want(t, 200).JSON(t, &o)
		return o
	}

	// The overview counts Anna's tickets only: t1 and t2 created in March, t1, t2 and t3 solved.
	all := overview(ws.Admin.As(ws), march)
	o := overview(ws.Admin.As(ws), march+"&assignee_id="+anna)
	if o.Created != 2 || o.Solved != 3 || len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != ws.Agent.ID || all.Created != 3 {
		t.Fatalf("anna overview %+v (all created %d)", o, all.Created)
	}
	if o = overview(ws.Admin.As(ws), march+"&assignee_id="+bea); o.Created != 1 || o.Solved != 0 || o.OpenNow != 1 {
		t.Fatalf("bea overview %+v", o)
	}
	// With the team too: Anna has no ticket of it.
	if o = overview(ws.Admin.As(ws), march+"&assignee_id="+anna+"&team_id="+f.team.String()); o.Created != 0 || o.Solved != 0 {
		t.Fatalf("anna team overview %+v", o)
	}

	// The agents report answers that member's row alone, the same row as unfiltered.
	full := agentsReport(t, e, ws.Admin.As(ws), march)
	r := agentsReport(t, e, ws.Admin.As(ws), march+"&assignee_id="+anna)
	if len(r.Data) != 1 || r.Data[0].User.ID != ws.Agent.ID {
		t.Fatalf("anna rows %+v", r.Data)
	}
	if a, w := r.Data[0], rowOf(t, full, ws.Agent.ID); a.Assigned != w.Assigned || a.Solved != w.Solved || a.Replies != w.Replies || a.Notes != w.Notes ||
		!eq(a.OnlineMinutes, 180) || !eq(a.HandleP50Minutes, 120) {
		t.Fatalf("anna row %+v, unfiltered %+v", a, w)
	}
	// An idle owner still has a row of zeros.
	if r = agentsReport(t, e, ws.Admin.As(ws), march+"&assignee_id="+ws.Owner.ID.String()); len(r.Data) != 1 || r.Data[0].Solved != 0 {
		t.Fatalf("owner rows %+v", r.Data)
	}

	// A member who is not an admin may only name themselves.
	for _, path := range []string{"/v1/reports/overview?", "/v1/reports/agents?"} {
		e.Do("GET", path+march+"&assignee_id="+anna, f.bea.As(ws), nil).Want(t, 403)
		e.Do("GET", path+march+"&assignee_id="+bea, f.bea.As(ws), nil).Want(t, 200)
		e.Do("GET", path+march+"&assignee_id=nope", ws.Admin.As(ws), nil).Want(t, 422)
	}
	if r = agentsReport(t, e, f.bea.As(ws), march+"&assignee_id="+bea); len(r.Data) != 1 || r.Data[0].User.ID != f.bea.ID || r.Data[0].Replies != 1 {
		t.Fatalf("bea own rows %+v", r.Data)
	}
	if o = overview(f.bea.As(ws), march+"&assignee_id="+bea); o.Created != 1 {
		t.Fatalf("bea own overview %+v", o)
	}
	// API keys read every ticket already, so any member.
	key := hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeTicketsRead)}
	if r = agentsReport(t, e, key, march+"&assignee_id="+anna); len(r.Data) != 1 || r.Data[0].Solved != 3 || r.Data[0].OnlineMinutes != nil {
		t.Fatalf("key rows %+v", r.Data)
	}
}

// A person and a mailbox together: the person's tickets that reply from the mailbox, and in
// Agents their row alone with their work on that mailbox's tickets.
func TestReportsPersonAndMailbox(t *testing.T) {
	e, _ := newEnv(t)
	f := seedAgents(t, e)
	ws := f.ws
	support := ids.New()
	e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id)
		VALUES ($1, $2, 'Support', $3, 'forwarding', $4, 'system', $5)`, support, ws.ID, "support-"+ws.Slug+"@acme.test", "t-support-"+ws.Slug, ws.BrandID)
	// t1 and t3 reply from Support: both Anna's.
	e.Exec(`UPDATE tickets SET mailbox_id = $2 WHERE workspace_id = $1 AND number IN (1, 3)`, ws.ID, support)
	q := march + "&mailbox_id=" + support.String() + "&assignee_id=" + ws.Agent.ID.String()

	var o tickets.ReportOverview
	e.Do("GET", "/v1/reports/overview?"+q, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &o)
	if o.Created != 1 || o.Solved != 2 || len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != ws.Agent.ID {
		t.Fatalf("anna support overview %+v", o)
	}
	r := agentsReport(t, e, ws.Admin.As(ws), q)
	if len(r.Data) != 1 || r.Data[0].User.ID != ws.Agent.ID || r.Data[0].Solved != 2 || r.Data[0].Replies != 3 || r.Data[0].Notes != 1 {
		t.Fatalf("anna support rows %+v", r.Data)
	}
	// Bea's only ticket replies from no mailbox.
	e.Do("GET", "/v1/reports/overview?"+march+"&mailbox_id="+support.String()+"&assignee_id="+f.bea.ID.String(), ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &o)
	if o.Created != 0 || o.Solved != 0 || o.OpenNow != 0 {
		t.Fatalf("bea support overview %+v", o)
	}
}
