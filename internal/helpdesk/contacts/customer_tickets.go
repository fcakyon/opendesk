package contacts

// A ticket's customer tickets: the customer's other tickets, whatever address they wrote from.
//
// One person is often several contacts: they write from a second address (its own contact), or
// a chat visitor types an address another contact has, which is kept in custom.widget_email and
// never joins the two. GET /v1/tickets/{id}/customer-tickets answers the tickets of, or written in
// by:
//   - the ticket's contact, and every contact who wrote an inbound message in it;
//   - every contact who has one of their addresses (primary, extra, or typed in the chat) as its
//     primary or extra address, or typed it in the chat.
//
// "Written in by" covers a ticket filed under another contact than its writer, such as a contact
// form's misspelt address. The ticket itself, deleted tickets, tickets merged into another and
// tickets of a team the caller may not see are left out. Nothing is merged: the contacts stay
// apart, since a second address may be a colleague, a forwarder or a supplier in copy.

import (
	"context"
	"net/http"
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
)

// customerTicketsMax caps the list; total counts them all.
const customerTicketsMax = 50

// CustomerPastTicket is one of the customer's other tickets, with the contact it is filed under.
type CustomerPastTicket struct {
	ID            uuid.UUID `json:"id"`
	Number        int64     `json:"number"`
	Subject       string    `json:"subject"`
	Status        string    `json:"status"`
	Channel       string    `json:"channel"`
	MessageCount  int       `json:"message_count"`
	LastMessageAt time.Time `json:"last_message_at"`
	Contact       struct {
		ID    uuid.UUID `json:"id"`
		Name  string    `json:"name"`
		Email string    `json:"email" doc:"Its address, or the one it typed in the chat"`
	} `json:"contact"`
}

type customerTicketsOut struct {
	Body struct {
		Data  []CustomerPastTicket `json:"data"`
		Total int                  `json:"total" doc:"All of them, beyond the list's cap"`
	}
}

func registerCustomerTickets(d *deps.Deps, api huma.API) {
	o := op("list-ticket-customer-tickets", http.MethodGet, "/v1/tickets/{id}/customer-tickets", "List the customer's other tickets, from any of their addresses", "Contacts", 0)
	o.Description = "The tickets of the ticket's contact, of every contact who wrote in it, and of every contact who has one of " +
		"their addresses (primary, extra, or typed in the chat), and the tickets those contacts wrote in. Not the ticket itself, " +
		"deleted or merged tickets, nor tickets of a team the caller may not see. Newest first, at most 50, with `total`."
	huma.Register(api, o,
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*customerTicketsOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind == auth.KindAPIKey && !p.HasScope(auth.ScopeContactsRead) {
				return nil, httpx.Forbidden()
			}
			id, err := hd.ParseID(in.ID, "Ticket")
			if err != nil {
				return nil, err
			}
			hidden, err := domain.HiddenTeams(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, total, err := customerTickets(ctx, d.DB.Pool, p.WorkspaceID, id, hidden, p.ActorUserID())
			if err != nil {
				return nil, err
			}
			out := &customerTicketsOut{}
			out.Body.Data, out.Body.Total = list, total
			return out, nil
		})
}

// customerTickets answers the customer's other tickets (see the file's comment) and how many
// there are; not found when the ticket is not in the workspace or the caller may not see it.
func customerTickets(ctx context.Context, q db.Querier, wid, tid uuid.UUID, hidden []uuid.UUID, uid *uuid.UUID) ([]CustomerPastTicket, int, error) {
	var visible bool
	err := q.QueryRow(ctx, `SELECT COALESCE(`+domain.VisibleSQLUser("t", 3, 4)+`, false) FROM tickets t
		WHERE t.workspace_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`, wid, tid, hidden, uid).Scan(&visible)
	if db.IsNotFound(err) || (err == nil && !visible) {
		return nil, 0, httpx.NotFound("Ticket")
	}
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}

	// Who wrote in the ticket: its contact and the authors of its inbound messages.
	rows, err := q.Query(ctx, `SELECT t.contact_id FROM tickets t WHERE t.id = $1 AND t.contact_id IS NOT NULL
		UNION SELECT m.author_contact_id FROM messages m WHERE m.ticket_id = $1 AND m.direction = 'inbound' AND m.author_contact_id IS NOT NULL`, tid)
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	writers, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	if len(writers) == 0 {
		return []CustomerPastTicket{}, 0, nil
	}

	// Their addresses: primary, extra, and typed in the chat.
	rows, err = q.Query(ctx, `SELECT c.email::text FROM contacts c WHERE c.id = ANY($1) AND COALESCE(c.email, '') <> ''
		UNION SELECT ce.email::text FROM contact_emails ce WHERE ce.contact_id = ANY($1)
		UNION SELECT c.custom ->> 'widget_email' FROM contacts c WHERE c.id = ANY($1) AND COALESCE(c.custom ->> 'widget_email', '') <> ''`, writers)
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	addrs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	for i, a := range addrs {
		addrs[i] = strings.ToLower(strings.TrimSpace(a))
	}

	// The people: the writers and every contact with one of those addresses. Their tickets: the ones
	// filed under them and the ones they wrote an inbound message in.
	rows, err = q.Query(ctx, `WITH people AS (
			SELECT unnest($2::uuid[]) AS id
			UNION SELECT c.id FROM contacts c WHERE c.workspace_id = $1 AND c.email = ANY($3::text[]::citext[])
			UNION SELECT ce.contact_id FROM contact_emails ce WHERE ce.workspace_id = $1 AND ce.email = ANY($3::text[]::citext[])
			UNION SELECT c.id FROM contacts c WHERE c.workspace_id = $1 AND c.custom ? 'widget_email'
				AND lower(btrim(c.custom ->> 'widget_email')) = ANY($3::text[])),
		theirs AS (
			SELECT t.id FROM tickets t WHERE t.workspace_id = $1 AND t.contact_id IN (SELECT id FROM people)
			UNION SELECT m.ticket_id FROM messages m WHERE m.author_contact_id IN (SELECT id FROM people) AND m.direction = 'inbound')
		SELECT t.id, t.number, t.subject, t.status, t.channel, t.message_count, t.last_message_at,
			c.id, c.name, COALESCE(NULLIF(c.email::text, ''), c.custom ->> 'widget_email', ''), count(*) OVER ()
		FROM tickets t JOIN contacts c ON c.id = t.contact_id
		WHERE t.workspace_id = $1 AND t.id IN (SELECT id FROM theirs) AND t.id <> $4
			AND t.deleted_at IS NULL AND t.merged_into_id IS NULL
			AND `+domain.VisibleSQLUser("t", 5, 6)+`
		ORDER BY t.last_message_at DESC, t.id DESC LIMIT $7`, wid, writers, addrs, tid, hidden, uid, customerTicketsMax)
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	total := 0
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (CustomerPastTicket, error) {
		var x CustomerPastTicket
		err := r.Scan(&x.ID, &x.Number, &x.Subject, &x.Status, &x.Channel, &x.MessageCount, &x.LastMessageAt,
			&x.Contact.ID, &x.Contact.Name, &x.Contact.Email, &total)
		return x, err
	})
	if err != nil {
		return nil, 0, httpx.Wrap(err)
	}
	return list, total, nil
}
