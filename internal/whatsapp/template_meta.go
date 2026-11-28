package whatsapp

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// whatsappTemplate is one template send as the outbound message carries it: the approved
// template Meta knows plus the values an agent filled in for this message. It lives in
// messages.delivery_meta under "whatsapp_template" (contracts/whatsapp.md).
//
// A media header names the workspace's attachment in HeaderAttachmentID. The file is uploaded
// to Meta by the send itself, which fills HeaderMediaID (Meta's id, what the send carries) and
// HeaderMediaFilename (a document's name); a text header uses HeaderText instead.
type whatsappTemplate struct {
	ID         string            `json:"id,omitempty"`
	Name       string            `json:"name"`
	Language   string            `json:"language"`
	Body       string            `json:"body,omitempty"`
	Params     map[string]string `json:"params,omitempty"`
	HeaderType string            `json:"header_type,omitempty"`
	HeaderText string            `json:"header_text,omitempty"`
	// HeaderAttachmentID is the opendesk attachment an image, video or document header sends.
	HeaderAttachmentID string `json:"header_attachment_id,omitempty"`
	// HeaderMediaID is Meta's id of that file once it was uploaded for the send.
	HeaderMediaID string `json:"header_media_id,omitempty"`
	// HeaderMediaFilename is a document header's file name at send time.
	HeaderMediaFilename string            `json:"header_media_filename,omitempty"`
	ButtonURLs          map[string]string `json:"button_urls,omitempty"`
}

// templateEnvelope reads the template of an outbound message out of delivery_meta. It
// returns nil for a free-form message.
func whatsappTemplateFromMeta(raw []byte) *whatsappTemplate {
	if len(raw) == 0 {
		return nil
	}
	var env struct {
		Template *whatsappTemplate `json:"whatsapp_template"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || env.Template == nil || strings.TrimSpace(env.Template.Name) == "" {
		return nil
	}
	return env.Template
}

// components renders Meta's components array for this send: the body's parameters in the
// order the template's placeholders appear, an optional header (a text value, or the file of
// an image, video or document header), and URL button values by button index. Components a
// template does not need are left out, so Meta uses the approved text as it is.
func (t *whatsappTemplate) components() []map[string]any {
	var out []map[string]any
	if header := t.headerComponent(); header != nil {
		out = append(out, header)
	}
	if keys := orderedPlaceholders(t.Body); len(keys) > 0 {
		params := make([]map[string]any, 0, len(keys))
		for _, key := range keys {
			params = append(params, map[string]any{"type": "text", "text": t.param(key)})
		}
		out = append(out, map[string]any{"type": "body", "parameters": params})
	}
	if len(t.ButtonURLs) > 0 {
		indexes := make([]int, 0, len(t.ButtonURLs))
		for raw := range t.ButtonURLs {
			if i, err := strconv.Atoi(raw); err == nil {
				indexes = append(indexes, i)
			}
		}
		sort.Ints(indexes)
		for _, i := range indexes {
			out = append(out, map[string]any{
				"type":       "button",
				"sub_type":   "url",
				"index":      strconv.Itoa(i),
				"parameters": []map[string]any{{"type": "text", "text": t.ButtonURLs[strconv.Itoa(i)]}},
			})
		}
	}
	return out
}

// headerComponent renders Meta's header component for this send: a text header's one value,
// or the uploaded file of an image, video or document header. A static header needs no
// component, so Meta uses the approved header as it is; a media header whose file was not
// uploaded sends none (the send is refused before it gets here).
func (t *whatsappTemplate) headerComponent() map[string]any {
	switch kind := strings.ToUpper(strings.TrimSpace(t.HeaderType)); kind {
	case "TEXT":
		if strings.TrimSpace(t.HeaderText) == "" {
			return nil
		}
		header := map[string]any{"type": "header"}
		if keys := orderedPlaceholders(t.HeaderText); len(keys) > 0 {
			header["parameters"] = []map[string]any{{"type": "text", "text": t.param(keys[0])}}
		}
		return header
	case "IMAGE", "VIDEO", "DOCUMENT":
		if strings.TrimSpace(t.HeaderMediaID) == "" {
			return nil
		}
		kind = strings.ToLower(kind)
		media := map[string]any{"id": t.HeaderMediaID}
		if kind == "document" && strings.TrimSpace(t.HeaderMediaFilename) != "" {
			media["filename"] = t.HeaderMediaFilename
		}
		return map[string]any{"type": "header", "parameters": []map[string]any{{"type": kind, kind: media}}}
	}
	return nil
}

// templateMediaKind returns the media shape of a template header: image, video or document,
// or "" for a header that carries no file (a text one, none, or one this channel cannot fill).
func templateMediaKind(headerType string) string {
	switch strings.ToUpper(strings.TrimSpace(headerType)) {
	case "IMAGE":
		return "image"
	case "VIDEO":
		return "video"
	case "DOCUMENT":
		return "document"
	}
	return ""
}

// templateMediaProblem says why a stored file cannot fill a header of kind, or "" when it
// can: the file's content type must match the header's shape, and its size stays inside
// Meta's cap for that shape (and never above this instance's own attachment limit). The text
// is safe to show an agent and names nothing about where the file is stored.
func templateMediaProblem(kind, contentType string, sizeBytes int64) string {
	if kind == "" {
		return ""
	}
	if mediaKind(contentType) != kind {
		return "That file does not match this template's " + kind + " header."
	}
	if limit := mediaSizeLimit(kind); sizeBytes > limit {
		return fmt.Sprintf("This file is larger than WhatsApp's limit for %s headers (%d MB).", kind, limit>>20)
	}
	return ""
}

// param is the value for one placeholder, or empty when the agent left it blank (Meta then
// refuses the send with its own error).
func (t *whatsappTemplate) param(key string) string {
	if t.Params == nil {
		return ""
	}
	if v, ok := t.Params[key]; ok {
		return v
	}
	// Meta numbers positional placeholders from one; a template listed with named ones is
	// filled by its name. Both are accepted as the same key.
	if i, err := strconv.Atoi(key); err == nil {
		return t.Params[strconv.Itoa(i)]
	}
	return ""
}

var placeholderPattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+)\s*\}\}`)

// orderedPlaceholders returns the distinct placeholders of a template text in the order they
// appear, which is the order Meta expects their parameters.
func orderedPlaceholders(text string) []string {
	matches := placeholderPattern.FindAllStringSubmatch(text, -1)
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		key := m[1]
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	return out
}

// renderTemplateBody fills a template's body with the agent's values for the message's own
// text, so the timeline shows what the customer gets.
func renderTemplateBody(body string, params map[string]string) string {
	if body == "" || len(params) == 0 {
		return body
	}
	return placeholderPattern.ReplaceAllStringFunc(body, func(match string) string {
		sub := placeholderPattern.FindStringSubmatch(match)
		if sub == nil {
			return match
		}
		if v, ok := params[sub[1]]; ok {
			return v
		}
		return match
	})
}
