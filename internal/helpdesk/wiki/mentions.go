package wiki

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// Notification types of the wiki (contracts/wiki.md "Mentions and notifications").
const (
	typeMention  = "wiki_mention"
	typeComment  = "wiki_comment"
	typeReminder = "wiki_reminder"
)

// reminderAttr is a reminder's id in a body.
var reminderAttr = regexp.MustCompile(`data-reminder="([0-9a-fA-F-]{36})"`)

// previewLen bounds the text a notification quotes.
const previewLen = 140

// pageHead is what comments, follows, reminders and their notifications need of a page:
// its title, where it lives (for scoping events, see pageEvent) and whether it is trashed.
type pageHead struct {
	pg       WikiPage
	deleted  bool
	template bool
}

func headOf(ctx context.Context, q db.Querier, wid, id uuid.UUID) (pageHead, error) {
	var h pageHead
	err := q.QueryRow(ctx, `SELECT id, title, private_to, team_id, deleted_at IS NOT NULL, template FROM wiki_pages WHERE workspace_id = $1 AND id = $2`,
		wid, id).Scan(&h.pg.ID, &h.pg.Title, &h.pg.owner, &h.pg.TeamID, &h.deleted, &h.template)
	return h, err
}

// bodyMarks is what a page body says to people: whom it mentions and the reminders in it.
type bodyMarks struct {
	// mentions are the people mentioned, each once, in order; previews the text of the
	// block each is first mentioned in.
	mentions []uuid.UUID
	previews map[uuid.UUID]string
	// reminders are the dates with a reminder, each id once.
	reminders []reminderMark
}

// reminderMark is a date mention with a reminder: its id, its datetime as written and
// the text of the block it is in.
type reminderMark struct {
	id       uuid.UUID
	datetime string
	label    string
}

// textBlocks are the elements whose text a mention or a reminder is quoted with.
var textBlocks = map[atom.Atom]bool{atom.P: true, atom.Li: true, atom.H1: true, atom.H2: true, atom.H3: true,
	atom.Td: true, atom.Th: true, atom.Blockquote: true, atom.Summary: true, atom.Pre: true}

// scanBody reads the marks of a sanitized page body (contracts/wiki.md "Body").
func scanBody(body string) bodyMarks {
	out := bodyMarks{previews: map[uuid.UUID]string{}}
	if !strings.Contains(body, `data-type="mention"`) && !strings.Contains(body, "data-reminder") {
		return out
	}
	nodes, err := html.ParseFragment(strings.NewReader(body), &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: "body"})
	if err != nil {
		return out
	}
	seen := map[uuid.UUID]bool{}
	var walk func(n, block *html.Node)
	walk = func(n, block *html.Node) {
		if n.Type == html.ElementNode {
			if textBlocks[n.DataAtom] || block == nil {
				block = n
			}
			switch {
			case n.DataAtom == atom.Span && attr(n, "data-type") == "mention":
				if id, err := uuid.Parse(attr(n, "data-id")); err == nil && !seen[id] {
					seen[id] = true
					out.mentions = append(out.mentions, id)
					out.previews[id] = hd.Excerpt(textOf(block), previewLen)
				}
			case n.DataAtom == atom.Time && attr(n, "data-reminder") != "":
				if id, err := uuid.Parse(attr(n, "data-reminder")); err == nil && !seen[id] {
					seen[id] = true
					out.reminders = append(out.reminders, reminderMark{id: id, datetime: attr(n, "datetime"), label: hd.Excerpt(textOf(block), previewLen)})
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, block)
		}
	}
	for _, n := range nodes {
		walk(n, nil)
	}
	return out
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && textBlocks[n.DataAtom] {
			b.WriteByte(' ')
		}
	}
	walk(n)
	return b.String()
}

// bodySaved is what follows a person saving a page body, beside indexBody: the files the
// saver uploaded for it become the page's, the page's reminders follow the body, and the
// people it newly mentions hear about it. prev is the body before ("" for a new page or a
// copy). A template reminds and tells nobody.
func bodySaved(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID, prev, next string) error {
	if err := claimFiles(ctx, tx, p, id, next); err != nil {
		return err
	}
	head, err := headOf(ctx, tx, p.WorkspaceID, id)
	if err != nil {
		return err
	}
	if head.template {
		return syncReminders(ctx, tx, p, id, nil)
	}
	marks := scanBody(next)
	if err := syncReminders(ctx, tx, p, id, marks.reminders); err != nil {
		return err
	}
	had := map[uuid.UUID]bool{}
	for _, uid := range scanBody(prev).mentions {
		had[uid] = true
	}
	var fresh []uuid.UUID
	for _, uid := range marks.mentions {
		if !had[uid] {
			fresh = append(fresh, uid)
		}
	}
	people, err := hearers(ctx, tx, p, head, fresh)
	if err != nil {
		return err
	}
	for _, uid := range people {
		data := map[string]any{"page_id": id.String(), "page_title": head.pg.Title, "by": idOrNil(p.ActorUserID()), "preview": marks.previews[uid]}
		if err := hd.Notify(ctx, tx, p.WorkspaceID, uid, typeMention, nil, data); err != nil {
			return err
		}
	}
	return nil
}

// hearers keeps the people of users who hear about something done on the page: members
// of the workspace who may see it, never the one who did it. A page in the trash tells nobody.
func hearers(ctx context.Context, tx pgx.Tx, p *auth.Principal, head pageHead, users []uuid.UUID) ([]uuid.UUID, error) {
	if head.deleted {
		return nil, nil
	}
	var cand []uuid.UUID
	for _, uid := range users {
		if me := p.ActorUserID(); me != nil && *me == uid {
			continue
		}
		cand = append(cand, uid)
	}
	return audience(ctx, tx, p.WorkspaceID, head.pg.ID, cand)
}

// dropHiddenNotifications removes the wiki notifications about pages that their
// recipients may no longer see (moved out of their sight, trashed, deleted), as tickets do.
func dropHiddenNotifications(ctx context.Context, tx pgx.Tx, wid uuid.UUID, pages []uuid.UUID) error {
	keys := make([]string, len(pages))
	for i, id := range pages {
		keys[i] = id.String()
	}
	return hd.DeleteNotifications(ctx, tx, wid, `DELETE FROM notifications n
		WHERE n.workspace_id = $1 AND n.type IN ('wiki_mention', 'wiki_comment', 'wiki_reminder') AND n.data->>'page_id' = ANY($2::text[])
		AND NOT EXISTS (SELECT 1 FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id::text = n.data->>'page_id' AND `+seenBySQL("p", "n.user_id")+`)
		RETURNING n.id, n.user_id, n.read_at IS NULL`, wid, keys)
}

func idOrNil(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return id.String()
}
