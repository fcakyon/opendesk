package whatsapp

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The types in this file are Meta's WhatsApp Cloud API webhook payload
// (https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks). Every delivery is an
// envelope of entries, one per WhatsApp Business account; each entry carries the changes of
// one field, "messages" for customer messages and delivery receipts, and one of Meta's
// template fields for a template's review result. A connection's callback may receive
// several messages in one delivery, so the parser below flattens them for the engine.

// WebhookPayload is one delivery Meta posts to a connection's callback URL.
type WebhookPayload struct {
	Object string         `json:"object"`
	Entry  []WebhookEntry `json:"entry"`
}

// WebhookEntry is one account's changes in a delivery.
type WebhookEntry struct {
	ID      string          `json:"id"`
	Time    json.Number     `json:"time,omitempty"`
	Changes []WebhookChange `json:"changes"`
}

// WebhookChange is one field's change: "messages" for messages and statuses, otherwise one
// of Meta's message template fields.
type WebhookChange struct {
	Field string       `json:"field"`
	Value WebhookValue `json:"value"`
}

// WebhookValue is a change's value. The message fields are set for field "messages"; an
// embedded TemplateStatus is set for a template'review result.
type WebhookValue struct {
	MessagingProduct string           `json:"messaging_product"`
	Metadata         WebhookMetadata  `json:"metadata"`
	Contacts         []WebhookContact `json:"contacts"`
	Messages         []WebhookMessage `json:"messages"`
	Statuses         []WebhookStatus  `json:"statuses"`
	Errors           []WebhookError   `json:"errors"`
	TemplateStatus
}

// TemplateStatus is a message template's review result (field
// "message_template_status_update"). MessageTemplateID stays a json.Number: Meta sends it
// as a JSON number above int32.
type TemplateStatus struct {
	Event                   string      `json:"event,omitempty"`
	MessageTemplateID       json.Number `json:"message_template_id,omitempty"`
	MessageTemplateName     string      `json:"message_template_name,omitempty"`
	MessageTemplateLanguage string      `json:"message_template_language,omitempty"`
	Reason                  string      `json:"reason,omitempty"`
}

// WebhookMetadata names the number a delivery is for: its display form and the id that
// selects the connection on this side.
type WebhookMetadata struct {
	DisplayPhoneNumber string `json:"display_phone_number"`
	PhoneNumberID      string `json:"phone_number_id"`
}

// WebhookContact is the WhatsApp profile of one sender in a delivery's contacts list.
type WebhookContact struct {
	WaID    string         `json:"wa_id"`
	Profile WebhookProfile `json:"profile"`
}

// WebhookProfile is a sender's WhatsApp profile name.
type WebhookProfile struct {
	Name string `json:"name"`
}

// WebhookMessage is one customer message. Exactly one of the typed pointers is set, chosen
// by Type; a type this build does not map keeps Type alone and the engine decides to ignore
// it.
type WebhookMessage struct {
	From        string                 `json:"from"`
	ID          string                 `json:"id"`
	Timestamp   string                 `json:"timestamp"`
	Type        string                 `json:"type"`
	Context     *WebhookContext        `json:"context,omitempty"`
	Text        *WebhookText           `json:"text,omitempty"`
	Image       *WebhookMedia          `json:"image,omitempty"`
	Video       *WebhookMedia          `json:"video,omitempty"`
	Audio       *WebhookMedia          `json:"audio,omitempty"`
	Voice       *WebhookMedia          `json:"voice,omitempty"`
	Document    *WebhookMedia          `json:"document,omitempty"`
	Sticker     *WebhookMedia          `json:"sticker,omitempty"`
	Interactive *WebhookInteractive    `json:"interactive,omitempty"`
	Button      *WebhookButton         `json:"button,omitempty"`
	Location    *WebhookLocation       `json:"location,omitempty"`
	Contacts    []WebhookSharedContact `json:"contacts,omitempty"`
	System      *WebhookSystem         `json:"system,omitempty"`
	Reaction    *WebhookReaction       `json:"reaction,omitempty"`
}

// WebhookText is the body of a text message, or a quick reply button's text.
type WebhookText struct {
	Body string `json:"body"`
}

// WebhookMedia is an attachment: one shape for image, video, audio, voice, document and
// sticker messages. Caption and Filename are empty where Meta does not send them.
type WebhookMedia struct {
	ID       string `json:"id"`
	MimeType string `json:"mime_type"`
	SHA256   string `json:"sha256"`
	Caption  string `json:"caption"`
	Filename string `json:"filename"`
	Link     string `json:"link"`
	Voice    bool   `json:"voice"`
	Animated bool   `json:"animated"`
}

