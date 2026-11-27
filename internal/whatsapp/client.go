package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

const (
	// graphAPI is Meta's Graph API. SetBaseURL points the client elsewhere in tests only.
	graphAPI = "https://graph.facebook.com"
	// maxGraphResponse bounds what one Graph answer may buffer.
	maxGraphResponse = 1 << 20
	// defaultMaxMedia bounds a media download a caller gives no limit for.
	defaultMaxMedia = 16 << 20
	// maxMediaRedirects is how many redirects a media download follows.
	maxMediaRedirects = 3
)

// Client is a Meta Graph API client for the WhatsApp Cloud API. It holds the connection's
// access token only in the request header, never in a URL, an error or a log line. Its URLs
// are built from constants and ids, never from outside input; the media downloader is the
// one call that takes a URL, so it is restricted to Meta's media hosts.
type Client struct {
	http     *http.Client
	download *http.Client
	baseURL  string
}

// NewClient returns a Graph API client. A nil hc gives the provider default: a 15-second
// timeout and no redirects. A caller's client is used as it is, so tests can point it at an
// httptest server.
func NewClient(hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	timeout := hc.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		http: hc,
		download: &http.Client{
			Transport: hc.Transport,
			Timeout:   timeout,
			// A media URL answers with a redirect to lookaside.fbsbx.com. Only Meta's media
			// hosts may be the target, and the token rides along to them: the request stays
			// inside the one provider.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= maxMediaRedirects {
					return errors.New("whatsapp: media download redirected too many times")
				}
				if req.URL.Scheme != "https" || !allowedMediaHost(req.URL.Hostname()) {
					return errors.New("whatsapp: media download redirected outside Meta's media hosts")
				}
				if token := via[0].Header.Get("Authorization"); token != "" {
					req.Header.Set("Authorization", token)
				}
				return nil
			},
		},
		baseURL: graphAPI,
	}
}

// SetBaseURL points the client at another Graph API host. Tests only; a connection's base
// URL is never user input.
func (c *Client) SetBaseURL(u string) {
	if u = strings.TrimSpace(u); u != "" {
		c.baseURL = strings.TrimRight(u, "/")
	}
}

// MetaAPIError is a refused Graph API request: the HTTP status and the fields Meta's error
// body carries. UserMsg is Meta's message for the end user when it sent one; Message is the
// developer-facing one. Neither ever includes the access token.
type MetaAPIError struct {
	StatusCode int
	Code       int
	Subcode    int
	Message    string
	UserMsg    string
}

// Error returns Meta's user-facing text first, then its message, and a description of the
// status when it sent neither.
func (e *MetaAPIError) Error() string {
	switch {
	case e.UserMsg != "":
		return e.UserMsg
	case e.Message != "":
		return e.Message
	case e.StatusCode != 0:
		return fmt.Sprintf("whatsapp: request failed with status %d", e.StatusCode)
	default:
		return "whatsapp: request failed"
	}
}

// AccountInfo is what a connection's number reports about itself when credentials are
// checked: the display number and the verified business name.
type AccountInfo struct {
	DisplayPhoneNumber string
	VerifiedName       string
}

// MediaInfo is one media object's metadata on the Graph API. URL is the short-lived URL the
// media itself is downloaded from.
type MediaInfo struct {
	URL      string
	MimeType string
	FileSize int64
	ID       string
}

// TemplateComponent is one component of a Meta message template as the Graph API lists it.
type TemplateComponent struct {
	Type    string           `json:"type"`
	Format  string           `json:"format,omitempty"`
	Text    string           `json:"text,omitempty"`
	Buttons []map[string]any `json:"buttons,omitempty"`
	Example map[string]any   `json:"example,omitempty"`
}

// MetaTemplate is one message template of the connection's WhatsApp Business account.
type MetaTemplate struct {
	ID         string              `json:"id"`
	Name       string              `json:"name"`
	Language   string              `json:"language"`
	Category   string              `json:"category"`
	Status     string              `json:"status"`
	Components []TemplateComponent `json:"components"`
}

