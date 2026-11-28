package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Bounds on what one template send may carry: Meta's own limits, so a refused request says
// what to fix instead of being cut short by a provider error.
const (
	// maxTemplateParams bounds how many variables one send may fill.
	maxTemplateParams = 50
	// maxTemplateParamRunes is Meta's cap on one variable's value.
	maxTemplateParamRunes = 1024
	// maxTemplateHeaderRunes is Meta's cap on a text header's value.
	maxTemplateHeaderRunes = 60
	// maxTemplateURLRunes bounds one URL button's value.
	maxTemplateURLRunes = 2000
)

// templateList is the synced templates of a workspace, or of one connection.
type templateList struct {
	Data []TemplateView `json:"data"`
}

// templateSyncBody names the connection to sync; empty or absent syncs every connection of
// the workspace.
type templateSyncBody struct {
	ConnectionID string `json:"connection_id,omitempty" doc:"Sync only this connection; empty syncs every connection of the workspace"`
}

// templateSyncResult is the sync's outcome: the templates afterwards and how many were stored.
type templateSyncResult struct {
	Data   []TemplateView `json:"data"`
	Synced int            `json:"synced"`
}

// templateSendBody picks a template and fills in what it needs.
type templateSendBody struct {
	TemplateID string            `json:"template_id" doc:"The synced template to send"`
	Params     map[string]string `json:"params,omitempty" doc:"Values for the template's body variables, by placeholder name or number"`
	// HeaderText is the value filled into the header's variable, not the template's approved
	// header text: the approval already holds that text, and Meta takes only the value.
	HeaderText string `json:"header_text,omitempty" doc:"The value (not the approved header text) of the template's text header variable, when it has one"`
	// HeaderMediaID is the workspace's uploaded file that fills an IMAGE, VIDEO or DOCUMENT
	// header; the send uploads it to Meta, which is what the approval's header expects.
	HeaderMediaID string            `json:"header_media_id,omitempty" doc:"The opendesk attachment id of the file for an IMAGE/VIDEO/DOCUMENT header"`
	ButtonURLs    map[string]string `json:"button_urls,omitempty" doc:"Values for the template's URL buttons, by button number"`
}

