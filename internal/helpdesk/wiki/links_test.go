package wiki_test

import (
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type mention struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

type tagged struct {
	ID   string   `json:"id"`
	Tags []string `json:"tags"`
}

func mentions(t *testing.T, e *hdtest.Env, a hdtest.Auth, path string) []mention {
	t.Helper()
	var out struct{ Data []mention }
	e.Do("GET", path, a, nil).Want(t, 200).JSON(t, &out)
	return out.Data
}

func ids(ms []mention) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}

func TestLinksAndTags(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)

	refunds := create(t, e, agent, map[string]any{"title": "Refund policy"})
	link := `<a data-type="page" data-id="` + refunds.ID + `" href="/wiki/` + refunds.ID + `">Refund policy</a>`
	byLink := create(t, e, agent, map[string]any{"title": "Escalation", "body_html": `<p>Money at stake? Read ` + link + ` first. #Billing #urgent-ish #42 <code>#notatag</code></p><pre><code>#nor-this</code></pre>`})
	bySubpage := create(t, e, agent, map[string]any{"title": "Index", "body_html": `<div data-type="subpage" data-id="` + refunds.ID + `"></div>`})
	named := create(t, e, agent, map[string]any{"title": "Onboarding", "body_html": `<p>Week one: read the refund policy and shadow a teammate.</p>`})
	create(t, e, agent, map[string]any{"title": "Unrelated", "body_html": `<p>Refunds, policies, but never the phrase.</p>`})

	if got := ids(mentions(t, e, viewer, "/v1/wiki/pages/"+refunds.ID+"/backlinks")); !slices.Contains(got, byLink.ID) || !slices.Contains(got, bySubpage.ID) || len(got) != 2 {
		t.Fatalf("backlinks %v", got)
	}
	unlinked := mentions(t, e, viewer, "/v1/wiki/pages/"+refunds.ID+"/mentions")
	if len(unlinked) != 1 || unlinked[0].ID != named.ID || unlinked[0].Snippet == "" {
		t.Fatalf("unlinked %+v", unlinked)
	}

	// Tags come from the text, lower case, never from code; a number is not a tag.
	var nodes struct{ Data []tagged }
	e.Do("GET", "/v1/wiki/pages", viewer, nil).Want(t, 200).JSON(t, &nodes)
	for _, n := range nodes.Data {
		if n.ID == byLink.ID && !slices.Equal(n.Tags, []string{"billing", "urgent-ish"}) {
			t.Fatalf("tags %v", n.Tags)
		}
	}

	// Linking it moves the page from unlinked mentions to backlinks.
	e.Do("PATCH", "/v1/wiki/pages/"+named.ID, agent, map[string]any{"body_html": `<p>Week one: read the ` + link + ` and shadow a teammate.</p>`}).Want(t, 200)
	if got := mentions(t, e, viewer, "/v1/wiki/pages/"+refunds.ID+"/mentions"); len(got) != 0 {
		t.Fatalf("still unlinked %+v", got)
	}
	if got := mentions(t, e, viewer, "/v1/wiki/pages/"+refunds.ID+"/backlinks"); len(got) != 3 {
		t.Fatalf("backlinks %d", len(got))
	}

	var graph struct {
		Data []struct{ From, To string }
	}
	e.Do("GET", "/v1/wiki/graph", viewer, nil).Want(t, 200).JSON(t, &graph)
	if len(graph.Data) != 3 {
		t.Fatalf("graph %+v", graph.Data)
	}

	// Another workspace's page is never linked; a deleted page takes its links along.
	other := e.NewWorkspace()
	foreign := create(t, e, other.Owner.As(other), map[string]any{"title": "Theirs"})
	e.Do("PATCH", "/v1/wiki/pages/"+bySubpage.ID, agent, map[string]any{"body_html": `<p><a href="/wiki/` + foreign.ID + `">x</a></p>`}).Want(t, 200)
	e.Do("DELETE", "/v1/wiki/pages/"+byLink.ID, ws.Admin.As(ws), nil).Want(t, 204)
	e.Do("GET", "/v1/wiki/graph", viewer, nil).Want(t, 200).JSON(t, &graph)
	if len(graph.Data) != 1 || graph.Data[0].From != named.ID {
		t.Fatalf("graph after %+v", graph.Data)
	}
	e.Do("GET", "/v1/wiki/pages/"+refunds.ID+"/backlinks", other.Owner.As(other), nil).Want(t, 404)
}
