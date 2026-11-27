package tickets_test

// The reports narrowed to one mailbox, on the Agents report's fixture (reports_agents_test.go).

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestReportsMailboxFilter(t *testing.T) {
	e, _ := newEnv(t)
	f := seedAgents(t, e)
	ws := f.ws
	support, info := ids.New(), ids.New()
	for _, mb := range []struct {
		id         any
		name, mail string
	}{{support, "Support", "support-" + ws.Slug + "@acme.test"}, {info, "Info", "info-" + ws.Slug + "@acme.test"}} {
		e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id)
			VALUES ($1, $2, $3, $4, 'forwarding', $5, 'system', $6)`, mb.id, ws.ID, mb.name, mb.mail, "t-"+mb.mail, ws.BrandID)
	}
	// t1 and t3 reply from Support, t4 from Info, t2 from none.
	e.Exec(`UPDATE tickets SET mailbox_id = $2 WHERE workspace_id = $1 AND number IN (1, 3)`, ws.ID, support)
	e.Exec(`UPDATE tickets SET mailbox_id = $2 WHERE workspace_id = $1 AND number = 4`, ws.ID, info)
	overview := func(query string) tickets.ReportOverview {
		t.Helper()
		var o tickets.ReportOverview
		e.Do("GET", "/v1/reports/overview?"+query, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &o)
		return o
	}

	if o := overview(march + "&mailbox_id=" + support.String()); o.Created != 1 || o.Solved != 2 || o.OpenNow != 0 {
		t.Fatalf("support overview %+v", o)
	}
	if o := overview(march + "&mailbox_id=none"); o.Created != 1 || o.Solved != 1 {
		t.Fatalf("no mailbox overview %+v", o)
	}
	if o := overview(march + "&mailbox_id=" + info.String()); o.Created != 1 || o.Solved != 0 || o.OpenNow != 1 {
		t.Fatalf("info overview %+v", o)
	}

	// The agents report counts the mailbox's tickets; the roster stays.
	r := agentsReport(t, e, ws.Admin.As(ws), march+"&mailbox_id="+info.String())
	if len(r.Data) != 5 {
		t.Fatalf("info rows %+v", r.Data)
	}
	if b := rowOf(t, r, f.bea.ID); b.Assigned != 1 || b.Replies != 1 || b.Notes != 1 {
		t.Fatalf("info bea %+v", b)
	}
	if a := rowOf(t, r, ws.Agent.ID); a.Solved != 0 || a.Replies != 0 {
		t.Fatalf("info anna %+v", a)
	}
	r = agentsReport(t, e, ws.Admin.As(ws), march+"&mailbox_id="+support.String())
	if a := rowOf(t, r, ws.Agent.ID); a.Solved != 2 || a.Replies != 3 || a.Notes != 1 {
		t.Fatalf("support anna %+v", a)
	}
	// With the team: Info's ticket is the team's.
	if o := overview(march + "&mailbox_id=" + info.String() + "&team_id=" + f.team.String()); o.Created != 1 {
		t.Fatalf("info team overview %+v", o)
	}

	e.Do("GET", "/v1/reports/overview?"+march+"&mailbox_id=nope", ws.Admin.As(ws), nil).Want(t, 422)
	e.Do("GET", "/v1/reports/agents?"+march+"&mailbox_id=nope", ws.Admin.As(ws), nil).Want(t, 422)
}
