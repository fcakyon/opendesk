package phone

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/phone/provider"
)

// Playing a recording (contracts/phone.md "Recordings"): for a provider whose recordings only
// its connection can open, the app fetches the audio with the connection's credentials and
// streams it to the agent. No copy is kept, and the credentials never leave the server.

const (
	// maxRecordingBytes bounds what one play reads from the provider.
	maxRecordingBytes = 200 << 20
	// recordingTimeout bounds one play, the whole audio included.
	recordingTimeout = 3 * time.Minute
)

func (s *Service) registerRecording(api huma.API, tags []string) {
	huma.Register(api, huma.Operation{OperationID: "get-phone-call-recording", Method: http.MethodGet, Path: "/v1/phone/calls/{id}/recording", Tags: tags,
		Summary: "Play a call's recording", Description: "Streams the recording of a call whose provider only serves it to the connection's own credentials. For agents who can read the call's ticket.",
		Responses: map[string]*huma.Response{"200": {Description: "The audio", Content: map[string]*huma.MediaType{"audio/*": {}}}}},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*huma.StreamResponse, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, ok := ids.Parse(in.ID)
			if !ok {
				return nil, httpx.NotFound("Call")
			}
			call, err := scanCall(s.d.DB.Pool.QueryRow(ctx, callSelect+` WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id))
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Call")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			// Whoever reads the call's ticket may play it: a ticket of a private team they
			// are not in is not found.
			if call.TicketID == nil {
				return nil, httpx.NotFound("Call")
			}
			if _, err := domain.LoadVisibleTicket(ctx, s.d.DB.Pool, p, *call.TicketID); err != nil {
				if db.IsNotFound(err) {
					return nil, httpx.NotFound("Call")
				}
				return nil, httpx.Wrap(err)
			}
			rec, ok := s.adapters[call.Provider].(provider.Recorder)
			if !ok || !call.HasRecording || call.RecordingURL == "" || call.ConnectionID == nil {
				return nil, httpx.NotFound("Recording")
			}
			conn, err := scanConnection(s.d.DB.Pool.QueryRow(ctx, connectionSelect+` WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, *call.ConnectionID))
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Recording")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			creds, err := s.credentials(conn)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			// The client has no whole-request timeout, which would cut a long recording.
			stream := *s.http
			stream.Timeout = 0
			fetchCtx, cancel := context.WithTimeout(ctx, recordingTimeout)
			out, err := rec.Recording(fetchCtx, &stream, creds, call.RecordingURL)
			if err != nil {
				cancel()
				return nil, recordingError(err)
			}
			// Playing a recording is personal data: the entry names the call, never its content.
			// It counts once the provider has the audio: an attempt it refused played nothing.
			if err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				return audit.Log(ctx, tx, p, p.WorkspaceID, "phone.recording_played", "phone_call", &call.ID,
					map[string]any{"provider": call.Provider, "ticket_id": *call.TicketID})
			}); err != nil {
				out.Body.Close()
				cancel()
				return nil, httpx.Wrap(err)
			}
			return &huma.StreamResponse{Body: func(hctx huma.Context) {
				defer cancel()
				defer out.Body.Close()
				hctx.SetHeader("Content-Type", out.ContentType)
				// A download of an outside file: never shown or sniffed as a page, never stored.
				// The app fetches it and plays it from a blob, which this policy does not touch.
				hctx.SetHeader("Content-Disposition", `attachment; filename="call-recording"`)
				hctx.SetHeader("X-Content-Type-Options", "nosniff")
				hctx.SetHeader("Content-Security-Policy", "default-src 'none'; sandbox")
				hctx.SetHeader("Cache-Control", "private, no-store")
				hctx.SetHeader("Referrer-Policy", "no-referrer")
				if out.Length >= 0 && out.Length <= maxRecordingBytes {
					hctx.SetHeader("Content-Length", strconv.FormatInt(out.Length, 10))
				}
				hctx.SetStatus(http.StatusOK)
				_, _ = io.Copy(hctx.BodyWriter(), io.LimitReader(out.Body, maxRecordingBytes))
			}}, nil
		})
}

// recordingError is what an agent is told when the provider would not play a recording: the
// entry shows it, so it says what to do, never what the provider answered.
func recordingError(err error) error {
	var limited *provider.RateLimited
	switch {
	case errors.Is(err, provider.ErrNoRecording):
		return httpx.E(http.StatusConflict, "recording_not_ready", "The recording is not ready yet. Try again in a minute.")
	case errors.As(err, &limited):
		return httpx.E(http.StatusTooManyRequests, "provider_rate_limited", "The phone provider is busy. Try again in a minute.")
	case provider.Refused(err):
		return httpx.E(http.StatusBadGateway, "recording_refused", "The provider refused the connection's token. It needs access to call recordings.")
	}
	return httpx.E(http.StatusBadGateway, "recording_unavailable", "The recording could not be fetched from the provider.")
}
