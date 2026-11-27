package whatsapp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParsePayloadText(t *testing.T) {
	body := []byte(`{
		"object": "whatsapp_business_account",
		"entry": [{
			"id": "WABA1",
			"changes": [{
				"field": "messages",
				"value": {
					"messaging_product": "whatsapp",
					"metadata": {"display_phone_number": "+1 555 000 1111", "phone_number_id": "111222"},
					"contacts": [{"profile": {"name": "Ada Lovelace"}, "wa_id": "15551234567"}],
					"messages": [{
						"from": "15551234567",
						"id": "wamid.A1",
						"timestamp": "1710000000",
						"type": "text",
						"context": {"id": "wamid.PARENT"},
						"text": {"body": "Hello there"}
					}]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 1 {
		t.Fatalf("messages: %+v", messages)
	}
	got := messages[0]
	if got.From != "15551234567" || got.ID != "wamid.A1" || got.Type != "text" {
		t.Fatalf("message: %+v", got)
	}
	if got.Text != "Hello there" || got.ContactName != "Ada Lovelace" || got.PhoneNumberID != "111222" {
		t.Fatalf("message: %+v", got)
	}
	if got.ContextID != "wamid.PARENT" {
		t.Fatalf("context: %+v", got)
	}
	if !got.Timestamp.Equal(time.Unix(1710000000, 0)) {
		t.Fatalf("timestamp: %s", got.Timestamp)
	}
}

func TestParsePayloadMedia(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"id": "WABA1",
			"changes": [{
				"field": "messages",
				"value": {
					"metadata": {"phone_number_id": "111222"},
					"contacts": [{"profile": {"name": "Ada"}, "wa_id": "1555"}],
					"messages": [
						{"from": "1555", "id": "wamid.IMG", "timestamp": "1710000001", "type": "image",
						 "image": {"id": "media-img", "mime_type": "image/jpeg", "sha256": "abc", "caption": "the photo"}},
						{"from": "1555", "id": "wamid.VID", "timestamp": "1710000002", "type": "video",
						 "video": {"id": "media-vid", "mime_type": "video/mp4", "caption": "the clip"}},
						{"from": "1555", "id": "wamid.DOC", "timestamp": "1710000003", "type": "document",
						 "document": {"id": "media-doc", "mime_type": "application/pdf", "caption": "invoice", "filename": "invoice.pdf"}},
						{"from": "1555", "id": "wamid.STK", "timestamp": "1710000004", "type": "sticker",
						 "sticker": {"id": "media-stk", "mime_type": "image/webp", "animated": true}},
						{"from": "1555", "id": "wamid.VOICE", "timestamp": "1710000005", "type": "voice",
						 "voice": {"id": "media-voice", "mime_type": "audio/ogg", "voice": true}},
						{"from": "1555", "id": "wamid.AUD", "timestamp": "1710000006", "type": "audio",
						 "audio": {"id": "media-aud", "mime_type": "audio/mpeg"}}
					]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 6 {
		t.Fatalf("messages: %+v", messages)
	}
	image := messages[0]
	if image.MediaID != "media-img" || image.MediaMimeType != "image/jpeg" || image.Caption != "the photo" {
		t.Fatalf("image: %+v", image)
	}
	video := messages[1]
	if video.MediaID != "media-vid" || video.Caption != "the clip" || video.Filename != "" {
		t.Fatalf("video: %+v", video)
	}
	document := messages[2]
	if document.MediaID != "media-doc" || document.MediaMimeType != "application/pdf" ||
		document.Caption != "invoice" || document.Filename != "invoice.pdf" {
		t.Fatalf("document: %+v", document)
	}
	sticker := messages[3]
	if sticker.MediaID != "media-stk" || sticker.MediaMimeType != "image/webp" || sticker.Caption != "" {
		t.Fatalf("sticker: %+v", sticker)
	}
	for _, audio := range messages[4:] {
		if audio.MediaID == "" || audio.MediaMimeType == "" || audio.Caption != "" || audio.Filename != "" {
			t.Fatalf("audio: %+v", audio)
		}
	}
	for _, message := range messages {
		if message.ContactName != "Ada" {
			t.Fatalf("contact name fallback: %+v", message)
		}
	}
}

func TestParsePayloadInteractive(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"changes": [{
				"field": "messages",
				"value": {
					"metadata": {"phone_number_id": "1"},
					"messages": [
						{"from": "1", "id": "wamid.B", "timestamp": "1710000001", "type": "interactive",
						 "interactive": {"type": "button_reply", "button_reply": {"id": "yes", "title": "Yes, please"}}},
						{"from": "1", "id": "wamid.L", "timestamp": "1710000002", "type": "interactive",
						 "interactive": {"type": "list_reply", "list_reply": {"id": "billing", "title": "Billing", "description": "Invoices"}}},
						{"from": "1", "id": "wamid.C", "timestamp": "1710000003", "type": "button",
						 "button": {"text": "Confirm", "payload": "confirm"}}
					]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 3 {
		t.Fatalf("messages: %+v", messages)
	}
	if messages[0].Text != "Yes, please" || messages[1].Text != "Billing" || messages[2].Text != "Confirm" {
		t.Fatalf("texts: %+v", messages)
	}
}

func TestParsePayloadLocationAndContacts(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"changes": [{
				"field": "messages",
				"value": {
					"metadata": {"phone_number_id": "1"},
					"messages": [
						{"from": "1", "id": "wamid.LOC", "timestamp": "1710000001", "type": "location",
						 "location": {"latitude": 12.9716, "longitude": 77.5946, "name": "Cafe", "address": "1 Main St"}},
						{"from": "1", "id": "wamid.ONLY", "timestamp": "1710000002", "type": "location",
						 "location": {"latitude": 1.5, "longitude": -2.25}},
						{"from": "1", "id": "wamid.CARD", "timestamp": "1710000003", "type": "contacts",
						 "contacts": [
							{"name": {"formatted_name": "Bob Smith"}, "phones": [{"phone": "+15550002", "type": "CELL"}]},
							{"name": {"first_name": "Carol", "last_name": "Jones"}, "phones": [{"wa_id": "15550003"}]}
						 ]}
					]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 3 {
		t.Fatalf("messages: %+v", messages)
	}
	if want := "Cafe/1 Main St https://www.google.com/maps?q=12.9716,77.5946"; messages[0].Text != want {
		t.Fatalf("location text: %q, want %q", messages[0].Text, want)
	}
	if want := "https://www.google.com/maps?q=1.5,-2.25"; messages[1].Text != want {
		t.Fatalf("location text: %q, want %q", messages[1].Text, want)
	}
	if want := "Bob Smith +15550002\nCarol Jones 15550003"; messages[2].Text != want {
		t.Fatalf("shared contacts: %q, want %q", messages[2].Text, want)
	}
}

func TestParsePayloadSystem(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"changes": [{
				"field": "messages",
				"value": {
					"metadata": {"phone_number_id": "1"},
					"messages": [
						{"from": "1555", "id": "wamid.S", "timestamp": "1710000001", "type": "system",
						 "system": {"type": "user_changed_number", "body": "The customer changed number", "wa_id": "1555", "new_wa_id": "1555999"}}
					]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 1 {
		t.Fatalf("messages: %+v", messages)
	}
	got := messages[0]
	if got.SystemType != "user_changed_number" || got.SystemNewWAID != "1555999" || got.Text != "The customer changed number" {
		t.Fatalf("system: %+v", got)
	}
}

func TestParsePayloadKeepsUnknownType(t *testing.T) {
	body := []byte(`{"entry":[{"changes":[{"field":"messages","value":{"messages":[
		{"from":"1","id":"wamid.X","timestamp":"1710000001","type":"reaction","reaction":{"message_id":"wamid.Y","emoji":"👍"}}
	]}}]}]}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	messages := payload.ExtractMessages()
	if len(messages) != 1 || messages[0].Type != "reaction" {
		t.Fatalf("messages: %+v", messages)
	}
}

func TestParsePayloadStatuses(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"id": "WABA1",
			"changes": [{
				"field": "messages",
				"value": {
					"metadata": {"phone_number_id": "111222"},
					"statuses": [
						{"id": "wamid.S1", "status": "delivered", "timestamp": "1710000001", "recipient_id": "1555"},
						{"id": "wamid.S2", "status": "failed", "timestamp": "1710000002", "recipient_id": "1555",
						 "errors": [{"code": 131026, "title": "Message undeliverable", "message": "Message failed to send.",
									 "error_user_msg": "The customer's number is not on WhatsApp.", "error_data": {"details": "more detail"}}]}
					]
				}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	statuses := payload.ExtractStatuses()
	if len(statuses) != 2 {
		t.Fatalf("statuses: %+v", statuses)
	}
	if statuses[0].MessageID != "wamid.S1" || statuses[0].Status != "delivered" || statuses[0].ErrorCode != 0 {
		t.Fatalf("status: %+v", statuses[0])
	}
	if !statuses[0].Timestamp.Equal(time.Unix(1710000001, 0)) {
		t.Fatalf("timestamp: %s", statuses[0].Timestamp)
	}
	failed := statuses[1]
	if failed.MessageID != "wamid.S2" || failed.Status != "failed" || failed.ErrorCode != 131026 {
		t.Fatalf("status: %+v", failed)
	}
	if failed.UserMsg != "The customer's number is not on WhatsApp." {
		t.Fatalf("error message: %+v", failed)
	}
	if messages := payload.ExtractMessages(); len(messages) != 0 {
		t.Fatalf("messages: %+v", messages)
	}
}

func TestParsePayloadTemplateStatus(t *testing.T) {
	body := []byte(`{
		"entry": [{
			"id": "WABA1",
			"changes": [{
				"field": "message_template_status_update",
				"value": {"event": "APPROVED", "message_template_id": 123456789012345,
						  "message_template_name": "order_update", "message_template_language": "en_US"}
			}]
		}]
	}`)
	payload, err := ParsePayload(body)
	if err != nil {
		t.Fatal(err)
	}
	value := payload.Entry[0].Changes[0].Value
	if value.Event != "APPROVED" || value.MessageTemplateName != "order_update" || value.MessageTemplateLanguage != "en_US" {
		t.Fatalf("template status: %+v", value.TemplateStatus)
	}
	if value.MessageTemplateID.String() != "123456789012345" {
		t.Fatalf("template id: %q", value.MessageTemplateID)
	}
}

func TestParsePayloadRejectsBadJSON(t *testing.T) {
	if _, err := ParsePayload([]byte(`{"entry":`)); err == nil {
		t.Fatal("accepted broken JSON")
	}
	if _, err := ParsePayload(nil); err == nil {
		t.Fatal("accepted an empty body")
	}
}

func TestVerifySignature(t *testing.T) {
	body := []byte(`{"object":"whatsapp_business_account"}`)
	secret := "app-secret"
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !VerifySignature(body, signature, secret) {
		t.Fatal("refused a valid signature")
	}
	if VerifySignature([]byte(`{"other":true}`), signature, secret) {
		t.Fatal("accepted a signature for another body")
	}
	if VerifySignature(body, "sha256=deadbeef", secret) {
		t.Fatal("accepted a wrong signature")
	}
	if VerifySignature(body, signature, "") {
		t.Fatal("accepted a signature without a secret")
	}
	if VerifySignature(body, "", secret) {
		t.Fatal("accepted an empty signature header")
	}
	if VerifySignature(body, "sha1="+hex.EncodeToString(mac.Sum(nil)), secret) {
		t.Fatal("accepted a signature with another algorithm")
	}
	if VerifySignature(body, "sha256=not-hex", secret) {
		t.Fatal("accepted a malformed signature")
	}
}

func TestSendText(t *testing.T) {
	var method, path, auth, contentType string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		auth, contentType = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body: %v", err)
		}
		_, _ = w.Write([]byte(`{"messaging_product":"whatsapp","contacts":[{"input":"+15551234567","wa_id":"15551234567"}],
			"messages":[{"id":"wamid.accepted","message_status":"accepted"}]}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	id, err := client.SendText(context.Background(),
		Account{PhoneNumberID: "123456", AccessToken: "access-token"}, "+15551234567", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if id != "wamid.accepted" {
		t.Fatalf("message id: %q", id)
	}
	if method != http.MethodPost || path != "/v26.0/123456/messages" {
		t.Fatalf("request: %s %s", method, path)
	}
	if auth != "Bearer access-token" {
		t.Fatalf("authorization: %q", auth)
	}
	if contentType != "application/json" {
		t.Fatalf("content type: %q", contentType)
	}
	if body["messaging_product"] != "whatsapp" || body["to"] != "+15551234567" || body["type"] != "text" {
		t.Fatalf("body: %+v", body)
	}
	text, ok := body["text"].(map[string]any)
	if !ok || text["body"] != "hello" {
		t.Fatalf("body: %+v", body)
	}
}

func TestSendTextUsesAccountVersion(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"messages":[{"id":"wamid.x"}]}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL + "/")
	_, err := client.SendText(context.Background(),
		Account{PhoneNumberID: "123", AccessToken: "token", APIVersion: "v19.0"}, "1555", "hi")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v19.0/123/messages" {
		t.Fatalf("path: %q", path)
	}
}

func TestSendTextMetaAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Unsupported post request.","type":"GraphMethodException",
			"code":100,"error_subcode":33,"error_user_msg":"Re-engage the customer first."}}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	_, err := client.SendText(context.Background(),
		Account{PhoneNumberID: "123", AccessToken: "access-token"}, "1555", "hi")
	var apiErr *MetaAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type: %v", err)
	}
	if apiErr.StatusCode != http.StatusBadRequest || apiErr.Code != 100 || apiErr.Subcode != 33 {
		t.Fatalf("error: %+v", apiErr)
	}
	if apiErr.Message != "Unsupported post request." || apiErr.UserMsg != "Re-engage the customer first." {
		t.Fatalf("error: %+v", apiErr)
	}
	if apiErr.Error() != "Re-engage the customer first." {
		t.Fatalf("error text: %q", apiErr.Error())
	}
	if strings.Contains(err.Error(), "access-token") {
		t.Fatalf("error leaks the access token: %v", err)
	}
}

func TestSendTextNonJSONError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>bad gateway</html>`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	_, err := client.SendText(context.Background(), Account{PhoneNumberID: "123", AccessToken: "t"}, "1", "hi")
	var apiErr *MetaAPIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("error: %v", err)
	}
	if apiErr.Error() != "whatsapp: request failed with status 502" {
		t.Fatalf("error text: %q", apiErr.Error())
	}
}

func TestMetaAPIErrorText(t *testing.T) {
	tests := []struct {
		name string
		err  *MetaAPIError
		want string
	}{
		{"user message first", &MetaAPIError{StatusCode: 400, Message: "developer", UserMsg: "customer"}, "customer"},
		{"message second", &MetaAPIError{StatusCode: 400, Message: "developer"}, "developer"},
		{"status fallback", &MetaAPIError{StatusCode: 503}, "whatsapp: request failed with status 503"},
		{"no status", &MetaAPIError{}, "whatsapp: request failed"},
	}
	for _, tt := range tests {
		if got := tt.err.Error(); got != tt.want {
			t.Fatalf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestSendTemplate(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body: %v", err)
		}
		_, _ = w.Write([]byte(`{"messages":[{"id":"wamid.template"}]}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	components := []map[string]any{{"type": "body", "parameters": []map[string]any{{"type": "text", "text": "Ada"}}}}
	id, err := client.SendTemplate(context.Background(),
		Account{PhoneNumberID: "123", AccessToken: "token"}, "1555", "order_update", "en_US", components)
	if err != nil {
		t.Fatal(err)
	}
	if id != "wamid.template" {
		t.Fatalf("message id: %q", id)
	}
	if body["type"] != "template" || body["to"] != "1555" {
		t.Fatalf("body: %+v", body)
	}
	template, ok := body["template"].(map[string]any)
	if !ok {
		t.Fatalf("body: %+v", body)
	}
	if template["name"] != "order_update" {
		t.Fatalf("template: %+v", template)
	}
	language, ok := template["language"].(map[string]any)
	if !ok || language["code"] != "en_US" {
		t.Fatalf("template: %+v", template)
	}
	if _, ok := template["components"]; !ok {
		t.Fatalf("template components missing: %+v", template)
	}
}

func TestValidateCredentials(t *testing.T) {
	var numberAuth, numbersAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v26.0/111":
			numberAuth = r.Header.Get("Authorization")
			if got := r.URL.Query().Get("fields"); got != "display_phone_number,verified_name" {
				t.Errorf("fields: %q", got)
			}
			_, _ = w.Write([]byte(`{"id":"111","display_phone_number":"+1 555 000 1111","verified_name":"Acme"}`))
		case "/v26.0/222/phone_numbers":
			numbersAuth = r.Header.Get("Authorization")
			if got := r.URL.Query().Get("fields"); got != "id" {
				t.Errorf("fields: %q", got)
			}
			if got := r.URL.Query().Get("limit"); got != "100" {
				t.Errorf("limit: %q", got)
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"999"},{"id":"111"}]}`))
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	info, err := client.ValidateCredentials(context.Background(),
		Account{PhoneNumberID: "111", WABAID: "222", AccessToken: "token"})
	if err != nil {
		t.Fatal(err)
	}
	if info.DisplayPhoneNumber != "+1 555 000 1111" || info.VerifiedName != "Acme" {
		t.Fatalf("account info: %+v", info)
	}
	if numberAuth != "Bearer token" || numbersAuth != "Bearer token" {
		t.Fatalf("authorization: %q, %q", numberAuth, numbersAuth)
	}
}

func TestValidateCredentialsRefusesForeignNumber(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v26.0/111" {
			_, _ = w.Write([]byte(`{"display_phone_number":"+1","verified_name":"Acme"}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"999"}]}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	if _, err := client.ValidateCredentials(context.Background(),
		Account{PhoneNumberID: "111", WABAID: "222", AccessToken: "token"}); err == nil {
		t.Fatal("accepted a number outside the WABA")
	}
}

func TestSubscribeWebhook(t *testing.T) {
	type post struct {
		path string
		body map[string]any
	}
	var posts []post
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		record := post{path: r.URL.Path}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&record.body)
		}
		posts = append(posts, record)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	if err := client.SubscribeWebhook(context.Background(),
		Account{WABAID: "222", AccessToken: "token"}, "https://desk.example/v1/whatsapp/hooks/1", "verify-token"); err != nil {
		t.Fatal(err)
	}
	if len(posts) != 2 {
		t.Fatalf("requests: %+v", posts)
	}
	for _, recorded := range posts {
		if recorded.path != "/v26.0/222/subscribed_apps" {
			t.Fatalf("path: %q", recorded.path)
		}
	}
	if posts[0].body != nil {
		t.Fatalf("first request body: %+v", posts[0].body)
	}
	if posts[1].body["override_callback_uri"] != "https://desk.example/v1/whatsapp/hooks/1" ||
		posts[1].body["verify_token"] != "verify-token" {
		t.Fatalf("second request body: %+v", posts[1].body)
	}
}

func TestGetMediaURL(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"url":"https://lookaside.fbsbx.com/whatsapp/1","mime_type":"image/jpeg","file_size":1234,"id":"media-1"}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	info, err := client.GetMediaURL(context.Background(),
		Account{AccessToken: "token"}, "media-1")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v26.0/media-1" {
		t.Fatalf("path: %q", path)
	}
	if info.URL != "https://lookaside.fbsbx.com/whatsapp/1" || info.MimeType != "image/jpeg" ||
		info.FileSize != 1234 || info.ID != "media-1" {
		t.Fatalf("media info: %+v", info)
	}
}

func TestUploadMedia(t *testing.T) {
	var path, auth, contentType, product, kind, filename string
	var content []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, auth = r.URL.Path, r.Header.Get("Authorization")
		contentType = r.Header.Get("Content-Type")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart: %v", err)
			return
		}
		product, kind = r.FormValue("messaging_product"), r.FormValue("type")
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Errorf("file: %v", err)
			return
		}
		defer file.Close()
		if content, err = io.ReadAll(file); err != nil {
			t.Errorf("file: %v", err)
		}
		filename = header.Filename
		_, _ = w.Write([]byte(`{"id":"media-uploaded"}`))
	}))
	defer server.Close()
	client := NewClient(server.Client())
	client.SetBaseURL(server.URL)
	id, err := client.UploadMedia(context.Background(),
		Account{PhoneNumberID: "123", AccessToken: "token"}, []byte("image-bytes"), "image/png", "photo.png")
	if err != nil {
		t.Fatal(err)
	}
	if id != "media-uploaded" || path != "/v26.0/123/media" || auth != "Bearer token" {
		t.Fatalf("upload: %q %q %q", id, path, auth)
	}
	if !strings.HasPrefix(contentType, "multipart/form-data") {
		t.Fatalf("content type: %q", contentType)
	}
	if product != "whatsapp" || kind != "image" || filename != "photo.png" || string(content) != "image-bytes" {
		t.Fatalf("form: %q %q %q %q", product, kind, filename, content)
	}
}

func TestMediaKind(t *testing.T) {
	tests := map[string]string{
		"image/png":                 "image",
		"video/mp4":                 "video",
		"audio/ogg":                 "audio",
		"application/pdf":           "document",
		"text/plain; charset=utf-8": "document",
		"":                          "document",
		"IMAGE/JPEG":                "image",
	}
	for contentType, want := range tests {
		if got := mediaKind(contentType); got != want {
			t.Fatalf("%q: %q, want %q", contentType, got, want)
		}
	}
}

func TestDownloadMediaRefusesForeignURLs(t *testing.T) {
	client := NewClient(nil)
	tests := []string{
		"http://graph.facebook.com/media/1",
		"https://example.com/media/1",
		"https://lookaside.fbsbx.com.evil.example/media/1",
		"https://127.0.0.1/media/1",
		"",
	}
	for _, mediaURL := range tests {
		if _, err := client.DownloadMedia(context.Background(), Account{AccessToken: "token"}, mediaURL, 1024); err == nil {
			t.Fatalf("downloaded %q", mediaURL)
		}
	}
}

func TestAllowedMediaHost(t *testing.T) {
	allowed := []string{"graph.facebook.com", "lookaside.fbsbx.com", "fbsbx.com", "a.b.fbsbx.com", "Graph.Facebook.com."}
	for _, host := range allowed {
		if !allowedMediaHost(host) {
			t.Fatalf("refused %q", host)
		}
	}
	refused := []string{"example.com", "fbsbx.com.evil.example", "notfbsbx.com", "facebook.com", "127.0.0.1", ""}
	for _, host := range refused {
		if allowedMediaHost(host) {
			t.Fatalf("allowed %q", host)
		}
	}
}

func TestNewClientDefaults(t *testing.T) {
	client := NewClient(nil)
	if client.baseURL != graphAPI {
		t.Fatalf("base URL: %q", client.baseURL)
	}
	if client.http.Timeout != 15*time.Second {
		t.Fatalf("timeout: %s", client.http.Timeout)
	}
	if client.http.CheckRedirect == nil || client.download == nil {
		t.Fatal("client is not configured for provider requests")
	}
	client.SetBaseURL(" http://example.test/api/ ")
	if client.baseURL != "http://example.test/api" {
		t.Fatalf("base URL: %q", client.baseURL)
	}
}
