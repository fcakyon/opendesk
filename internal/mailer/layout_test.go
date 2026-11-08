package mailer

import (
	"strings"
	"testing"
)

func TestRenderEscapes(t *testing.T) {
	html, text := Render(Email{
		Subject: "Hi", Heading: `<script>alert(1)</script>`,
		Intro:  []string{`Tom & "Jerry"`},
		Ticket: &TicketCard{Ref: "#1", Subject: `<img src=x onerror=alert(1)>`, Snippet: "<b>bold</b>"},
		Items:  []Item{{Title: "x", URL: "javascript:alert(1)", Tone: `red;background:url(x)`}},
		Button: &Button{Label: "Go", URL: "https://app.example/a?b=1&c=2"},
		Footer: Footer{Reason: "Because", Links: []Link{{Label: "Bad", URL: "data:text/html,hi"}}, Contact: "team@opendesk.sh"},
	})
	for _, bad := range []string{"<script>", "<img src=x", "<b>bold</b>", "javascript:", "data:text/html", "url(x)"} {
		if strings.Contains(html, bad) {
			t.Errorf("html contains %q", bad)
		}
	}
	for _, want := range []string{"&lt;script&gt;", "&lt;b&gt;bold&lt;/b&gt;", `href="https://app.example/a?b=1&amp;c=2"`, "<!--[if mso]>", "prefers-color-scheme:dark", "mailto:team@opendesk.sh"} {
		if !strings.Contains(html, want) {
			t.Errorf("html lacks %q", want)
		}
	}
	if !strings.Contains(text, "Go: https://app.example/a?b=1&c=2") || strings.Contains(text, "javascript:") || !strings.Contains(text, "team@opendesk.sh") {
		t.Errorf("text:\n%s", text)
	}
}

func TestBuildHeaders(t *testing.T) {
	msg := Build("opendesk <team@opendesk.sh>", Mail{To: "a@example.com", Subject: "Hello\r\nBcc: evil@example.com", Text: "t", HTML: "h",
		Headers: map[string]string{"Reply-To": "visitor@example.com", "List-Unsubscribe": "<https://api.example/u?token=x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			"References": "<ticket-1@app.example>\r\nBcc: evil@example.com", "X-Not-Allowed": "nope"}})
	head, _, _ := strings.Cut(msg, "\r\n\r\n")
	if strings.Contains(head, "\r\nBcc:") || strings.Contains(head, "X-Not-Allowed") {
		t.Fatalf("header injection:\n%s", head)
	}
	for _, want := range []string{"Reply-To: visitor@example.com", "List-Unsubscribe: <https://api.example/u?token=x>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click", "References: <ticket-1@app.example> Bcc: evil@example.com"} {
		if !strings.Contains(head, want) {
			t.Errorf("missing %q in\n%s", want, head)
		}
	}
}
