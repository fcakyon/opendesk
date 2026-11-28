package tickets

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// AddWhatsAppTemplateReply adds an outbound WhatsApp reply that sends an approved template:
// bodyText is the template rendered for the timeline, and templateMeta is the envelope stored
// in delivery_meta under "whatsapp_template" (the template's name, language, variables and
// buttons) that the send worker reads. The send is queued in the same transaction. A template
// may go out at any time, so unlike PostMessage there is no window check. headerFile is the
// agent's upload for a media header, attached to the reply so the timeline shows what went.
func AddWhatsAppTemplateReply(ctx context.Context, tx pgx.Tx, jc domain.Jobs, p *auth.Principal, tid uuid.UUID,
	bodyText string, templateMeta map[string]any, headerFile *uuid.UUID) (domain.Message, error) {
	wid := p.WorkspaceID
	var channel, subject string
	if err := tx.QueryRow(ctx, `SELECT channel, subject FROM tickets
		WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`, wid, tid).Scan(&channel, &subject); err != nil {
		return domain.Message{}, err
	}
	if channel != domain.ChannelWhatsApp {
		return domain.Message{}, httpx.E(422, "not_whatsapp_ticket", "This ticket is not a WhatsApp conversation.")
	}
	bodyText = strings.TrimSpace(bodyText)
	if bodyText == "" {
		return domain.Message{}, httpx.Validation("the message is empty")
	}
	actor := actorOf(p)
	authorType := actor.Type
	if authorType == "ai" {
		authorType = "user" // the assistant writes on the user's behalf, after their approval
	}
	var attIDs []uuid.UUID
	if headerFile != nil {
		attIDs = []uuid.UUID{*headerFile}
	}
	msg, err := domain.AddMessage(ctx, tx, jc, domain.NewMessage{
		WorkspaceID: wid, TicketID: tid, Kind: "reply", Direction: "outbound",
		AuthorType: authorType, AuthorUserID: actor.UserID,
		BodyHTML: hd.TextToHTML(bodyText), BodyText: bodyText,
		Subject: replySubject(subject), DeliveryStatus: "pending", AttachmentIDs: attIDs,
	})
	if err != nil {
		return domain.Message{}, err
	}
	if templateMeta == nil {
		templateMeta = map[string]any{}
	}
	raw, err := json.Marshal(templateMeta)
	if err != nil {
		return domain.Message{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE messages SET delivery_meta = delivery_meta || $3::jsonb
		WHERE workspace_id = $1 AND id = $2`, wid, msg.ID, raw); err != nil {
		return domain.Message{}, err
	}
	if _, err := jc.InsertTx(ctx, tx, jobs.WhatsAppSendArgs{WorkspaceID: wid, MessageID: msg.ID},
		&river.InsertOpts{MaxAttempts: jobs.WhatsAppSendAttempts}); err != nil {
		return domain.Message{}, err
	}
	// Reloaded so the caller sees the delivery_meta that was just written.
	return domain.LoadMessage(ctx, tx, wid, msg.ID)
}
