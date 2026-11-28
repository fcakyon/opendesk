package whatsapp

import (
	"encoding/json"
	"testing"
)

func TestOrderedPlaceholders(t *testing.T) {
	cases := []struct {
		text string
		want []string
	}{
		{"Hello {{1}} and {{2}}", []string{"1", "2"}},
		{"{{2}} before {{1}}, then {{2}} again", []string{"2", "1"}},
		{"Hi {{ name }}, {{name}}", []string{"name"}},
		{"no variables here", nil},
	}
	for _, c := range cases {
		got := orderedPlaceholders(c.text)
		if len(got) != len(c.want) {
			t.Fatalf("%q: got %v, want %v", c.text, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%q: got %v, want %v", c.text, got, c.want)
			}
		}
	}
}

func TestRenderTemplateBody(t *testing.T) {
	body := "Hello {{1}}, your order {{ order }} is on its way."
	got := renderTemplateBody(body, map[string]string{"1": "Ana", "order": "A-12"})
	if want := "Hello Ana, your order A-12 is on its way."; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// A variable left blank stays visible, so the agent can see what is missing.
	if got := renderTemplateBody("Hi {{1}}", nil); got != "Hi {{1}}" {
		t.Fatalf("empty params: got %q", got)
	}
}

func TestTemplateComponentsBodyAndButtons(t *testing.T) {
	tmpl := &whatsappTemplate{
		Body:       "Hello {{2}}, your order {{1}} shipped.",
		Params:     map[string]string{"1": "A-12", "2": "Ana"},
		ButtonURLs: map[string]string{"1": "https://example.com/track/12"},
	}
	components := tmpl.components()
	if len(components) != 2 {
		t.Fatalf("components: %+v", components)
	}
	body, ok := components[0]["parameters"].([]map[string]any)
	if !ok || len(body) != 2 {
		t.Fatalf("body component: %+v", components[0])
	}
	// Parameters go in the order the placeholders appear, not their numbers.
	if body[0]["text"] != "Ana" || body[1]["text"] != "A-12" {
		t.Fatalf("body parameters order: %+v", body)
	}
	button := components[1]
	if button["type"] != "button" || button["sub_type"] != "url" || button["index"] != "1" {
		t.Fatalf("button component: %+v", button)
	}
	params, _ := button["parameters"].([]map[string]any)
	if len(params) != 1 || params[0]["text"] != "https://example.com/track/12" {
		t.Fatalf("button parameters: %+v", button)
	}
}

// A header and a body number their variables separately at Meta: both use {{1}}, and each
// value must travel in its own component.
func TestTemplateComponentsHeaderAndBodySameNumber(t *testing.T) {
	row := whatsappTemplateRow{HeaderType: "TEXT", HeaderContent: "Order {{1}} update",
		BodyContent: "Hello {{1}}, {{2}}"}
	tmpl := &whatsappTemplate{HeaderType: row.HeaderType, HeaderText: "A-12",
		Body: row.BodyContent, Params: map[string]string{"1": "Ana", "2": "shipped"}}
	prepareTemplateHeader(tmpl, row)
	components := tmpl.components()
	if len(components) != 2 {
		t.Fatalf("components: %+v", components)
	}
	headerParams, _ := components[0]["parameters"].([]map[string]any)
	if len(headerParams) != 1 || headerParams[0]["text"] != "A-12" {
		t.Fatalf("header parameter: %+v", components[0])
	}
	bodyParams, _ := components[1]["parameters"].([]map[string]any)
	if len(bodyParams) != 2 || bodyParams[0]["text"] != "Ana" || bodyParams[1]["text"] != "shipped" {
		t.Fatalf("body parameters: %+v", components[1])
	}
}

