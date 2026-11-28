package panels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/version"
)

const (
	// actionTimeout is how long an action's request may take: longer than a lookup, since it
	// writes somewhere (an invoice, a CRM record), but an agent waits for it.
	actionTimeout = 10 * time.Second
	// actionsPerMinute bounds the actions one panel sends, actionsPerUserMinute one person's.
	actionsPerMinute     = 60
	actionsPerUserMinute = 20
	maxActionMessage     = 280
	// ActivityPanelAction is the timeline entry an action leaves on its ticket.
	ActivityPanelAction = "panel_action"
)

// actionRequest is what OpenDesk posts to an http panel's URL when an agent presses an action.
// A lookup carries "event": "lookup", an action "event": "action". Later fields only add to it.
type actionRequest struct {
	Event       string        `json:"event"`
	RequestID   uuid.UUID     `json:"request_id"`
	PanelID     uuid.UUID     `json:"panel_id"`
	WorkspaceID uuid.UUID     `json:"workspace_id"`
	Action      actionCall    `json:"action"`
	Agent       actionAgent   `json:"agent"`
	Ticket      lookupTicket  `json:"ticket"`
	Contact     lookupContact `json:"contact"`
	Locale      string        `json:"locale,omitempty"`
}

type actionCall struct {
	ID     string            `json:"id"`
	Inputs map[string]string `json:"inputs"`
}

type actionAgent struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Email string    `json:"email"`
}

// ActionResult is what pressing an action came to: the URL's own words, and the panel as it is
// now when the URL sent blocks or the panel was read again.
type ActionResult struct {
	OK      bool   `json:"ok" doc:"The URL did what was asked"`
	Message string `json:"message" doc:"What the URL said, in a sentence, or a few words of ours when it said none"`
	Tone    string `json:"tone" enum:"neutral,info,success,warning,danger"`
	Data    *Data  `json:"data,omitempty" doc:"The panel after the action: the blocks the URL answered with, else a fresh reading"`
}

// actionAnswer is what a URL answers to an action.
type actionAnswer struct {
	Message string            `json:"message"`
	Tone    string            `json:"tone"`
	Blocks  []json.RawMessage `json:"blocks"`
}

// findAction is the action of this id in a panel's current answer.
func findAction(blocks []PanelBlock, id string) *PanelAction {
	for _, b := range blocks {
		for i := range b.Actions {
			if b.Actions[i].ID == id {
				return &b.Actions[i]
			}
		}
	}
	return nil
}

// cleanInputValues checks what the agent filled in against the form the URL asked for: no
// field it did not ask, every required one present, a select's value one of its options, a text
// within its length and without control characters (a textarea may have line breaks).
func cleanInputValues(a *PanelAction, in map[string]string) (map[string]string, error) {
	out := map[string]string{}
	known := map[string]bool{}
	for _, f := range a.Inputs {
		known[f.Name] = true
	}
	for k := range in {
		if !known[k] {
			return nil, httpx.Validation("Unknown input " + k + ".")
		}
	}
	for _, f := range a.Inputs {
		v := strings.TrimSpace(in[f.Name])
		for _, r := range v {
			if unicode.IsControl(r) && !(f.Type == "textarea" && (r == '\n' || r == '\r' || r == '\t')) {
				return nil, httpx.Validation(f.Label + " has characters that can't be sent.")
			}
		}
		switch {
		case v == "" && f.Required:
			return nil, httpx.Validation("Fill in " + f.Label + ".")
		case v == "":
			out[f.Name] = ""
		case f.Type == "select" && !hasOption(f.Options, v):
			return nil, httpx.Validation(f.Label + " is not one of the choices.")
		case f.Type != "select" && len([]rune(v)) > f.MaxLength:
			return nil, httpx.Validation(fmt.Sprintf("%s is longer than %d characters.", f.Label, f.MaxLength))
		default:
			out[f.Name] = v
		}
	}
	return out, nil
}

