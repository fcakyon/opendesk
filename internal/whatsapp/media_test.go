package whatsapp

import (
	"errors"
	"fmt"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

func TestMetaMediaLimit(t *testing.T) {
	tests := map[string]int64{
		"image":    5 << 20,
		"video":    16 << 20,
		"audio":    16 << 20,
		"document": 100 << 20,
		"sticker":  0,
		"":         0,
	}
	for kind, want := range tests {
		if got := metaMediaLimit(kind); got != want {
			t.Fatalf("%q: %d, want %d", kind, got, want)
		}
	}
}

func TestMediaSizeLimitIsTheSmallerCap(t *testing.T) {
	// Meta's caps are 5 MB for an image and 16 MB for video and audio; a document's 100 MB
	// is cut to this instance's attachment limit.
	tests := map[string]int64{
		"image":    5 << 20,
		"video":    16 << 20,
		"audio":    16 << 20,
		"document": hd.MaxAttachmentBytes,
	}
	for kind, want := range tests {
		if got := mediaSizeLimit(kind); got != want {
			t.Fatalf("%q: %d, want %d", kind, got, want)
		}
	}
	if got := mediaSizeLimit(""); got != hd.MaxAttachmentBytes {
		t.Fatalf("unknown kind: %d, want %d", got, hd.MaxAttachmentBytes)
	}
}

func TestInboundMediaKind(t *testing.T) {
	known := map[string]string{
		"image":    "image",
		"sticker":  "image",
		"video":    "video",
		"audio":    "audio",
		"voice":    "audio",
		"document": "document",
	}
	for messageType, want := range known {
		if got, ok := inboundMediaKind(messageType); !ok || got != want {
			t.Fatalf("%q: %q %v, want %q", messageType, got, ok, want)
		}
	}
	for _, messageType := range []string{"text", "location", "contacts", "reaction", ""} {
		if got, ok := inboundMediaKind(messageType); ok {
			t.Fatalf("%q: %q, want no media", messageType, got)
		}
	}
}

func TestMediaFilename(t *testing.T) {
	tests := []struct {
		name        string
		kind        string
		given       string
		contentType string
		want        string
	}{
		// A document keeps the name Meta sent, cleaned of path characters.
		{"document name", "document", "Invoice 7.pdf", "application/pdf", "Invoice 7.pdf"},
		{"document path", "document", "../../secret.pdf", "application/pdf", "secret.pdf"},
		{"document unnamed", "document", "", "application/pdf", "document.pdf"},
		// Every other kind is named from its type; the sender's name is not used.
		{"image", "image", "IMG-0001.jpg", "image/jpeg", "image.jpg"},
		{"image unnamed", "image", "", "image/png", "image.png"},
		{"video", "video", "", "video/mp4", "video.mp4"},
		{"video 3gp", "video", "", "video/3gpp", "video.3gp"},
		{"audio ogg with codecs", "audio", "", "audio/ogg; codecs=opus", "audio.ogg"},
		{"audio m4a", "audio", "", "audio/mp4", "audio.m4a"},
		{"audio amr", "audio", "", "audio/amr", "audio.amr"},
	}
	for _, tt := range tests {
		if got := mediaFilename(tt.kind, tt.given, tt.contentType); got != tt.want {
			t.Fatalf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestPermanentMediaError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"expired id", &MetaAPIError{StatusCode: 400}, true},
		{"not found", &MetaAPIError{StatusCode: 404}, true},
		{"wrapped", fmt.Errorf("media url: %w", &MetaAPIError{StatusCode: 400}), true},
		{"rate limited", &MetaAPIError{StatusCode: 429}, false},
		{"timeout", &MetaAPIError{StatusCode: 408}, false},
		{"server error", &MetaAPIError{StatusCode: 500}, false},
		{"network", errors.New("dial tcp"), false},
	}
	for _, tt := range cases {
		if got := permanentMediaError(tt.err); got != tt.want {
			t.Fatalf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestMetaRetryable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"rate limited", &MetaAPIError{StatusCode: 429}, true},
		{"server error", &MetaAPIError{StatusCode: 500}, true},
		{"unavailable", &MetaAPIError{StatusCode: 503}, true},
		{"rejected", &MetaAPIError{StatusCode: 400}, false},
		{"expired", &MetaAPIError{StatusCode: 404}, false},
		{"network", errors.New("dial tcp"), false},
	}
	for _, tt := range cases {
		if got := metaRetryable(tt.err); got != tt.want {
			t.Fatalf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestMediaTooLarge(t *testing.T) {
	if !mediaTooLarge(errors.New("whatsapp: media is larger than 5242880 bytes")) {
		t.Fatal("the downloader's size refusal is permanent")
	}
	if mediaTooLarge(errors.New("whatsapp: download media: connection reset")) {
		t.Fatal("a network failure is not a size refusal")
	}
	if mediaTooLarge(nil) {
		t.Fatal("no error is not a refusal")
	}
}

func TestPlaceholderForMedia(t *testing.T) {
	tests := map[string]string{
		"image":    "[image]",
		"video":    "[video]",
		"audio":    "[audio]",
		"voice":    "[audio]",
		"document": "[document]",
		"sticker":  "[sticker]",
		"location": "[location]",
		"text":     "[text]",
	}
	for kind, want := range tests {
		if got := placeholderFor(kind); got != want {
			t.Fatalf("%q: %q, want %q", kind, got, want)
		}
	}
}
