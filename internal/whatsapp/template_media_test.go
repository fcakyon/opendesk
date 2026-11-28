package whatsapp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

func TestTemplateMediaKind(t *testing.T) {
	tests := map[string]string{
		"IMAGE":    "image",
		"image":    "image",
		" VIDEO ":  "video",
		"DOCUMENT": "document",
		"TEXT":     "",
		"LOCATION": "",
		"":         "",
	}
	for headerType, want := range tests {
		if got := templateMediaKind(headerType); got != want {
			t.Fatalf("%q: %q, want %q", headerType, got, want)
		}
	}
}

func TestTemplateMediaProblem(t *testing.T) {
	cases := []struct {
		name        string
		kind        string
		contentType string
		size        int64
		want        bool
	}{
		{"image file", "image", "image/jpeg", 1 << 20, false},
		{"image at cap", "image", "image/png", 5 << 20, false},
		{"image over cap", "image", "image/png", 5<<20 + 1, true},
		{"video file", "video", "video/mp4", 16 << 20, false},
		{"video over cap", "video", "video/mp4", 16<<20 + 1, true},
		// A document may carry anything Meta does not call a picture, a video or audio; this
		// instance's own 25 MB upload limit cuts Meta's 100 MB.
		{"document pdf", "document", "application/pdf", hd.MaxAttachmentBytes, false},
		{"document over instance cap", "document", "application/pdf", hd.MaxAttachmentBytes + 1, true},
		{"document of image bytes", "document", "image/png", 1, true},
		{"document of video bytes", "document", "video/mp4", 1, true},
		{"document of audio bytes", "document", "audio/ogg", 1, true},
		{"image of document bytes", "image", "application/pdf", 1, true},
		{"no header", "", "application/pdf", 1 << 20, false},
	}
	for _, tt := range cases {
		got := templateMediaProblem(tt.kind, tt.contentType, tt.size)
		if (got != "") != tt.want {
			t.Fatalf("%s: %q, want problem %v", tt.name, got, tt.want)
		}
	}
	// A refusal names the shape and the cap, never where the file is stored.
	if got := templateMediaProblem("image", "image/png", 6<<20); !strings.Contains(got, "image") || !strings.Contains(got, "5 MB") {
		t.Fatalf("size refusal: %q", got)
	}
}

func TestTemplateComponentsMediaHeaders(t *testing.T) {
	image := &whatsappTemplate{HeaderType: "IMAGE", HeaderMediaID: "media-image", Body: "Hello {{1}}",
		Params: map[string]string{"1": "Ana"}}
	components := image.components()
	if len(components) != 2 {
		t.Fatalf("components: %+v", components)
	}
	assertMediaHeader(t, components[0], "image", "media-image", "")

	video := &whatsappTemplate{HeaderType: "VIDEO", HeaderMediaID: "media-video"}
	if components := video.components(); len(components) != 1 {
		t.Fatalf("components: %+v", components)
	} else {
		assertMediaHeader(t, components[0], "video", "media-video", "")
	}

	document := &whatsappTemplate{HeaderType: "document", HeaderMediaID: "media-doc",
		HeaderMediaFilename: "invoice.pdf", Body: "Hi {{1}}", Params: map[string]string{"1": "Ana"}}
	components = document.components()
	if len(components) != 2 {
		t.Fatalf("components: %+v", components)
	}
	assertMediaHeader(t, components[0], "document", "media-doc", "invoice.pdf")

	// Without Meta's uploaded id there is no component to send; the caller refuses the send.
	missing := &whatsappTemplate{HeaderType: "IMAGE", Body: "Hi {{1}}", Params: map[string]string{"1": "Ana"}}
	if components := missing.components(); len(components) != 1 || components[0]["type"] != "body" {
		t.Fatalf("components: %+v", components)
	}
}

