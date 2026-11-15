package contacts

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Merging two contacts that are one person (contracts/api.md "Merging contacts").
func registerMerge(d *deps.Deps, api huma.API) {
	huma.Register(api, op("merge-contact", http.MethodPost, "/v1/contacts/{id}/merge", "Merge a contact into another", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Into string `json:"into" doc:"The contact that stays. This one is removed, and everything it has becomes the other's"`
			}
		}) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			src, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			dst, err := hd.ParseID(in.Body.Into, "Contact")
			if err != nil {
				return nil, err
			}
			var c domain.Contact
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				moved, err := domain.MergeContacts(ctx, tx, p.WorkspaceID, src, dst)
				if err != nil {
					return err
				}
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "contact.merged", "contact", &dst,
					map[string]any{"from": src, "tickets": len(moved)}); err != nil {
					return err
				}
				if c, err = domain.LoadContact(ctx, tx, p.WorkspaceID, dst); err != nil {
					return err
				}
				if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.deleted", Data: map[string]any{"contact_id": src}}); err != nil {
					return err
				}
				if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.updated", Data: map[string]any{"contact": c}}); err != nil {
					return err
				}
				// Their tickets now show the other contact.
				for _, id := range moved {
					if err := domain.PublishTicketUpdated(ctx, tx, p.WorkspaceID, id, []string{"contact_id"}); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})
}