// sendAction posts the action to the panel's URL, signed like a lookup, and reads its answer.
func (s *Service) sendAction(ctx context.Context, x *row, req actionRequest) (ActionResult, error) {
	secret, err := s.d.Box.Open(x.SecretEnc)
	if err != nil {
		return ActionResult{}, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return ActionResult{}, err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, x.Target, bytes.NewReader(body))
	if err != nil {
		return ActionResult{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Accept", "application/json")
	hr.Header.Set("User-Agent", "opendesk-panels/"+version.Version)
	hr.Header.Set("OD-Signature", sign(secret, time.Now().Unix(), body))
	hr.Header.Set("OD-Panel-Id", x.ID.String())
	hr.Header.Set("OD-Panel-Event", "action")
	// One id per press, so the URL can tell a retry from a second press.
	hr.Header.Set("OD-Request-Id", req.RequestID.String())
	res, err := s.actions.Do(hr)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // never the URL: a path or query can carry a secret
		}
		return ActionResult{}, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxHTTPAnswer+1))
	if err != nil {
		return ActionResult{}, err
	}
	var a actionAnswer
	parsed := len(raw) <= maxHTTPAnswer && json.Unmarshal(raw, &a) == nil
	out := ActionResult{Message: cleanText(a.Message, maxActionMessage), Tone: toneOf(a.Tone)}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return ActionResult{}, &authError{fmt.Sprintf("The panel's URL refused the request (%d): check its signing secret.", res.StatusCode)}
	case res.StatusCode >= 200 && res.StatusCode < 300:
		out.OK = true
		if out.Message == "" {
			out.Tone = "success"
		}
		if parsed && a.Blocks != nil {
			blocks := s.cleanBlocks(a.Blocks)
			out.Data = &Data{PanelID: x.ID, Kind: x.Kind, State: "ok", Blocks: blocks, FetchedAt: time.Now().UTC()}
			if len(blocks) == 0 {
				out.Data.State, out.Data.Blocks = "empty", nil
			}
		}
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusConflict || res.StatusCode == http.StatusUnprocessableEntity:
		// The URL refused this request in its own words: an invoice that exists, a field it can't take.
		if out.Message == "" {
			out.Message = "The panel's URL refused this action."
		}
		out.Tone = "danger"
	default:
		return ActionResult{}, &answerError{fmt.Sprintf("The panel's URL answered %d.", res.StatusCode), "status"}
	}
	return out, nil
}

