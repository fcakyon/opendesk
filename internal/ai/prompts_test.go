package ai

import (
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

func TestSummaryGuidanceWritesInTheReadersLanguage(t *testing.T) {
	got := summaryGuidance("Acme", hd.AISettings{Instructions: "Be brief."}, "es")
	if !strings.Contains(got, "write the summary and the key_points in es") {
		t.Fatalf("guidance does not name Spanish:\n%s", got)
	}
	if strings.Contains(got, "which is English") {
		t.Fatalf("guidance still forces English:\n%s", got)
	}
	if strings.Contains(got, "customer's most recent message") {
		t.Fatalf("guidance follows the customer instead of the reader:\n%s", got)
	}
	if !strings.Contains(got, "Be brief.") {
		t.Fatalf("guidance dropped the workspace instructions:\n%s", got)
	}
}

func TestReaderLang(t *testing.T) {
	if got := readerLang("es"); got != "es" {
		t.Fatalf("es: got %q", got)
	}
	if got := readerLang("pt-BR"); got != "pt-BR" {
		t.Fatalf("pt-BR: got %q", got)
	}
	for _, bad := range []string{"", "und", "not a language", "english"} {
		if got := readerLang(bad); got != "" {
			t.Fatalf("%q: got %q, want empty", bad, got)
		}
	}
}
