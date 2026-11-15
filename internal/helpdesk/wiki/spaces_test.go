package wiki_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type spaced struct {
	page
	Private      bool    `json:"private"`
	TeamID       *string `json:"team_id"`
	Template     bool    `json:"template"`
	Journal      bool    `json:"journal"`
	DailyDate    *string `json:"daily_date"`
	DeletedAt    *string `json:"deleted_at"`
	Verification *struct {
		By      struct{ ID string } `json:"by"`
		Until   *string             `json:"until"`
		Expired bool                `json:"expired"`
	} `json:"verification"`
}

func get(t *testing.T, e *hdtest.Env, a hdtest.Auth, id string) spaced {
	t.Helper()
	var out spaced
	e.Do("GET", "/v1/wiki/pages/"+id, a, nil).Want(t, 200).JSON(t, &out)
	return out
}

func treeIDs(t *testing.T, e *hdtest.Env, a hdtest.Auth) []string {
	t.Helper()
	out := []string{}
	for _, n := range tree(t, e, a) {
		out = append(out, n.ID)
	}
	return out
}

// Private pages are their member's alone, admins included; a private team's teamspace
// is its members'; a public team's is everyone's.
func TestPrivatePagesAndTeamspaces(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, admin, viewer := ws.Agent.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)

	mine := create(t, e, agent, map[string]any{"title": "My scratchpad", "space": "private", "body_html": "<p>secret refunds plan</p>"})
	under := create(t, e, agent, map[string]any{"title": "Inside", "parent_id": mine.ID})
	if p := get(t, e, agent, under.ID); !p.Private {
		t.Fatal("a subpage of a private page is private")
	}
	for _, other := range []hdtest.Auth{admin, viewer} {
		e.Do("GET", "/v1/wiki/pages/"+mine.ID, other, nil).Want(t, 404)
		if slices.Contains(treeIDs(t, e, other), mine.ID) {
			t.Fatal("someone else's private page in the tree")
		}
		var s struct{ Data []struct{ ID string } }
		e.Do("GET", "/v1/wiki/search?q=secret", other, nil).Want(t, 200).JSON(t, &s)
		if len(s.Data) != 0 {
			t.Fatal("someone else's private page in search")
		}
	}
	e.Do("PATCH", "/v1/wiki/pages/"+mine.ID, admin, map[string]any{"title": "x"}).Want(t, 404)
	e.Do("POST", "/v1/wiki/pages/"+mine.ID+"/trash", admin, nil).Want(t, 404)
	e.Do("POST", "/v1/wiki/pages", admin, map[string]any{"title": "x", "parent_id": mine.ID}).Want(t, 422)
	if !slices.Contains(treeIDs(t, e, agent), mine.ID) {
		t.Fatal("my private page is missing from my tree")
	}
	// Moving it to the workspace shares it, with what is under it.
	e.Do("POST", "/v1/wiki/pages/"+mine.ID+"/move", agent, map[string]any{"parent_id": nil, "position": 0, "space": "workspace"}).Want(t, 200)
	if p := get(t, e, admin, under.ID); p.Private {
		t.Fatal("still private after the move")
	}

	// A private team's pages show to its members; a public team's to everyone.
	secret, open := uuid.New(), uuid.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Billing', true), ($3, $2, 'Docs', false)`, secret, ws.ID, open)
	e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, secret, ws.Agent.ID)
	billing := create(t, e, agent, map[string]any{"title": "Billing runbook", "space": "team", "team_id": secret.String()})
	docs := create(t, e, agent, map[string]any{"title": "Docs home", "space": "team", "team_id": open.String()})
	e.Do("GET", "/v1/wiki/pages/"+billing.ID, viewer, nil).Want(t, 404)
	e.Do("GET", "/v1/wiki/pages/"+docs.ID, viewer, nil).Want(t, 200)
	e.Do("POST", "/v1/wiki/pages", admin, map[string]any{"title": "x", "space": "team", "team_id": secret.String()}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "x", "space": "team", "team_id": uuid.NewString()}).Want(t, 422)

	// Links never leak a page out of sight: not in backlinks, mentions or the graph.
	link := `<p><a data-type="page" data-id="` + docs.ID + `" href="/wiki/` + docs.ID + `">Docs home</a></p>`
	e.Do("PATCH", "/v1/wiki/pages/"+billing.ID, agent, map[string]any{"body_html": link}).Want(t, 200)
	if got := mentions(t, e, viewer, "/v1/wiki/pages/"+docs.ID+"/backlinks"); len(got) != 0 {
		t.Fatalf("backlink from a hidden page %+v", got)
	}
	var graph struct{ Data []struct{ From string } }
	e.Do("GET", "/v1/wiki/graph", viewer, nil).Want(t, 200).JSON(t, &graph)
	if len(graph.Data) != 0 {
		t.Fatalf("graph shows a hidden page's link %+v", graph.Data)
	}
	if got := mentions(t, e, agent, "/v1/wiki/pages/"+docs.ID+"/backlinks"); len(got) != 1 {
		t.Fatalf("the member sees the backlink: %+v", got)
	}

	// The workspace-wide view (procedures) sees no private page and no private team's.
	wv, err := wiki.WorkspaceViewer(e.Ctx, e.D.DB.Pool, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wiki.LoadPage(e.Ctx, e.D.DB.Pool, wv, ws.ID, uuid.MustParse(billing.ID)); err == nil {
		t.Fatal("a procedure read a private team's page")
	}
	if _, err := wiki.LoadPage(e.Ctx, e.D.DB.Pool, wv, ws.ID, uuid.MustParse(docs.ID)); err != nil {
		t.Fatal(err)
	}
}