func (s *Service) registerActionRoute(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "run-ticket-panel-action", Method: http.MethodPost, Path: "/v1/tickets/{id}/panels/{panelId}/actions",
		Summary: "Press an action of an http ticket panel", Tags: []string{"Tickets"},
		Description: "Sends an action the panel's current answer offers to the panel's URL, signed like a lookup, and answers what the URL said. The action must be one the panel offers for this ticket now; its inputs must fit the form. A failure of the URL is `ok: false`, never an error status."},
		func(ctx context.Context, in *struct {
			ID      string `path:"id"`
			PanelID string `path:"panelId"`
			Body    struct {
				Action string            `json:"action" maxLength:"64" doc:"The id of an action of the panel's answer"`
				Inputs map[string]string `json:"inputs,omitempty" doc:"The form's values by input name"`
				Locale string            `json:"locale,omitempty" doc:"The reader's interface language, a lowercase base language tag"`
			}
		}) (*struct{ Body ActionResult }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind != auth.KindUser {
				return nil, httpx.Forbidden() // an action is a person's: the URL is told who pressed it
			}
			tid, err := parseID(in.ID, "Ticket")
			if err != nil {
				return nil, err
			}
			pid, err := parseID(in.PanelID, "Ticket panel")
			if err != nil {
				return nil, err
			}
			t, err := domain.LoadVisibleTicket(ctx, s.d.DB.Pool, p, tid)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Ticket")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			x, err := loadRow(ctx, s.d.DB.Pool, p.WorkspaceID, pid)
			if err != nil {
				return nil, wrapLoad(err)
			}
			if !x.Enabled {
				return nil, httpx.NotFound("Ticket panel")
			}
			if x.Kind != KindHTTP {
				return nil, httpx.Validation("Only a panel from a URL has actions.")
			}
			if !s.d.Limiter.Allow("ticket-panel:action:"+x.ID.String(), actionsPerMinute, time.Minute) ||
				!s.d.Limiter.Allow("ticket-panel:action-user:"+p.UserID.String(), actionsPerUserMinute, time.Minute) {
				return nil, httpx.E(429, "rate_limited", "Too many actions. Try again in a minute.")
			}
			locale := viewerLocale(in.Body.Locale)
			// The action must be one the panel offers for this ticket now: what the agent pressed is
			// checked against the answer the URL gave, never trusted from the request.
			current := s.read(ctx, x, &t, false, locale)
			act := findAction(current.Blocks, in.Body.Action)
			if current.State != "ok" || act == nil {
				return nil, httpx.E(409, "action_unavailable", "The panel no longer offers this action. Refresh it and try again.")
			}
			inputs, err := cleanInputValues(act, in.Body.Inputs)
			if err != nil {
				return nil, err
			}
			sub := subjectOf(&t)
			c, err := s.lookupContext(ctx, x, &t, sub)
			if err != nil {
				return nil, httpx.E(500, "ticket_unreadable", "Couldn't read the ticket.")
			}
			me, err := domain.LoadUserRef(ctx, s.d.DB.Pool, p.UserID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			req := actionRequest{Event: "action", RequestID: ids.New(), PanelID: x.ID, WorkspaceID: x.WorkspaceID, Locale: locale,
				Action: actionCall{ID: act.ID, Inputs: inputs}, Agent: actionAgent{ID: me.ID, Name: me.Name, Email: me.Email},
				Ticket:  lookupTicket{ID: t.ID, Number: t.Number, Subject: t.Subject, References: c.References},
				Contact: lookupContact{ID: sub.ContactID, Email: sub.Email, Name: sub.Name, Emails: c.Emails, Phone: c.Phone}}
			actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), actionTimeout)
			defer cancel()
			result, err := s.sendAction(actx, x, req)
			if err != nil {
				s.markStatus(context.WithoutCancel(ctx), x, err)
				s.d.Log.Info("ticket panel action failed", "panel", x.ID, "host", x.api().Host, "err", lookupMessage(err))
				result = ActionResult{Message: actionFailure(err), Tone: "danger"}
			} else {
				s.markStatus(context.WithoutCancel(ctx), x, nil)
			}
			// The panel as it is now: what the URL answered with, else read again.
			s.cache.forget(x.ID)
			if result.OK && result.Data == nil {
				fresh := s.read(ctx, x, &t, true, locale)
				result.Data = &fresh
			}
			if result.Message == "" {
				result.Message = map[bool]string{true: "Done.", false: "The action did not go through."}[result.OK]
			}
			if err := s.recordAction(ctx, p, x, &t, act, req.RequestID, result); err != nil {
				s.d.Log.Warn("ticket panel action record", "panel", x.ID, "err", err)
			}
			return &struct{ Body ActionResult }{result}, nil
		})
}

// actionFailure words a URL that could not be reached or understood, for the agent.
func actionFailure(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "The panel's URL didn't answer in time. Check before trying again: the action may still have gone through."
	case errors.Is(err, errAuth):
		return "The panel's URL refused the request. An admin can check its signing secret in settings."
	}
	return "The panel's URL could not be reached or answered an error."
}

// recordAction leaves what was done where the team reads it: an audit entry (the action and
// the ticket, never the values filled in) and an entry in the ticket's timeline.
func (s *Service) recordAction(ctx context.Context, p *auth.Principal, x *row, t *domain.Ticket, a *PanelAction, request uuid.UUID, r ActionResult) error {
	return s.d.DB.Tx(context.WithoutCancel(ctx), func(tx pgx.Tx) error {
		data := map[string]any{"panel_id": x.ID.String(), "panel": x.Name, "action": a.ID, "label": a.Label, "ok": r.OK,
			"message": clip(r.Message, maxActionMessage), "request_id": request.String()}
		if _, err := domain.LogActivity(ctx, tx, x.WorkspaceID, t.ID, "user", p.ActorUserID(), ActivityPanelAction, data); err != nil {
			return err
		}
		return audit.Log(ctx, tx, p, x.WorkspaceID, "ticket_panel.action", "ticket_panel", &x.ID,
			map[string]any{"ticket_id": t.ID.String(), "action": a.ID, "ok": r.OK, "request_id": request.String()})
	})
}