// FetchTemplates lists every message template of the connection's WhatsApp Business
// account, following Meta's pages. The list is what the settings page syncs and what an
// agent picks a template from outside the 24-hour window.
func (c *Client) FetchTemplates(ctx context.Context, acc Account) ([]MetaTemplate, error) {
	if strings.TrimSpace(acc.WABAID) == "" {
		return nil, errors.New("whatsapp: the account has no WhatsApp Business account id")
	}
	var out []MetaTemplate
	path := "/" + url.PathEscape(acc.WABAID) + "/message_templates?limit=100"
	endpoint := ""
	for page := 0; page < 50; page++ {
		var res struct {
			Data   []MetaTemplate `json:"data"`
			Paging struct {
				Next string `json:"next"`
			} `json:"paging"`
		}
		var err error
		if page == 0 {
			err = c.sendJSON(ctx, acc, "list templates", http.MethodGet, path, nil, &res)
		} else {
			// Meta's next page is an absolute URL on the Graph API; it is checked there.
			err = c.sendJSONURL(ctx, acc, "list templates", http.MethodGet, endpoint, nil, &res)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, res.Data...)
		endpoint = res.Paging.Next
		if endpoint == "" {
			break
		}
	}
	return out, nil
}

// SendMedia sends one uploaded media object (UploadMedia's id) with an optional caption and
// document filename, and returns the WhatsApp message id.
func (c *Client) SendMedia(ctx context.Context, acc Account, to, kind, mediaID, caption, filename string) (string, error) {
	switch kind {
	case "image", "video", "audio", "document":
	default:
		return "", fmt.Errorf("whatsapp: unsupported media kind %q", kind)
	}
	if strings.TrimSpace(mediaID) == "" {
		return "", errors.New("whatsapp: no media id")
	}
	media := map[string]any{"id": mediaID}
	if caption = strings.TrimSpace(caption); caption != "" && kind != "audio" {
		media["caption"] = caption
	}
	if kind == "document" && strings.TrimSpace(filename) != "" {
		media["filename"] = strings.TrimSpace(filename)
	}
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              kind,
		kind:                media,
	}
	return c.send(ctx, acc, "send media", payload)
}

// ValidateCredentials checks that the access token reads the number and that the number
// belongs to the WhatsApp Business account, and returns what the number calls itself. The
// number list is read with the API's largest page; a WABA with more numbers than that is
// not supported by this check.
func (c *Client) ValidateCredentials(ctx context.Context, acc Account) (AccountInfo, error) {
	if strings.TrimSpace(acc.PhoneNumberID) == "" {
		return AccountInfo{}, errors.New("whatsapp: the account has no phone number id")
	}
	if strings.TrimSpace(acc.WABAID) == "" {
		return AccountInfo{}, errors.New("whatsapp: the account has no WhatsApp Business account id")
	}
	var number struct {
		DisplayPhoneNumber string `json:"display_phone_number"`
		VerifiedName       string `json:"verified_name"`
	}
	query := url.Values{"fields": {"display_phone_number,verified_name"}}
	path := "/" + url.PathEscape(acc.PhoneNumberID) + "?" + query.Encode()
	if err := c.sendJSON(ctx, acc, "validate credentials", http.MethodGet, path, nil, &number); err != nil {
		return AccountInfo{}, err
	}
	var numbers struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	query = url.Values{"fields": {"id"}, "limit": {"100"}}
	path = "/" + url.PathEscape(acc.WABAID) + "/phone_numbers?" + query.Encode()
	if err := c.sendJSON(ctx, acc, "list phone numbers", http.MethodGet, path, nil, &numbers); err != nil {
		return AccountInfo{}, err
	}
	for _, candidate := range numbers.Data {
		if candidate.ID == acc.PhoneNumberID {
			return AccountInfo{DisplayPhoneNumber: number.DisplayPhoneNumber, VerifiedName: number.VerifiedName}, nil
		}
	}
	return AccountInfo{}, fmt.Errorf("whatsapp: phone number %s is not part of the WhatsApp Business account %s", acc.PhoneNumberID, acc.WABAID)
}

// SendText sends a free-form text message inside Meta's customer service window and returns
// its WhatsApp message id.
func (c *Client) SendText(ctx context.Context, acc Account, to, body string) (string, error) {
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "text",
		"text":              map[string]any{"preview_url": false, "body": body},
	}
	return c.send(ctx, acc, "send text", payload)
}

// SendTemplate sends an approved template message outside the window and returns its
// WhatsApp message id. Components are Meta's template components, already built by the
// caller from the template's variables.
func (c *Client) SendTemplate(ctx context.Context, acc Account, to, name, language string, components []map[string]any) (string, error) {
	template := map[string]any{"name": name, "language": map[string]any{"code": language}}
	if len(components) > 0 {
		template["components"] = components
	}
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "template",
		"template":          template,
	}
	return c.send(ctx, acc, "send template", payload)
}

