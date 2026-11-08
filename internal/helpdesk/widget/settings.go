package widget

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

type widgetSettingsPatch struct {
	Greeting        *string    `json:"greeting,omitempty" maxLength:"2000"`
	Intro           *string    `json:"intro,omitempty" maxLength:"1000" doc:"Up to 200 characters; \"\" = the translated default"`
	ChatWelcome     *bool      `json:"chat_welcome,omitempty"`
	RequireEmail    *bool      `json:"require_email,omitempty"`
	Enabled         *bool      `json:"enabled,omitempty"`
	AllowedOrigins  *[]string  `json:"allowed_origins,omitempty" maxItems:"50"`
	Color           *string    `json:"color,omitempty" maxLength:"7" doc:"#rrggbb, or empty for the workspace brand colour"`
	Theme           *string    `json:"theme,omitempty" enum:"auto,light,dark"`
	Position        *string    `json:"position,omitempty" enum:"right,left"`
	OffsetX         *int       `json:"offset_x,omitempty" minimum:"0" maximum:"200"`
	OffsetY         *int       `json:"offset_y,omitempty" minimum:"0" maximum:"200"`
	ZIndex          *int       `json:"z_index,omitempty" minimum:"0" maximum:"2147483647" doc:"0 = the default, above the page"`
	Launcher        *string    `json:"launcher,omitempty" enum:"icon,label"`
	LauncherLabel   *string    `json:"launcher_label,omitempty" maxLength:"200"`
	Radius          *string    `json:"radius,omitempty" enum:"square,soft,round"`
	Title           *string    `json:"title,omitempty" maxLength:"200"`
	Subtitle        *string    `json:"subtitle,omitempty" maxLength:"400"`
	ShowTeam        *bool      `json:"show_team,omitempty"`
	Suggestions     *[]string  `json:"suggestions,omitempty" maxItems:"10"`
	Sound           *bool      `json:"sound,omitempty"`
	Topics          *[]topicIn `json:"topics,omitempty" maxItems:"20" doc:"At most 8; asked before the first message, the pick routes the conversation"`
	OfflineMessage  *string    `json:"offline_message,omitempty" maxLength:"1000" doc:"Up to 300 characters; \"\" = the translated default"`
	EmailFollowUp   *bool      `json:"email_follow_up,omitempty"`
	ForwardEmail    *string    `json:"forward_email,omitempty" maxLength:"254"`
	Attachments     *bool      `json:"attachments,omitempty"`
	AttachmentTypes *[]string  `json:"attachment_types,omitempty" maxItems:"50" doc:"Ids of the file type catalog (contracts/api.md); [] takes any file but a program or a script"`
	VoiceMessages   *bool      `json:"voice_messages,omitempty"`
	VoiceMaxSeconds *int       `json:"voice_max_seconds,omitempty" minimum:"5" maximum:"300" doc:"The longest voice message, in seconds"`
}

