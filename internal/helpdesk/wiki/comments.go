package wiki

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Comments (contracts/wiki.md "Comments"): threads on a page, each started by its first
// comment, inline (on a run of the text, marked in the body with data-comment) or on the
// page as a whole.
const (
	maxCommentHTML = 20000
	maxQuote       = 500
	maxMentions    = 50
	maxReactions   = 20
)

var mentionAttr = regexp.MustCompile(`data-(?:mention|id)="([0-9a-fA-F-]{36})"`)

// WikiReaction is one emoji on a comment and who put it there.
type WikiReaction struct {
	Emoji string      `json:"emoji"`
	Users []uuid.UUID `json:"users" doc:"Who reacted, oldest first"`
}

// WikiComment is one comment of a thread.
type WikiComment struct {
	ID        uuid.UUID       `json:"id"`
	ThreadID  uuid.UUID       `json:"thread_id"`
	Author    *domain.UserRef `json:"author" doc:"Null for a deleted account"`
	BodyHTML  string          `json:"body_html"`
	Mentions  []uuid.UUID     `json:"mentions" doc:"The members it mentions"`
	CreatedAt time.Time       `json:"created_at"`
	EditedAt  *time.Time      `json:"edited_at"`
	Reactions []WikiReaction  `json:"reactions"`
}

// WikiThread is a thread of comments on a page; its id is its first comment's.
type WikiThread struct {
	ID         uuid.UUID       `json:"id"`
	PageID     uuid.UUID       `json:"page_id"`
	Quote      string          `json:"quote" doc:"The text an inline thread was started on"`
	Inline     bool            `json:"inline"`
	CreatedAt  time.Time       `json:"created_at"`
	ResolvedAt *time.Time      `json:"resolved_at"`
	ResolvedBy *domain.UserRef `json:"resolved_by"`
	Comments   []WikiComment   `json:"comments" doc:"Oldest first"`
}

// WikiComments is a page's threads, open and resolved.
type WikiComments struct {
	Data      []WikiThread `json:"data" doc:"Oldest first"`
	Following bool         `json:"following" doc:"Whether you follow the page"`
}

type commentCreate struct {
	BodyHTML string   `json:"body_html" maxLength:"20000" doc:"Rich text, sanitized like a note"`
	Mentions []string `json:"mentions,omitempty" maxItems:"50" doc:"Members mentioned besides the body's mention marks"`
	ThreadID *string  `json:"thread_id,omitempty" doc:"Reply in this thread of the page; left out, start a thread"`
	Quote    string   `json:"quote,omitempty" doc:"A new inline thread: the text it is on (up to 500 characters)"`
	Inline   bool     `json:"inline,omitempty" doc:"A new thread on a run of the text, marked in the body with data-comment"`
}

type commentPatch struct {
	BodyHTML string   `json:"body_html" maxLength:"20000"`
	Mentions []string `json:"mentions,omitempty" maxItems:"50"`
}

type threadOut struct{ Body WikiThread }

