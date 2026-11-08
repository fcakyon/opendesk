package hd

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// WidgetTopic is a choice the widget offers before the first message; the pick routes
// the conversation to TeamID (contracts/teams.md).
type WidgetTopic struct {
	ID     string     `json:"id"`
	Label  string     `json:"label"`
	TeamID *uuid.UUID `json:"team_id"`
}

// WidgetSettings lives in widgets.settings. The default brand's first widget is also
// mirrored to workspaces.settings.widget, where workspace-wide readers (the AI agent's
// name) find it.
type WidgetSettings struct {
	Greeting       string   `json:"greeting"`
	Intro          string   `json:"intro" doc:"Under the greeting in a new chat; empty = the translated default"`
	ChatWelcome    bool     `json:"chat_welcome" doc:"A new chat opens with the greeting and intro; off, it opens empty"`
	RequireEmail   bool     `json:"require_email"`
	Enabled        bool     `json:"enabled"`
	AllowedOrigins []string `json:"allowed_origins"`
	// Appearance (contracts/api.md "Widget"). Keys missing from a stored document read
	// as their defaults.
	Color         string   `json:"color" doc:"#rrggbb, or empty for the workspace brand colour"`
	Theme         string   `json:"theme" enum:"auto,light,dark"`
	Position      string   `json:"position" enum:"right,left"`
	OffsetX       int      `json:"offset_x" minimum:"0" maximum:"200"`
	OffsetY       int      `json:"offset_y" minimum:"0" maximum:"200"`
	ZIndex        int      `json:"z_index" minimum:"0" maximum:"2147483647" doc:"The widget's stacking order on the page; 0 = the default, above the page"`
	Launcher      string   `json:"launcher" enum:"icon,label"`
	LauncherLabel string   `json:"launcher_label"`
	Radius        string   `json:"radius" enum:"square,soft,round"`
	Title         string   `json:"title"`
	Subtitle      string   `json:"subtitle"`
	ShowTeam      bool     `json:"show_team"`
	Suggestions   []string `json:"suggestions"`
	Sound         bool     `json:"sound"`
	// Routing and offline behaviour (contracts/teams.md).
	Topics         []WidgetTopic `json:"topics"`
	OfflineMessage string        `json:"offline_message"`
	EmailFollowUp  bool          `json:"email_follow_up"`
	ForwardEmail   string        `json:"forward_email" doc:"Private recipient for full visitor messages, empty disables forwarding"`
	// Attachments lets visitors send files: of AttachmentTypes (FileTypes ids), or any
	// file but a program or a script when that is empty.
	Attachments     bool     `json:"attachments"`
	AttachmentTypes []string `json:"attachment_types"`
	// VoiceMessages lets visitors record voice messages of up to VoiceMaxSeconds.
	VoiceMessages   bool `json:"voice_messages"`
	VoiceMaxSeconds int  `json:"voice_max_seconds"`
}

// The range of a widget's longest voice message, in seconds.
const (
	MinVoiceSeconds = 5
	MaxVoiceSeconds = 300
)

// DefaultWidgetSettings are the settings of a workspace that never changed them.
func DefaultWidgetSettings() WidgetSettings {
	return WidgetSettings{Greeting: "Hi! How can we help?", Enabled: true, AllowedOrigins: []string{},
		Theme: "auto", Position: "right", OffsetX: 20, OffsetY: 20, Launcher: "icon", Radius: "soft",
		ChatWelcome: true, ShowTeam: true, Suggestions: []string{}, Topics: []WidgetTopic{}, EmailFollowUp: true, Attachments: true,
		AttachmentTypes: []string{}, VoiceMaxSeconds: 60}
}

// UnmarshalJSON fills keys missing from a stored document with their defaults.
func (w *WidgetSettings) UnmarshalJSON(b []byte) error {
	type plain WidgetSettings
	v := plain(DefaultWidgetSettings())
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*w = WidgetSettings(v)
	w.normalize()
	return nil
}

// normalize replaces values outside their allowed sets with defaults.
func (w *WidgetSettings) normalize() {
	d := DefaultWidgetSettings()
	if !slices.Contains([]string{"auto", "light", "dark"}, w.Theme) {
		w.Theme = d.Theme
	}
	if w.Position != "left" {
		w.Position = "right"
	}
	if w.Launcher != "label" {
		w.Launcher = "icon"
	}
	if !slices.Contains([]string{"square", "soft", "round"}, w.Radius) {
		w.Radius = d.Radius
	}
	w.OffsetX, w.OffsetY = min(max(w.OffsetX, 0), 200), min(max(w.OffsetY, 0), 200)
	w.ZIndex = min(max(w.ZIndex, 0), math.MaxInt32)
	if w.AllowedOrigins == nil {
		w.AllowedOrigins = []string{}
	}
	if w.Suggestions == nil {
		w.Suggestions = []string{}
	}
	if w.Topics == nil {
		w.Topics = []WidgetTopic{}
	}
	if w.VoiceMaxSeconds < MinVoiceSeconds || w.VoiceMaxSeconds > MaxVoiceSeconds {
		w.VoiceMaxSeconds = d.VoiceMaxSeconds
	}
	// Ids this version does not know are dropped; a list of only those stays, and takes
	// nothing, rather than opening the widget to any file.
	if known := knownFileTypes(w.AttachmentTypes); len(known) > 0 || len(w.AttachmentTypes) == 0 {
		w.AttachmentTypes = known
	}
}

