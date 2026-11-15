package kb_test

import (
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

func TestArticleFromWiki(t *testing.T) {
	e := hdtest.New(t, kb.Register, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	other := e.AddUser(ws, auth.RoleAgent, "Omar Other").As(ws)

	var pg struct{ ID string }
	body := `<h2>Refunds</h2><p>Ask <span data-type="mention" data-id="` + ws.Agent.ID.String() + `" class="mention">@Anna Agent</span> first.</p>` +
		`<div data-type="callout" data-tone="blue"><p>Careful</p></div><img src="/v1/attachments/44444444-4444-4444-8444-444444444444" alt="x">`
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "Refund policy", "body_html": body}).Want(t, 201).JSON(t, &pg)

	var out struct {
		Article article `json:"article"`
		LeftOut int     `json:"left_out"`
	}
	e.Do("POST", "/v1/kb/articles/from-wiki", ws.Viewer.As(ws), map[string]any{"page_id": pg.ID}).Want(t, 403)
	e.Do("POST", "/v1/kb/articles/from-wiki", agent, map[string]any{"page_id": "00000000-0000-4000-8000-000000000000"}).Want(t, 404)
	e.Do("POST", "/v1/kb/articles/from-wiki", agent, map[string]any{"page_id": pg.ID}).Want(t, 201).JSON(t, &out)
	a := out.Article
	if a.Title != "Refund policy" || a.Status != "draft" || out.LeftOut != 1 {
		t.Fatalf("%+v left %d", a, out.LeftOut)
	}
	if !strings.Contains(a.BodyHTML, "<h2>Refunds</h2>") || !strings.Contains(a.BodyHTML, "Ask Anna Agent first.") ||
		!strings.Contains(a.BodyHTML, "<blockquote><p>Careful</p></blockquote>") {
		t.Fatalf("body %s", a.BodyHTML)
	}
	for _, gone := range []string{"mention", "data-", "/v1/attachments"} {
		if strings.Contains(a.BodyHTML, gone) {
			t.Fatalf("%q in %s", gone, a.BodyHTML)
		}
	}

	// A private page is someone else's: not found for them. An untitled page needs a title.
	var mine struct{ ID string }
	e.Do("POST", "/v1/wiki/pages", agent, map[string]any{"title": "", "space": "private", "body_html": "<p>notes</p>"}).Want(t, 201).JSON(t, &mine)
	e.Do("POST", "/v1/kb/articles/from-wiki", other, map[string]any{"page_id": mine.ID, "title": "Notes"}).Want(t, 404)
	e.Do("POST", "/v1/kb/articles/from-wiki", agent, map[string]any{"page_id": mine.ID}).Want(t, 422)
	e.Do("POST", "/v1/kb/articles/from-wiki", agent, map[string]any{"page_id": mine.ID, "title": "Notes"}).Want(t, 201)
}
