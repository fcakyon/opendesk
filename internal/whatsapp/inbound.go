package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/routing"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/products"
	"github.com/useopendesk/opendesk/internal/whatsapp/thread"
)

// inboundWorker applies one verified Meta delivery: the messages in it become ticket
// messages, the statuses in it update what we sent.
type inboundWorker struct {
	river.WorkerDefaults[jobs.WhatsAppInboundArgs]
	s *Service
}

func (w *inboundWorker) Work(ctx context.Context, job *river.Job[jobs.WhatsAppInboundArgs]) error {
	s := w.s
	connID, payload, err := loadInboundEvent(ctx, s.d.DB.Pool, job.Args.WorkspaceID, job.Args.EventID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The prune job removed it between queueing and running.
		return nil
	}
	if err != nil {
		return err
	}
	c, err := loadConnection(ctx, s.d.DB.Pool, job.Args.WorkspaceID, connID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// A suspended workspace's deliveries are acknowledged and dropped, as the phone engine
	// does: nothing changes tickets and nothing is sent while the workspace is suspended.
	if suspended, err := domain.WorkspaceSuspended(ctx, s.d.DB.Pool, c.WorkspaceID); err != nil {
		return err
	} else if suspended {
		s.d.Log.Info("whatsapp delivery dropped: workspace suspended", "connection_id", c.ID)
		return nil
	}
	// While Tickets is off the delivery stays stored and unapplied; the job snoozes until it
	// is on again (products.Reactivate wakes it), as the phone engine's events do.
	if err := products.Hold(ctx, s.d.DB.Pool, c.WorkspaceID); err != nil {
		return products.SnoozeHeld(err)
	}
	payloadData, err := ParsePayload(payload)
	if err != nil {
		// Verified but not understood: acknowledged so Meta keeps the webhook on.
		s.d.Log.Warn("whatsapp delivery not understood", "connection_id", c.ID, "err", err)
		return nil
	}
	var errs []error
	for _, m := range payloadData.ExtractMessages() {
		if err := w.ingest(ctx, c, m); err != nil {
			s.d.Log.Error("whatsapp message not applied", "connection_id", c.ID, "wa_message_id", m.ID, "err", err)
			errs = append(errs, err)
		}
	}
	for _, st := range payloadData.ExtractStatuses() {
		if err := w.applyStatus(ctx, c, st); err != nil {
			s.d.Log.Error("whatsapp status not applied", "connection_id", c.ID, "wa_message_id", st.MessageID, "err", err)
			errs = append(errs, err)
		}
	}
	for _, ts := range payloadData.ExtractTemplateStatuses() {
		if err := w.s.applyTemplateStatus(ctx, c, ts); err != nil {
			s.d.Log.Error("whatsapp template status not applied", "connection_id", c.ID, "template", ts.MessageTemplateName, "err", err)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// ingest applies one inbound WhatsApp message: the contact, the 24-hour window, the ticket
// (reusing an open one), and the message itself. All of it is one transaction with the
// ticket's and message's events.
func (w *inboundWorker) ingest(ctx context.Context, c connection, m ParsedMessage) error {
	s := w.s
	if m.ID == "" || m.From == "" {
		return nil
	}
	// Kinds that carry nothing to answer, or that would open a ticket on their own.
	switch m.Type {
	case "reaction", "ephemeral", "request_welcome", "system":
		return nil
	}
	// Meta posts every number of an app to one callback; the payload's number decides the
	// connection. A mismatch means the URL named another number of the same app.
	if m.PhoneNumberID != "" && m.PhoneNumberID != c.PhoneNumberID {
		other, err := loadConnectionByPhoneNumber(ctx, s.d.DB.Pool, c.WorkspaceID, m.PhoneNumberID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		c = other
	}
	at := m.Timestamp
	if at.IsZero() {
		at = time.Now().UTC()
	}
	text := strings.TrimSpace(m.Text)
	if text == "" {
		text = strings.TrimSpace(m.Caption)
	}
	if text == "" {
		text = placeholderFor(m.Type)
	}
	text = truncate(text, 10000)
	// Meta's retry of a message already applied: the window was advanced with it.
	var exists bool
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE workspace_id = $1 AND provider_message_id = $2)`,
		c.WorkspaceID, m.ID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	subject := truncate(text, 80)
	if subject == "" {
		subject = "WhatsApp message"
	}
	// Media is fetched before the transaction: the download is slow and may fail, and only
	// its stored copy joins the ticket. A file that will never be usable leaves the
	// placeholder text in place; a refusal that may pass is returned for River to retry.
	var media *inboundAttachment
	if m.MediaID != "" {
		var err error
		if media, err = s.prepareInboundMedia(ctx, c, m); err != nil {
			return err
		}
	}
	// A file that came through needs no "[image]" placeholder under it; the attachment is
	// the message. A caption stays as the text.
	bodyText := text
	if media != nil && strings.TrimSpace(m.Text) == "" && strings.TrimSpace(m.Caption) == "" {
		bodyText = ""
	}
	linked := false
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		pc, err := domain.ContactByPhone(ctx, tx, c.WorkspaceID, m.From, m.ContactName)
		if err != nil {
			return err
		}
		if pc.Blocked {
			return nil
		}
		if err := thread.Touch(ctx, tx, c.WorkspaceID, c.PhoneNumberID, m.From, pc.ID, m.ContactName, at); err != nil {
			return err
		}
		ticketID, err := thread.OpenTicket(ctx, tx, c.WorkspaceID, c.PhoneNumberID, m.From)
		newTicket := false
		if errors.Is(err, pgx.ErrNoRows) {
			newTicket = true
			ticketID, err = createTicketFor(ctx, s, tx, c, pc.ID, m.From, subject, text)
		}
		if err != nil {
			return err
		}
		// The attachment row is inserted unattached: AddMessage links the uploads of the
		// message it inserts, and an inbound file has no uploader to match.
		var attIDs []uuid.UUID
		if media != nil {
			if _, err := tx.Exec(ctx, `INSERT INTO attachments (id, workspace_id, filename, content_type, size_bytes, storage_key, inline)
				VALUES ($1,$2,$3,$4,$5,$6,false)`,
				media.ID, c.WorkspaceID, media.Filename, media.ContentType, media.SizeBytes, media.StorageKey); err != nil {
				return err
			}
			attIDs = []uuid.UUID{media.ID}
		}
		msg, err := domain.AddMessage(ctx, tx, s.d.Jobs, domain.NewMessage{
			WorkspaceID:     c.WorkspaceID,
			TicketID:        ticketID,
			Kind:            "reply",
			Direction:       "inbound",
			AuthorType:      "contact",
			AuthorContactID: &pc.ID,
			BodyHTML:        hd.TextToHTML(bodyText),
			BodyText:        bodyText,
			DeliveryStatus:  "none",
			AttachmentIDs:   attIDs,
			// A ticket this message opened runs the new-ticket work (auto-triage, SLA
			// policies, notifications) with the message as its body, like the widget's
			// first message. A message on an open ticket is a customer reply.
			Trigger:   ticketTrigger(newTicket),
			CreatedAt: at,
		})
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE messages SET provider_message_id = $3 WHERE workspace_id = $1 AND id = $2`,
			c.WorkspaceID, msg.ID, m.ID)
		if err != nil {
			return err
		}
		linked = true
		return nil
	})
	if media != nil && (err != nil || !linked) {
		// The transaction left no message for the file: nothing references the object.
		_ = s.d.Storage.Delete(context.WithoutCancel(ctx), media.StorageKey)
	}
	return err
}

// createTicketFor opens a WhatsApp ticket for the contact, routing it like any other ticket,
// and records the conversation it carries.
func createTicketFor(ctx context.Context, s *Service, tx pgx.Tx, c connection, contactID uuid.UUID, waID, subject, body string) (uuid.UUID, error) {
	res, err := routing.Resolve(ctx, tx, routing.Input{WorkspaceID: c.WorkspaceID, Channel: domain.ChannelWhatsApp,
		BrandID: c.BrandID, ContactID: &contactID, Subject: subject, Body: body})
	if err != nil {
		// Routing is best effort: a ticket with no team is better than a dropped message.
		s.d.Log.Warn("whatsapp ticket routing failed", "connection_id", c.ID, "err", err)
		res = routing.Result{}
	}
	brandID := c.BrandID
	t, err := domain.CreateTicket(ctx, tx, domain.NewTicket{WorkspaceID: c.WorkspaceID, Subject: subject,
		Channel: domain.ChannelWhatsApp, ContactID: &contactID, BrandID: &brandID, TeamID: res.TeamID,
		Routed: res.Routed, RequiredSkillIDs: res.RequiredSkillIDs})
	if err != nil {
		return uuid.Nil, err
	}
	if err := thread.Link(ctx, tx, c.WorkspaceID, t.ID, c.PhoneNumberID, waID); err != nil {
		return uuid.Nil, err
	}
	if rule := res.RuleID(); rule != nil {
		if err := routing.Count(ctx, tx, *rule); err != nil {
			return uuid.Nil, err
		}
	}
	return t.ID, nil
}

// ticketTrigger is what a message's ticket trigger is: the first message of a ticket this
// delivery opened runs the new-ticket work (auto-triage, SLA policies, notifications) with
// the message as its body; a message on an open ticket keeps its own derived trigger.
func ticketTrigger(newTicket bool) string {
	if newTicket {
		return jobs.TriggerTicketCreated
	}
	return ""
}

// applyStatus applies Meta's delivery report to the message it is about.
func (w *inboundWorker) applyStatus(ctx context.Context, c connection, st ParsedStatus) error {
	s := w.s
	if st.MessageID == "" || st.Status == "" {
		return nil
	}
	at := st.Timestamp
	if at.IsZero() {
		at = time.Now().UTC()
	}
	patch := map[string]any{"provider_status": st.Status, "provider_status_updated_at": at.Format(time.RFC3339)}
	if st.ErrorCode != 0 {
		patch["provider_error_code"] = st.ErrorCode
	}
	if st.UserMsg != "" {
		patch["provider_error"] = st.UserMsg
	}
	raw, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	rank := statusRank(st.Status)
	if rank == 0 {
		// A status this channel does not show (Meta adds kinds over time).
		return nil
	}
	status, detail := "sent", ""
	if st.Status == "failed" {
		status, detail = "failed", truncate(st.UserMsg, 500)
	}
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		// Meta's reports may arrive out of order: a status only moves forward, so a late
		// "delivered" never replaces "read".
		var msgID uuid.UUID
		err := tx.QueryRow(ctx, `UPDATE messages SET
				delivery_status = $3,
				delivery_error = CASE WHEN $3 = 'failed' THEN $4 ELSE messages.delivery_error END,
				delivery_meta = messages.delivery_meta || $5::jsonb
			WHERE workspace_id = $1 AND provider_message_id = $2 AND direction = 'outbound'
				AND delivery_status <> 'failed'
				AND (CASE messages.delivery_meta->>'provider_status'
					WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END) < $6
			RETURNING id`, c.WorkspaceID, st.MessageID, status, detail, raw, rank).Scan(&msgID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		return domain.PublishMessageUpdated(ctx, tx, c.WorkspaceID, msgID)
	})
}

// statusRank orders Meta's delivery statuses: sent, then delivered, then read. Failed ranks
// with read, so it replaces sent or delivered but never a message the customer read. 0 is a
// status this channel does not apply.
func statusRank(status string) int {
	switch status {
	case "sent":
		return 1
	case "delivered":
		return 2
	case "read", "failed":
		return 3
	}
	return 0
}

// placeholderFor names a message kind whose payload carries no text the agent can read.
func placeholderFor(kind string) string {
	switch kind {
	case "image":
		return "[image]"
	case "video":
		return "[video]"
	case "audio", "voice":
		return "[audio]"
	case "document":
		return "[document]"
	case "sticker":
		return "[sticker]"
	case "location":
		return "[location]"
	default:
		return "[" + kind + "]"
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