// SubscribeWebhook subscribes this instance's Meta app to the WhatsApp Business account and
// points deliveries at callbackURL, handing Meta verifyToken to echo back on the handshake.
func (c *Client) SubscribeWebhook(ctx context.Context, acc Account, callbackURL, verifyToken string) error {
	if strings.TrimSpace(acc.WABAID) == "" {
		return errors.New("whatsapp: the account has no WhatsApp Business account id")
	}
	path := "/" + url.PathEscape(acc.WABAID) + "/subscribed_apps"
	if err := c.sendJSON(ctx, acc, "subscribe webhook", http.MethodPost, path, nil, nil); err != nil {
		return err
	}
	override := map[string]any{"override_callback_uri": callbackURL, "verify_token": verifyToken}
	return c.sendJSON(ctx, acc, "override webhook", http.MethodPost, path, override, nil)
}

// GetMediaURL reads a media object's short-lived download URL and type.
func (c *Client) GetMediaURL(ctx context.Context, acc Account, mediaID string) (MediaInfo, error) {
	if strings.TrimSpace(mediaID) == "" {
		return MediaInfo{}, errors.New("whatsapp: no media id")
	}
	var media struct {
		URL      string `json:"url"`
		MimeType string `json:"mime_type"`
		FileSize int64  `json:"file_size"`
		ID       string `json:"id"`
	}
	if err := c.sendJSON(ctx, acc, "media url", http.MethodGet, "/"+url.PathEscape(mediaID), nil, &media); err != nil {
		return MediaInfo{}, err
	}
	if media.URL == "" {
		return MediaInfo{}, errors.New("whatsapp: Meta returned no media URL")
	}
	return MediaInfo{URL: media.URL, MimeType: media.MimeType, FileSize: media.FileSize, ID: media.ID}, nil
}