// WebhookInteractive is an answer to a button or list message the business sent.
type WebhookInteractive struct {
	Type        string        `json:"type"`
	ButtonReply *WebhookReply `json:"button_reply,omitempty"`
	ListReply   *WebhookReply `json:"list_reply,omitempty"`
}

// WebhookReply is the chosen option of an interactive message.
type WebhookReply struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// WebhookButton is a customer tapping a template's quick reply button.
type WebhookButton struct {
	Text    string `json:"text"`
	Payload string `json:"payload"`
}

// WebhookLocation is a shared location. Coordinates keep Meta's literal numbers so the map
// link is exact.
type WebhookLocation struct {
	Latitude  json.Number `json:"latitude"`
	Longitude json.Number `json:"longitude"`
	Name      string      `json:"name"`
	Address   string      `json:"address"`
}

// WebhookSharedContact is a contact card a customer sent.
type WebhookSharedContact struct {
	Name   WebhookContactName    `json:"name"`
	Phones []WebhookContactPhone `json:"phones,omitempty"`
}

// WebhookContactName is a shared contact's name, as the customer's phone book has it.
type WebhookContactName struct {
	FormattedName string `json:"formatted_name"`
	FirstName     string `json:"first_name"`
	MiddleName    string `json:"middle_name"`
	LastName      string `json:"last_name"`
	Prefix        string `json:"prefix"`
	Suffix        string `json:"suffix"`
}

// WebhookContactPhone is one phone number of a shared contact.
type WebhookContactPhone struct {
	Phone string `json:"phone"`
	WaID  string `json:"wa_id"`
	Type  string `json:"type"`
}

// WebhookSystem is a message Meta sends about the customer's account, such as a number
// change. NewWaID is the number after a user_changed_number.
type WebhookSystem struct {
	Type    string `json:"type"`
	Body    string `json:"body"`
	WaID    string `json:"wa_id"`
	NewWaID string `json:"new_wa_id"`
}

// WebhookContext is the message a customer answered.
type WebhookContext struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	Forwarded bool   `json:"forwarded"`
}

// WebhookReaction is a customer's emoji reaction to a message.
type WebhookReaction struct {
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
}

// WebhookStatus is one delivery or read receipt of a message this instance sent.
type WebhookStatus struct {
	ID           string               `json:"id"`
	Status       string               `json:"status"`
	Timestamp    string               `json:"timestamp"`
	RecipientID  string               `json:"recipient_id"`
	Errors       []WebhookError       `json:"errors,omitempty"`
	Conversation *WebhookConversation `json:"conversation,omitempty"`
	Pricing      *WebhookPricing      `json:"pricing,omitempty"`
}

// WebhookConversation is the billing conversation a message belongs to.
type WebhookConversation struct {
	ID                  string `json:"id"`
	ExpirationTimestamp string `json:"expiration_timestamp"`
	Origin              struct {
		Type string `json:"type"`
	} `json:"origin"`
}

// WebhookPricing is what Meta charged for a message.
type WebhookPricing struct {
	Billable     bool   `json:"billable"`
	PricingModel string `json:"pricing_model"`
	Category     string `json:"category"`
}

// WebhookError is why a delivery failed: a status's error, or an error entry of a delivery.
// ErrorData carries Meta's own details.
type WebhookError struct {
	Code           int              `json:"code"`
	Title          string           `json:"title"`
	Message        string           `json:"message"`
	ErrorUserTitle string           `json:"error_user_title"`
	ErrorUserMsg   string           `json:"error_user_msg"`
	ErrorData      WebhookErrorData `json:"error_data"`
}

// WebhookErrorData is Meta's extra detail about a failed delivery.
type WebhookErrorData struct {
	Details string `json:"details"`
}

// ParsedMessage is one inbound customer message, flattened out of the webhook envelope and
// ready for the engine. Type keeps Meta's own name, so a type this build does not map can be
// ignored by the caller.
type ParsedMessage struct {
	From          string
	ID            string
	Timestamp     time.Time
	Type          string
	Text          string
	ContactName   string
	PhoneNumberID string
	MediaID       string
	MediaMimeType string
	Caption       string
	Filename      string
	SystemType    string
	SystemNewWAID string
	ContextID     string
}

