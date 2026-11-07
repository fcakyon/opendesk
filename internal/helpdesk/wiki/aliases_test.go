package wiki_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type aliased struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Version int      `json:"version"`
	Aliases []string `json:"aliases"`
}

func aliasesOf(t *testing.T, e *hdtest.Env, a hdtest.Auth, id string) aliased {
	t.Helper()
	var out aliased
	e.Do("GET", "/v1/wiki/pages/"+id, a, nil).Want(t, 200).JSON(t, &out)
	return out
}

// Aliases are cleaned like titles, at most 10 of 100 characters; changing them keeps the version.
func TestAliasesCleanAndLimits(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	pg := create(t, e, agent, map[string]any{"title": "Refund policy", "aliases": []string{"  money\n back ", "Money back", "", "Returns"}})
	if got := aliasesOf(t, e, viewer, pg.ID); !slices.Equal(got.Aliases, []string{"money back", "Returns"}) {
		t.Fatalf("aliases on create: %q", got.Aliases)
	}
	var out aliased
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"aliases": []string{"Chargebacks", "returns policy"}}).Want(t, 200).JSON(t, &out)
	if !slices.Equal(out.Aliases, []string{"Chargebacks", "returns policy"}) || out.Version != pg.Version {
		t.Fatalf("patch: %+v (version was %d)", out, pg.Version)
	}
	var tree struct{ Data []aliased }
	e.Do("GET", "/v1/wiki/pages", viewer, nil).Want(t, 200).JSON(t, &tree)
	if i := slices.IndexFunc(tree.Data, func(n aliased) bool { return n.ID == pg.ID }); i < 0 || !slices.Equal(tree.Data[i].Aliases, out.Aliases) {
		t.Fatalf("tree node: %+v", tree.Data)
	}

	eleven := make([]string, 11)
	for i := range eleven {
		eleven[i] = "name " + string(rune('a'+i))
	}
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"aliases": eleven}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"aliases": []string{strings.Repeat("x", 101)}}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"aliases": []string{strings.Repeat("é", 100)}}).Want(t, 200)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, viewer, map[string]any{"aliases": []string{"x"}}).Want(t, 403)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"aliases": []string{}}).Want(t, 200).JSON(t, &out)
	if len(out.Aliases) != 0 {
		t.Fatalf("cleared: %q", out.Aliases)
	}
}

// Search finds a page by an alias, and unlinked mentions look for its aliases as for its title.
func TestAliasesSearchAndMentions(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	pg := create(t, e, agent, map[string]any{"title": "Refund policy", "aliases": []string{"Money back guarantee"}})
	byTitle := create(t, e, agent, map[string]any{"title": "Onboarding", "body_html": "<p>Read the refund policy first.</p>"})
	byAlias := create(t, e, agent, map[string]any{"title": "Sales script", "body_html": "<p>Mention our money back guarantee, always.</p>"})
	create(t, e, agent, map[string]any{"title": "Unrelated", "body_html": "<p>Money comes back, guaranteed, but not the phrase.</p>"})

	var s struct{ Data []struct{ ID string } }
	e.Do("GET", "/v1/wiki/search?q=guarantee", viewer, nil).Want(t, 200).JSON(t, &s)
	if len(s.Data) == 0 || s.Data[0].ID != pg.ID {
		t.Fatalf("search by alias: %+v", s.Data)
	}

	got := mentions(t, e, viewer, "/v1/wiki/pages/"+pg.ID+"/mentions")
	if g := ids(got); len(g) != 2 || !slices.Contains(g, byTitle.ID) || !slices.Contains(g, byAlias.ID) {
		t.Fatalf("unlinked mentions: %+v", got)
	}
	for _, m := range got {
		if m.ID == byAlias.ID && !strings.Contains(strings.ToLower(m.Snippet), "money back guarantee") {
			t.Fatalf("snippet around the alias: %q", m.Snippet)
		}
	}

	// An untitled page is found by its aliases alone.
	untitled := create(t, e, agent, map[string]any{"aliases": []string{"Sales playbook"}})
	create(t, e, agent, map[string]any{"title": "Training", "body_html": "<p>Learn the sales playbook by heart.</p>"})
	if g := mentions(t, e, viewer, "/v1/wiki/pages/"+untitled.ID+"/mentions"); len(g) != 1 {
		t.Fatalf("untitled page's mentions: %+v", g)
	}
}

