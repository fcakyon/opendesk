package tickets

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// A message to many customers (contracts/api.md "Messages to many customers"): one subject and
// body sent from one address to the contacts a People selection names, as one ticket for each,
// so a reply lands in that customer's own ticket and no customer sees another's address. The
// tickets share a label. Each is made exactly as POST /v1/tickets makes one (routing,
// automations, template variables filled for that customer), a few at a time by a job that
// follows contact_messages, as the member who sent it.

const (
	// noticeChunk is how many tickets one job run creates, and noticePause the wait before the
	// next run: a send of 1000 takes a few minutes, which spares the address's sending limits.
	noticeChunk = 20
	noticePause = 2 * time.Second
	// noticesPerDay bounds the messages a workspace sends in 24 hours.
	noticesPerDay = 10
	// noticeListed is how many recent messages the list shows.
	noticeListed = 20
)

// ContactMessage is a message sent to many customers and how far it got.
type ContactMessage struct {
	ID         uuid.UUID      `json:"id"`
	Subject    string         `json:"subject"`
	Label      string         `json:"label" doc:"The label every ticket of this message carries"`
	Status     string         `json:"status" enum:"open,pending,solved" doc:"What the tickets start as"`
	State      string         `json:"state" enum:"sending,done,cancelled"`
	MailboxID  *uuid.UUID     `json:"mailbox_id" doc:"The address it goes out from; null once that address was removed"`
	CreatedBy  *uuid.UUID     `json:"created_by"`
	Total      int            `json:"total" doc:"Customers it reaches"`
	Sent       int            `json:"sent" doc:"Tickets created so far"`
	Failed     int            `json:"failed" doc:"Customers whose ticket could not be created"`
	LastError  string         `json:"last_error" doc:"Why the latest one failed, or empty"`
	Skipped    map[string]int `json:"skipped" doc:"Customers left out when it was made, by reason: no_email, blocked"`
	CreatedAt  time.Time      `json:"created_at"`
	FinishedAt *time.Time     `json:"finished_at"`
}

// NoticePreview is who a send would reach.
type NoticePreview struct {
	Reaches int            `json:"reaches" doc:"Customers it would reach"`
	Skipped map[string]int `json:"skipped" doc:"Customers it would leave out, by reason: no_email, blocked"`
}

type noticeTarget struct {
	IDs   []string         `json:"ids,omitempty" maxItems:"100" doc:"The contacts to reach"`
	Query *contacts.Filter `json:"query,omitempty" doc:"Instead of ids: the People list's filters (at most 1000 contacts)"`
}

type noticeInput struct {
	IDs       []string         `json:"ids,omitempty" maxItems:"100" doc:"The contacts to reach"`
	Query     *contacts.Filter `json:"query,omitempty" doc:"Instead of ids: the People list's filters (at most 1000 contacts)"`
	MailboxID string           `json:"mailbox_id" doc:"The address it goes out from (an address the caller may send from)"`
	Subject   string           `json:"subject" minLength:"1" maxLength:"500" doc:"As written; template tags are filled in the body only"`
	BodyHTML  string           `json:"body_html" maxLength:"500000" doc:"The message, with template tags (contracts/templates.md) filled for each customer"`
	Label     string           `json:"label" minLength:"1" maxLength:"50" doc:"The label every ticket carries, created when missing and the caller may create labels"`
	Status    string           `json:"status,omitempty" enum:"open,pending,solved" doc:"What the tickets start as. Default solved: most customers will not answer, and one who does reopens theirs. A solved notice asks for no satisfaction rating"`
}