// registerTemplateAPI mounts the templates' API: the synced list, an admin sync, and sending
// a template on a ticket, which is the only way to reach a customer outside Meta's window.
func (s *Service) registerTemplateAPI(api huma.API, _ chi.Router) {
	tags := []string{"WhatsApp"}

	huma.Register(api, huma.Operation{OperationID: "list-whatsapp-templates", Method: http.MethodGet,
		Path: "/v1/whatsapp/templates", Tags: tags, Summary: "List WhatsApp templates"},
		func(ctx context.Context, in *struct {
			ConnectionID string `query:"connection_id" doc:"Only this connection's templates"`
		}) (*struct{ Body templateList }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeSettingsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var connectionID *uuid.UUID
			if raw := strings.TrimSpace(in.ConnectionID); raw != "" {
				id, err := uuid.Parse(raw)
				if err != nil {
					return nil, httpx.Validation("connection_id is not a valid id.")
				}
				connectionID = &id
			}
			rows, err := listTemplates(ctx, s.d.DB.Pool, p.WorkspaceID, connectionID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct{ Body templateList }{templateList{Data: make([]TemplateView, 0, len(rows))}}
			for _, row := range rows {
				out.Body.Data = append(out.Body.Data, templateView(row))
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "sync-whatsapp-templates", Method: http.MethodPost,
		Path: "/v1/whatsapp/templates/sync", Tags: tags, Summary: "Sync WhatsApp templates",
		Description: "Reads the message templates of a connection's WhatsApp Business account, or of every connection of the workspace, from Meta and stores them."},
		func(ctx context.Context, in *struct{ Body *templateSyncBody }) (*struct{ Body templateSyncResult }, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			connectionID := ""
			if in.Body != nil {
				connectionID = strings.TrimSpace(in.Body.ConnectionID)
			}
			var targets []connection
			if connectionID != "" {
				c, err := s.loadWorkspaceConnection(ctx, p.WorkspaceID, connectionID)
				if err != nil {
					return nil, err
				}
				targets = append(targets, c)
			} else if targets, err = listConnections(ctx, s.d.DB.Pool, p.WorkspaceID); err != nil {
				return nil, httpx.Wrap(err)
			}
			// One connection whose token Meta rejects must not keep the others' templates
			// stale; the sync answers with an error only when none of them succeeded.
			synced, succeeded := 0, 0
			var firstErr error
			for _, c := range targets {
				n, err := s.syncConnectionTemplates(ctx, c)
				if err != nil {
					s.d.Log.Warn("whatsapp template sync failed", "connection_id", c.ID, "err", err)
					if firstErr == nil {
						firstErr = err
					}
					continue
				}
				synced += n
				succeeded++
			}
			if succeeded == 0 && firstErr != nil {
				// The sync answers like the connection's own test and subscribe do: Meta's
				// refusal in words the admin can act on, a retry for a transport failure.
				var me *MetaAPIError
				if errors.As(firstErr, &me) {
					if msg := metaRefusal(firstErr); msg != "" {
						s.d.Log.Info("whatsapp template sync refused", "detail", msg)
						return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_templates_refused",
							"Meta refused the template sync: "+msg)
					}
				}
				s.d.Log.Error("whatsapp template sync failed", "err", firstErr)
				return nil, httpx.E(http.StatusBadGateway, "whatsapp_templates_failed",
					"Couldn't reach Meta to sync the templates. Try again in a moment.")
			}
			var (
				rows []whatsappTemplateRow
				only *uuid.UUID
			)
			if len(targets) == 1 && connectionID != "" {
				only = &targets[0].ID
			}
			if rows, err = listTemplates(ctx, s.d.DB.Pool, p.WorkspaceID, only); err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct{ Body templateSyncResult }{templateSyncResult{Data: make([]TemplateView, 0, len(rows)), Synced: synced}}
			for _, row := range rows {
				out.Body.Data = append(out.Body.Data, templateView(row))
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "send-whatsapp-template", Method: http.MethodPost,
		Path: "/v1/tickets/{id}/whatsapp-template", Tags: tags, Summary: "Send a WhatsApp template",
		Description:   "Sends an approved template on a WhatsApp ticket, inside or outside Meta's 24-hour window, with the values an agent filled in. It becomes a reply in the ticket's timeline.",
		DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body templateSendBody
		}) (*struct{ Body domain.Message }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			ticketID, err := hd.ParseID(in.ID, "Ticket")
			if err != nil {
				return nil, err
			}
			t, err := domain.LoadVisibleTicket(ctx, s.d.DB.Pool, p, ticketID)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Ticket")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if t.Channel != domain.ChannelWhatsApp {
				return nil, httpx.E(http.StatusUnprocessableEntity, "not_whatsapp_ticket", "This ticket is not a WhatsApp conversation.")
			}
			row, err := s.templateForTicket(ctx, p.WorkspaceID, t.ID, in.Body.TemplateID)
			if err != nil {
				return nil, err
			}
			params, err := cleanTemplateParams(in.Body.Params, row)
			if err != nil {
				return nil, err
			}
			headerText, headerAttachmentID, err := templateHeader(row, in.Body.HeaderText, in.Body.HeaderMediaID)
			if err != nil {
				return nil, err
			}
			var headerUpload *uuid.UUID
			if headerAttachmentID != "" {
				// The file is checked here, before the message is written, so a wrong or
				// missing one answers the agent instead of failing the send later.
				if headerUpload, err = s.templateHeaderFile(ctx, p, t.ID,
					templateMediaKind(row.HeaderType), headerAttachmentID); err != nil {
					return nil, err
				}
			}
			buttonURLs, err := cleanButtonURLs(in.Body.ButtonURLs, row.Buttons)
			if err != nil {
				return nil, err
			}
			// The message shows what the customer gets; the stored template keeps Meta's own
			// text with its placeholders, which is what the send components are built from.
			bodyText := renderTemplateBody(row.BodyContent, params)
			if strings.TrimSpace(bodyText) == "" {
				return nil, httpx.Validation("This template has no body text to send.")
			}
			tmpl := &whatsappTemplate{ID: row.ID.String(), Name: row.Name, Language: row.Language,
				Body: row.BodyContent, Params: params, HeaderType: strings.ToUpper(strings.TrimSpace(row.HeaderType)),
				HeaderText: headerText, HeaderAttachmentID: headerAttachmentID, ButtonURLs: buttonURLs}
			var msg domain.Message
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var err error
				msg, err = tickets.AddWhatsAppTemplateReply(ctx, tx, s.d.Jobs, p, t.ID, bodyText,
					map[string]any{"whatsapp_template": tmpl}, headerUpload)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body domain.Message }{msg}, nil
		})
}

