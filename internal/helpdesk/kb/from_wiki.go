package kb

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
	"github.com/useopendesk/opendesk/internal/helpdesk/wikiconv"
	"github.com/useopendesk/opendesk/internal/httpx"
)

type fromWikiIn struct {
	PageID       string  `json:"page_id" doc:"The wiki page to copy"`
	Title        string  `json:"title,omitempty" maxLength:"200" doc:"The article's title; the page's when empty"`
	CollectionID *string `json:"collection_id,omitempty" doc:"Collection id, or empty for none"`
	BrandID      *string `json:"brand_id,omitempty" required:"false" nullable:"true" doc:"Brand id, or null for every brand"`
}

type fromWikiOut struct {
	Body struct {
		Article KbArticle `json:"article"`
		// Blocks that stay in the wiki: the workspace's own files and images, databases, ticket lists and subpage links.
		LeftOut int `json:"left_out"`
	}
}

// registerFromWiki publishes a wiki page as a help center article draft
// (contracts/wiki.md "Publishing"): a copy, nothing stays linked.
func registerFromWiki(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "create-kb-article-from-wiki", Method: http.MethodPost, Path: "/v1/kb/articles/from-wiki",
		Summary: "Copy a wiki page into a draft article", Tags: []string{"Knowledge base"}, DefaultStatus: http.StatusCreated,
		Description: "Copies a wiki page's title and text into a new draft article. Mentions of teammates and links to wiki pages keep only their text; " +
			"the workspace's own files and images, databases, ticket lists and subpage links stay in the wiki. Nothing stays linked: later edits of the page don't reach the article."},
		func(ctx context.Context, in *struct{ Body fromWikiIn }) (*fromWikiOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeKBWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if _, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiRead); err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.Body.PageID, "Wiki page")
			if err != nil {
				return nil, err
			}
			v, err := wiki.ViewerOf(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			pg, err := wiki.LoadPage(ctx, d.DB.Pool, v, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Wiki page")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if pg.DeletedAt != nil {
				return nil, httpx.NotFound("Wiki page")
			}
			body, left := wikiconv.Article(pg.BodyHTML)
			title := in.Body.Title
			if title == "" {
				title = pg.Title
			}
			if title == "" {
				return nil, httpx.Validation("title is required for a page without one")
			}
			a, err := createArticle(ctx, d, p, kbArticleCreate{Title: title, BodyHTML: body, Status: "draft",
				CollectionID: in.Body.CollectionID, BrandID: in.Body.BrandID})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &fromWikiOut{}
			out.Body.Article, out.Body.LeftOut = a, left
			return out, nil
		})
}