// noticeRecipients resolves a target to the customers a send reaches and counts who it leaves
// out: no email address, or blocked.
func noticeRecipients(ctx context.Context, tx pgx.Tx, p *auth.Principal, t noticeTarget) ([]uuid.UUID, map[string]int, error) {
	all, err := contacts.Recipients(ctx, tx, p, t.IDs, t.Query)
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id, COALESCE(email, ''), blocked FROM contacts WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id`, p.WorkspaceID, all)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	reach, skipped := []uuid.UUID{}, map[string]int{}
	for rows.Next() {
		var id uuid.UUID
		var email string
		var blocked bool
		if err := rows.Scan(&id, &email, &blocked); err != nil {
			return nil, nil, err
		}
		switch {
		case blocked:
			skipped["blocked"]++
		case email == "":
			skipped["no_email"]++
		default:
			reach = append(reach, id)
		}
	}
	return reach, skipped, rows.Err()
}

const contactMessageSelect = `SELECT id, subject, label, status, state, mailbox_id, created_by, total, sent, failed, last_error, skipped, created_at, finished_at
	FROM contact_messages`

func scanContactMessage(r pgx.Row) (ContactMessage, error) {
	var m ContactMessage
	err := r.Scan(&m.ID, &m.Subject, &m.Label, &m.Status, &m.State, &m.MailboxID, &m.CreatedBy, &m.Total, &m.Sent, &m.Failed, &m.LastError,
		&m.Skipped, &m.CreatedAt, &m.FinishedAt)
	if m.Skipped == nil {
		m.Skipped = map[string]int{}
	}
	return m, err
}

func registerContactMessages(d *deps.Deps, api huma.API) {
	tags := []string{"Tickets"}
	member := func(ctx context.Context, role auth.Role, scope string) (*auth.Principal, error) {
		p, err := auth.RequireWorkspace(ctx, role, scope)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		if p.ActorUserID() == nil || p.Assistant {
			return nil, httpx.E(http.StatusForbidden, "forbidden", "A message to many customers is sent by a signed-in member.")
		}
		return p, nil
	}

	huma.Register(api, huma.Operation{OperationID: "preview-contact-message", Method: http.MethodPost, Path: "/v1/contacts/message/preview",
		Summary: "Preview who a message to many customers reaches", Tags: tags,
		Description: "Counts the customers a send would reach and who it would leave out (no email address, blocked). Nothing is sent. Preview and test the text itself with POST /v1/templates/preview and /v1/templates/test (kind notice)."},
		func(ctx context.Context, in *struct{ Body noticeTarget }) (*struct{ Body NoticePreview }, error) {
			p, err := member(ctx, auth.RoleAgent, auth.ScopeContactsRead)
			if err != nil {
				return nil, err
			}
			out := NoticePreview{}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				reach, skipped, err := noticeRecipients(ctx, tx, p, in.Body)
				out.Reaches, out.Skipped = len(reach), skipped
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body NoticePreview }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "send-contact-message", Method: http.MethodPost, Path: "/v1/contacts/message",
		Summary: "Send a message to many customers", Tags: tags, DefaultStatus: http.StatusAccepted,
		Description: "Creates one ticket for each customer the selection reaches, all with one label, a few at a time, and answers at once with how it stands (GET /v1/contact-messages/{id}). At most 1000 customers, one send at a time per workspace and 10 a day."},
		func(ctx context.Context, in *struct{ Body noticeInput }) (*struct{ Body ContactMessage }, error) {
			p, err := member(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, err
			}
			var out ContactMessage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var err error
				out, err = createContactMessage(ctx, tx, d, p, in.Body)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactMessage }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-contact-messages", Method: http.MethodGet, Path: "/v1/contact-messages",
		Summary: "List recent messages to many customers", Tags: tags, Description: "The latest 20, newest first."},
		func(ctx context.Context, _ *struct{}) (*struct {
			Body struct {
				Data []ContactMessage `json:"data"`
			}
		}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, contactMessageSelect+` WHERE workspace_id = $1 ORDER BY created_at DESC, id LIMIT $2`, p.WorkspaceID, noticeListed)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ContactMessage, error) { return scanContactMessage(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct {
				Body struct {
					Data []ContactMessage `json:"data"`
				}
			}{}
			out.Body.Data = list
			if out.Body.Data == nil {
				out.Body.Data = []ContactMessage{}
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-contact-message", Method: http.MethodGet, Path: "/v1/contact-messages/{id}",
		Summary: "Get a message to many customers", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ContactMessage }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Message")
			if err != nil {
				return nil, err
			}
			m, err := scanContactMessage(d.DB.Pool.QueryRow(ctx, contactMessageSelect+` WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id))
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Message")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactMessage }{m}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "cancel-contact-message", Method: http.MethodPost, Path: "/v1/contact-messages/{id}/cancel",
		Summary: "Stop a message to many customers", Tags: tags,
		Description: "Stops creating tickets for the customers it has not reached yet. The tickets already made stay. By the member who sent it, or an admin."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body ContactMessage }, error) {
			p, err := member(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, err
			}
			id, err := hd.ParseID(in.ID, "Message")
			if err != nil {
				return nil, err
			}
			var out ContactMessage
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var by *uuid.UUID
				var state string
				err := tx.QueryRow(ctx, `SELECT created_by, state FROM contact_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).Scan(&by, &state)
				if db.IsNotFound(err) {
					return httpx.NotFound("Message")
				}
				if err != nil {
					return err
				}
				if !p.Role.AtLeast(auth.RoleAdmin) && (by == nil || *by != p.UserID) {
					return httpx.Forbidden()
				}
				if state == "sending" {
					if _, err := tx.Exec(ctx, `UPDATE contact_messages SET state = 'cancelled', finished_at = now() WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
						return err
					}
					if err := audit.Log(ctx, tx, p, p.WorkspaceID, "contact_message.cancelled", "contact_message", &id, nil); err != nil {
						return err
					}
				}
				if out, err = scanContactMessage(tx.QueryRow(ctx, contactMessageSelect+` WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)); err != nil {
					return err
				}
				return publishContactMessage(ctx, tx, out)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ContactMessage }{out}, nil
		})
}

// publishContactMessage tells the member who sent it how it stands.
func publishContactMessage(ctx context.Context, tx pgx.Tx, m ContactMessage) error {
	if m.CreatedBy == nil {
		return nil
	}
	var wid uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM contact_messages WHERE id = $1`, m.ID).Scan(&wid); err != nil {
		return err
	}
	_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "contact_message.updated", Users: []uuid.UUID{*m.CreatedBy},
		Data: map[string]any{"contact_message": m}})
	return err
}