func TestTrashAndRestore(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, admin, viewer := ws.Agent.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)
	root := create(t, e, agent, map[string]any{"title": "Old process"})
	child := create(t, e, agent, map[string]any{"title": "Step one", "parent_id": root.ID, "body_html": "<p>unique wording</p>"})
	keep := create(t, e, agent, map[string]any{"title": "Keep"})
	e.Do("PUT", "/v1/wiki/favorites", agent, map[string]any{"page_ids": []string{child.ID, keep.ID}}).Want(t, 200)

	// Someone else's page is the admin's to trash, as it is to delete.
	e.Do("POST", "/v1/wiki/pages/"+root.ID+"/trash", ws.Owner.As(ws), nil).Want(t, 200)
	if ids := treeIDs(t, e, viewer); slices.Contains(ids, root.ID) || slices.Contains(ids, child.ID) || !slices.Contains(ids, keep.ID) {
		t.Fatalf("tree after trash %v", ids)
	}
	if p := get(t, e, viewer, child.ID); p.DeletedAt == nil {
		t.Fatal("a trashed page reads with deleted_at")
	}
	var s struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/search?q=unique", viewer, nil).Want(t, 200).JSON(t, &s)
	if len(s.Data) != 0 {
		t.Fatal("trashed page in search")
	}
	e.Do("PATCH", "/v1/wiki/pages/"+child.ID, agent, map[string]any{"title": "x"}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "x", "parent_id": root.ID}).Want(t, 422)
	var trash struct {
		Data []struct {
			ID       string `json:"id"`
			Subpages int    `json:"subpages"`
		}
	}
	e.Do("GET", "/v1/wiki/trash", viewer, nil).Want(t, 200).JSON(t, &trash)
	if len(trash.Data) != 1 || trash.Data[0].ID != root.ID || trash.Data[0].Subpages != 1 {
		t.Fatalf("trash %+v", trash.Data)
	}
	var favs struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/favorites", agent, nil).Want(t, 200).JSON(t, &favs)
	if len(favs.Data) != 1 || favs.Data[0].ID != keep.ID {
		t.Fatalf("favorites %+v", favs.Data)
	}

	// Restoring takes the whole batch back; a page trashed with its parent restores with it.
	e.Do("POST", "/v1/wiki/pages/"+child.ID+"/restore", agent, nil).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages/"+root.ID+"/restore", agent, nil).Want(t, 200)
	if ids := treeIDs(t, e, viewer); !slices.Contains(ids, root.ID) || !slices.Contains(ids, child.ID) {
		t.Fatalf("tree after restore %v", ids)
	}
	if got := children(tree(t, e, viewer), ""); len(got) != 2 || got[1] != "Old process" {
		t.Fatalf("restored last: %v", got)
	}

	// Thirty days later the trash empties itself.
	e.Do("POST", "/v1/wiki/pages/"+root.ID+"/trash", admin, nil).Want(t, 200)
	e.Exec(`UPDATE wiki_pages SET deleted_at = now() - interval '31 days' WHERE trashed_with = $1`, uuid.MustParse(root.ID))
	if err := wiki.PurgeTrash(e.Ctx, e.D, time.Now().Add(-30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", "/v1/wiki/pages/"+child.ID, admin, nil).Want(t, 404)
	// Delete for good works from the trash too.
	gone := create(t, e, agent, map[string]any{"title": "Gone"})
	e.Do("POST", "/v1/wiki/pages/"+gone.ID+"/trash", agent, nil).Want(t, 200)
	e.Do("DELETE", "/v1/wiki/pages/"+gone.ID, agent, nil).Want(t, 204)
	e.Do("GET", "/v1/wiki/pages/"+gone.ID, agent, nil).Want(t, 404)
}

func TestTemplatesAndDuplicate(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)
	src := create(t, e, agent, map[string]any{"title": "Incident review", "icon": "🧯"})
	sub := create(t, e, agent, map[string]any{"title": "Timeline", "parent_id": src.ID})
	link := `<div data-type="subpage" data-id="` + sub.ID + `"></div>`
	e.Do("PATCH", "/v1/wiki/pages/"+src.ID, agent, map[string]any{"body_html": link, "cover": "gradient:ember"}).Want(t, 200)

	// Save as template: out of the tree, in the templates.
	var tpl spaced
	e.Do("POST", "/v1/wiki/pages/"+src.ID+"/duplicate", agent, map[string]any{"template": true, "title": "Incident review template"}).Want(t, 201).JSON(t, &tpl)
	if !tpl.Template || len(tpl.Children) != 1 {
		t.Fatalf("template %+v", tpl)
	}
	if slices.Contains(treeIDs(t, e, viewer), tpl.ID) {
		t.Fatal("template in the tree")
	}
	var list struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/templates", viewer, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != tpl.ID {
		t.Fatalf("templates %+v", list.Data)
	}

	// A blank template is a page made as one.
	blank := create(t, e, agent, map[string]any{"title": "Weekly sync", "template": true})
	e.Do("GET", "/v1/wiki/templates", viewer, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 2 || slices.Contains(treeIDs(t, e, viewer), blank.ID) {
		t.Fatalf("blank template %+v", list.Data)
	}

	// A page from the template: its subpage copied, the subpage block pointing at the copy.
	var made spaced
	e.Do("POST", "/v1/wiki/pages/"+tpl.ID+"/duplicate", agent, map[string]any{"template": false, "title": "Outage 12 May"}).Want(t, 201).JSON(t, &made)
	if made.Template || made.Title != "Outage 12 May" || made.Icon != "🧯" || len(made.Children) != 1 {
		t.Fatalf("page from template %+v", made)
	}
	copied := made.Children[0].ID
	if copied == sub.ID || !strings.Contains(made.BodyHTML, copied) || strings.Contains(made.BodyHTML, sub.ID) {
		t.Fatalf("subpage block not remapped: %s", made.BodyHTML)
	}
	ids := treeIDs(t, e, viewer)
	if !slices.Contains(ids, made.ID) || !slices.Contains(ids, copied) {
		t.Fatal("page from template is not in the tree")
	}
	// Duplicate under itself is a cycle; viewers copy nothing.
	e.Do("POST", "/v1/wiki/pages/"+src.ID+"/duplicate", agent, map[string]any{"parent_id": sub.ID}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages/"+src.ID+"/duplicate", viewer, map[string]any{}).Want(t, 403)
}

func TestFavoritesRecentJournalAndVerification(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, admin := ws.Agent.As(ws), ws.Admin.As(ws)
	a := create(t, e, agent, map[string]any{"title": "A"})
	b := create(t, e, agent, map[string]any{"title": "B"})
	secret := create(t, e, admin, map[string]any{"title": "Admin's own", "space": "private"})

	// Favorites keep their order; pages out of sight are left out.
	var favs struct{ Data []struct{ ID string } }
	e.Do("PUT", "/v1/wiki/favorites", agent, map[string]any{"page_ids": []string{b.ID, a.ID, secret.ID}}).Want(t, 200).JSON(t, &favs)
	if len(favs.Data) != 2 || favs.Data[0].ID != b.ID || favs.Data[1].ID != a.ID {
		t.Fatalf("favorites %+v", favs.Data)
	}
	e.Do("GET", "/v1/wiki/favorites", hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeWikiRead)}, nil).Want(t, 403)

	// Reads count as visits: recent pages, and who reads a page.
	get(t, e, agent, a.ID)
	get(t, e, agent, b.ID)
	get(t, e, admin, a.ID)
	get(t, e, admin, a.ID)
	var recent struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/recent", agent, nil).Want(t, 200).JSON(t, &recent)
	if len(recent.Data) != 2 || recent.Data[0].ID != b.ID {
		t.Fatalf("recent %+v", recent.Data)
	}
	var views struct {
		Views, People int
	}
	e.Do("GET", "/v1/wiki/pages/"+a.ID+"/views", agent, nil).Want(t, 200).JSON(t, &views)
	if views.Views != 3 || views.People != 2 {
		t.Fatalf("views %+v", views)
	}

	// The journal: made on the first daily note, private, the same note for the same day.
	var day1, again, day2 spaced
	e.Do("POST", "/v1/wiki/daily", agent, map[string]any{"date": "2026-11-06", "title": "Friday, 6 November", "journal_title": "Journal"}).Want(t, 200).JSON(t, &day1)
	e.Do("POST", "/v1/wiki/daily", agent, map[string]any{"date": "2026-11-06", "title": "ignored"}).Want(t, 200).JSON(t, &again)
	e.Do("POST", "/v1/wiki/daily", agent, map[string]any{"date": "2026-11-07", "title": "Saturday, 7 November"}).Want(t, 200).JSON(t, &day2)
	if day1.ID != again.ID || !day1.Private || day1.DailyDate == nil || *day1.DailyDate != "2026-11-06" || day1.ParentID == nil {
		t.Fatalf("daily note %+v", day1)
	}
	if journal := get(t, e, agent, *day1.ParentID); !journal.Journal || !journal.Private || journal.Children[0].ID != day2.ID {
		t.Fatalf("journal %+v", journal)
	}
	var days struct{ Data []struct{ Date string } }
	e.Do("GET", "/v1/wiki/daily?from=2026-11-01&to=2026-11-30", agent, nil).Want(t, 200).JSON(t, &days)
	if len(days.Data) != 2 {
		t.Fatalf("days %+v", days.Data)
	}
	e.Do("GET", "/v1/wiki/pages/"+day1.ID, admin, nil).Want(t, 404)
	e.Do("POST", "/v1/wiki/pages/"+*day1.ParentID+"/move", agent, map[string]any{"parent_id": a.ID, "position": 0}).Want(t, 422)

	// Verification: by a person, for some days or for good, and taken away.
	var v spaced
	e.Do("PATCH", "/v1/wiki/pages/"+a.ID, admin, map[string]any{"verified": true, "verified_days": 90}).Want(t, 200).JSON(t, &v)
	if v.Verification == nil || v.Verification.By.ID != ws.Admin.ID.String() || v.Verification.Until == nil || v.Verification.Expired || v.Version != a.Version {
		t.Fatalf("verified %+v", v.Verification)
	}
	e.Exec(`UPDATE wiki_pages SET verified_until = now() - interval '1 day' WHERE id = $1`, uuid.MustParse(a.ID))
	if got := get(t, e, agent, a.ID); got.Verification == nil || !got.Verification.Expired {
		t.Fatal("an expired verification reads as expired")
	}
	e.Do("PATCH", "/v1/wiki/pages/"+a.ID, agent, map[string]any{"verified": false}).Want(t, 200).JSON(t, &v)
	if v.Verification != nil {
		t.Fatal("still verified")
	}
	e.Do("PATCH", "/v1/wiki/pages/"+a.ID, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeWikiRead, auth.ScopeWikiWrite)}, map[string]any{"verified": true}).Want(t, 403)
}
