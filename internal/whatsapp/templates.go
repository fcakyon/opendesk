package whatsapp

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// templateApproved is the only status Meta lets a template go out with: the send re-reads it
// so a template that was paused or rejected after the sync is not sent.
const templateApproved = "APPROVED"

// whatsappTemplateRow is one message template as synced from Meta: the local copy of what
// the connection's WhatsApp Business account holds, with the status Meta last reported.
type whatsappTemplateRow struct {
	ID             uuid.UUID
	WorkspaceID    uuid.UUID
	ConnectionID   uuid.UUID
	MetaTemplateID string
	Name           string
	Language       string
	Category       string
	Status         string
	HeaderType     string
	HeaderContent  string
	BodyContent    string
	FooterContent  string
	// Buttons is Meta's buttons array as stored (jsonb): each button's type, text and URL.
	Buttons   []byte
	CreatedAt time.Time
	UpdatedAt time.Time
}

// TemplateView is one synced template as the settings API shows it. A template holds no
// credentials, so the whole row can be returned.
type TemplateView struct {
	ID             uuid.UUID        `json:"id"`
	ConnectionID   uuid.UUID        `json:"connection_id"`
	MetaTemplateID string           `json:"meta_template_id"`
	Name           string           `json:"name"`
	Language       string           `json:"language"`
	Category       string           `json:"category"`
	Status         string           `json:"status"`
	HeaderType     string           `json:"header_type"`
	HeaderContent  string           `json:"header_content"`
	BodyContent    string           `json:"body_content"`
	FooterContent  string           `json:"footer_content"`
	Buttons        []map[string]any `json:"buttons"`
	CreatedAt      time.Time        `json:"created_at"`
	UpdatedAt      time.Time        `json:"updated_at"`
}

const templateColumns = `id, workspace_id, connection_id, meta_template_id, name, language, category, status,
	header_type, header_content, body_content, footer_content, buttons, created_at, updated_at`

func scanTemplateRow(row pgx.Row) (whatsappTemplateRow, error) {
	var t whatsappTemplateRow
	err := row.Scan(&t.ID, &t.WorkspaceID, &t.ConnectionID, &t.MetaTemplateID, &t.Name, &t.Language,
		&t.Category, &t.Status, &t.HeaderType, &t.HeaderContent, &t.BodyContent, &t.FooterContent,
		&t.Buttons, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// templateView is a row as the API shows it, its buttons decoded.
func templateView(t whatsappTemplateRow) TemplateView {
	v := TemplateView{ID: t.ID, ConnectionID: t.ConnectionID, MetaTemplateID: t.MetaTemplateID,
		Name: t.Name, Language: t.Language, Category: t.Category, Status: t.Status,
		HeaderType: t.HeaderType, HeaderContent: t.HeaderContent, BodyContent: t.BodyContent,
		FooterContent: t.FooterContent, Buttons: []map[string]any{}, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt}
	if len(t.Buttons) > 0 {
		var buttons []map[string]any
		if err := json.Unmarshal(t.Buttons, &buttons); err == nil && buttons != nil {
			v.Buttons = buttons
		}
	}
	return v
}

// templateParts are the row fields a Meta template's components describe: its header, body,
// footer and buttons.
type templateParts struct {
	HeaderType    string
	HeaderContent string
	BodyContent   string
	FooterContent string
	Buttons       []map[string]any
}

// templatePartsFrom reads a Meta template's components. Meta sends the types uppercase; a
// header keeps its format (TEXT, IMAGE, ...) so only a text header carries text.
func templatePartsFrom(components []TemplateComponent) templateParts {
	var parts templateParts
	for _, component := range components {
		switch strings.ToUpper(strings.TrimSpace(component.Type)) {
		case "HEADER":
			parts.HeaderType = strings.ToUpper(strings.TrimSpace(component.Format))
			if parts.HeaderType == "" {
				parts.HeaderType = "TEXT"
			}
			if parts.HeaderType == "TEXT" {
				parts.HeaderContent = component.Text
			}
		case "BODY":
			parts.BodyContent = component.Text
		case "FOOTER":
			parts.FooterContent = component.Text
		case "BUTTONS":
			parts.Buttons = component.Buttons
		}
	}
	return parts
}

// syncTemplates refreshes a connection's workspace copy of Meta's message templates. Every
// template Meta lists is upserted by (connection_id, name, language), so a changed status,
// body or button shows after the next sync. It returns how many templates were stored.
func (s *Service) syncTemplates(ctx context.Context, q db.Querier, wid uuid.UUID, c connection) (int, error) {
	acc, _, err := s.account(c)
	if err != nil {
		return 0, err
	}
	fetched, err := s.client().FetchTemplates(ctx, acc)
	if err != nil {
		return 0, err
	}
	stored := 0
	for _, t := range fetched {
		name, language := strings.TrimSpace(t.Name), strings.TrimSpace(t.Language)
		if name == "" || language == "" {
			// Meta always names both. A nameless template cannot be picked or sent anyway.
			continue
		}
		parts := templatePartsFrom(t.Components)
		buttons := []byte("[]")
		if parts.Buttons != nil {
			raw, err := json.Marshal(parts.Buttons)
			if err != nil {
				return stored, err
			}
			buttons = raw
		}
		if _, err := q.Exec(ctx, `INSERT INTO whatsapp_templates (id, workspace_id, connection_id, meta_template_id,
				name, language, category, status, header_type, header_content, body_content, footer_content, buttons,
				created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
			ON CONFLICT (connection_id, name, language) DO UPDATE SET
				meta_template_id = EXCLUDED.meta_template_id,
				category = EXCLUDED.category,
				status = EXCLUDED.status,
				header_type = EXCLUDED.header_type,
				header_content = EXCLUDED.header_content,
				body_content = EXCLUDED.body_content,
				footer_content = EXCLUDED.footer_content,
				buttons = EXCLUDED.buttons,
				updated_at = now()`,
			ids.New(), wid, c.ID, strings.TrimSpace(t.ID), name, language,
			strings.TrimSpace(t.Category), strings.ToUpper(strings.TrimSpace(t.Status)),
			parts.HeaderType, parts.HeaderContent, parts.BodyContent, parts.FooterContent, buttons); err != nil {
			return stored, err
		}
		stored++
	}
	return stored, nil
}

// syncConnectionTemplates syncs one connection in its own transaction: a failed fetch stores
// nothing, so the next attempt starts from the copy Meta listed.
func (s *Service) syncConnectionTemplates(ctx context.Context, c connection) (int, error) {
	var stored int
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		stored, err = s.syncTemplates(ctx, tx, c.WorkspaceID, c)
		return err
	})
	return stored, err
}