// Markdown export writes aliases into the front matter, and import reads them back.
func TestAliasesExportImport(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)

	pg := create(t, e, agent, map[string]any{"title": "Refunds", "aliases": []string{"Money back", `Say "yes"`}})
	r := e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/export?format=markdown", agent, nil).Want(t, 200)
	if !strings.Contains(string(r.Body), "aliases:\n  - \"Money back\"\n  - \"Say \\\"yes\\\"\"\n") {
		t.Fatalf("front matter: %s", r.Body)
	}

	out := importOK(t, e, agent, nil, portFile{"Returns.md", "---\naliases: [Give back, \"Money back\"]\nalias: Refund\n---\nText.\n"})
	if got := aliasesOf(t, e, agent, out.RootIDs[0]); !slices.Equal(got.Aliases, []string{"Give back", "Money back", "Refund"}) {
		t.Fatalf("imported aliases: %q", got.Aliases)
	}
	// Past the wiki's limits: an over-long one is left out, then the first 10 kept.
	var b strings.Builder
	b.WriteString("---\naliases:\n  - " + strings.Repeat("x", 101) + "\n")
	for i := range 12 {
		b.WriteString("  - name " + string(rune('a'+i)) + "\n")
	}
	b.WriteString("---\n")
	out = importOK(t, e, agent, nil, portFile{"Many.md", b.String()})
	if got := aliasesOf(t, e, agent, out.RootIDs[0]); len(got.Aliases) != 10 || got.Aliases[0] != "name a" {
		t.Fatalf("trimmed aliases: %q", got.Aliases)
	}
}

type analytics struct {
	Days []struct {
		Date    string `json:"date"`
		Views   int    `json:"views"`
		Viewers int    `json:"viewers"`
	} `json:"days"`
	TotalViews   int `json:"total_views"`
	TotalViewers int `json:"total_viewers"`
	Edits        []struct {
		Date  string `json:"date"`
		Count int    `json:"count"`
	} `json:"edits"`
}

// Views count per person and day, reads close together once; counts only, to those who may see the page.
func TestPageAnalytics(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, admin, viewer := ws.Agent.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)

	pg := create(t, e, agent, map[string]any{"title": "Refunds"})
	pid := uuid.MustParse(pg.ID)
	read := func(a hdtest.Auth, id string) { e.Do("GET", "/v1/wiki/pages/"+id, a, nil).Want(t, 200) }
	read(viewer, pg.ID)
	read(viewer, pg.ID) // again at once: the same view
	read(admin, pg.ID)
	// The viewer's last read more than 30 minutes ago: the next one is a new view.
	e.Exec(`UPDATE wiki_visits SET last_at = now() - interval '1 hour' WHERE page_id = $1 AND user_id = $2`, pid, ws.Viewer.ID)
	read(viewer, pg.ID)
	e.Exec(`INSERT INTO wiki_page_views (workspace_id, page_id, day, user_id, views) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 2, $3, 4)`, ws.ID, pid, ws.Agent.ID)
	e.Exec(`INSERT INTO wiki_page_views (workspace_id, page_id, day, user_id, views) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 60, $3, 9)`, ws.ID, pid, ws.Agent.ID)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"body_html": "<p>Within 30 days.</p>"}).Want(t, 200)

	var a analytics
	e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/analytics", viewer, nil).Want(t, 200).JSON(t, &a)
	if len(a.Days) != 28 || len(a.Edits) != 28 {
		t.Fatalf("days %d edits %d", len(a.Days), len(a.Edits))
	}
	today, before := a.Days[27], a.Days[25]
	if today.Views != 3 || today.Viewers != 2 || before.Views != 4 || before.Viewers != 1 || a.TotalViews != 7 || a.TotalViewers != 3 {
		t.Fatalf("analytics: %+v", a)
	}
	if a.Edits[27].Count < 1 {
		t.Fatalf("edits today: %+v", a.Edits[27])
	}
	e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/analytics?days=90", viewer, nil).Want(t, 200).JSON(t, &a)
	if len(a.Days) != 90 || a.TotalViews != 16 {
		t.Fatalf("90 days: %d days, %d views", len(a.Days), a.TotalViews)
	}
	e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/analytics?days=91", viewer, nil).Want(t, 422)
	e.Do("GET", "/v1/wiki/pages/"+uuid.NewString()+"/analytics", viewer, nil).Want(t, 404)

	// A private page's analytics are its member's alone; nobody else learns it exists.
	mine := create(t, e, agent, map[string]any{"title": "Mine", "space": "private"})
	read(agent, mine.ID)
	e.Do("GET", "/v1/wiki/pages/"+mine.ID+"/analytics", agent, nil).Want(t, 200).JSON(t, &a)
	if a.TotalViews != 1 || a.TotalViewers != 1 {
		t.Fatalf("private page: %d views by %d", a.TotalViews, a.TotalViewers)
	}
	e.Do("GET", "/v1/wiki/pages/"+mine.ID+"/analytics", admin, nil).Want(t, 404)

	// Another workspace's page is not found.
	other := e.NewWorkspace()
	e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/analytics", other.Admin.As(other), nil).Want(t, 404)
}
