package wiki

import (
	"context"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Links and tags (contracts/wiki.md "Links and tags"): kept from each page's body as it is
// saved. A link is a link to a page, a subpage block or a synced block (an embed of the page
// or of one of its blocks, `<div data-type="transclusion" data-id="…">`): any data-id or
// /wiki/ path naming a page of the workspace. A tag is #word in the text (at least one
// letter, so "#42" is a number), never inside code. A ticket mention is the sanitizer's
// `<a data-type="ticket" data-id="…">` (hd.SanitizeWiki).
var (
	linkRef   = regexp.MustCompile(`(?:/wiki/|data-id=")([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`)
	ticketRef = regexp.MustCompile(`data-type="ticket" data-id="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"`)
	codeText  = regexp.MustCompile(`(?i)<code\b[^>]*>[^<]*</code>`)
	tagRef    = regexp.MustCompile(`(?:^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)`)
)

const (
	maxTags   = 50
	maxTagLen = 64
)

// pageTags are the #tags of a body, lower case, each once, in the order they first appear.
func pageTags(body string) []string {
	text := hd.HTMLToText(codeText.ReplaceAllString(body, " "))
	out := []string{}
	for _, m := range tagRef.FindAllStringSubmatch(text, -1) {
		tag := strings.Trim(strings.ToLower(m[1]), "/-")
		if tag == "" || utf8.RuneCountInString(tag) > maxTagLen || slices.Contains(out, tag) {
			continue
		}
		if out = append(out, tag); len(out) == maxTags {
			break
		}
	}
	return out
}

// linkedIDs are the page ids a body links to, each once.
func linkedIDs(body string) []uuid.UUID { return refIDs(linkRef, body) }

// ticketIDs are the ticket ids a body mentions, each once.
func ticketIDs(body string) []uuid.UUID { return refIDs(ticketRef, body) }

func refIDs(re *regexp.Regexp, body string) []uuid.UUID {
	var out []uuid.UUID
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		if id, err := uuid.Parse(m[1]); err == nil && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// indexBody keeps a page's tags, outgoing links and ticket mentions in step with its body.
// Links to pages and mentions of tickets that don't exist in the workspace (deleted pages,
// another workspace's) are left out.
func indexBody(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID, body string) error {
	// A canvas's cards count as its text: their links, tags, mentions and words (search).
	var canvas []byte
	if err := tx.QueryRow(ctx, `SELECT canvas FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, wid, id).Scan(&canvas); err != nil {
		return err
	}
	body += canvasLinkHTML(canvas)
	if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET tags = $3, canvas_text = $4 WHERE workspace_id = $1 AND id = $2`,
		wid, id, pageTags(body), canvasPlain(canvas)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM wiki_links WHERE workspace_id = $1 AND from_id = $2`, wid, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM wiki_ticket_links WHERE workspace_id = $1 AND page_id = $2`, wid, id); err != nil {
		return err
	}
	if ids := linkedIDs(body); len(ids) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO wiki_links (workspace_id, from_id, to_id)
			SELECT $1, $2, t.id FROM wiki_pages t WHERE t.workspace_id = $1 AND t.id = ANY($3) AND t.id <> $2
			ON CONFLICT DO NOTHING`, wid, id, ids); err != nil {
			return err
		}
	}
	if ids := ticketIDs(body); len(ids) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO wiki_ticket_links (workspace_id, page_id, ticket_id)
			SELECT $1, $2, t.id FROM tickets t WHERE t.workspace_id = $1 AND t.id = ANY($3)
			ON CONFLICT DO NOTHING`, wid, id, ids); err != nil {
			return err
		}
	}
	return nil
}