// assertMediaHeader checks one media header component's shape: the parameter's type is the
// media shape, and its object carries Meta's id and, for a document, the file name.
func assertMediaHeader(t *testing.T, component map[string]any, shape, id, filename string) {
	t.Helper()
	if component["type"] != "header" {
		t.Fatalf("component: %+v", component)
	}
	params, ok := component["parameters"].([]map[string]any)
	if !ok || len(params) != 1 {
		t.Fatalf("parameters: %+v", component)
	}
	if params[0]["type"] != shape {
		t.Fatalf("parameter type: %+v", params[0])
	}
	media, ok := params[0][shape].(map[string]any)
	if !ok || media["id"] != id {
		t.Fatalf("media: %+v", params[0])
	}
	if filename == "" {
		if _, ok := media["filename"]; ok {
			t.Fatalf("filename on a %s header: %+v", shape, media)
		}
		return
	}
	if media["filename"] != filename {
		t.Fatalf("filename: %+v", media)
	}
}

func TestTemplateHeaderPicksWhatTheHeaderNeeds(t *testing.T) {
	// No header: a value or file a client sent for it is ignored.
	if text, media, err := templateHeader(whatsappTemplateRow{}, "ignored", "attachment-1"); err != nil || text != "" || media != "" {
		t.Fatalf("no header: %q %q %v", text, media, err)
	}
	// A static text header sends no value.
	row := whatsappTemplateRow{HeaderType: "TEXT", HeaderContent: "Order update"}
	if text, media, err := templateHeader(row, "ignored", ""); err != nil || text != "" || media != "" {
		t.Fatalf("static header: %q %q %v", text, media, err)
	}
	// A text header's variable needs its value.
	row = whatsappTemplateRow{HeaderType: "TEXT", HeaderContent: "Order {{1}} update"}
	if _, _, err := templateHeader(row, "", ""); err == nil {
		t.Fatal("a missing header value was accepted")
	}
	if text, media, err := templateHeader(row, "A-12", ""); err != nil || text != "A-12" || media != "" {
		t.Fatalf("text header: %q %q %v", text, media, err)
	}
	// An image, video or document header needs the workspace's file, and carries no text.
	for _, kind := range []string{"IMAGE", "VIDEO", "DOCUMENT"} {
		row := whatsappTemplateRow{HeaderType: kind}
		if _, _, err := templateHeader(row, "", ""); err == nil {
			t.Fatalf("%s header without a file was accepted", kind)
		}
		text, media, err := templateHeader(row, "ignored", " attachment-1 ")
		if err != nil || text != "" || media != "attachment-1" {
			t.Fatalf("%s header: %q %q %v", kind, text, media, err)
		}
	}
	// A header this channel cannot fill is still refused.
	if _, _, err := templateHeader(whatsappTemplateRow{HeaderType: "LOCATION"}, "", ""); err == nil {
		t.Fatal("a location header was accepted")
	}
}

// The delivery_meta envelope keeps the workspace's attachment and both media ids separate:
// the API writes the attachment id, the send fills Meta's media id and the document's name.
func TestWhatsappTemplateMediaMetaRoundTrip(t *testing.T) {
	tmpl := &whatsappTemplate{Name: "order_update", Language: "en_US", HeaderType: "DOCUMENT",
		HeaderAttachmentID: "attachment-1", HeaderMediaID: "media-1", HeaderMediaFilename: "invoice.pdf"}
	raw, err := json.Marshal(map[string]any{"whatsapp_template": tmpl})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"header_attachment_id":"attachment-1"`, `"header_media_id":"media-1"`, `"header_media_filename":"invoice.pdf"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("%s missing from %s", want, raw)
		}
	}
	got := whatsappTemplateFromMeta(raw)
	if got == nil || got.HeaderAttachmentID != "attachment-1" || got.HeaderMediaID != "media-1" || got.HeaderMediaFilename != "invoice.pdf" {
		t.Fatalf("round trip: %+v", got)
	}
	// The API's envelope carries the attachment only; Meta's ids are filled by the send.
	raw, err = json.Marshal(map[string]any{"whatsapp_template": &whatsappTemplate{Name: "order_update",
		HeaderType: "IMAGE", HeaderAttachmentID: "attachment-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"header_media_id"`) {
		t.Fatalf("an unsent template carries a media id: %s", raw)
	}
}