// ParsedStatus is one delivery receipt of a message this instance sent.
type ParsedStatus struct {
	MessageID string
	Status    string
	Timestamp time.Time
	ErrorCode int
	UserMsg   string
}

// ParsePayload decodes one webhook body. A decoder with UseNumber keeps ids and timestamps
// that Meta sends as numbers from losing precision; timestamps themselves arrive as strings
// of Unix seconds.
func ParsePayload(body []byte) (*WebhookPayload, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var payload WebhookPayload
	if err := dec.Decode(&payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// ExtractMessages flattens every customer message of a delivery, in Meta's order. The
// contacts list of a change names its senders; a change with a single contact uses that name
// for its messages as well.
func (p *WebhookPayload) ExtractMessages() []ParsedMessage {
	if p == nil {
		return nil
	}
	var out []ParsedMessage
	for _, entry := range p.Entry {
		for _, change := range entry.Changes {
			if change.Field != "messages" {
				continue
			}
			value := change.Value
			names, only := contactNames(value.Contacts)
			for _, message := range value.Messages {
				parsed := ParsedMessage{
					From:          message.From,
					ID:            message.ID,
					Timestamp:     parseWebhookTimestamp(message.Timestamp),
					Type:          message.Type,
					ContactName:   names[message.From],
					PhoneNumberID: value.Metadata.PhoneNumberID,
				}
				if parsed.ContactName == "" {
					parsed.ContactName = only
				}
				if message.Context != nil {
					parsed.ContextID = message.Context.ID
				}
				switch message.Type {
				case "text":
					if message.Text != nil {
						parsed.Text = message.Text.Body
					}
				case "image":
					applyMedia(&parsed, message.Image)
				case "video":
					applyMedia(&parsed, message.Video)
				case "document":
					applyMedia(&parsed, message.Document)
				case "sticker":
					applyMedia(&parsed, message.Sticker)
				case "audio":
					applyAudio(&parsed, message.Audio)
				case "voice":
					applyAudio(&parsed, message.Voice)
				case "interactive":
					if message.Interactive != nil {
						switch {
						case message.Interactive.ButtonReply != nil:
							parsed.Text = message.Interactive.ButtonReply.Title
						case message.Interactive.ListReply != nil:
							parsed.Text = message.Interactive.ListReply.Title
						}
					}
				case "button":
					if message.Button != nil {
						parsed.Text = message.Button.Text
					}
				case "location":
					if message.Location != nil {
						parsed.Text = locationText(message.Location)
					}
				case "contacts":
					parsed.Text = sharedContactsText(message.Contacts)
				case "system":
					if message.System != nil {
						parsed.SystemType = message.System.Type
						parsed.SystemNewWAID = message.System.NewWaID
						parsed.Text = message.System.Body
						if parsed.Text == "" && message.System.Type == "user_changed_number" {
							parsed.Text = message.System.NewWaID
						}
					}
				}
				out = append(out, parsed)
			}
		}
	}
	return out
}

// ExtractStatuses flattens every delivery or read receipt of a delivery. A failed status's
// error becomes ErrorCode and UserMsg: Meta's user-facing text, else its own details.
func (p *WebhookPayload) ExtractStatuses() []ParsedStatus {
	if p == nil {
		return nil
	}
	var out []ParsedStatus
	for _, entry := range p.Entry {
		for _, change := range entry.Changes {
			if change.Field != "messages" {
				continue
			}
			for _, status := range change.Value.Statuses {
				parsed := ParsedStatus{
					MessageID: status.ID,
					Status:    status.Status,
					Timestamp: parseWebhookTimestamp(status.Timestamp),
				}
				if len(status.Errors) > 0 {
					err := status.Errors[0]
					parsed.ErrorCode = err.Code
					parsed.UserMsg = err.ErrorUserMsg
					if parsed.UserMsg == "" {
						parsed.UserMsg = err.ErrorData.Details
					}
					if parsed.UserMsg == "" {
						parsed.UserMsg = err.Message
					}
				}
				out = append(out, parsed)
			}
		}
	}
	return out
}

// VerifySignature checks the X-Hub-Signature-256 header Meta signs a delivery with: the HMAC
// of the raw body under the app secret, as "sha256=<hex>". An empty secret or header never
// verifies.
func VerifySignature(body []byte, signatureHeader, appSecret string) bool {
	if appSecret == "" || signatureHeader == "" {
		return false
	}
	const prefix = "sha256="
	if !strings.HasPrefix(signatureHeader, prefix) {
		return false
	}
	got, err := hex.DecodeString(signatureHeader[len(prefix):])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}

// contactNames maps a change's contacts by wa_id, and returns the one name a single-contact
// change may fall back to for a sender the map does not cover.
func contactNames(contacts []WebhookContact) (map[string]string, string) {
	names := make(map[string]string, len(contacts))
	var only string
	for _, contact := range contacts {
		name := strings.TrimSpace(contact.Profile.Name)
		if name != "" {
			names[contact.WaID] = name
			only = name
		}
	}
	if len(contacts) != 1 {
		return names, ""
	}
	return names, only
}

// applyMedia copies an attachment's id, MIME type, caption and filename to a message.
func applyMedia(parsed *ParsedMessage, media *WebhookMedia) {
	if media == nil {
		return
	}
	parsed.MediaID = media.ID
	parsed.MediaMimeType = media.MimeType
	parsed.Caption = media.Caption
	parsed.Filename = media.Filename
}

// applyAudio copies an audio or voice attachment's id and MIME type: Meta sends neither a
// caption nor a filename for them.
func applyAudio(parsed *ParsedMessage, media *WebhookMedia) {
	if media == nil {
		return
	}
	parsed.MediaID = media.ID
	parsed.MediaMimeType = media.MimeType
}

// locationText renders a shared location as the name and address, then a Google Maps link.
func locationText(location *WebhookLocation) string {
	var label []string
	if name := strings.TrimSpace(location.Name); name != "" {
		label = append(label, name)
	}
	if address := strings.TrimSpace(location.Address); address != "" {
		label = append(label, address)
	}
	text := strings.Join(label, "/")
	lat, lng := strings.TrimSpace(location.Latitude.String()), strings.TrimSpace(location.Longitude.String())
	if lat == "" || lng == "" {
		return text
	}
	link := fmt.Sprintf("https://www.google.com/maps?q=%s,%s", lat, lng)
	if text == "" {
		return link
	}
	return text + " " + link
}

// sharedContactsText renders contact cards as one "name phone" line each, in sent order.
func sharedContactsText(contacts []WebhookSharedContact) string {
	var lines []string
	for _, contact := range contacts {
		var fields []string
		if name := sharedContactName(contact.Name); name != "" {
			fields = append(fields, name)
		}
		if phone := sharedContactPhone(contact.Phones); phone != "" {
			fields = append(fields, phone)
		}
		if len(fields) > 0 {
			lines = append(lines, strings.Join(fields, " "))
		}
	}
	return strings.Join(lines, "\n")
}

// sharedContactName is a card's formatted name, else the parts of a name it has.
func sharedContactName(name WebhookContactName) string {
	if formatted := strings.TrimSpace(name.FormattedName); formatted != "" {
		return formatted
	}
	var parts []string
	for _, part := range []string{name.Prefix, name.FirstName, name.MiddleName, name.LastName, name.Suffix} {
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " ")
}

// sharedContactPhone is a card's first phone number, or its WhatsApp id when it has none.
func sharedContactPhone(phones []WebhookContactPhone) string {
	if len(phones) == 0 {
		return ""
	}
	if phone := strings.TrimSpace(phones[0].Phone); phone != "" {
		return phone
	}
	return strings.TrimSpace(phones[0].WaID)
}

// ExtractTemplateStatuses flattens Meta's template review results (field
// "message_template_status_update"): one template's approval state changed on Meta's side,
// so the stored copy can follow without waiting for the next sync.
func (p *WebhookPayload) ExtractTemplateStatuses() []TemplateStatus {
	if p == nil {
		return nil
	}
	var out []TemplateStatus
	for _, entry := range p.Entry {
		for _, change := range entry.Changes {
			if change.Field != "message_template_status_update" {
				continue
			}
			st := change.Value.TemplateStatus
			if st.MessageTemplateName == "" || st.MessageTemplateLanguage == "" || st.Event == "" {
				continue
			}
			out = append(out, st)
		}
	}
	return out
}

// parseWebhookTimestamp reads Meta's timestamp, a string of Unix seconds. A fractional
// timestamp is read to the nanosecond; anything that is not a time is zero.
func parseWebhookTimestamp(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if seconds, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.Unix(seconds, 0).UTC()
	}
	if value, err := strconv.ParseFloat(raw, 64); err == nil && value > 0 {
		seconds := int64(value)
		return time.Unix(seconds, int64((value-float64(seconds))*float64(time.Second))).UTC()
	}
	return time.Time{}
}
