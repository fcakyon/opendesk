package wiki_test

import (
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type areaNode struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parent_id"`
	Title    string  `json:"title"`
	Position int     `json:"position"`
	Area     string  `json:"area"`
}

func areaTree(t *testing.T, e *hdtest.Env, a hdtest.Auth, area string) []areaNode {
	t.Helper()
	var out struct{ Data []areaNode }
	e.Do("GET", "/v1/wiki/pages?area="+area, a, nil).Want(t, 200).JSON(t, &out)
	return out.Data
}

func areaTitles(nodes []areaNode) []string {
	out := []string{}
	for _, n := range nodes {
		out = append(out, n.Title)
	}
	return out
}

// Pages (contracts/pages.md) is a tree of its own beside the wiki's: each list reads one
// area, subpages stay in their parent's, links cross, a page moves between them with its
// subpages, and with Pages off its pages are out of reach but kept.
func TestPagesArea(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)

	runbook := create(t, e, agent, map[string]any{"title": "Runbook"})
	var roadmap areaNode
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Roadmap", "area": "pages",
		"body_html": `<p>See <a data-type="page" data-id="` + runbook.ID + `" href="/wiki/` + runbook.ID + `">Runbook</a></p>`}).Want(t, 201).JSON(t, &roadmap)
	if roadmap.Area != "pages" || roadmap.Position != 0 {
		t.Fatalf("roadmap %+v", roadmap)
	}
	// A subpage goes in its parent's area, whatever it asks for.
	var q1 areaNode
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Q1", "parent_id": roadmap.ID, "area": "wiki"}).Want(t, 201).JSON(t, &q1)
	if q1.Area != "pages" {
		t.Fatalf("subpage area %q", q1.Area)
	}
	if got := areaTitles(areaTree(t, e, agent, "wiki")); !slices.Equal(got, []string{"Runbook"}) {
		t.Fatalf("wiki tree %v", got)
	}
	if got := areaTitles(areaTree(t, e, agent, "pages")); !slices.Equal(got, []string{"Roadmap", "Q1"}) {
		t.Fatalf("pages tree %v", got)
	}
	// Left out, a list reads the wiki's, as before Pages.
	var plain struct{ Data []areaNode }
	e.Do("GET", "/v1/wiki/pages", agent, nil).Want(t, 200).JSON(t, &plain)
	if got := areaTitles(plain.Data); !slices.Equal(got, []string{"Runbook"}) {
		t.Fatalf("default tree %v", got)
	}

	// Links cross areas; search finds both and says which.
	var back struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/pages/"+runbook.ID+"/backlinks", agent, nil).Want(t, 200).JSON(t, &back)
	if len(back.Data) != 1 || back.Data[0].ID != roadmap.ID {
		t.Fatalf("backlinks %+v", back.Data)
	}
	var hits struct {
		Data []struct {
			ID   string
			Area string `json:"area"`
		}
	}
	e.Do("GET", "/v1/wiki/search?q=roadmap", agent, nil).Want(t, 200).JSON(t, &hits)
	if len(hits.Data) != 1 || hits.Data[0].Area != "pages" {
		t.Fatalf("search %+v", hits.Data)
	}
	e.Do("GET", "/v1/wiki/search?q=roadmap&area=wiki", agent, nil).Want(t, 200).JSON(t, &hits)
	if len(hits.Data) != 0 {
		t.Fatalf("wiki-only search %+v", hits.Data)
	}

	// Each area has its own journal: one daily note of a day in each.
	var dw, dp areaNode
	e.Do("POST", "/v1/wiki/daily", agent, map[string]any{"date": "2026-11-07", "title": "Saturday"}).Want(t, 200).JSON(t, &dw)
	e.Do("POST", "/v1/wiki/daily", agent, map[string]any{"date": "2026-11-07", "title": "Saturday", "area": "pages"}).Want(t, 200).JSON(t, &dp)
	if dw.ID == dp.ID || dw.Area != "wiki" || dp.Area != "pages" {
		t.Fatalf("daily notes %+v %+v", dw, dp)
	}

	// Moving to the other area at the top level takes the subpages along.
	var moved areaNode
	e.Do("POST", "/v1/wiki/pages/"+roadmap.ID+"/move", agent, map[string]any{"parent_id": nil, "position": 99, "area": "wiki"}).Want(t, 200).JSON(t, &moved)
	if moved.Area != "wiki" {
		t.Fatalf("moved %+v", moved)
	}
	if got := areaTitles(areaTree(t, e, agent, "wiki")); !slices.Contains(got, "Q1") || !slices.Contains(got, "Roadmap") {
		t.Fatalf("wiki tree after the move %v", got)
	}
	if got := areaTitles(areaTree(t, e, agent, "pages")); slices.Contains(got, "Q1") {
		t.Fatalf("pages tree after the move %v", got)
	}
	e.Do("POST", "/v1/wiki/pages/"+roadmap.ID+"/move", agent, map[string]any{"parent_id": nil, "position": 0, "area": "pages"}).Want(t, 200)

	// Pages off: its pages and lists are refused, the wiki's are not, nothing is lost.
	var favs struct{ Data []areaNode }
	e.Do("PUT", "/v1/wiki/favorites", agent, map[string]any{"page_ids": []string{roadmap.ID, runbook.ID}}).Want(t, 200)
	e.SetSettings(ws, map[string]any{"pages_enabled": false})
	// Saving favorites while Pages is off replaces the wiki's and keeps Pages'.
	e.Do("PUT", "/v1/wiki/favorites", agent, map[string]any{"page_ids": []string{runbook.ID}}).Want(t, 200).JSON(t, &favs)
	if got := areaTitles(favs.Data); !slices.Equal(got, []string{"Runbook"}) {
		t.Fatalf("favorites with Pages off %v", got)
	}
	for _, path := range []string{"/v1/wiki/pages?area=pages", "/v1/wiki/pages/" + roadmap.ID, "/v1/wiki/trash?area=pages", "/v1/wiki/search?q=roadmap&area=pages"} {
		var problem struct {
			Code    string `json:"code"`
			Product string `json:"product"`
		}
		e.Do("GET", path, agent, nil).Want(t, 403).JSON(t, &problem)
		if problem.Code != "feature_disabled" || problem.Product != "pages" {
			t.Fatalf("%s: %+v", path, problem)
		}
	}
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "New", "area": "pages"}).Want(t, 403)
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Child", "parent_id": roadmap.ID}).Want(t, 403)
	e.Do("GET", "/v1/wiki/pages/"+runbook.ID, agent, nil).Want(t, 200)
	e.Do("GET", "/v1/wiki/search?q=roadmap", agent, nil).Want(t, 200).JSON(t, &hits)
	if len(hits.Data) != 0 {
		t.Fatalf("search with Pages off %+v", hits.Data)
	}
	e.SetSettings(ws, map[string]any{"pages_enabled": true})
	if got := areaTitles(areaTree(t, e, agent, "pages")); !slices.Contains(got, "Roadmap") {
		t.Fatalf("pages tree back %v", got)
	}
	e.Do("GET", "/v1/wiki/favorites", agent, nil).Want(t, 200).JSON(t, &favs)
	if got := areaTitles(favs.Data); !slices.Equal(got, []string{"Roadmap", "Runbook"}) {
		t.Fatalf("favorites with Pages back %v", got)
	}
}

