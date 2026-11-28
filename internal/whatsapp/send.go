package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// sendWorker delivers one outbound WhatsApp reply.
type sendWorker struct {
	river.WorkerDefaults[jobs.WhatsAppSendArgs]
	s *Service
}

func (w *sendWorker) Work(ctx context.Context, job *river.Job[jobs.WhatsAppSendArgs]) error {
	s := w.s
	var m struct {
		ID             uuid.UUID
		BodyText       string
		BodyHTML       string
		TicketID       uuid.UUID
		Channel        string
		Kind           string
		Direction      string
		DeliveryStatus string
		DeliveryMeta   []byte
		Attachments    int64
	}
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT m.id, m.body_text, m.body_html, m.kind, m.direction, m.delivery_status,
			m.delivery_meta, t.id, t.channel,
			(SELECT count(*) FROM attachments a WHERE a.workspace_id = m.workspace_id AND a.message_id = m.id)
		FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.workspace_id = m.workspace_id
		WHERE m.workspace_id = $1 AND m.id = $2`, job.Args.WorkspaceID, job.Args.MessageID).Scan(
		&m.ID, &m.BodyText, &m.BodyHTML, &m.Kind, &m.Direction, &m.DeliveryStatus, &m.DeliveryMeta,
		&m.TicketID, &m.Channel, &m.Attachments)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if m.Channel != domain.ChannelWhatsApp || m.Kind != "reply" || m.Direction != "outbound" || m.DeliveryStatus != "pending" {
		return nil
	}
	// A suspended workspace's replies do not go out, as the email sender's do not: the job is
	// canceled rather than retried, and the message keeps what the agent wrote.
	if suspended, err := domain.WorkspaceSuspended(ctx, s.d.DB.Pool, job.Args.WorkspaceID); err != nil {
		return err
	} else if suspended {
		s.d.Log.Info("whatsapp send canceled: workspace suspended", "message_id", m.ID)
		return river.JobCancel(errors.New("workspace suspended"))
	}
	c, th, err := ticketConnection(ctx, s.d.DB.Pool, job.Args.WorkspaceID, m.TicketID)
	switch {
	case errors.Is(err, errNoConversation):
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID, "This ticket has no WhatsApp conversation to reply on.")
	case errors.Is(err, errDisconnected):
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID, "This ticket's WhatsApp number is not connected.")
	case err != nil:
		return err
	}
	lastTry := job.Attempt >= job.MaxAttempts
	out := outboundMessage{ID: m.ID, TicketID: m.TicketID, BodyText: m.BodyText, BodyHTML: m.BodyHTML,
		Attachments: m.Attachments, DeliveryMeta: m.DeliveryMeta}
	// A template may go out at any time; a free-form reply only inside the window.
	if tmpl := whatsappTemplateFromMeta(m.DeliveryMeta); tmpl != nil {
		return s.sendTemplateMessage(ctx, c, out, th.WaID, tmpl, lastTry)
	}
	// The window is checked again here: the send can run seconds after the reply was written,
	// and the window may have closed in between.
	if !th.Open(time.Now()) {
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID,
			"The 24-hour WhatsApp reply window has closed. Send a template, or wait for the customer to message again.")
	}
	waID := th.WaID
	if out.Attachments > 0 {
		err := s.sendMediaMessage(ctx, c, out, waID)
		if err != nil && lastTry {
			return s.failMessage(ctx, c.WorkspaceID, out.ID, whatsappSendError(err))
		}
		return err
	}
	body := m.BodyText
	if body == "" {
		body = hd.HTMLToText(m.BodyHTML)
	}
	if len([]rune(body)) > maxTextRunes {
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID, "This message is longer than WhatsApp's limit of 4096 characters.")
	}
	acc, _, err := s.account(c)
	if err != nil {
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID, "This WhatsApp connection's credentials could not be read.")
	}
	wamid, err := s.client().SendText(ctx, acc, waID, body)
	if err != nil {
		reason := whatsappSendError(err)
		if metaRetryable(err) && !lastTry {
			// Meta refused it before accepting: safe to let River try again.
			return err
		}
		return s.failMessage(ctx, job.Args.WorkspaceID, m.ID, reason)
	}
	meta := map[string]any{"provider_status": "sent", "provider_sent_at": time.Now().UTC().Format(time.RFC3339)}
	raw, _ := json.Marshal(meta)
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE messages SET delivery_status = 'sent', provider_message_id = $3,
				delivery_error = '', delivery_meta = delivery_meta || $4::jsonb
			WHERE workspace_id = $1 AND id = $2`, c.WorkspaceID, m.ID, wamid, raw); err != nil {
			return err
		}
		return domain.PublishMessageUpdated(ctx, tx, c.WorkspaceID, m.ID)
	})
}

// failMessage records why a reply could not be sent and tells the team through the message's
// event. It never retries: a send may have reached Meta before the error surfaced.
func (s *Service) failMessage(ctx context.Context, wid, msgID uuid.UUID, reason string) error {
	reason = truncate(reason, 500)
	meta := map[string]any{"provider_status": "failed", "provider_failed_at": time.Now().UTC().Format(time.RFC3339)}
	if reason != "" {
		meta["provider_error"] = reason
	}
	raw, _ := json.Marshal(meta)
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE messages SET delivery_status = 'failed', delivery_error = $3,
				delivery_meta = delivery_meta || $4::jsonb
			WHERE workspace_id = $1 AND id = $2`, wid, msgID, reason, raw); err != nil {
			return err
		}
		return domain.PublishMessageUpdated(ctx, tx, wid, msgID)
	})
}

// whatsappSendError is the safe text of a failed send: Meta's own reason when it gave one.
func whatsappSendError(err error) string {
	var me *MetaAPIError
	if errors.As(err, &me) {
		if me.UserMsg != "" {
			return me.UserMsg
		}
		if me.Message != "" {
			return me.Message
		}
	}
	return "WhatsApp could not deliver this message."
}

// outboundMessage is what a send helper needs from the message row it delivers: the words,
// the attachments count and the template an agent picked, if any.
type outboundMessage struct {
	ID           uuid.UUID
	TicketID     uuid.UUID
	BodyText     string
	BodyHTML     string
	Attachments  int64
	DeliveryMeta []byte
}