// listTemplates lists a workspace's synced templates, all of them or the ones of one
// connection.
func listTemplates(ctx context.Context, q db.Querier, wid uuid.UUID, connectionID *uuid.UUID) ([]whatsappTemplateRow, error) {
	sql := `SELECT ` + templateColumns + ` FROM whatsapp_templates WHERE workspace_id = $1`
	args := []any{wid}
	if connectionID != nil {
		sql += ` AND connection_id = $2`
		args = append(args, *connectionID)
	}
	rows, err := q.Query(ctx, sql+` ORDER BY name, language, created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []whatsappTemplateRow
	for rows.Next() {
		t, err := scanTemplateRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// loadTemplate reads one template by id.
func loadTemplate(ctx context.Context, q db.Querier, wid, id uuid.UUID) (whatsappTemplateRow, error) {
	return scanTemplateRow(q.QueryRow(ctx, `SELECT `+templateColumns+` FROM whatsapp_templates
		WHERE workspace_id = $1 AND id = $2`, wid, id))
}

// loadTemplateByNameLanguage reads the template a message names when it carries no row id:
// templates are unique per connection, name and language.
func loadTemplateByNameLanguage(ctx context.Context, q db.Querier, wid, connID uuid.UUID, name, language string) (whatsappTemplateRow, error) {
	return scanTemplateRow(q.QueryRow(ctx, `SELECT `+templateColumns+` FROM whatsapp_templates
		WHERE workspace_id = $1 AND connection_id = $2 AND name = $3 AND language = $4`, wid, connID, name, language))
}

// templateSyncWorker refreshes every connection's templates from Meta.
type templateSyncWorker struct {
	river.WorkerDefaults[jobs.WhatsAppTemplateSyncArgs]
	s *Service
}

func (w *templateSyncWorker) Work(ctx context.Context, _ *river.Job[jobs.WhatsAppTemplateSyncArgs]) error {
	return w.s.syncAllTemplates(ctx)
}

// syncAllTemplates syncs every connection on its own: one number whose token Meta rejects
// must not keep the other connections' templates stale.
func (s *Service) syncAllTemplates(ctx context.Context) error {
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT `+connectionColumns+` FROM whatsapp_connections c ORDER BY c.created_at`)
	if err != nil {
		return err
	}
	conns, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (connection, error) { return scanConnection(r) })
	if err != nil {
		return err
	}
	for _, c := range conns {
		// A suspended workspace's connection is not called: its stored templates stay as
		// they are until it is unsuspended, as the email syncer leaves a suspended mailbox.
		if suspended, err := domain.WorkspaceSuspended(ctx, s.d.DB.Pool, c.WorkspaceID); err != nil {
			s.d.Log.Warn("whatsapp template sync skipped", "workspace_id", c.WorkspaceID, "connection_id", c.ID, "err", err)
			continue
		} else if suspended {
			continue
		}
		if _, err := s.syncConnectionTemplates(ctx, c); err != nil {
			s.d.Log.Warn("whatsapp template sync failed", "workspace_id", c.WorkspaceID, "connection_id", c.ID, "err", err)
		}
	}
	return nil
}

// applyTemplateStatus folds a template review result from Meta into the stored copy, so a
// template Meta approved, paused or rejected is not offered until the next sync. A template
// this connection does not hold is ignored.
func (s *Service) applyTemplateStatus(ctx context.Context, c connection, st TemplateStatus) error {
	status := strings.ToUpper(strings.TrimSpace(st.Event))
	if status == "" || st.MessageTemplateName == "" || st.MessageTemplateLanguage == "" {
		return nil
	}
	_, err := s.d.DB.Pool.Exec(ctx, `UPDATE whatsapp_templates SET status = $4, updated_at = now()
		WHERE workspace_id = $1 AND connection_id = $2 AND name = $3 AND language = $5`,
		c.WorkspaceID, c.ID, st.MessageTemplateName, status, st.MessageTemplateLanguage)
	return err
}
