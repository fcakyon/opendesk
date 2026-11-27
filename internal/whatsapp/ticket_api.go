package whatsapp

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// TicketState is a WhatsApp ticket's conversation as its composer shows it: the connection a
// reply goes out from and the customer's 24-hour window, both as the send will see them.
type TicketState struct {
	// ConnectionID is the connection that holds the ticket's number now; null while the number
	// is not connected, when nothing can be sent.
	ConnectionID   *uuid.UUID `json:"connection_id" nullable:"true"`
	ConnectionName string     `json:"connection_name"`
	DisplayPhone   string     `json:"display_phone_number"`
	// WindowOpen is whether a free-form reply may go out now; a template may go out any time.
	WindowOpen bool `json:"window_open"`
	// WindowClosesAt is when the window closes (or closed); null when the customer never wrote
	// to this number.
	WindowClosesAt *time.Time `json:"window_closes_at" nullable:"true"`
}

// registerTicketAPI mounts a ticket's WhatsApp state.
func (s *Service) registerTicketAPI(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "get-ticket-whatsapp", Method: http.MethodGet,
		Path: "/v1/tickets/{id}/whatsapp", Tags: []string{"WhatsApp"}, Summary: "Get a ticket's WhatsApp state",
		Description: "The connection a reply on this WhatsApp ticket goes out from, and the customer's 24-hour window."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body TicketState }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			ticketID, err := hd.ParseID(in.ID, "Ticket")
			if err != nil {
				return nil, err
			}
			t, err := domain.LoadVisibleTicket(ctx, s.d.DB.Pool, p, ticketID)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Ticket")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if t.Channel != domain.ChannelWhatsApp {
				return nil, httpx.E(http.StatusUnprocessableEntity, "not_whatsapp_ticket", "This ticket is not a WhatsApp conversation.")
			}
			out := &struct{ Body TicketState }{}
			c, th, err := ticketConnection(ctx, s.d.DB.Pool, p.WorkspaceID, t.ID)
			switch {
			case errors.Is(err, errNoConversation):
				return out, nil
			case errors.Is(err, errDisconnected):
			case err != nil:
				return nil, httpx.Wrap(err)
			default:
				out.Body.ConnectionID = &c.ID
				out.Body.ConnectionName = c.Name
				out.Body.DisplayPhone = c.DisplayPhone
				out.Body.WindowOpen = th.Open(time.Now())
			}
			out.Body.WindowClosesAt = th.ClosesAt()
			return out, nil
		})
}