// DownloadMedia fetches a media URL Meta returned. Only https URLs on Meta's media hosts are
// fetched, redirects included, and more than maxBytes is refused rather than buffered.
func (c *Client) DownloadMedia(ctx context.Context, acc Account, mediaURL string, maxBytes int64) ([]byte, error) {
	parsed, err := url.Parse(strings.TrimSpace(mediaURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("whatsapp: media URL is not https")
	}
	if !allowedMediaHost(parsed.Hostname()) {
		return nil, fmt.Errorf("whatsapp: refusing to download media from %s", parsed.Hostname())
	}
	if maxBytes <= 0 {
		maxBytes = defaultMaxMedia
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("whatsapp: download media: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "*/*")
	res, err := c.download.Do(req)
	if err != nil {
		return nil, fmt.Errorf("whatsapp: download media: %w", transportError(err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, statusError(res)
	}
	if res.ContentLength > maxBytes {
		return nil, fmt.Errorf("whatsapp: media is larger than %d bytes", maxBytes)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("whatsapp: read media: %w", err)
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("whatsapp: media is larger than %d bytes", maxBytes)
	}
	return raw, nil
}

// UploadMedia uploads one attachment for a later message and returns Meta's media id. The
// media type is read from contentType: image, video and audio, anything else a document.
func (c *Client) UploadMedia(ctx context.Context, acc Account, content []byte, contentType, filename string) (string, error) {
	if strings.TrimSpace(acc.PhoneNumberID) == "" {
		return "", errors.New("whatsapp: the account has no phone number id")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("messaging_product", "whatsapp"); err != nil {
		return "", fmt.Errorf("whatsapp upload media: %w", err)
	}
	if err := writer.WriteField("type", mediaKind(contentType)); err != nil {
		return "", fmt.Errorf("whatsapp upload media: %w", err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{
		"name":     "file",
		"filename": filename,
	}))
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", fmt.Errorf("whatsapp upload media: %w", err)
	}
	if _, err := part.Write(content); err != nil {
		return "", fmt.Errorf("whatsapp upload media: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("whatsapp upload media: %w", err)
	}
	var media struct {
		ID string `json:"id"`
	}
	path := "/" + url.PathEscape(acc.PhoneNumberID) + "/media"
	if err := c.call(ctx, acc, "upload media", http.MethodPost, path, writer.FormDataContentType(), &body, &media); err != nil {
		return "", err
	}
	if media.ID == "" {
		return "", errors.New("whatsapp upload media: Meta returned no media id")
	}
	return media.ID, nil
}

// send posts one message payload to the connection's number and returns the message id Meta
// accepted it with.
func (c *Client) send(ctx context.Context, acc Account, op string, payload any) (string, error) {
	if strings.TrimSpace(acc.PhoneNumberID) == "" {
		return "", errors.New("whatsapp: the account has no phone number id")
	}
	var out struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	path := "/" + url.PathEscape(acc.PhoneNumberID) + "/messages"
	if err := c.sendJSON(ctx, acc, op, http.MethodPost, path, payload, &out); err != nil {
		return "", err
	}
	if len(out.Messages) == 0 || out.Messages[0].ID == "" {
		return "", fmt.Errorf("whatsapp %s: Meta returned no message id", op)
	}
	return out.Messages[0].ID, nil
}

// sendJSON makes one Graph API call with an optional JSON body.
func (c *Client) sendJSON(ctx context.Context, acc Account, op, method, path string, body any, out any) error {
	if body == nil {
		return c.call(ctx, acc, op, method, path, "", nil, out)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, err)
	}
	return c.call(ctx, acc, op, method, path, "application/json", bytes.NewReader(raw), out)
}

// call makes one Graph API request: bearer token, bounded response, Meta's error body on a
// refusal. A URL is never part of an error.
func (c *Client) call(ctx context.Context, acc Account, op, method, path, contentType string, body io.Reader, out any) error {
	rawURL := c.baseURL + "/" + graphVersion(acc) + path
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, err)
	}
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, transportError(err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return statusError(res)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxGraphResponse))
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxGraphResponse)).Decode(out); err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, err)
	}
	return nil
}

// sendJSONURL makes one Graph API call against an absolute URL Meta itself returned (a
// template page), after checking it stays on the Graph API host.
func (c *Client) sendJSONURL(ctx context.Context, acc Account, op, method, rawURL string, body any, out any) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "graph.facebook.com" {
		return fmt.Errorf("whatsapp %s: refusing a URL outside the Graph API", op)
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("whatsapp %s: %w", op, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, err)
	}
	req.Header.Set("Authorization", "Bearer "+acc.AccessToken)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("whatsapp %s: %w", op, transportError(err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return statusError(res)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxGraphResponse))
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, maxGraphResponse)).Decode(out)
}

// graphVersion is the Graph API version a connection uses, defaultAPIVersion unless the
// connection names one.
func graphVersion(acc Account) string {
	if version := strings.Trim(strings.TrimSpace(acc.APIVersion), "/"); version != "" {
		return version
	}
	return defaultAPIVersion
}

// statusError reads a refused answer as Meta's error body, falling back to the status alone
// when it is not JSON.
func statusError(res *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(res.Body, maxGraphResponse))
	var graph struct {
		Error struct {
			Message        string `json:"message"`
			Code           int    `json:"code"`
			ErrorSubcode   int    `json:"error_subcode"`
			ErrorUserTitle string `json:"error_user_title"`
			ErrorUserMsg   string `json:"error_user_msg"`
			ErrorData      struct {
				Details string `json:"details"`
			} `json:"error_data"`
		} `json:"error"`
	}
	failure := &MetaAPIError{StatusCode: res.StatusCode}
	if err := json.Unmarshal(raw, &graph); err != nil {
		return failure
	}
	failure.Code = graph.Error.Code
	failure.Subcode = graph.Error.ErrorSubcode
	failure.UserMsg = graph.Error.ErrorUserMsg
	failure.Message = graph.Error.Message
	if failure.Message == "" {
		failure.Message = graph.Error.ErrorData.Details
	}
	if failure.Message == "" {
		failure.Message = graph.Error.ErrorUserTitle
	}
	return failure
}

// transportError drops the URL from a transport error: the media URL is short-lived and the
// Graph URL carries ids, neither belongs in a log line.
func transportError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

// allowedMediaHost reports whether host is one Meta serves WhatsApp media from:
// graph.facebook.com or any fbsbx.com subdomain (lookaside.fbsbx.com answers the download).
func allowedMediaHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if host == "graph.facebook.com" || host == "fbsbx.com" {
		return true
	}
	return strings.HasSuffix(host, ".fbsbx.com")
}

// mediaKind is the upload type for a content type: image, video or audio, anything else a
// document.
func mediaKind(contentType string) string {
	kind := strings.ToLower(strings.TrimSpace(contentType))
	if index := strings.IndexByte(kind, ';'); index >= 0 {
		kind = strings.TrimSpace(kind[:index])
	}
	switch {
	case strings.HasPrefix(kind, "image/"):
		return "image"
	case strings.HasPrefix(kind, "video/"):
		return "video"
	case strings.HasPrefix(kind, "audio/"):
		return "audio"
	default:
		return "document"
	}
}
