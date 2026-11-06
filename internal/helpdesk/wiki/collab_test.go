package wiki_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

type comment struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
	Author   *struct {
		ID string `json:"id"`
	} `json:"author"`
	BodyHTML  string   `json:"body_html"`
	Mentions  []string `json:"mentions"`
	EditedAt  *string  `json:"edited_at"`
	Reactions []struct {
		Emoji string   `json:"emoji"`
		Users []string `json:"users"`
	} `json:"reactions"`
}

type thread struct {
	ID         string  `json:"id"`
	PageID     string  `json:"page_id"`
	Quote      string  `json:"quote"`
	Inline     bool    `json:"inline"`
	ResolvedAt *string `json:"resolved_at"`
	ResolvedBy *struct {
		ID string `json:"id"`
	} `json:"resolved_by"`
	Comments []comment `json:"comments"`
}

func say(t *testing.T, e *hdtest.Env, a hdtest.Auth, pageID string, body map[string]any) thread {
	t.Helper()
	var out thread
	e.Do("POST", "/v1/wiki/pages/"+pageID+"/comments", a, body).Want(t, 201).JSON(t, &out)
	return out
}

func threads(t *testing.T, e *hdtest.Env, a hdtest.Auth, pageID string) ([]thread, bool) {
	t.Helper()
	var out struct {
		Data      []thread `json:"data"`
		Following bool     `json:"following"`
	}
	e.Do("GET", "/v1/wiki/pages/"+pageID+"/comments", a, nil).Want(t, 200).JSON(t, &out)
	return out.Data, out.Following
}

func at(u hdtest.User) string {
	return `<span data-type="mention" data-id="` + u.ID.String() + `" class="mention">@` + u.Name + `</span>`
}

type note struct {
	Type string
	Data map[string]any
}

