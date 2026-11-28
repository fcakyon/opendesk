package templates

// A picture the signature editor inserts (a public https URL, a width and height, alt text)
// survives saving and sending as it is.

import (
	"strings"
	"testing"
)

func TestSignaturePictureSurvives(t *testing.T) {
	img := `<img src="https://api.example.test/v1/images/6f1d3c1e-58b2-4f7a-9d55-0d0b7b0c4c11" alt="Company logo" width="200" height="50">`
	sig := `<p>Kind regards,</p>` + img + `<p>{{ agent.name }}</p>`
	for name, out := range map[string]string{"saved": SanitizeDesign(sig), "sent": SanitizeForSend(SanitizeDesign(img))} {
		for _, want := range []string{`src="https://api.example.test/v1/images/6f1d3c1e-58b2-4f7a-9d55-0d0b7b0c4c11"`, `alt="Company logo"`, `width="200"`, `height="50"`} {
			if !strings.Contains(out, want) {
				t.Errorf("%s: %s lost from %s", name, want, out)
			}
		}
	}
	if !strings.Contains(SanitizeDesign(sig), "{{ agent.name }}") {
		t.Error("the template tag was lost")
	}
}