// WikiMention is a page that links to another (a backlink), or names it without a link.
type WikiMention struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	Title     string     `json:"title"`
	Icon      string     `json:"icon"`
	Snippet   string     `json:"snippet" doc:"Plain text around where it names the page"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// WikiLink is one link of the graph: from a page to another.
type WikiLink struct {
	From uuid.UUID `json:"from"`
	To   uuid.UUID `json:"to"`
}

// snippet is the text around the first place text names title, else its start.
func snippet(text, title string) string {
	text = strings.Join(strings.Fields(text), " ")
	at := -1
	if t := strings.TrimSpace(title); t != "" {
		at = strings.Index(strings.ToLower(text), strings.ToLower(t))
	}
	runes := []rune(text)
	start := 0
	if at > 0 {
		start = max(0, utf8.RuneCountInString(text[:at])-60)
	}
	end := min(len(runes), start+180)
	out := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

func registerLinks(d *deps.Deps, api huma.API) {
	type mentionsOut struct {
		Body httpx.Page[WikiMention]
	}
	page := func(ctx context.Context, raw string) (*auth.Principal, Viewer, uuid.UUID, string, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
		if err != nil {
			return nil, Viewer{}, uuid.Nil, "", httpx.Wrap(err)
		}
		id, err := hd.ParseID(raw, "Page")
		if err != nil {
			return nil, Viewer{}, uuid.Nil, "", err
		}
		v, err := viewerFor(ctx, d, p)
		if err != nil {
			return nil, Viewer{}, uuid.Nil, "", httpx.Wrap(err)
		}
		me, hidden := v.args()
		var title string
		err = d.DB.Pool.QueryRow(ctx, `SELECT p.title FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2 AND `+seesSQL("p", 3, 4), p.WorkspaceID, id, me, hidden).Scan(&title)
		if db.IsNotFound(err) {
			return nil, Viewer{}, uuid.Nil, "", httpx.NotFound("Page")
		}
		if err != nil {
			return nil, Viewer{}, uuid.Nil, "", httpx.Wrap(err)
		}
		if err := mustSee(ctx, d.DB.Pool, v, p.WorkspaceID, id); err != nil {
			return nil, Viewer{}, uuid.Nil, "", httpx.Wrap(err)
		}
		return p, v, id, title, nil
	}
	collect := func(rows pgx.Rows, title string) ([]WikiMention, error) {
		out := []WikiMention{}
		defer rows.Close()
		for rows.Next() {
			var m WikiMention
			var body string
			if err := rows.Scan(&m.ID, &m.ParentID, &m.Title, &m.Icon, &body, &m.UpdatedAt); err != nil {
				return nil, err
			}
			m.Snippet = snippet(hd.HTMLToText(body), title)
			out = append(out, m)
		}
		return out, rows.Err()
	}

	huma.Register(api, huma.Operation{OperationID: "list-wiki-backlinks", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/backlinks",
		Summary: "List the pages that link to a page", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*mentionsOut, error) {
			p, v, id, title, err := page(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			me, hidden := v.args()
			areas, err := areasOn(ctx, d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT s.id, s.parent_id, s.title, s.icon, s.body_html, s.updated_at
				FROM wiki_links l JOIN wiki_pages s ON s.workspace_id = l.workspace_id AND s.id = l.from_id
				WHERE l.workspace_id = $1 AND l.to_id = $2 AND s.area = ANY($5) AND `+liveSQL("s", 3, 4)+` ORDER BY s.updated_at DESC LIMIT 200`, p.WorkspaceID, id, me, hidden, areas)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := collect(rows, title)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &mentionsOut{httpx.Page[WikiMention]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-wiki-unlinked-mentions", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/mentions",
		Summary: "List the pages that name a page without linking it", Tags: tags,
		Description: "Pages whose text has the page's title or one of its aliases as a phrase, and no link to it yet. An untitled page without aliases has none."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*mentionsOut, error) {
			p, v, id, title, err := page(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			me, hidden := v.args()
			var aliases []string
			if err := d.DB.Pool.QueryRow(ctx, `SELECT aliases FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id).Scan(&aliases); err != nil {
				return nil, httpx.Wrap(err)
			}
			names := pageNames(title, aliases)
			if len(names) == 0 {
				return &mentionsOut{httpx.Page[WikiMention]{Data: []WikiMention{}}}, nil
			}
			areas, err := areasOn(ctx, d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			args := []any{p.WorkspaceID, id, me, hidden, areas}
			for _, n := range names {
				args = append(args, n)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT s.id, s.parent_id, s.title, s.icon, s.body_html, s.updated_at
				FROM wiki_pages s
				WHERE s.workspace_id = $1 AND s.id <> $2 AND s.area = ANY($5) AND s.search @@ `+phraseQuery(names, 6)+` AND `+liveSQL("s", 3, 4)+`
				  AND NOT EXISTS (SELECT 1 FROM wiki_links l WHERE l.workspace_id = $1 AND l.from_id = s.id AND l.to_id = $2)
				ORDER BY s.updated_at DESC LIMIT 100`, args...)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := []WikiMention{}
			defer rows.Close()
			for rows.Next() {
				var m WikiMention
				var body string
				if err := rows.Scan(&m.ID, &m.ParentID, &m.Title, &m.Icon, &body, &m.UpdatedAt); err != nil {
					return nil, httpx.Wrap(err)
				}
				// The phrase search ignores punctuation (and an alias may match only in the
				// title, weighed as text): keep the pages whose text has a name itself.
				text := hd.HTMLToText(body)
				name := namedIn(text, names)
				if name == "" {
					continue
				}
				m.Snippet = snippet(text, name)
				out = append(out, m)
			}
			if err := rows.Err(); err != nil {
				return nil, httpx.Wrap(err)
			}
			return &mentionsOut{httpx.Page[WikiMention]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-ticket-wiki-pages", Method: http.MethodGet, Path: "/v1/tickets/{id}/wiki",
		Summary: "List the wiki pages that mention a ticket", Tags: []string{"Tickets"},
		Description: "The pages of the tree the caller may see whose text mentions the ticket, newest edit first, at most 50. " +
			"Needs `tickets:read` and `wiki:read`; a ticket the caller may not see is `404`."},
		func(ctx context.Context, in *struct {
			ID string `path:"id" doc:"The ticket's id, \"#123\", \"123\" or alias"`
		}) (*struct{ Body httpx.Page[WikiNode] }, error) {
			if _, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead); err != nil {
				return nil, httpx.Wrap(err)
			}
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tid, err := domain.ResolveVisibleTicket(ctx, d.DB.Pool, p, in.ID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			areas, err := areasOn(ctx, d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			out, err := collectNodes(d.DB.Pool.Query(ctx, nodeSelect+` JOIN wiki_ticket_links l ON l.workspace_id = p.workspace_id AND l.page_id = p.id
				WHERE l.workspace_id = $1 AND l.ticket_id = $2 AND p.area = ANY($5) AND `+liveSQL("p", 3, 4)+` ORDER BY p.updated_at DESC, p.id LIMIT 50`,
				p.WorkspaceID, tid, me, hidden, areas))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[WikiNode] }{httpx.Page[WikiNode]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-wiki-graph", Method: http.MethodGet, Path: "/v1/wiki/graph",
		Summary: "List every link between the wiki's pages", Tags: tags,
		Description: "The pages are the tree's (`GET /v1/wiki/pages`, of the same area); this adds the links between them."},
		func(ctx context.Context, in *areaIn) (*struct{ Body httpx.Page[WikiLink] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := requireArea(ctx, d.DB.Pool, p.WorkspaceID, in.Area); err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me, hidden := v.args()
			rows, err := d.DB.Pool.Query(ctx, `SELECT l.from_id, l.to_id FROM wiki_links l
				JOIN wiki_pages a ON a.workspace_id = l.workspace_id AND a.id = l.from_id
				JOIN wiki_pages b ON b.workspace_id = l.workspace_id AND b.id = l.to_id
				WHERE l.workspace_id = $1 AND a.area = $4 AND b.area = $4 AND `+liveSQL("a", 2, 3)+` AND `+liveSQL("b", 2, 3), p.WorkspaceID, me, hidden, in.Area)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (WikiLink, error) {
				var l WikiLink
				err := r.Scan(&l.From, &l.To)
				return l, err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if out == nil {
				out = []WikiLink{}
			}
			return &struct{ Body httpx.Page[WikiLink] }{httpx.Page[WikiLink]{Data: out}}, nil
		})
}