// wikiNotes are the user's wiki notifications in the workspace, oldest first.
func wikiNotes(t *testing.T, e *hdtest.Env, ws hdtest.WS, u hdtest.User) []note {
	t.Helper()
	rows, err := e.D.DB.Pool.Query(e.Ctx, `SELECT type, data FROM notifications WHERE workspace_id = $1 AND user_id = $2 AND type LIKE 'wiki_%' ORDER BY created_at, id`, ws.ID, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []note
	for rows.Next() {
		var n note
		var raw []byte
		if err := rows.Scan(&n.Type, &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &n.Data); err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

func count(notes []note, typ, pageID string) int {
	n := 0
	for _, x := range notes {
		if x.Type == typ && x.Data["page_id"] == pageID {
			n++
		}
	}
	return n
}

func TestCommentThreads(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	bob := e.AddUser(ws, auth.RoleAgent, "Bob Agent")
	anna, b, admin, viewer := ws.Agent.As(ws), bob.As(ws), ws.Admin.As(ws), ws.Viewer.As(ws)

	pg := create(t, e, anna, map[string]any{"title": "Refunds", "body_html": "<p>Refunds within 30 days.</p>"})
	other := create(t, e, anna, map[string]any{"title": "Other"})

	th := say(t, e, b, pg.ID, map[string]any{"body_html": "<p>Is this right?</p>", "inline": true, "quote": "  30   days "})
	if th.ID == "" || th.ID != th.Comments[0].ID || th.Comments[0].ThreadID != th.ID || !th.Inline || th.Quote != "30 days" || th.PageID != pg.ID {
		t.Fatalf("new thread %+v", th)
	}
	if th.Comments[0].Author == nil || th.Comments[0].Author.ID != bob.ID.String() {
		t.Fatalf("author %+v", th.Comments[0].Author)
	}
	reply := say(t, e, anna, pg.ID, map[string]any{"body_html": "<p>Yes <script>x</script></p>", "thread_id": th.ID, "quote": "ignored"})
	if len(reply.Comments) != 2 || reply.Quote != "30 days" || strings.Contains(reply.Comments[1].BodyHTML, "script") {
		t.Fatalf("reply %+v", reply)
	}
	annaReply := reply.Comments[1].ID

	// Viewers read but don't write; a hidden or unknown page is not found.
	list, following := threads(t, e, viewer, pg.ID)
	if len(list) != 1 || len(list[0].Comments) != 2 || following {
		t.Fatalf("viewer reads %+v following %v", list, following)
	}
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/comments", viewer, map[string]any{"body_html": "<p>x</p>"}).Want(t, 403)
	e.Do("GET", "/v1/wiki/pages/"+uuid.NewString()+"/comments", anna, nil).Want(t, 404)

	// Bad input.
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/comments", anna, map[string]any{"body_html": "<p> </p>"}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/comments", anna, map[string]any{"body_html": "<p>x</p>", "thread_id": annaReply}).Want(t, 422)
	e.Do("POST", "/v1/wiki/pages/"+other.ID+"/comments", anna, map[string]any{"body_html": "<p>x</p>", "thread_id": th.ID}).Want(t, 422)

	// Only the author edits.
	e.Do("PATCH", "/v1/wiki/comments/"+annaReply, b, map[string]any{"body_html": "<p>mine now</p>"}).Want(t, 403)
	var edited thread
	e.Do("PATCH", "/v1/wiki/comments/"+annaReply, anna, map[string]any{"body_html": "<p>Yes, 30 days.</p>"}).Want(t, 200).JSON(t, &edited)
	if c := edited.Comments[1]; c.BodyHTML != "<p>Yes, 30 days.</p>" || c.EditedAt == nil {
		t.Fatalf("edited %+v", c)
	}

	// Resolving, and a reply reopens.
	var resolved thread
	e.Do("POST", "/v1/wiki/threads/"+th.ID+"/resolve", b, map[string]any{"resolved": true}).Want(t, 200).JSON(t, &resolved)
	if resolved.ResolvedAt == nil || resolved.ResolvedBy == nil || resolved.ResolvedBy.ID != bob.ID.String() {
		t.Fatalf("resolved %+v", resolved)
	}
	e.Do("POST", "/v1/wiki/threads/"+annaReply+"/resolve", b, map[string]any{"resolved": true}).Want(t, 404)
	reopened := say(t, e, admin, pg.ID, map[string]any{"body_html": "<p>One more thing</p>", "thread_id": th.ID})
	if reopened.ResolvedAt != nil || reopened.ResolvedBy != nil || len(reopened.Comments) != 3 {
		t.Fatalf("a reply reopens: %+v", reopened)
	}

	// Reactions: one per person and emoji, oldest first.
	var r thread
	e.Do("POST", "/v1/wiki/comments/"+th.ID+"/reactions", b, map[string]any{"emoji": "👍", "on": true}).Want(t, 200)
	e.Do("POST", "/v1/wiki/comments/"+th.ID+"/reactions", anna, map[string]any{"emoji": "👍", "on": true}).Want(t, 200)
	e.Do("POST", "/v1/wiki/comments/"+th.ID+"/reactions", anna, map[string]any{"emoji": "👍", "on": true}).Want(t, 200).JSON(t, &r)
	if got := r.Comments[0].Reactions; len(got) != 1 || !slices.Equal(got[0].Users, []string{bob.ID.String(), ws.Agent.ID.String()}) {
		t.Fatalf("reactions %+v", got)
	}
	e.Do("POST", "/v1/wiki/comments/"+th.ID+"/reactions", b, map[string]any{"emoji": "👍", "on": false}).Want(t, 200).JSON(t, &r)
	if got := r.Comments[0].Reactions; len(got) != 1 || !slices.Equal(got[0].Users, []string{ws.Agent.ID.String()}) {
		t.Fatalf("reaction taken back %+v", got)
	}
	e.Do("POST", "/v1/wiki/comments/"+th.ID+"/reactions", b, map[string]any{"emoji": "ok", "on": true}).Want(t, 422)

	// The author or an admin deletes; the first comment takes its thread with it.
	e.Do("DELETE", "/v1/wiki/comments/"+annaReply, b, nil).Want(t, 403)
	e.Do("DELETE", "/v1/wiki/comments/"+annaReply, admin, nil).Want(t, 204)
	if list, _ := threads(t, e, anna, pg.ID); len(list) != 1 || len(list[0].Comments) != 2 {
		t.Fatalf("after deleting a reply %+v", list)
	}
	e.Do("DELETE", "/v1/wiki/comments/"+th.ID, b, nil).Want(t, 204)
	if list, _ := threads(t, e, anna, pg.ID); len(list) != 0 {
		t.Fatalf("the thread went with its first comment %+v", list)
	}
	var left int
	e.Scalar(`SELECT count(*) FROM wiki_comments WHERE thread_id = $1`, &left, th.ID)
	if left != 0 {
		t.Fatalf("%d comments outlived their thread", left)
	}

	// An API key reads comments but never writes as someone.
	key := hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeWikiRead, auth.ScopeWikiWrite), Workspace: ws.ID}
	e.Do("GET", "/v1/wiki/pages/"+pg.ID+"/comments", key, nil).Want(t, 200)
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/comments", key, map[string]any{"body_html": "<p>x</p>"}).Want(t, 403)
}