// ParseWidgetSettings decodes a stored widget settings document with defaults; a
// malformed document reads as the defaults.
func ParseWidgetSettings(raw []byte) WidgetSettings {
	var w WidgetSettings
	if len(raw) == 0 || json.Unmarshal(raw, &w) != nil {
		return DefaultWidgetSettings()
	}
	return w
}

// Settings is the helpdesk's view of workspaces.settings. Unknown keys are kept by
// writers that patch individual keys with jsonb operators.
type Settings struct {
	BrandColor        string `json:"brand_color"`
	Timezone          string `json:"timezone"`
	HelpCenterEnabled bool   `json:"help_center_enabled"`
	HelpCenterTitle   string `json:"help_center_title"`
	CSATEnabled       bool   `json:"csat_enabled"`
	AutoAssign        string `json:"auto_assign"`
	// AutoAwayMinutes marks an online member away after this long unseen; 0 = off.
	AutoAwayMinutes int `json:"auto_away_minutes"`
	// NewTicketNotifyRaw is settings.new_ticket_notify; read it with NewTicketNotify().
	NewTicketNotifyRaw string `json:"new_ticket_notify"`
	// FollowUpKeepsAssignee gives a follow-up of a closed ticket (an email answering it opens a
	// new ticket) to the closed ticket's assignee. Default false.
	FollowUpKeepsAssignee bool `json:"followup_keeps_assignee"`
	// BusinessHoursRaw is settings.business_hours; read it with Hours().
	BusinessHoursRaw json.RawMessage `json:"business_hours"`
	// Locale is the default language (BCP 47) of customer-facing pages; "" = the visitor's browser.
	Locale string `json:"locale"`
	// LocaleFixed: customer-facing pages always use the locale (a brand's own, else this one).
	LocaleFixed bool `json:"locale_fixed"`
	// AutoCloseDays closes solved tickets after this many days; nil = 7, 0 = never.
	AutoCloseDays *int            `json:"auto_close_days"`
	Widget        *WidgetSettings `json:"widget"`
	// AIRaw is settings.ai; read it with AI().
	AIRaw json.RawMessage `json:"ai"`
}

// Who hears about a new ticket nobody is assigned to (settings.new_ticket_notify,
// contracts/api.md "Assignment").
const (
	// NewTicketNotifyAuto: everyone on small teams, else only the leads.
	NewTicketNotifyAuto     = "auto"
	NewTicketNotifyEveryone = "everyone"
	NewTicketNotifyLeads    = "leads"
	NewTicketNotifyOff      = "off"
)

// NewTicketNotifyModes are the values of settings.new_ticket_notify.
var NewTicketNotifyModes = []string{NewTicketNotifyAuto, NewTicketNotifyEveryone, NewTicketNotifyLeads, NewTicketNotifyOff}

// NewTicketNotify returns settings.new_ticket_notify; empty or unknown reads as auto.
func (s Settings) NewTicketNotify() string {
	if slices.Contains(NewTicketNotifyModes, s.NewTicketNotifyRaw) {
		return s.NewTicketNotifyRaw
	}
	return NewTicketNotifyAuto
}

// DefaultAutoCloseDays applies when settings.auto_close_days is not set.
const DefaultAutoCloseDays = 7

// AutoClose returns the auto-close delay in days (0 = disabled).
func (s Settings) AutoClose() int {
	if s.AutoCloseDays == nil {
		return DefaultAutoCloseDays
	}
	if *s.AutoCloseDays < 0 {
		return 0
	}
	return *s.AutoCloseDays
}

// WidgetOrDefault returns the widget settings with defaults filled in.
func (s Settings) WidgetOrDefault() WidgetSettings {
	if s.Widget == nil {
		return DefaultWidgetSettings()
	}
	w := *s.Widget
	w.normalize()
	return w
}

// Location returns the workspace timezone, UTC when unset or unknown.
func (s Settings) Location() *time.Location {
	if s.Timezone != "" {
		if loc, err := time.LoadLocation(s.Timezone); err == nil {
			return loc
		}
	}
	return time.UTC
}

// ParseSettings decodes a settings document leniently: a malformed key falls back to
// its zero value rather than failing the request.
func ParseSettings(raw []byte) Settings {
	var s Settings
	if len(raw) == 0 {
		return s
	}
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return Settings{}
	}
	s = Settings{}
	field := func(k string, v any) {
		if r, ok := m[k]; ok {
			_ = json.Unmarshal(r, v)
		}
	}
	field("brand_color", &s.BrandColor)
	field("timezone", &s.Timezone)
	field("help_center_enabled", &s.HelpCenterEnabled)
	field("help_center_title", &s.HelpCenterTitle)
	field("csat_enabled", &s.CSATEnabled)
	field("auto_assign", &s.AutoAssign)
	field("auto_away_minutes", &s.AutoAwayMinutes)
	field("new_ticket_notify", &s.NewTicketNotifyRaw)
	field("followup_keeps_assignee", &s.FollowUpKeepsAssignee)
	field("business_hours", &s.BusinessHoursRaw)
	field("auto_close_days", &s.AutoCloseDays)
	field("ai", &s.AIRaw)
	var w WidgetSettings
	if r, ok := m["widget"]; ok && json.Unmarshal(r, &w) == nil {
		s.Widget = &w
	}
	return s
}

// LoadSettings reads a workspace's settings.
func LoadSettings(ctx context.Context, q db.Querier, wid uuid.UUID) (Settings, error) {
	var raw []byte
	if err := q.QueryRow(ctx, `SELECT settings FROM workspaces WHERE id = $1`, wid).Scan(&raw); err != nil {
		return Settings{}, err
	}
	return ParseSettings(raw), nil
}
