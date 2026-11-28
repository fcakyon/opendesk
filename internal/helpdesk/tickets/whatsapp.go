package tickets

import (
	"context"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/whatsapp/thread"
)

// Meta's caps on a free-form reply: 4096 characters of text, or 1024 of caption when the
// reply carries one file.
const (
	whatsAppMaxTextRunes    = 4096
	whatsAppMaxCaptionRunes = 1024
)

// checkWhatsAppReply refuses a free-form WhatsApp reply Meta would refuse: the ticket needs
// its conversation, a connection for the number it is on, and the customer's 24-hour window
// open. A template goes out any time (AddWhatsAppTemplateReply).
func checkWhatsAppReply(ctx context.Context, tx pgx.Tx, wid, ticketID uuid.UUID) error {
	th, err := thread.ForTicket(ctx, tx, wid, ticketID)
	if db.IsNotFound(err) {
		return httpx.E(http.StatusConflict, "whatsapp_no_conversation", "This ticket has no WhatsApp conversation to reply on.")
	}
	if err != nil {
		return err
	}
	if th.ConnectionID == nil {
		return httpx.E(http.StatusConflict, "whatsapp_disconnected",
			"This ticket's WhatsApp number is not connected. Connect it again in Settings > WhatsApp to reply.")
	}
	if !th.Open(time.Now()) {
		return httpx.E(http.StatusUnprocessableEntity, "whatsapp_window_closed",
			"The 24-hour WhatsApp reply window has closed. Send a template, or wait for the customer to message again.")
	}
	return nil
}

// validateWhatsAppReply holds a free-form WhatsApp reply to Meta's limits: one file per
// message, and a caption of at most 1024 characters when the reply carries it. Text alone
// may be 4096. The 24-hour window is checked before this.
func validateWhatsAppReply(attIDs []uuid.UUID, bodyText string) error {
	switch {
	case len(attIDs) > 1:
		return httpx.Validation("WhatsApp takes one file per message. Send the files one at a time.")
	case len(attIDs) == 1 && utf8.RuneCountInString(bodyText) > whatsAppMaxCaptionRunes:
		return httpx.Validation("A WhatsApp caption can be at most 1024 characters.")
	case len(attIDs) == 0 && utf8.RuneCountInString(bodyText) > whatsAppMaxTextRunes:
		return httpx.Validation("The message is longer than WhatsApp's limit of 4096 characters.")
	}
	return nil
}