type topicIn struct {
	ID     string  `json:"id,omitempty" maxLength:"40" doc:"Kept when given; generated when empty"`
	Label  string  `json:"label" maxLength:"200" doc:"2..40 characters"`
	TeamID *string `json:"team_id,omitempty" required:"false" nullable:"true" doc:"Team id, or null"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// cleanLabel collapses whitespace in a short visitor-facing text and refuses markup and
// control characters.
func cleanLabel(field, s string, minLen, maxLen int) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	n := utf8.RuneCountInString(s)
	if s == "" && minLen == 0 {
		return "", nil
	}
	if n < max(minLen, 1) || n > maxLen || strings.ContainsAny(s, "<>") ||
		strings.IndexFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.In(r, unicode.Cf) }) >= 0 {
		return "", httpx.Validation(fmt.Sprintf("%s must be up to %d characters of plain text", field, maxLen))
	}
	return s, nil
}

func cleanGreeting(s string) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if utf8.RuneCountInString(s) > 300 {
		return "", httpx.Validation("greeting must be 300 characters or less")
	}
	for _, r := range s {
		if (unicode.IsControl(r) && r != '\n') || unicode.In(r, unicode.Cf) {
			return "", httpx.Validation("greeting contains characters that are not allowed")
		}
	}
	return s, nil
}

// cleanOrigin accepts https://host[:port], or http:// for localhost only, with no path.
func cleanOrigin(raw string) (string, error) {
	bad := httpx.Validation("allowed_origins entries must look like https://example.com")
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", bad
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Host)
	hostname := strings.ToLower(u.Hostname())
	switch scheme {
	case "https":
	case "http":
		if hostname != "localhost" && hostname != "127.0.0.1" && !strings.HasSuffix(hostname, ".localhost") {
			return "", httpx.Validation("allowed_origins must use https, except for localhost")
		}
	default:
		return "", bad
	}
	if port := u.Port(); port != "" {
		if _, err := net.LookupPort("tcp", port); err != nil {
			return "", bad
		}
	}
	if strings.ContainsAny(hostname, " *") {
		return "", bad
	}
	return scheme + "://" + host, nil
}

// applyPatch merges a settings patch into w and returns the changed keys. Referenced
// teams are checked to belong to the workspace.
func applyPatch(ctx context.Context, q db.Querier, wid uuid.UUID, w hd.WidgetSettings, b widgetSettingsPatch) (hd.WidgetSettings, []string, error) {
	var fields []string
	if b.Greeting != nil {
		g, err := cleanGreeting(*b.Greeting)
		if err != nil {
			return w, nil, err
		}
		w.Greeting = g
		fields = append(fields, "greeting")
	}
	if b.Intro != nil {
		m, err := cleanText("intro", *b.Intro, 200)
		if err != nil {
			return w, nil, err
		}
		w.Intro = m
		fields = append(fields, "intro")
	}
	if b.RequireEmail != nil {
		w.RequireEmail = *b.RequireEmail
		fields = append(fields, "require_email")
	}
	if b.Enabled != nil {
		w.Enabled = *b.Enabled
		fields = append(fields, "enabled")
	}
	if b.Color != nil {
		c := strings.TrimSpace(*b.Color)
		if c != "" && !hexColor.MatchString(c) {
			return w, nil, httpx.Validation("color must look like #1a2b3c")
		}
		w.Color = strings.ToLower(c)
		fields = append(fields, "color")
	}
	for name, pair := range map[string]struct {
		in  *string
		out *string
	}{"theme": {b.Theme, &w.Theme}, "position": {b.Position, &w.Position}, "launcher": {b.Launcher, &w.Launcher}, "radius": {b.Radius, &w.Radius}} {
		if pair.in != nil {
			*pair.out = *pair.in // huma checked the enum
			fields = append(fields, name)
		}
	}
	if b.OffsetX != nil {
		w.OffsetX = *b.OffsetX
		fields = append(fields, "offset_x")
	}
	if b.OffsetY != nil {
		w.OffsetY = *b.OffsetY
		fields = append(fields, "offset_y")
	}
	if b.ZIndex != nil {
		w.ZIndex = *b.ZIndex
		fields = append(fields, "z_index")
	}
	for name, t := range map[string]struct {
		in  *string
		out *string
		max int
	}{"launcher_label": {b.LauncherLabel, &w.LauncherLabel, 24}, "title": {b.Title, &w.Title, 40},
		"subtitle": {b.Subtitle, &w.Subtitle, 80}} {
		if t.in == nil {
			continue
		}
		v, err := cleanLabel(name, *t.in, 0, t.max)
		if err != nil {
			return w, nil, err
		}
		*t.out = v
		fields = append(fields, name)
	}
	if b.ChatWelcome != nil {
		w.ChatWelcome = *b.ChatWelcome
		fields = append(fields, "chat_welcome")
	}
	if b.ShowTeam != nil {
		w.ShowTeam = *b.ShowTeam
		fields = append(fields, "show_team")
	}
	if b.Sound != nil {
		w.Sound = *b.Sound
		fields = append(fields, "sound")
	}
	if b.ForwardEmail != nil {
		email, err := normalizeEmail(*b.ForwardEmail)
		if err != nil {
			return w, nil, err
		}
		w.ForwardEmail = email
		fields = append(fields, "forward_email")
	}
	if b.EmailFollowUp != nil {
		w.EmailFollowUp = *b.EmailFollowUp
		fields = append(fields, "email_follow_up")
	}
	if b.Attachments != nil {
		w.Attachments = *b.Attachments
		fields = append(fields, "attachments")
	}
	if b.AttachmentTypes != nil {
		types, err := hd.CleanFileTypes(*b.AttachmentTypes)
		if err != nil {
			return w, nil, err
		}
		w.AttachmentTypes = types
		fields = append(fields, "attachment_types")
	}
	if b.VoiceMessages != nil {
		w.VoiceMessages = *b.VoiceMessages
		fields = append(fields, "voice_messages")
	}
	if b.VoiceMaxSeconds != nil {
		if *b.VoiceMaxSeconds < hd.MinVoiceSeconds || *b.VoiceMaxSeconds > hd.MaxVoiceSeconds {
			return w, nil, httpx.Validation(fmt.Sprintf("voice_max_seconds must be %d to %d", hd.MinVoiceSeconds, hd.MaxVoiceSeconds))
		}
		w.VoiceMaxSeconds = *b.VoiceMaxSeconds
		fields = append(fields, "voice_max_seconds")
	}
	if b.OfflineMessage != nil {
		m, err := cleanText("offline_message", *b.OfflineMessage, 300)
		if err != nil {
			return w, nil, err
		}
		w.OfflineMessage = m
		fields = append(fields, "offline_message")
	}
	if b.Suggestions != nil {
		out := []string{}
		for _, sg := range *b.Suggestions {
			v, err := cleanLabel("each suggestion", sg, 2, 60)
			if err != nil {
				return w, nil, err
			}
			if !contains(out, v) {
				out = append(out, v)
			}
		}
		if len(out) > 4 {
			return w, nil, httpx.Validation("at most 4 suggestions")
		}
		w.Suggestions = out
		fields = append(fields, "suggestions")
	}
	if b.Topics != nil {
		topics, err := cleanTopics(ctx, q, wid, *b.Topics)
		if err != nil {
			return w, nil, err
		}
		w.Topics = topics
		fields = append(fields, "topics")
	}
	if b.AllowedOrigins != nil {
		if len(*b.AllowedOrigins) > 20 {
			return w, nil, httpx.Validation("at most 20 allowed_origins")
		}
		origins := []string{}
		for _, o := range *b.AllowedOrigins {
			c, err := cleanOrigin(o)
			if err != nil {
				return w, nil, err
			}
			if !contains(origins, c) {
				origins = append(origins, c)
			}
		}
		w.AllowedOrigins = origins
		fields = append(fields, "allowed_origins")
	}
	return w, fields, nil
}

var topicIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// cleanTopics checks the widget's topics: at most 8, labels of 2..40 characters, ids kept
// or generated, teams of this workspace.
func cleanTopics(ctx context.Context, q db.Querier, wid uuid.UUID, in []topicIn) ([]hd.WidgetTopic, error) {
	if len(in) > 8 {
		return nil, httpx.Validation("at most 8 topics")
	}
	out := make([]hd.WidgetTopic, 0, len(in))
	seen := map[string]bool{}
	for _, t := range in {
		label, err := cleanLabel("each topic label", t.Label, 2, 40)
		if err != nil {
			return nil, err
		}
		id := strings.TrimSpace(t.ID)
		if id == "" {
			id = "tp_" + strings.ToLower(crypto.RandomString(10))
		} else if !topicIDRe.MatchString(id) {
			return nil, httpx.Validation("topic ids are 1 to 40 letters, digits, _ or -")
		}
		if seen[id] {
			return nil, httpx.Validation("topic ids must be unique")
		}
		seen[id] = true
		var team *uuid.UUID
		if t.TeamID != nil && strings.TrimSpace(*t.TeamID) != "" {
			tid, err := hd.ParseRef(*t.TeamID, "team_id")
			if err != nil {
				return nil, err
			}
			if err := hd.CheckRef(ctx, q, wid, "team", tid); err != nil {
				return nil, err
			}
			team = &tid
		}
		out = append(out, hd.WidgetTopic{ID: id, Label: label, TeamID: team})
	}
	return out, nil
}

// cleanText checks a visitor-facing text of up to max characters; newlines are kept.
func cleanText(field, s string, max int) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if utf8.RuneCountInString(s) > max || strings.ContainsAny(s, "<>") {
		return "", httpx.Validation(fmt.Sprintf("%s must be up to %d characters of plain text", field, max))
	}
	for _, r := range s {
		if (unicode.IsControl(r) && r != '\n') || unicode.In(r, unicode.Cf) {
			return "", httpx.Validation(field + " contains characters that are not allowed")
		}
	}
	return s, nil
}

func (h *handler) registerSettings(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "get-widget-settings", Method: http.MethodGet, Path: "/v1/widget/settings",
		Summary: "Get chat widget settings", Description: "The default brand's first widget.", Tags: []string{"Widget"}},
		func(ctx context.Context, _ *struct{}) (*struct{ Body hd.WidgetSettings }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := brands.PrimaryWidgetID(ctx, h.d.DB.Pool, p.WorkspaceID)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Widget")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			g, err := h.loadWidget(ctx, h.d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body hd.WidgetSettings }{g.Settings}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-widget-settings", Method: http.MethodPatch, Path: "/v1/widget/settings",
		Summary: "Update chat widget settings", Description: "The default brand's first widget.", Tags: []string{"Widget"}},
		func(ctx context.Context, in *struct{ Body widgetSettingsPatch }) (*struct{ Body hd.WidgetSettings }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out hd.WidgetSettings
			err = h.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				id, err := brands.PrimaryWidgetID(ctx, tx, p.WorkspaceID)
				if db.IsNotFound(err) {
					return httpx.NotFound("Widget")
				}
				if err != nil {
					return err
				}
				g, err := h.update(ctx, tx, p, id, widgetPatch{Settings: &in.Body}, "widget.settings_updated")
				out = g.Settings
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body hd.WidgetSettings }{out}, nil
		})
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