func TestCommentsOnHiddenAndTrashedPages(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	anna, admin := ws.Agent.As(ws), ws.Admin.As(ws)

	mine := create(t, e, anna, map[string]any{"title": "Mine", "space": "private"})
	_, seq := e.Events(ws.ID, 0)
	th := say(t, e, anna, mine.ID, map[string]any{"body_html": "<p>note to self</p>"})
	var topics []string
	e.Scalar(`SELECT topics FROM events WHERE workspace_id = $1 AND seq > $2 AND type = 'wiki_comment.changed'`, &topics, ws.ID, seq)
	if slices.Contains(topics, events.WorkspaceTopic(ws.ID)) || !slices.Contains(topics, events.UserTopic(ws.Agent.ID)) {
		t.Fatalf("a private page's comment event went to %v", topics)
	}
	e.Do("GET", "/v1/wiki/pages/"+mine.ID+"/comments", admin, nil).Want(t, 404)
	e.Do("POST", "/v1/wiki/pages/"+mine.ID+"/comments", admin, map[string]any{"body_html": "<p>x</p>"}).Want(t, 404)
	e.Do("PATCH", "/v1/wiki/comments/"+th.ID, admin, map[string]any{"body_html": "<p>x</p>"}).Want(t, 404)
	e.Do("DELETE", "/v1/wiki/comments/"+th.ID, admin, nil).Want(t, 404)
	e.Do("POST", "/v1/wiki/threads/"+th.ID+"/resolve", admin, map[string]any{"resolved": true}).Want(t, 404)
	e.Do("PUT", "/v1/wiki/pages/"+mine.ID+"/follow", admin, map[string]any{"following": true}).Want(t, 404)

	// A page in the trash keeps its comments to read, not to add to.
	shared := create(t, e, anna, map[string]any{"title": "Shared"})
	st := say(t, e, anna, shared.ID, map[string]any{"body_html": "<p>hello</p>"})
	e.Do("POST", "/v1/wiki/pages/"+shared.ID+"/trash", anna, nil).Want(t, 200)
	if list, _ := threads(t, e, admin, shared.ID); len(list) != 1 {
		t.Fatalf("trashed page's comments %+v", list)
	}
	e.Do("POST", "/v1/wiki/pages/"+shared.ID+"/comments", anna, map[string]any{"body_html": "<p>x</p>"}).Want(t, 422)
	e.Do("PATCH", "/v1/wiki/comments/"+st.ID, anna, map[string]any{"body_html": "<p>x</p>"}).Want(t, 422)
}