// templateForTicket reads the template an agent picked and checks it may go out on this
// ticket: the same workspace, approved at Meta, and sent through the connection the ticket
// was opened on.
func (s *Service) templateForTicket(ctx context.Context, wid, ticketID uuid.UUID, raw string) (whatsappTemplateRow, error) {
	id, err := hd.ParseRef(raw, "template_id")
	if err != nil {
		return whatsappTemplateRow{}, err
	}
	row, err := loadTemplate(ctx, s.d.DB.Pool, wid, id)
	if db.IsNotFound(err) {
		return row, httpx.NotFound("WhatsApp template")
	}
	if err != nil {
		return row, httpx.Wrap(err)
	}
	c, _, err := ticketConnection(ctx, s.d.DB.Pool, wid, ticketID)
	if err != nil {
		return row, ticketConnectionError(err)
	}
	if row.ConnectionID != c.ID {
		return row, httpx.Validation("That template belongs to another WhatsApp connection.")
	}
	if !strings.EqualFold(strings.TrimSpace(row.Status), templateApproved) {
		return row, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_not_approved", templateApprovalDetail(row.Status))
	}
	return row, nil
}

// ticketConnectionError is what the API answers when a ticket's message cannot go out.
func ticketConnectionError(err error) error {
	switch {
	case errors.Is(err, errNoConversation):
		return httpx.E(http.StatusConflict, "whatsapp_no_conversation", "This ticket has no WhatsApp conversation to reply on.")
	case errors.Is(err, errDisconnected):
		return httpx.E(http.StatusConflict, "whatsapp_disconnected",
			"This ticket's WhatsApp number is not connected. Connect it again in Settings > WhatsApp to reply.")
	}
	return httpx.Wrap(err)
}

// templateApprovalDetail says why a template cannot be sent, from the status Meta reported.
func templateApprovalDetail(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "":
		return "This template has not been synced from Meta yet."
	case "PENDING":
		return "This template is still waiting for Meta's review."
	case "REJECTED":
		return "Meta rejected this template. Edit it in Meta's template manager and sync again."
	default:
		return "Meta reports this template as " + strings.ToLower(strings.TrimSpace(status)) + ". Only an approved template can be sent."
	}
}

// cleanTemplateParams checks the body variables an agent filled in: their sizes stay inside
// Meta's caps, and every variable the body names has a value.
func cleanTemplateParams(given map[string]string, row whatsappTemplateRow) (map[string]string, error) {
	if len(given) > maxTemplateParams {
		return nil, httpx.Validation("Too many template variables.")
	}
	params := make(map[string]string, len(given))
	for key, value := range given {
		if utf8.RuneCountInString(value) > maxTemplateParamRunes {
			return nil, httpx.Validation("One template variable is longer than WhatsApp's 1024-character limit.")
		}
		params[key] = value
	}
	var missing []string
	for _, key := range orderedPlaceholders(row.BodyContent) {
		if strings.TrimSpace(params[key]) == "" {
			missing = append(missing, "{{"+key+"}}")
		}
	}
	if len(missing) > 0 {
		return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_params_missing",
			"Fill in the template's variables: "+strings.Join(missing, ", ")+".")
	}
	return params, nil
}

// templateHeader decides what a send carries for the template's header: the value of a text
// header's one variable, or the attachment that fills an image, video or document header. A
// template without a header ignores a value or file sent for it (a client may send both for
// every template), and a header this channel cannot fill is refused. given is what the agent
// filled in, never the template's approved header text.
func templateHeader(row whatsappTemplateRow, headerText, headerMediaID string) (string, string, error) {
	switch kind := strings.ToUpper(strings.TrimSpace(row.HeaderType)); kind {
	case "":
		// The template has no header, so there is nothing to fill.
		return "", "", nil
	case "TEXT":
		text, err := textHeaderValue(headerText, row)
		return text, "", err
	case "IMAGE", "VIDEO", "DOCUMENT":
		if strings.TrimSpace(headerMediaID) == "" {
			return "", "", httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_params_missing",
				"Choose the file for this template's "+strings.ToLower(kind)+" header.")
		}
		return "", strings.TrimSpace(headerMediaID), nil
	default:
		return "", "", httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_header_unsupported",
			"Templates with a "+strings.ToLower(kind)+" header can't be sent from opendesk yet.")
	}
}

// textHeaderValue checks the value of a text header's one variable. It returns "" for a
// static header, which sends no component.
func textHeaderValue(given string, row whatsappTemplateRow) (string, error) {
	keys := orderedPlaceholders(row.HeaderContent)
	if len(keys) == 0 {
		// A static header uses Meta's approved text; a value makes no difference.
		return "", nil
	}
	if strings.TrimSpace(given) == "" {
		return "", httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_params_missing",
			"Fill in the template's header value ({{"+keys[0]+"}}).")
	}
	if utf8.RuneCountInString(given) > maxTemplateHeaderRunes {
		return "", httpx.Validation("The template's header value is longer than WhatsApp's 60-character limit.")
	}
	return given, nil
}

