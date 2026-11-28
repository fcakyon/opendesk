package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Meta's media limits on the Cloud API, by the message shape that carries the file. This
// instance stores at most hd.MaxAttachmentBytes per file, so an image, video, audio or
// document travels only when it is under both caps.
const (
	metaImageBytes    = 5 << 20
	metaVideoBytes    = 16 << 20
	metaAudioBytes    = 16 << 20
	metaDocumentBytes = 100 << 20
	// maxCaptionRunes is Meta's cap on the caption of a media message.
	maxCaptionRunes = 1024
	// mediaSniffBytes is how much of a download its type is told from, as hd's uploads.
	mediaSniffBytes = 4096
)

// metaMediaLimit is Meta's own size cap for one media kind.
func metaMediaLimit(kind string) int64 {
	switch kind {
	case "image":
		return metaImageBytes
	case "video":
		return metaVideoBytes
	case "audio":
		return metaAudioBytes
	case "document":
		return metaDocumentBytes
	default:
		return 0
	}
}

// mediaSizeLimit is how large a file of a kind may be here: Meta's cap and
// hd.MaxAttachmentBytes, whichever is smaller.
func mediaSizeLimit(kind string) int64 {
	if limit := metaMediaLimit(kind); limit > 0 && limit < hd.MaxAttachmentBytes {
		return limit
	}
	return hd.MaxAttachmentBytes
}

// inboundMediaKind maps a webhook message type to the media shape it is stored as. A
// sticker is an image here: Meta serves it as WebP.
func inboundMediaKind(messageType string) (string, bool) {
	switch messageType {
	case "image", "sticker":
		return "image", true
	case "video":
		return "video", true
	case "audio", "voice":
		return "audio", true
	case "document":
		return "document", true
	}
	return "", false
}

// mediaExtensions is the usual extension of the types a customer or an agent sends. It is
// a fixed table so a stored name never depends on the host's mime database.
var mediaExtensions = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/gif":  ".gif",
	"image/webp": ".webp",

	"video/mp4":  ".mp4",
	"video/3gpp": ".3gp",

	"audio/aac":  ".aac",
	"audio/mp4":  ".m4a",
	"audio/mpeg": ".mp3",
	"audio/amr":  ".amr",
	"audio/ogg":  ".ogg",
	"audio/opus": ".opus",

	"application/pdf": ".pdf",
}

// mediaFilename is the name a file is stored under. A document keeps the name Meta sent,
// cleaned; every other kind is named from its type, image.jpg and the like.
func mediaFilename(kind, given, contentType string) string {
	if kind == "document" {
		if name := strings.TrimSpace(given); name != "" {
			return hd.CleanFilename(name)
		}
	}
	return kind + mediaExtension(contentType)
}

// mediaExtension is the usual extension of a content type, from the table above, else from
// the host's registry, else the kind's typical one.
func mediaExtension(contentType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if ext, ok := mediaExtensions[base]; ok {
		return ext
	}
	if exts, err := mime.ExtensionsByType(base); err == nil && len(exts) > 0 {
		return exts[0]
	}
	switch {
	case strings.HasPrefix(base, "image/"):
		return ".jpg"
	case strings.HasPrefix(base, "video/"):
		return ".mp4"
	case strings.HasPrefix(base, "audio/"):
		return ".m4a"
	default:
		return ".bin"
	}
}

// inboundAttachment is media downloaded from Meta, stored and ready to be inserted as an
// unattached attachment row in the message's transaction.
type inboundAttachment struct {
	ID          uuid.UUID
	Filename    string
	ContentType string
	SizeBytes   int64
	StorageKey  string
}