func TestWikiNotifications(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	bob := e.AddUser(ws, auth.RoleAgent, "Bob Agent")
	cara := e.AddUser(ws, auth.RoleAgent, "Cara Agent")
	anna, b, c := ws.Agent.As(ws), bob.As(ws), cara.As(ws)

	// A body mention tells the newly mentioned, once.
	pg := create(t, e, anna, map[string]any{"title": "Escalations", "body_html": "<p>Ask " + at(bob) + " first. " + at(ws.Agent) + "</p>"})
	bn := wikiNotes(t, e, ws, bob)
	if count(bn, "wiki_mention", pg.ID) != 1 || bn[0].Data["page_title"] != "Escalations" || bn[0].Data["by"] != ws.Agent.ID.String() || !strings.Contains(bn[0].Data["preview"].(string), "first") {
		t.Fatalf("bob's mention %+v", bn)
	}
	if len(wikiNotes(t, e, ws, ws.Agent)) != 0 {
		t.Fatal("mentioning yourself tells you")
	}
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, anna, map[string]any{"body_html": "<p>Ask " + at(bob) + " or " + at(cara) + ".</p>"}).Want(t, 200)
	if count(wikiNotes(t, e, ws, bob), "wiki_mention", pg.ID) != 1 || count(wikiNotes(t, e, ws, cara), "wiki_mention", pg.ID) != 1 {
		t.Fatal("only the newly mentioned hear about an edit")
	}

	// A comment: its mentions get wiki_mention, the page's followers (the creator) and the
	// thread's commenters get wiki_comment, the author nothing.
	th := say(t, e, c, pg.ID, map[string]any{"body_html": "<p>" + at(bob) + " can you check?</p>"})
	bn = wikiNotes(t, e, ws, bob)
	if count(bn, "wiki_mention", pg.ID) != 2 || count(bn, "wiki_comment", pg.ID) != 0 || bn[len(bn)-1].Data["comment_id"] != th.ID || bn[len(bn)-1].Data["thread_id"] != th.ID {
		t.Fatalf("bob after the comment %+v", bn)
	}
	an := wikiNotes(t, e, ws, ws.Agent)
	if count(an, "wiki_comment", pg.ID) != 1 || an[0].Data["thread_id"] != th.ID || an[0].Data["preview"] != "@Bob Agent can you check?" {
		t.Fatalf("the creator follows the page %+v", an)
	}
	if count(wikiNotes(t, e, ws, cara), "wiki_comment", pg.ID) != 0 {
		t.Fatal("the author heard about their own comment")
	}

	// Bob replies (and follows), then unfollows: other threads stay quiet for him, his
	// own thread does not, and commenting again doesn't follow him back.
	say(t, e, b, pg.ID, map[string]any{"body_html": "<p>Checked.</p>", "thread_id": th.ID})
	if _, following := threads(t, e, b, pg.ID); !following {
		t.Fatal("commenting follows the page")
	}
	var f struct{ Following bool }
	e.Do("PUT", "/v1/wiki/pages/"+pg.ID+"/follow", b, map[string]any{"following": false}).Want(t, 200).JSON(t, &f)
	if f.Following {
		t.Fatal("unfollow answered following")
	}
	before := count(wikiNotes(t, e, ws, bob), "wiki_comment", pg.ID)
	say(t, e, anna, pg.ID, map[string]any{"body_html": "<p>New topic</p>"})
	if count(wikiNotes(t, e, ws, bob), "wiki_comment", pg.ID) != before {
		t.Fatal("an unfollower heard about another thread")
	}
	say(t, e, b, pg.ID, map[string]any{"body_html": "<p>My own thread</p>"})
	if _, following := threads(t, e, b, pg.ID); following {
		t.Fatal("commenting undid an unfollow")
	}
	say(t, e, anna, pg.ID, map[string]any{"body_html": "<p>Answer</p>", "thread_id": th.ID})
	if count(wikiNotes(t, e, ws, bob), "wiki_comment", pg.ID) != before+1 {
		t.Fatal("a thread's commenter hears about its replies")
	}

	// An edited comment tells only the newly mentioned.
	mine := say(t, e, anna, pg.ID, map[string]any{"body_html": "<p>cc " + at(bob) + "</p>"})
	bm := count(wikiNotes(t, e, ws, bob), "wiki_mention", pg.ID)
	e.Do("PATCH", "/v1/wiki/comments/"+mine.ID, anna, map[string]any{"body_html": "<p>cc " + at(bob) + " " + at(cara) + "</p>"}).Want(t, 200)
	if count(wikiNotes(t, e, ws, bob), "wiki_mention", pg.ID) != bm || count(wikiNotes(t, e, ws, cara), "wiki_mention", pg.ID) != 2 {
		t.Fatal("an edit told someone already mentioned, or not the new one")
	}

	// Nobody hears about a page they may not see.
	private := create(t, e, anna, map[string]any{"title": "Private", "space": "private", "body_html": "<p>" + at(bob) + "</p>"})
	team := uuid.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Billing', true)`, team, ws.ID)
	e.Exec(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)`, team, ws.Agent.ID, cara.ID)
	billing := create(t, e, anna, map[string]any{"title": "Billing", "space": "team", "team_id": team.String(), "body_html": "<p>" + at(bob) + at(cara) + "</p>"})
	bn = wikiNotes(t, e, ws, bob)
	if count(bn, "wiki_mention", private.ID) != 0 || count(bn, "wiki_mention", billing.ID) != 0 {
		t.Fatalf("bob heard about pages he may not see %+v", bn)
	}
	if count(wikiNotes(t, e, ws, cara), "wiki_mention", billing.ID) != 1 {
		t.Fatal("a team member hears about the team's page")
	}

	// A page moved out of someone's sight takes their notifications about it along;
	// a page in the trash, everyone's.
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/move", anna, map[string]any{"parent_id": nil, "position": 0, "space": "team", "team_id": team.String()}).Want(t, 200)
	if n := len(wikiNotes(t, e, ws, bob)); n != 0 {
		t.Fatalf("bob kept %d notifications about a page he may no longer see", n)
	}
	if count(wikiNotes(t, e, ws, cara), "wiki_mention", pg.ID) == 0 {
		t.Fatal("cara still sees the page and lost its notifications")
	}
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/trash", anna, nil).Want(t, 200)
	if count(wikiNotes(t, e, ws, cara), "wiki_mention", pg.ID)+count(wikiNotes(t, e, ws, cara), "wiki_comment", pg.ID) != 0 {
		t.Fatal("notifications about a trashed page stayed")
	}
}

func TestReminders(t *testing.T) {
	e := hdtest.New(t, wiki.Register)
	ws := e.NewWorkspace()
	bob := e.AddUser(ws, auth.RoleAgent, "Bob Agent")
	anna, b := ws.Agent.As(ws), bob.As(ws)
	e.Exec(`INSERT INTO notification_settings (user_id, timezone) VALUES ($1, 'Europe/Budapest')`, ws.Agent.ID)

	r1, r2 := uuid.NewString(), uuid.NewString()
	date := func(id, when string) string {
		return `<time data-type="date" datetime="` + when + `" data-reminder="` + id + `">` + when + `</time>`
	}
	type rem struct {
		Owner  uuid.UUID
		At     time.Time
		Sent   *time.Time
		Exists bool
	}
	get := func(id string) rem {
		var r rem
		err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT user_id, remind_at, sent_at FROM wiki_reminders WHERE id = $1`, id).Scan(&r.Owner, &r.At, &r.Sent)
		r.Exists = err == nil
		return r
	}

	pg := create(t, e, anna, map[string]any{"title": "Launch", "body_html": "<p>Ship it " + date(r1, "2030-01-02") + "</p>"})
	if r := get(r1); r.Owner != ws.Agent.ID || !r.At.Equal(time.Date(2030, 1, 2, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("a bare date reminds at 9:00 in its owner's timezone: %+v", r)
	}

	// Someone else's edit keeps the owner; their new reminder is theirs.
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, b, map[string]any{"body_html": "<p>Ship it " + date(r1, "2030-01-03T10:15") + "</p><p>Review " + date(r2, "2030-01-04T08:00:00Z") + "</p>"}).Want(t, 200)
	if r := get(r1); r.Owner != ws.Agent.ID || !r.At.Equal(time.Date(2030, 1, 3, 9, 15, 0, 0, time.UTC)) {
		t.Fatalf("r1 after bob's edit %+v", r)
	}
	if r := get(r2); r.Owner != bob.ID || !r.At.Equal(time.Date(2030, 1, 4, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("r2 %+v", r)
	}

	// The same time keeps a sent reminder sent; a new time sends it again.
	e.Exec(`UPDATE wiki_reminders SET sent_at = now() WHERE id = $1`, r1)
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, anna, map[string]any{"body_html": "<p>Ship it! " + date(r1, "2030-01-03T10:15") + "</p>"}).Want(t, 200)
	if r := get(r1); r.Sent == nil {
		t.Fatal("an unchanged time cleared sent_at")
	}
	if get(r2).Exists {
		t.Fatal("a reminder taken out of the body stayed")
	}
	e.Do("PATCH", "/v1/wiki/pages/"+pg.ID, anna, map[string]any{"body_html": "<p>Ship it! " + date(r1, "2030-01-05") + "</p>"}).Want(t, 200)
	if r := get(r1); r.Sent != nil {
		t.Fatal("a new time kept sent_at")
	}

	// The job sends a due reminder once.
	e.Exec(`UPDATE wiki_reminders SET remind_at = now() - interval '1 minute' WHERE id = $1`, r1)
	for range 2 {
		if err := wiki.SendReminders(e.Ctx, e.D, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	an := wikiNotes(t, e, ws, ws.Agent)
	if count(an, "wiki_reminder", pg.ID) != 1 || an[len(an)-1].Data["reminder_id"] != r1 || an[len(an)-1].Data["page_title"] != "Launch" ||
		!strings.Contains(an[len(an)-1].Data["label"].(string), "Ship it!") {
		t.Fatalf("anna's reminder %+v", an)
	}

	// A copy's reminders are new ones, the copier's.
	var dup page
	e.Do("POST", "/v1/wiki/pages/"+pg.ID+"/duplicate", b, map[string]any{}).Want(t, 201).JSON(t, &dup)
	if strings.Contains(dup.BodyHTML, r1) || !strings.Contains(dup.BodyHTML, "data-reminder=") {
		t.Fatalf("the copy kept the reminder id: %s", dup.BodyHTML)
	}
	var owner uuid.UUID
	e.Scalar(`SELECT user_id FROM wiki_reminders WHERE page_id = $1`, &owner, dup.ID)
	if owner != bob.ID {
		t.Fatal("the copy's reminder is not the copier's")
	}
}