// With Pages off, nothing of Pages' pages reaches a wiki reader: not as a backlink or an
// unlinked mention of a wiki page, not as one of their files. Turned on again, all is back.
func TestPagesOffHidesItsLinksAndFiles(t *testing.T) {
	e := hdtest.New(t, wiki.Register, widget.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)

	runbook := create(t, e, agent, map[string]any{"title": "Runbook"})
	var file struct{ ID string }
	e.Upload("/v1/attachments", agent, "chart.png", []byte(pngBytes)).Want(t, 201).JSON(t, &file)
	var roadmap, notes areaNode
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Roadmap", "area": "pages",
		"body_html": `<p>See <a data-type="page" data-id="` + runbook.ID + `" href="/wiki/` + runbook.ID + `">Runbook</a></p><img src="/v1/attachments/` + file.ID + `">`}).Want(t, 201).JSON(t, &roadmap)
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Notes", "area": "pages", "body_html": "<p>Read the Runbook first.</p>"}).Want(t, 201).JSON(t, &notes)

	check := func(on bool) {
		t.Helper()
		back := ids(mentions(t, e, agent, "/v1/wiki/pages/"+runbook.ID+"/backlinks"))
		named := ids(mentions(t, e, agent, "/v1/wiki/pages/"+runbook.ID+"/mentions"))
		if slices.Contains(back, roadmap.ID) != on || slices.Contains(named, notes.ID) != on {
			t.Fatalf("Pages on %v: backlinks %v, unlinked mentions %v", on, back, named)
		}
		status := 404
		if on {
			status = 200
		}
		e.Do("GET", "/v1/attachments/"+file.ID, agent, nil).Want(t, status)
	}
	check(true)
	e.SetSettings(ws, map[string]any{"pages_enabled": false})
	check(false)
	e.SetSettings(ws, map[string]any{"pages_enabled": true})
	check(true)
}
