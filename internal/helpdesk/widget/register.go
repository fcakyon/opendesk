// Package widget is the chat widget API (visitor sessions, conversations, uploads), the
// admin-side widgets and their settings, and the attachment routes shared by agents and
// visitors. A workspace has any number of widgets, one per website, each in a brand
// (contracts/teams.md).
package widget

import (
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Register adds this package's routes.
func Register(d *deps.Deps, api huma.API, r chi.Router) {
	// Conversations are tickets: starting, reading and answering one needs Tickets on.
	api.UseMiddleware(httpx.TicketsGate(d.DB.Pool, func(op *huma.Operation) bool {
		return strings.HasPrefix(op.Path, "/v1/widget/conversations") || op.OperationID == "widget-upload-attachment"
	}))
	h := &handler{d: d, api: api}
	h.registerAttachments(api, r)
	h.registerPublic(api)
	h.registerVerification(api)
	h.registerConversations(api)
	h.registerAgentRoutes(api)
	h.registerSettings(api)
	h.registerWidgets(api)
}

type handler struct {
	d   *deps.Deps
	api huma.API
}