// templateHeaderFile checks the file an agent picked for a media header: their own upload for
// this send, which the reply then holds (fresh is its id), or a file already on one of this
// ticket's messages. A file anywhere else in the workspace is refused, so a private team's
// ticket or a member's Collab mail never reaches WhatsApp through a template. The file must be
// of the header's shape and under Meta's cap for it; the send checks again from the same row.
func (s *Service) templateHeaderFile(ctx context.Context, p *auth.Principal, ticketID uuid.UUID, kind, rawID string) (fresh *uuid.UUID, err error) {
	id, err := hd.ParseRef(rawID, "header_media_id")
	if err != nil {
		return nil, err
	}
	var (
		contentType, storageKey string
		sizeBytes               int64
		attached                bool
	)
	err = s.d.DB.Pool.QueryRow(ctx, `SELECT a.content_type, a.size_bytes, a.storage_key, a.message_id IS NOT NULL
		FROM attachments a LEFT JOIN messages m ON m.workspace_id = a.workspace_id AND m.id = a.message_id
		WHERE a.workspace_id = $1 AND a.id = $2 AND (a.message_id IS NULL OR (m.ticket_id = $3 AND m.deleted_at IS NULL))`,
		p.WorkspaceID, id, ticketID).Scan(&contentType, &sizeBytes, &storageKey, &attached)
	if err == nil && !attached {
		err = hd.CheckAttachments(ctx, s.d.DB.Pool, p.WorkspaceID, []uuid.UUID{id},
			hd.Uploader{User: p.ActorUserID(), APIKey: p.ActorAPIKeyID()})
	}
	var refused *httpx.Error
	if db.IsNotFound(err) || errors.As(err, &refused) {
		return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_file_missing",
			"Upload the file for this template's header, or pick one from this ticket.")
	}
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if strings.TrimSpace(storageKey) == "" {
		return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_file_missing",
			"The file for this template's header is not available.")
	}
	if problem := templateMediaProblem(kind, contentType, sizeBytes); problem != "" {
		return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_file_unsupported", problem)
	}
	if attached {
		return nil, nil
	}
	return &id, nil
}

// cleanButtonURLs checks the values of a template's URL buttons. Meta keeps a button's index
// as its place in the template's buttons array, and only a URL with a variable takes one.
func cleanButtonURLs(given map[string]string, buttons []byte) (map[string]string, error) {
	needed := templateURLButtonParams(buttons)
	if len(given) == 0 {
		if len(needed) > 0 {
			return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_params_missing",
				"Fill in the template's URL buttons: "+strings.Join(needed, ", ")+".")
		}
		return nil, nil
	}
	neededSet := make(map[string]bool, len(needed))
	for _, index := range needed {
		neededSet[index] = true
	}
	out := make(map[string]string, len(given))
	for key, value := range given {
		index := strings.TrimSpace(key)
		if _, err := strconv.Atoi(index); err != nil {
			return nil, httpx.Validation("button_urls is keyed by the number of the button it fills.")
		}
		if !neededSet[index] {
			return nil, httpx.Validation("button_urls names a button this template does not use.")
		}
		if strings.TrimSpace(value) == "" {
			return nil, httpx.Validation("A URL button value is empty.")
		}
		if utf8.RuneCountInString(value) > maxTemplateURLRunes {
			return nil, httpx.Validation("A URL button value is too long.")
		}
		out[index] = value
	}
	var missing []string
	for _, index := range needed {
		if _, ok := out[index]; !ok {
			missing = append(missing, index)
		}
	}
	if len(missing) > 0 {
		return nil, httpx.E(http.StatusUnprocessableEntity, "whatsapp_template_params_missing",
			"Fill in the template's URL buttons: "+strings.Join(missing, ", ")+".")
	}
	return out, nil
}

// templateURLButtonParams returns the indexes of a template's URL buttons whose URL holds a
// variable: those need a value to send.
func templateURLButtonParams(buttons []byte) []string {
	if len(buttons) == 0 {
		return nil
	}
	var list []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(buttons, &list); err != nil {
		return nil
	}
	var out []string
	for i, button := range list {
		if strings.EqualFold(strings.TrimSpace(button.Type), "URL") && placeholderPattern.MatchString(button.URL) {
			out = append(out, strconv.Itoa(i))
		}
	}
	return out
}
