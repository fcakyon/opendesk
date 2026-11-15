package wiki

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/images"
)

// registerUnfurl adds the link cards of bookmark blocks (contracts/wiki.md "Bookmarks"):
// the API reads the page once, through the outbound guard, and the app stores the card
// in the block. Nothing is fetched when the page is read later.
func registerUnfurl(d *deps.Deps, api huma.API) {
	fetcher := images.NewFetcher(d)
	huma.Register(api, huma.Operation{OperationID: "unfurl-wiki-link", Method: http.MethodPost, Path: "/v1/wiki/unfurl",
		Summary: "Read a link's card for a bookmark", Tags: tags,
		Description: "Fetches an https page and returns its title, description and image (Open Graph, then the page's own). Private and local addresses are refused."},
		func(ctx context.Context, in *struct {
			Body struct {
				URL string `json:"url" maxLength:"2000" doc:"An https link"`
			}
		}) (*struct{ Body images.Card }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if !d.Limiter.Allow("wiki-unfurl:"+p.WorkspaceID.String(), 120, time.Minute) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many links at once. Try again in a minute.")
			}
			raw := strings.TrimSpace(in.Body.URL)
			if !strings.HasPrefix(strings.ToLower(raw), "https://") {
				return nil, httpx.Validation("url must start with https://")
			}
			card, err := fetcher.LinkCard(ctx, raw)
			if err != nil {
				// A page that can't be read still becomes a bookmark, with its address alone.
				return nil, httpx.E(http.StatusUnprocessableEntity, "unreachable", "Couldn't read that page. The bookmark shows its address.")
			}
			return &struct{ Body images.Card }{card}, nil
		})
}