func registerComments(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-wiki-comments", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/comments",
		Summary: "List a wiki page's comments", Tags: tags,
		Description: "Every thread on the page, open and resolved, oldest first, and whether you follow the page."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body WikiComments }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Page")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := mustSee(ctx, d.DB.Pool, v, p.WorkspaceID, id); err != nil {
				return nil, httpx.Wrap(err)
			}
			threads, err := loadThreads(ctx, d.DB.Pool, p.WorkspaceID, id, nil)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			on, err := following(ctx, d.DB.Pool, p, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body WikiComments }{WikiComments{Data: threads, Following: on}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-wiki-comment", Method: http.MethodPost, Path: "/v1/wiki/pages/{id}/comments",
		Summary: "Comment on a wiki page", Tags: tags, DefaultStatus: http.StatusCreated,
		Description: "Starts a thread, or replies in one with `thread_id` (a reply reopens a resolved thread). You follow the page from then on unless you unfollowed it. The people it mentions, the page's followers and the thread's other commenters hear about it."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body commentCreate
		}) (*threadOut, error) {
			p, err := onlyPerson(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, err
			}
			id, err := hd.ParseID(in.ID, "Page")
			if err != nil {
				return nil, err
			}
			b := in.Body
			body, err := cleanComment(b.BodyHTML)
			if err != nil {
				return nil, err
			}
			listed, err := parseMentions(b.Mentions)
			if err != nil {
				return nil, err
			}
			var reply *uuid.UUID
			if b.ThreadID != nil && strings.TrimSpace(*b.ThreadID) != "" {
				t, err := hd.ParseRef(*b.ThreadID, "thread_id")
				if err != nil {
					return nil, err
				}
				reply = &t
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out WikiThread
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				head, err := writable(ctx, tx, v, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				people, err := mentioned(ctx, tx, p, body, listed)
				if err != nil {
					return err
				}
				cid := ids.New()
				thread := cid
				if reply != nil {
					var ok bool
					if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM wiki_comments WHERE workspace_id = $1 AND page_id = $2 AND id = $3 AND thread_id = id)`,
						p.WorkspaceID, id, *reply).Scan(&ok); err != nil {
						return err
					}
					if !ok {
						return httpx.Validation("thread_id is not a thread of this page")
					}
					thread = *reply
					// A reply reopens the thread.
					if _, err := tx.Exec(ctx, `UPDATE wiki_comments SET resolved_at = NULL, resolved_by = NULL
						WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NOT NULL`, p.WorkspaceID, thread); err != nil {
						return err
					}
					b.Quote, b.Inline = "", false
				}
				quote := hd.Truncate(strings.Join(strings.Fields(b.Quote), " "), maxQuote)
				if _, err := tx.Exec(ctx, `INSERT INTO wiki_comments (id, workspace_id, page_id, thread_id, quote, inline, author_id, body_html, mentions)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, cid, p.WorkspaceID, id, thread, quote, b.Inline, p.UserID, body, people); err != nil {
					return err
				}
				if err := autoFollow(ctx, tx, p, id); err != nil {
					return err
				}
				if err := notifyComment(ctx, tx, p, head, thread, cid, body, people); err != nil {
					return err
				}
				if out, err = loadThread(ctx, tx, p.WorkspaceID, id, thread); err != nil {
					return err
				}
				return commentEvent(ctx, tx, p.WorkspaceID, head, thread)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &threadOut{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-wiki-comment", Method: http.MethodPatch, Path: "/v1/wiki/comments/{id}",
		Summary: "Edit a wiki comment", Tags: tags,
		Description: "Its author only. People it mentions now and didn't before hear about it."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body commentPatch
		}) (*threadOut, error) {
			p, err := onlyPerson(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, err
			}
			cid, err := hd.ParseID(in.ID, "Comment")
			if err != nil {
				return nil, err
			}
			body, err := cleanComment(in.Body.BodyHTML)
			if err != nil {
				return nil, err
			}
			listed, err := parseMentions(in.Body.Mentions)
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out WikiThread
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				c, head, err := commentFor(ctx, tx, v, p.WorkspaceID, cid)
				if err != nil {
					return err
				}
				if c.author == nil || *c.author != p.UserID {
					return httpx.E(http.StatusForbidden, "forbidden", "Only its author edits a comment.")
				}
				people, err := mentioned(ctx, tx, p, body, listed)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE wiki_comments SET body_html = $3, mentions = $4, edited_at = now() WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, cid, body, people); err != nil {
					return err
				}
				fresh := slices.DeleteFunc(slices.Clone(people), func(u uuid.UUID) bool { return slices.Contains(c.mentions, u) })
				if err := notifyMentions(ctx, tx, p, head, c.thread, cid, body, fresh); err != nil {
					return err
				}
				if out, err = loadThread(ctx, tx, p.WorkspaceID, head.pg.ID, c.thread); err != nil {
					return err
				}
				return commentEvent(ctx, tx, p.WorkspaceID, head, c.thread)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &threadOut{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-wiki-comment", Method: http.MethodDelete, Path: "/v1/wiki/comments/{id}",
		Summary: "Delete a wiki comment", Tags: tags, DefaultStatus: http.StatusNoContent,
		Description: "Its author or an admin. Deleting a thread's first comment deletes the thread."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*hd.Empty, error) {
			p, err := onlyPerson(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, err
			}
			cid, err := hd.ParseID(in.ID, "Comment")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				c, head, err := commentFor(ctx, tx, v, p.WorkspaceID, cid)
				if err != nil {
					return err
				}
				if (c.author == nil || *c.author != p.UserID) && !p.Role.AtLeast(auth.RoleAdmin) {
					return httpx.E(http.StatusForbidden, "forbidden", "Someone else wrote this comment, so only an admin can delete it.")
				}
				rows, err := tx.Query(ctx, `DELETE FROM wiki_comments WHERE workspace_id = $1 AND (id = $2 OR ($2 = $3 AND thread_id = $3)) RETURNING id`,
					p.WorkspaceID, cid, c.thread)
				gone, err := collectIDs(rows, err)
				if err != nil {
					return err
				}
				// What was said there is gone from people's notifications too.
				keys := make([]string, len(gone))
				for i, x := range gone {
					keys[i] = x.String()
				}
				if err := hd.DeleteNotifications(ctx, tx, p.WorkspaceID, `DELETE FROM notifications WHERE workspace_id = $1
					AND type IN ('wiki_mention', 'wiki_comment', 'wiki_reminder') AND data->>'page_id' = $3 AND data->>'comment_id' = ANY($2::text[])
					RETURNING id, user_id, read_at IS NULL`, p.WorkspaceID, keys, head.pg.ID.String()); err != nil {
					return err
				}
				return commentEvent(ctx, tx, p.WorkspaceID, head, c.thread)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})

	huma.Register(api, huma.Operation{OperationID: "resolve-wiki-thread", Method: http.MethodPost, Path: "/v1/wiki/threads/{id}/resolve",
		Summary: "Resolve or reopen a wiki comment thread", Tags: tags,
		Description: "A resolved thread stays on the page for whoever wants to read it; a reply reopens it."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Resolved bool `json:"resolved"`
			}
		}) (*threadOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tid, err := hd.ParseID(in.ID, "Thread")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out WikiThread
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				c, head, err := commentFor(ctx, tx, v, p.WorkspaceID, tid)
				if err != nil || c.thread != tid {
					return orNotFound(err, "Thread")
				}
				tag, err := tx.Exec(ctx, `UPDATE wiki_comments SET resolved_at = CASE WHEN $3 THEN now() END, resolved_by = CASE WHEN $3 THEN $4::uuid END
					WHERE workspace_id = $1 AND id = $2 AND (resolved_at IS NOT NULL) <> $3`, p.WorkspaceID, tid, in.Body.Resolved, p.ActorUserID())
				if err != nil {
					return err
				}
				if out, err = loadThread(ctx, tx, p.WorkspaceID, head.pg.ID, tid); err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return nil
				}
				return commentEvent(ctx, tx, p.WorkspaceID, head, tid)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &threadOut{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "react-wiki-comment", Method: http.MethodPost, Path: "/v1/wiki/comments/{id}/reactions",
		Summary: "React to a wiki comment", Tags: tags,
		Description: "Adds (on: true) or takes back (on: false) your reaction with one emoji."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Emoji string `json:"emoji" maxLength:"64" doc:"One emoji"`
				On    bool   `json:"on"`
			}
		}) (*threadOut, error) {
			p, err := onlyPerson(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, err
			}
			cid, err := hd.ParseID(in.ID, "Comment")
			if err != nil {
				return nil, err
			}
			emoji := strings.TrimSpace(in.Body.Emoji)
			if !hd.IsEmoji(emoji) {
				return nil, httpx.Validation("emoji must be one emoji")
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out WikiThread
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				c, head, err := commentFor(ctx, tx, v, p.WorkspaceID, cid)
				if err != nil {
					return err
				}
				q := `DELETE FROM wiki_comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3`
				if in.Body.On {
					var kinds int
					if err := tx.QueryRow(ctx, `SELECT count(DISTINCT emoji) FROM wiki_comment_reactions WHERE comment_id = $1 AND emoji <> $2`, cid, emoji).Scan(&kinds); err != nil {
						return err
					}
					if kinds >= maxReactions {
						return httpx.Validation("A comment takes up to 20 different reactions.")
					}
					q = `INSERT INTO wiki_comment_reactions (comment_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
				}
				tag, err := tx.Exec(ctx, q, cid, p.UserID, emoji)
				if err != nil {
					return err
				}
				if out, err = loadThread(ctx, tx, p.WorkspaceID, head.pg.ID, c.thread); err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return nil
				}
				return commentEvent(ctx, tx, p.WorkspaceID, head, c.thread)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &threadOut{out}, nil
		})
}

// writable is a page the viewer may see and comment on: not in the trash.
func writable(ctx context.Context, tx pgx.Tx, v Viewer, wid, id uuid.UUID) (pageHead, error) {
	if err := mustSee(ctx, tx, v, wid, id); err != nil {
		return pageHead{}, err
	}
	return liveHead(ctx, tx, wid, id)
}

// liveHead is a page that is not in the trash, else page_in_trash.
func liveHead(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID) (pageHead, error) {
	head, err := headOf(ctx, tx, wid, id)
	if err != nil {
		return head, err
	}
	if head.deleted {
		return head, inTrash()
	}
	return head, nil
}

// commentRow is a comment as its writes need it.
type commentRow struct {
	thread   uuid.UUID
	author   *uuid.UUID
	mentions []uuid.UUID
}

// commentFor locks a comment on a page the viewer may see and comment on; a comment of a
// page out of their sight is not found.
func commentFor(ctx context.Context, tx pgx.Tx, v Viewer, wid, id uuid.UUID) (commentRow, pageHead, error) {
	var c commentRow
	var page uuid.UUID
	err := tx.QueryRow(ctx, `SELECT page_id, thread_id, author_id, mentions FROM wiki_comments WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
		wid, id).Scan(&page, &c.thread, &c.author, &c.mentions)
	if err != nil {
		return c, pageHead{}, orNotFound(err, "Comment")
	}
	if err := mustSee(ctx, tx, v, wid, page); err != nil {
		if he := (*httpx.Error)(nil); errors.As(err, &he) {
			return c, pageHead{}, httpx.NotFound("Comment")
		}
		return c, pageHead{}, err
	}
	head, err := liveHead(ctx, tx, wid, page)
	return c, head, err
}

func orNotFound(err error, what string) error {
	if err == nil || db.IsNotFound(err) {
		return httpx.NotFound(what)
	}
	return err
}

// commentEvent tells the page's readers that a thread changed: they fetch its comments again.
func commentEvent(ctx context.Context, tx pgx.Tx, wid uuid.UUID, head pageHead, thread uuid.UUID) error {
	return pageEvent(ctx, tx, wid, head.pg, "wiki_comment.changed", map[string]any{"page_id": head.pg.ID, "thread_id": thread})
}

// cleanComment sanitizes a comment like a note; nothing left is refused.
func cleanComment(raw string) (string, error) {
	if len(raw) > maxCommentHTML {
		return "", httpx.Validation("A comment is at most 20000 characters.")
	}
	body := hd.SanitizeRich(raw)
	if hd.HTMLToText(body) == "" && !mentionAttr.MatchString(body) {
		return "", httpx.Validation("Write a comment.")
	}
	return body, nil
}

func parseMentions(raw []string) ([]uuid.UUID, error) {
	var out []uuid.UUID
	for _, s := range raw {
		id, err := hd.ParseRef(s, "mentions")
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

// mentioned is who a comment mentions: the listed ids and the body's mention marks, kept to
// members of the workspace, without the author, in the order they were mentioned.
func mentioned(ctx context.Context, tx pgx.Tx, p *auth.Principal, body string, listed []uuid.UUID) ([]uuid.UUID, error) {
	cand := []uuid.UUID{}
	add := func(id uuid.UUID) {
		if id != p.UserID && !slices.Contains(cand, id) {
			cand = append(cand, id)
		}
	}
	for _, id := range listed {
		add(id)
	}
	for _, m := range mentionAttr.FindAllStringSubmatch(body, -1) {
		if id, err := uuid.Parse(m[1]); err == nil {
			add(id)
		}
	}
	if len(cand) == 0 {
		return cand, nil
	}
	if len(cand) > maxMentions {
		return nil, httpx.Validation("Mention at most 50 people.")
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM members WHERE workspace_id = $1 AND user_id = ANY($2)`, p.WorkspaceID, cand)
	if err != nil {
		return nil, err
	}
	members, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(cand, func(id uuid.UUID) bool { return !slices.Contains(members, id) }), nil
}

// notifyMentions tells people a comment mentions them, those who may see the page.
func notifyMentions(ctx context.Context, tx pgx.Tx, p *auth.Principal, head pageHead, thread, comment uuid.UUID, body string, people []uuid.UUID) error {
	people, err := hearers(ctx, tx, p, head, people)
	if err != nil {
		return err
	}
	for _, uid := range people {
		if err := hd.Notify(ctx, tx, p.WorkspaceID, uid, typeMention, nil, commentData(p, head, thread, comment, body)); err != nil {
			return err
		}
	}
	return nil
}

// notifyComment tells about a new comment: the people it mentions (wiki_mention), and the
// page's followers and the thread's other commenters (wiki_comment). A thread's commenters
// hear about its replies even when they unfollowed the page.
func notifyComment(ctx context.Context, tx pgx.Tx, p *auth.Principal, head pageHead, thread, comment uuid.UUID, body string, people []uuid.UUID) error {
	if err := notifyMentions(ctx, tx, p, head, thread, comment, body, people); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM wiki_follows WHERE workspace_id = $1 AND page_id = $2 AND following
		UNION SELECT author_id FROM wiki_comments WHERE workspace_id = $1 AND thread_id = $3 AND author_id IS NOT NULL`, p.WorkspaceID, head.pg.ID, thread)
	if err != nil {
		return err
	}
	others, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	others = slices.DeleteFunc(others, func(u uuid.UUID) bool { return slices.Contains(people, u) })
	slices.SortFunc(others, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	if others, err = hearers(ctx, tx, p, head, others); err != nil {
		return err
	}
	for _, uid := range others {
		if err := hd.Notify(ctx, tx, p.WorkspaceID, uid, typeComment, nil, commentData(p, head, thread, comment, body)); err != nil {
			return err
		}
	}
	return nil
}

func commentData(p *auth.Principal, head pageHead, thread, comment uuid.UUID, body string) map[string]any {
	return map[string]any{"page_id": head.pg.ID.String(), "page_title": head.pg.Title, "by": idOrNil(p.ActorUserID()),
		"preview": hd.Excerpt(hd.HTMLToText(body), previewLen), "thread_id": thread.String(), "comment_id": comment.String()}
}

// loadThread reads one thread of the page.
func loadThread(ctx context.Context, q db.Querier, wid, page, thread uuid.UUID) (WikiThread, error) {
	out, err := loadThreads(ctx, q, wid, page, &thread)
	if err != nil {
		return WikiThread{}, err
	}
	if len(out) == 0 {
		return WikiThread{}, httpx.NotFound("Thread")
	}
	return out[0], nil
}

// loadThreads reads the page's threads (or one of them), oldest first, each with its
// comments and their reactions.
func loadThreads(ctx context.Context, q db.Querier, wid, page uuid.UUID, thread *uuid.UUID) ([]WikiThread, error) {
	rows, err := q.Query(ctx, `SELECT c.id, c.thread_id, c.quote, c.inline, c.body_html, c.mentions, c.created_at, c.edited_at, c.resolved_at,
			a.id, a.name, a.email, a.avatar_url, r.id, r.name, r.email, r.avatar_url
		FROM wiki_comments c LEFT JOIN users a ON a.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by
		WHERE c.workspace_id = $1 AND c.page_id = $2 AND ($3::uuid IS NULL OR c.thread_id = $3)
		ORDER BY c.created_at, c.id`, wid, page, thread)
	if err != nil {
		return nil, err
	}
	out := []WikiThread{}
	at := map[uuid.UUID]int{}
	byComment := map[uuid.UUID][2]int{}
	var orphans []WikiComment
	for rows.Next() {
		var c WikiComment
		var quote string
		var inline bool
		var resolvedAt *time.Time
		var a, r userCols
		if err := rows.Scan(&c.ID, &c.ThreadID, &quote, &inline, &c.BodyHTML, &c.Mentions, &c.CreatedAt, &c.EditedAt, &resolvedAt,
			&a.id, &a.name, &a.email, &a.avatar, &r.id, &r.name, &r.email, &r.avatar); err != nil {
			rows.Close()
			return nil, err
		}
		c.Author, c.Reactions = a.ref(), []WikiReaction{}
		if c.Mentions == nil {
			c.Mentions = []uuid.UUID{}
		}
		if c.ID == c.ThreadID {
			at[c.ID] = len(out)
			out = append(out, WikiThread{ID: c.ID, PageID: page, Quote: quote, Inline: inline, CreatedAt: c.CreatedAt, ResolvedAt: resolvedAt, ResolvedBy: r.ref()})
		}
		orphans = append(orphans, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Replies go under their thread's first comment; none outlives it.
	var commentIDs []uuid.UUID
	for _, c := range orphans {
		i, ok := at[c.ThreadID]
		if !ok {
			continue
		}
		byComment[c.ID] = [2]int{i, len(out[i].Comments)}
		out[i].Comments = append(out[i].Comments, c)
		commentIDs = append(commentIDs, c.ID)
	}
	if len(commentIDs) == 0 {
		return out, nil
	}
	rows, err = q.Query(ctx, `SELECT comment_id, emoji, array_agg(user_id ORDER BY created_at, user_id) FROM wiki_comment_reactions
		WHERE comment_id = ANY($1) GROUP BY comment_id, emoji ORDER BY comment_id, min(created_at), emoji`, commentIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid uuid.UUID
		var x WikiReaction
		if err := rows.Scan(&cid, &x.Emoji, &x.Users); err != nil {
			return nil, err
		}
		pos := byComment[cid]
		c := &out[pos[0]].Comments[pos[1]]
		c.Reactions = append(c.Reactions, x)
	}
	return out, rows.Err()
}