// prepareInboundMedia downloads one inbound message's media, sniffs it, refuses programs
// and stores it. A file that a retry cannot make usable (expired media id, too large, a
// kind Meta declares differently, an executable) is left out and the caller keeps the
// placeholder text; a failure that may pass (network, Meta 5xx) is returned so River
// retries the delivery.
func (s *Service) prepareInboundMedia(ctx context.Context, c connection, m ParsedMessage) (*inboundAttachment, error) {
	kind, ok := inboundMediaKind(m.Type)
	if !ok || strings.TrimSpace(m.MediaID) == "" {
		return nil, nil
	}
	acc, _, err := s.account(c)
	if err != nil {
		// A connection whose credentials cannot be read takes no file: the text still arrives.
		s.d.Log.Warn("whatsapp media not downloaded", "connection_id", c.ID, "reason", "credentials", "err", err)
		return nil, nil
	}
	client := s.client()
	info, err := client.GetMediaURL(ctx, acc, m.MediaID)
	if err != nil {
		if permanentMediaError(err) {
			s.d.Log.Warn("whatsapp media is gone", "connection_id", c.ID, "media_id", m.MediaID, "err", err)
			return nil, nil
		}
		return nil, err
	}
	limit := mediaSizeLimit(kind)
	if info.FileSize > limit {
		s.d.Log.Warn("whatsapp media refused: too large", "connection_id", c.ID, "media_id", m.MediaID,
			"kind", kind, "size", info.FileSize, "limit", limit)
		return nil, nil
	}
	declared := strings.TrimSpace(m.MediaMimeType)
	if declared == "" {
		declared = strings.TrimSpace(info.MimeType)
	}
	// An image, video or audio message must carry that kind of file; a document may carry
	// any file Meta accepted as one.
	if declared != "" && kind != "document" && mediaKind(declared) != kind {
		s.d.Log.Warn("whatsapp media refused: unexpected type", "connection_id", c.ID, "media_id", m.MediaID,
			"kind", kind, "content_type", declared)
		return nil, nil
	}
	raw, err := client.DownloadMedia(ctx, acc, info.URL, limit)
	if err != nil {
		if permanentMediaError(err) || mediaTooLarge(err) {
			s.d.Log.Warn("whatsapp media refused: too large", "connection_id", c.ID, "media_id", m.MediaID, "err", err)
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		s.d.Log.Warn("whatsapp media refused: empty", "connection_id", c.ID, "media_id", m.MediaID)
		return nil, nil
	}
	head := raw
	if len(head) > mediaSniffBytes {
		head = head[:mediaSniffBytes]
	}
	filename := mediaFilename(kind, m.Filename, declared)
	if hd.IsExecutable(head, filename) {
		s.d.Log.Warn("whatsapp media refused: executable", "connection_id", c.ID, "media_id", m.MediaID, "filename", filename)
		return nil, nil
	}
	contentType := hd.DetectType(head, filename)
	filename = mediaFilename(kind, m.Filename, contentType)
	id := ids.New()
	key := "workspaces/" + c.WorkspaceID.String() + "/attachments/" + id.String()
	if err := s.d.Storage.Put(ctx, key, bytes.NewReader(raw), int64(len(raw)), contentType); err != nil {
		return nil, fmt.Errorf("store whatsapp media: %w", err)
	}
	return &inboundAttachment{ID: id, Filename: filename, ContentType: contentType,
		SizeBytes: int64(len(raw)), StorageKey: key}, nil
}

// permanentMediaError reports a refusal a retry cannot fix: a 4xx from Meta other than a
// rate limit or a timeout. An expired media id is Meta's usual 400 or 404 here.
func permanentMediaError(err error) bool {
	var me *MetaAPIError
	if !errors.As(err, &me) {
		return false
	}
	return me.StatusCode >= 400 && me.StatusCode < 500 &&
		me.StatusCode != http.StatusTooManyRequests && me.StatusCode != http.StatusRequestTimeout
}

// mediaTooLarge reports the downloader's own refusal of a body over its limit: Meta said
// the file was small enough, the body was not.
func mediaTooLarge(err error) bool {
	return err != nil && strings.Contains(err.Error(), "media is larger than")
}

// metaRetryable reports a Meta refusal worth another try: it refused before accepting, so
// the same send may succeed later.
func metaRetryable(err error) bool {
	var me *MetaAPIError
	if !errors.As(err, &me) {
		return false
	}
	return me.StatusCode == http.StatusTooManyRequests || me.StatusCode >= 500
}

// sendMediaMessage delivers one outbound WhatsApp reply with its one attachment: the file
// is read from storage, uploaded to Meta and sent as an image, video, audio or document
// with the reply's text as its caption.
func (s *Service) sendMediaMessage(ctx context.Context, c connection, m outboundMessage, waID string) error {
	wid := c.WorkspaceID
	if m.Attachments > 1 {
		return s.failMessage(ctx, wid, m.ID, "WhatsApp takes one file per message. Send the files one at a time.")
	}
	var filename, contentType, storageKey string
	var sizeBytes int64
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT filename, content_type, size_bytes, storage_key FROM attachments
		WHERE workspace_id = $1 AND message_id = $2 ORDER BY created_at LIMIT 1`, wid, m.ID).
		Scan(&filename, &contentType, &sizeBytes, &storageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.failMessage(ctx, wid, m.ID, "This WhatsApp reply has no file to send.")
	}
	if err != nil {
		return err
	}
	kind := mediaKind(contentType)
	if limit := mediaSizeLimit(kind); sizeBytes > limit {
		return s.failMessage(ctx, wid, m.ID,
			fmt.Sprintf("This file is larger than WhatsApp's limit for %s messages (%d MB).", kind, limit>>20))
	}
	body, err := s.d.Storage.Get(ctx, storageKey)
	if err != nil {
		return s.failMessage(ctx, wid, m.ID, "This reply's file could not be read.")
	}
	content, err := io.ReadAll(io.LimitReader(body, hd.MaxAttachmentBytes+1))
	_ = body.Close()
	if err != nil {
		return s.failMessage(ctx, wid, m.ID, "This reply's file could not be read.")
	}
	if int64(len(content)) > hd.MaxAttachmentBytes {
		return s.failMessage(ctx, wid, m.ID, "This file is larger than WhatsApp's limit for documents (25 MB).")
	}
	acc, _, err := s.account(c)
	if err != nil {
		return s.failMessage(ctx, wid, m.ID, "This WhatsApp connection's credentials could not be read.")
	}
	client := s.client()
	mediaID, err := client.UploadMedia(ctx, acc, content, contentType, filename)
	if err != nil {
		if metaRetryable(err) {
			return err
		}
		return s.failMessage(ctx, wid, m.ID, whatsappSendError(err))
	}
	caption := strings.TrimSpace(truncate(m.BodyText, maxCaptionRunes))
	if caption == "" {
		caption = strings.TrimSpace(truncate(hd.HTMLToText(m.BodyHTML), maxCaptionRunes))
	}
	wamid, err := client.SendMedia(ctx, acc, waID, kind, mediaID, caption, filename)
	if err != nil {
		if metaRetryable(err) {
			return err
		}
		return s.failMessage(ctx, wid, m.ID, whatsappSendError(err))
	}
	return s.markMediaSent(ctx, wid, m.ID, wamid)
}

// markMediaSent records the WhatsApp message id of a sent media reply and tells the team
// through the message's event, as a text send does.
func (s *Service) markMediaSent(ctx context.Context, wid, msgID uuid.UUID, wamid string) error {
	meta := map[string]any{"provider_status": "sent", "provider_sent_at": time.Now().UTC().Format(time.RFC3339)}
	raw, _ := json.Marshal(meta)
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE messages SET delivery_status = 'sent', provider_message_id = $3,
				delivery_error = '', delivery_meta = delivery_meta || $4::jsonb
			WHERE workspace_id = $1 AND id = $2`, wid, msgID, wamid, raw); err != nil {
			return err
		}
		return domain.PublishMessageUpdated(ctx, tx, wid, msgID)
	})
}