// createContactMessage checks a send, records it and queues its first job.
func createContactMessage(ctx context.Context, tx pgx.Tx, d *deps.Deps, p *auth.Principal, in noticeInput) (ContactMessage, error) {
	wid := p.WorkspaceID
	subject := strings.TrimSpace(in.Subject)
	// Kept with its template tags, also inside links: each ticket fills them for its customer and
	// cleans the result again, as a reply with tags is (hd.FillReply).
	html := hd.SanitizeRichTemplate(in.BodyHTML)
	if subject == "" {
		return ContactMessage{}, httpx.Validation("subject is required")
	}
	if hd.HTMLToText(html) == "" && !strings.Contains(html, "<img") {
		return ContactMessage{}, httpx.Validation("body_html is required")
	}
	status := in.Status
	if status == "" {
		status = domain.StatusSolved
	}
	label, err := domain.CleanTagName(in.Label)
	if err != nil {
		return ContactMessage{}, err
	}
	mailbox, err := hd.ParseRef(in.MailboxID, "mailbox_id")
	if err != nil {
		return ContactMessage{}, err
	}
	if err := hd.CheckRef(ctx, tx, wid, "mailbox", mailbox); err != nil {
		return ContactMessage{}, err
	}
	ok, err := domain.CanSendFrom(ctx, tx, p, mailbox)
	if err != nil {
		return ContactMessage{}, err
	}
	if !ok {
		return ContactMessage{}, httpx.E(http.StatusForbidden, "forbidden", "Only members of its team can send from this address.")
	}
	// The label the tickets share: it exists (and is for tickets) or is created now, so the
	// job never depends on what the sender may do later.
	var scopes []string
	err = tx.QueryRow(ctx, `SELECT applies_to FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2) ORDER BY name = $2 DESC LIMIT 1`, wid, label).Scan(&scopes)
	switch {
	case db.IsNotFound(err):
		create, err := hd.CanCreateLabels(ctx, tx, p)
		if err != nil {
			return ContactMessage{}, err
		}
		if !create {
			return ContactMessage{}, httpx.E(http.StatusUnprocessableEntity, "unknown_label", "There is no label named \""+label+"\"; ask an admin to create it.")
		}
		if _, err := domain.CreateLabel(ctx, tx, wid, label); err != nil {
			return ContactMessage{}, err
		}
	case err != nil:
		return ContactMessage{}, err
	default:
		var forTickets bool
		for _, s := range scopes {
			forTickets = forTickets || s == domain.ScopeTickets
		}
		if !forTickets {
			return ContactMessage{}, httpx.Validation("that label is not for tickets; choose another")
		}
	}

	reach, skipped, err := noticeRecipients(ctx, tx, p, noticeTarget{IDs: in.IDs, Query: in.Query})
	if err != nil {
		return ContactMessage{}, err
	}
	if len(reach) == 0 {
		return ContactMessage{}, httpx.E(http.StatusUnprocessableEntity, "no_recipients", "Nobody in this selection can be reached: they have no email address or are blocked.")
	}
	// One at a time, and a bounded number a day.
	var recent int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM contact_messages WHERE workspace_id = $1 AND created_at > now() - interval '24 hours'`, wid).Scan(&recent); err != nil {
		return ContactMessage{}, err
	}
	if recent >= noticesPerDay {
		return ContactMessage{}, httpx.E(http.StatusTooManyRequests, "rate_limited", "This workspace sent 10 messages to many customers in the last day. Try again later.")
	}
	var sending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM contact_messages WHERE workspace_id = $1 AND state = 'sending')`, wid).Scan(&sending); err != nil {
		return ContactMessage{}, err
	}
	if sending {
		return ContactMessage{}, httpx.E(http.StatusConflict, "message_in_progress", "Another message to many customers is still being sent. Wait for it to finish or stop it.")
	}
	id := ids.New()
	if _, err := tx.Exec(ctx, `INSERT INTO contact_messages (id, workspace_id, created_by, mailbox_id, subject, body_html, label, status, contact_ids, total, skipped)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, id, wid, p.UserID, mailbox, subject, html, label, status, reach, len(reach), skipped); err != nil {
		if db.IsUniqueViolation(err, "contact_messages_sending_idx") {
			return ContactMessage{}, httpx.E(http.StatusConflict, "message_in_progress", "Another message to many customers is still being sent. Wait for it to finish or stop it.")
		}
		return ContactMessage{}, err
	}
	if _, err := d.Jobs.InsertTx(ctx, tx, jobs.ContactMessageArgs{WorkspaceID: wid, MessageID: id}, nil); err != nil {
		return ContactMessage{}, err
	}
	// Who sent what to how many from where; never the text.
	if err := audit.Log(ctx, tx, p, wid, "contact_message.sent", "contact_message", &id,
		map[string]any{"total": len(reach), "skipped": skipped, "label": label, "mailbox_id": mailbox, "status": status}); err != nil {
		return ContactMessage{}, err
	}
	m, err := scanContactMessage(tx.QueryRow(ctx, contactMessageSelect+` WHERE workspace_id = $1 AND id = $2`, wid, id))
	if err != nil {
		return ContactMessage{}, err
	}
	return m, publishContactMessage(ctx, tx, m)
}

// ContactMessageWorker creates the next tickets of a message sent to many customers.
type ContactMessageWorker struct {
	river.WorkerDefaults[jobs.ContactMessageArgs]
	D *deps.Deps
}

func (w *ContactMessageWorker) Work(ctx context.Context, job *river.Job[jobs.ContactMessageArgs]) error {
	return ContinueContactMessage(ctx, w.D, job.Args)
}

// ContinueContactMessage creates the next noticeChunk tickets of a message, as its sender, each
// in a savepoint so one customer's failure leaves the rest. It queues itself again until
// everyone was reached, and stops when the message was cancelled. A run whose NextIndex is not
// where the message stands (a retry of a run that already went through) does nothing, so the
// message is followed by one job at a time.
func ContinueContactMessage(ctx context.Context, d *deps.Deps, a jobs.ContactMessageArgs) error {
	return d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var by, mailbox *uuid.UUID
		var subject, html, label, status, state string
		var contactIDs []uuid.UUID
		var next int
		err := tx.QueryRow(ctx, `SELECT created_by, mailbox_id, subject, body_html, label, status, state, contact_ids, next_index FROM contact_messages
			WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, a.WorkspaceID, a.MessageID).Scan(&by, &mailbox, &subject, &html, &label, &status, &state, &contactIDs, &next)
		if db.IsNotFound(err) || (err == nil && (state != "sending" || next != a.NextIndex)) {
			return nil
		}
		if err != nil {
			return err
		}
		stop := func(reason string) error {
			if _, err := tx.Exec(ctx, `UPDATE contact_messages SET state = 'cancelled', finished_at = now(), last_error = $3 WHERE workspace_id = $1 AND id = $2`,
				a.WorkspaceID, a.MessageID, reason); err != nil {
				return err
			}
			return announceContactMessage(ctx, tx, a)
		}
		if by == nil {
			return stop("The member who sent it is gone, so the rest was not sent.")
		}
		p, err := noticePrincipal(ctx, tx, a.WorkspaceID, *by)
		if err != nil {
			return err
		}
		if p == nil {
			return stop("The member who sent it can no longer reply on tickets, so the rest was not sent.")
		}
		if mailbox == nil {
			return stop("The address it goes out from was removed, so the rest was not sent.")
		}
		end := min(next+noticeChunk, len(contactIDs))
		sent, failed, lastErr := 0, 0, ""
		for _, cid := range contactIDs[next:end] {
			if _, err := tx.Exec(ctx, `SAVEPOINT notice_ticket`); err != nil {
				return err
			}
			_, err := createTicket(ctx, tx, d, p, ticketCreateBody{Subject: subject, BodyHTML: html, ContactID: cid.String(), MailboxID: mailbox.String(),
				Channel: domain.ChannelEmail, Status: status, Tags: []string{label}, notice: true})
			if err == nil {
				if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT notice_ticket`); err != nil {
					return err
				}
				sent++
				continue
			}
			if _, rerr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT notice_ticket`); rerr != nil {
				return rerr
			}
			failed++
			lastErr = "A ticket could not be created."
			if he, ok := err.(*httpx.Error); ok && he.Detail != "" {
				lastErr = he.Detail
			} else if herr := httpx.Wrap(err); herr != nil {
				if he, ok := herr.(*httpx.Error); ok && he.Detail != "" {
					lastErr = he.Detail
				}
			}
		}
		done := end >= len(contactIDs)
		if _, err := tx.Exec(ctx, `UPDATE contact_messages SET next_index = $3, sent = sent + $4, failed = failed + $5,
			last_error = CASE WHEN $6 <> '' THEN $6 ELSE last_error END,
			state = CASE WHEN $7 THEN 'done' ELSE state END, finished_at = CASE WHEN $7 THEN now() ELSE finished_at END
			WHERE workspace_id = $1 AND id = $2`, a.WorkspaceID, a.MessageID, end, sent, failed, lastErr, done); err != nil {
			return err
		}
		if !done {
			a.NextIndex = end
			if _, err := d.Jobs.InsertTx(ctx, tx, a, &river.InsertOpts{ScheduledAt: time.Now().Add(noticePause)}); err != nil {
				return err
			}
		}
		return announceContactMessage(ctx, tx, a)
	})
}

func announceContactMessage(ctx context.Context, tx pgx.Tx, a jobs.ContactMessageArgs) error {
	m, err := scanContactMessage(tx.QueryRow(ctx, contactMessageSelect+` WHERE workspace_id = $1 AND id = $2`, a.WorkspaceID, a.MessageID))
	if err != nil {
		return err
	}
	return publishContactMessage(ctx, tx, m)
}

// noticePrincipal is the member who sent a message, as they would be signed in now, or nil
// when they may no longer reply: not a member or below agent, suspended, or the workspace
// suspended.
func noticePrincipal(ctx context.Context, q db.Querier, wid, uid uuid.UUID) (*auth.Principal, error) {
	var role string
	err := q.QueryRow(ctx, `SELECT m.role FROM members m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.suspended_at IS NULL AND w.suspended_at IS NULL`, wid, uid).Scan(&role)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p := &auth.Principal{Kind: auth.KindUser, UserID: uid, WorkspaceID: wid, Role: auth.Role(role)}
	if !p.Role.AtLeast(auth.RoleAgent) {
		return nil, nil
	}
	return p, nil
}
