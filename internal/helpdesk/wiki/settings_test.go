package wiki_test

import (
	"os"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type settingsPage struct {
	page
	Cover     string `json:"cover"`
	CoverY    int    `json:"cover_y"`
	FullWidth bool   `json:"full_width"`
	SmallText bool   `json:"small_text"`
	Font      string `json:"font"`
	Locked    bool   `json:"locked"`
}

// A page's look is not its text: changing it keeps the version (a tab typing on the page
// never conflicts with it) and adds no revision, and readers hear of it.
func TestPageSettings(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent, viewer := ws.Agent.As(ws), ws.Viewer.As(ws)
	pg := create(t, e, agent, map[string]any{"title": "Runbook", "body_html": "<p>x</p>"})

	var got settingsPage
	e.Do("GET", "/v1/wiki/pages/"+pg.ID, viewer, nil).Want(t, 200).JSON(t, &got)
	if got.Cover != "" || got.CoverY != 50 || got.FullWidth || got.SmallText || got.Font != "default" || got.Locked {
		t.Fatalf("defaults %+v", got)
	}

	_, seq := e.Events(ws.ID, 0)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"cover": "gradient:ocean", "cover_y": 30, "full_width": true, "small_text": true, "font": "serif", "locked": true}).
		Want(t, 200).JSON(t, &got)
	if got.Cover != "gradient:ocean" || got.CoverY != 30 || !got.FullWidth || !got.SmallText || got.Font != "serif" || !got.Locked {
		t.Fatalf("settings %+v", got)
	}
	if got.Version != pg.Version {
		t.Fatalf("version moved to %d", got.Version)
	}
	var revs int
	e.Scalar(`SELECT count(*) FROM wiki_page_revisions WHERE page_id = $1`, &revs, pg.ID)
	if revs != 1 {
		t.Fatalf("%d revisions", revs)
	}
	evs, _ := e.Events(ws.ID, seq)
	var data string
	e.Scalar(`SELECT data::text FROM events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT 1`, &data, ws.ID, seq)
	if len(evs) != 1 || evs[0] != "wiki_page.updated" || !strings.Contains(data, `"settings"`) {
		t.Fatalf("events %v %s", evs, data)
	}

	// A typing tab's save with the old version still applies.
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"body_html": "<p>y</p>", "version": pg.Version}).Want(t, 200)

	// Covers: the app's gradients, https or our attachments; nothing else.
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"cover": "https://images.example/c.jpg"}).Want(t, 200)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"cover": "/v1/attachments/3dcb61fa-abc6-47ac-9916-06acf5b7fdf7"}).Want(t, 200)
	for _, bad := range []string{"gradient:nope", "http://x.example/c.jpg", "javascript:alert(1)", "data:image/png;base64,AA"} {
		e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"cover": bad}).Want(t, 422)
	}
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"font": "comic"}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"cover_y": 101}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, viewer, map[string]any{"locked": false}).Want(t, 403)

	// Nothing changed, nothing published.
	_, seq = e.Events(ws.ID, 0)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, agent, map[string]any{"font": "serif"}).Want(t, 200)
	if evs, _ := e.Events(ws.ID, seq); len(evs) != 0 {
		t.Fatalf("published %d events for no change", len(evs))
	}
}

// Every block the wiki editor writes is stored as written (hd.SanitizeWiki).
func TestPageKeepsBlocks(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	raw, err := os.ReadFile("../hd/testdata/wiki_editor.html")
	if err != nil {
		t.Fatal(err)
	}
	pg := create(t, e, agent, map[string]any{"title": "Blocks", "body_html": string(raw)})
	for _, k := range []string{`data-type="callout"`, `data-type="columns"`, `data-type="taskItem"`, `data-type="embed"`, `<details`, `<table`, `data-type="page"`, `data-block-id=`} {
		if !strings.Contains(pg.BodyHTML, k) {
			t.Errorf("lost %s", k)
		}
	}
}

func TestUnfurlNeedsHTTPSAndWriters(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	e.Do("POST", "/v1/wiki/unfurl", ws.Agent.As(ws), map[string]any{"url": "http://example.com"}).Want(t, 422)
	e.Do("POST", "/v1/wiki/unfurl", ws.Viewer.As(ws), map[string]any{"url": "https://example.com"}).Want(t, 403)
	// Local and private addresses are refused before any request.
	e.Do("POST", "/v1/wiki/unfurl", ws.Agent.As(ws), map[string]any{"url": "https://169.254.169.254/latest/meta-data"}).Want(t, 422)
}
