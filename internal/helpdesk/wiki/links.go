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
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Links and tags (contracts/wiki.md "Links and tags"): kept from each page's body as it is
// saved. A link is a link to a page or a subpage block; a tag is #word in the text (at
// least one letter, so "#42" is a number), never inside code.
var (
	linkRef  = regexp.MustCompile(`(?:/wiki/|data-id=")([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`)
	codeText = regexp.MustCompile(`(?i)<code\b[^>]*>[^<]*</code>`)
	tagRef   = regexp.MustCompile(`(?:^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)`)
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
func linkedIDs(body string) []uuid.UUID {
	var out []uuid.UUID
	for _, m := range linkRef.FindAllStringSubmatch(body, -1) {
		if id, err := uuid.Parse(m[1]); err == nil && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// indexBody keeps a page's tags and outgoing links in step with its body. Links to pages
// that don't exist in the workspace (deleted, another workspace's) are left out.
func indexBody(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID, body string) error {
	if _, err := tx.Exec(ctx, `UPDATE wiki_pages SET tags = $3 WHERE workspace_id = $1 AND id = $2`, wid, id, pageTags(body)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM wiki_links WHERE workspace_id = $1 AND from_id = $2`, wid, id); err != nil {
		return err
	}
	ids := linkedIDs(body)
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO wiki_links (workspace_id, from_id, to_id)
		SELECT $1, $2, t.id FROM wiki_pages t WHERE t.workspace_id = $1 AND t.id = ANY($3) AND t.id <> $2
		ON CONFLICT DO NOTHING`, wid, id, ids)
	return err
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
	page := func(ctx context.Context, raw string) (*auth.Principal, uuid.UUID, string, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
		if err != nil {
			return nil, uuid.Nil, "", httpx.Wrap(err)
		}
		id, err := hd.ParseID(raw, "Page")
		if err != nil {
			return nil, uuid.Nil, "", err
		}
		var title string
		err = d.DB.Pool.QueryRow(ctx, `SELECT title FROM wiki_pages WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id).Scan(&title)
		if db.IsNotFound(err) {
			return nil, uuid.Nil, "", httpx.NotFound("Page")
		}
		if err != nil {
			return nil, uuid.Nil, "", httpx.Wrap(err)
		}
		return p, id, title, nil
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
			p, id, title, err := page(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT s.id, s.parent_id, s.title, s.icon, s.body_html, s.updated_at
				FROM wiki_links l JOIN wiki_pages s ON s.workspace_id = l.workspace_id AND s.id = l.from_id
				WHERE l.workspace_id = $1 AND l.to_id = $2 ORDER BY s.updated_at DESC LIMIT 200`, p.WorkspaceID, id)
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
		Description: "Pages whose text has the page's title as a phrase, and no link to it yet. An untitled page has none."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*mentionsOut, error) {
			p, id, title, err := page(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if strings.TrimSpace(title) == "" {
				return &mentionsOut{httpx.Page[WikiMention]{Data: []WikiMention{}}}, nil
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT s.id, s.parent_id, s.title, s.icon, s.body_html, s.updated_at
				FROM wiki_pages s
				WHERE s.workspace_id = $1 AND s.id <> $2 AND s.search @@ phraseto_tsquery('simple', $3)
				  AND NOT EXISTS (SELECT 1 FROM wiki_links l WHERE l.workspace_id = $1 AND l.from_id = s.id AND l.to_id = $2)
				ORDER BY s.updated_at DESC LIMIT 100`, p.WorkspaceID, id, title)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			all, err := collect(rows, title)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			// The phrase search ignores punctuation; keep the pages whose text has the title itself.
			out := []WikiMention{}
			for _, m := range all {
				if strings.Contains(strings.ToLower(m.Snippet), strings.ToLower(strings.TrimSpace(title))) {
					out = append(out, m)
				}
			}
			return &mentionsOut{httpx.Page[WikiMention]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-wiki-graph", Method: http.MethodGet, Path: "/v1/wiki/graph",
		Summary: "List every link between the wiki's pages", Tags: tags,
		Description: "The pages are the tree's (`GET /v1/wiki/pages`); this adds the links between them."},
		func(ctx context.Context, _ *struct{}) (*struct{ Body httpx.Page[WikiLink] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT from_id, to_id FROM wiki_links WHERE workspace_id = $1`, p.WorkspaceID)
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