func TestPrepareTemplateHeaderStatic(t *testing.T) {
	row := whatsappTemplateRow{HeaderType: "TEXT", HeaderContent: "Order update", BodyContent: "Hello {{1}}"}
	tmpl := &whatsappTemplate{HeaderType: "TEXT", HeaderText: "ignored", Body: row.BodyContent,
		Params: map[string]string{"1": "Ana"}}
	prepareTemplateHeader(tmpl, row)
	if tmpl.HeaderText != "" {
		t.Fatalf("a static header needs no component, got header_text %q", tmpl.HeaderText)
	}
	if components := tmpl.components(); len(components) != 1 {
		t.Fatalf("components: %+v", components)
	}
}

func TestPrepareTemplateHeaderNonText(t *testing.T) {
	row := whatsappTemplateRow{HeaderType: "IMAGE", BodyContent: "Hello {{1}}"}
	tmpl := &whatsappTemplate{HeaderType: "IMAGE", HeaderText: "ignored", Body: row.BodyContent,
		Params: map[string]string{"1": "Ana"}}
	prepareTemplateHeader(tmpl, row)
	if tmpl.HeaderType != "" || tmpl.HeaderText != "" {
		t.Fatalf("a media header sends no text component: %+v", tmpl)
	}
}

func TestTemplatePartsFrom(t *testing.T) {
	parts := templatePartsFrom([]TemplateComponent{
		{Type: "HEADER", Format: "TEXT", Text: "Hi {{1}}"},
		{Type: "BODY", Text: "Hello {{1}}"},
		{Type: "FOOTER", Text: "Unsubscribe any time"},
		{Type: "BUTTONS", Buttons: []map[string]any{{"type": "URL", "text": "Track", "url": "https://example.com/{{1}}"}}},
	})
	if parts.HeaderType != "TEXT" || parts.HeaderContent != "Hi {{1}}" {
		t.Fatalf("header: %+v", parts)
	}
	if parts.BodyContent != "Hello {{1}}" || parts.FooterContent != "Unsubscribe any time" {
		t.Fatalf("body/footer: %+v", parts)
	}
	if len(parts.Buttons) != 1 || parts.Buttons[0]["text"] != "Track" {
		t.Fatalf("buttons: %+v", parts.Buttons)
	}
	// A media header keeps its format and carries no text.
	media := templatePartsFrom([]TemplateComponent{{Type: "HEADER", Format: "IMAGE"}})
	if media.HeaderType != "IMAGE" || media.HeaderContent != "" {
		t.Fatalf("media header: %+v", media)
	}
}

func TestTemplateViewButtons(t *testing.T) {
	row := whatsappTemplateRow{Name: "order_update", Language: "en_US",
		Buttons: []byte(`[{"type":"URL","text":"Track","url":"https://example.com/{{1}}"}]`)}
	view := templateView(row)
	if len(view.Buttons) != 1 || view.Buttons[0]["text"] != "Track" {
		t.Fatalf("buttons: %+v", view.Buttons)
	}
	if empty := templateView(whatsappTemplateRow{Buttons: []byte("[]")}); empty.Buttons == nil {
		t.Fatal("a template without buttons must answer an empty list, not null")
	}
}

func TestTemplateURLButtonParams(t *testing.T) {
	buttons, _ := json.Marshal([]map[string]any{
		{"type": "QUICK_REPLY", "text": "Yes"},
		{"type": "URL", "text": "Track", "url": "https://example.com/{{1}}"},
		{"type": "URL", "text": "Site", "url": "https://example.com"},
	})
	got := templateURLButtonParams(buttons)
	if len(got) != 1 || got[0] != "1" {
		t.Fatalf("got %v, want [1]", got)
	}
	if got := templateURLButtonParams(nil); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestCleanTemplateParams(t *testing.T) {
	row := whatsappTemplateRow{BodyContent: "Hello {{1}}, order {{ order }} shipped"}
	if _, err := cleanTemplateParams(map[string]string{"1": "Ana", "order": "A-12"}, row); err != nil {
		t.Fatalf("filled params refused: %v", err)
	}
	if _, err := cleanTemplateParams(map[string]string{"1": "Ana"}, row); err == nil {
		t.Fatal("a missing variable was accepted")
	}
}
