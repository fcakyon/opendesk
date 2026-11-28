package whatsapp

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// verifyWebhook answers Meta's callback verification handshake with the challenge, once the
// URL's connection and the verify token it was configured with agree.
func (s *Service) verifyWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "connection"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	c, err := loadConnectionByID(r.Context(), s.d.DB.Pool, id)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	creds, err := s.openCredentials(c)
	if err != nil {
		s.d.Log.Error("whatsapp webhook: open credentials", "connection_id", c.ID, "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	mode := r.URL.Query().Get("hub.mode")
	token := r.URL.Query().Get("hub.verify_token")
	challenge := r.URL.Query().Get("hub.challenge")
	if mode != "subscribe" || creds.VerifyToken == "" ||
		subtle.ConstantTimeCompare([]byte(token), []byte(creds.VerifyToken)) != 1 {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, challenge)
}

// webhook receives one Meta delivery: the connection is found by its opaque id, the raw body
// is verified with the app secret before anything is read from it, then stored and queued in
// one transaction and acknowledged at once. Meta retries a delivery it did not see a 2xx for.
func (s *Service) webhook(w http.ResponseWriter, r *http.Request) {
	bad := "whatsapp-hook-bad:" + httpx.ClientIP(s.d.Cfg.TrustProxy, s.d.Cfg.ProxyHops)(r)
	if s.d.Limiter.Over(bad, badHooksPerMinute, time.Minute) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	refuse := func(status int) {
		if !s.d.Limiter.Allow(bad, badHooksPerMinute, time.Minute) {
			status = http.StatusTooManyRequests
		}
		w.WriteHeader(status)
	}
	id, err := uuid.Parse(chi.URLParam(r, "connection"))
	if err != nil {
		refuse(http.StatusNotFound)
		return
	}
	c, err := loadConnectionByID(r.Context(), s.d.DB.Pool, id)
	if err != nil && !db.IsNotFound(err) {
		s.d.Log.Error("whatsapp webhook: load connection", "connection_id", id, "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if db.IsNotFound(err) {
		refuse(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		refuse(http.StatusRequestEntityTooLarge)
		return
	}
	creds, err := s.openCredentials(c)
	if err != nil {
		s.d.Log.Error("whatsapp webhook: open credentials", "connection_id", c.ID, "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if creds.AppSecret == "" {
		refuse(http.StatusForbidden)
		return
	}
	if !VerifySignature(body, r.Header.Get("X-Hub-Signature-256"), creds.AppSecret) {
		s.d.Log.Warn("whatsapp webhook signature refused", "connection_id", c.ID)
		refuse(http.StatusUnauthorized)
		return
	}
	// Stored as jsonb, like the phone and support channel events. A signed body that is not
	// JSON is refused before it reaches the queue.
	if !json.Valid(body) {
		s.d.Log.Warn("whatsapp webhook body is not JSON", "connection_id", c.ID)
		refuse(http.StatusBadRequest)
		return
	}
	if !s.d.Limiter.Allow("whatsapp-hook:"+c.ID.String(), webhookPerMinute, time.Minute) {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	sum := sha256.Sum256(body)
	externalID := hex.EncodeToString(sum[:])
	var eventID uuid.UUID
	err = s.d.DB.Tx(r.Context(), func(tx pgx.Tx) error {
		stored, ok, err := insertInboundEvent(r.Context(), tx, c.WorkspaceID, c.ID, externalID, body)
		if err != nil {
			return err
		}
		if !ok {
			// Meta's retry of a delivery already stored.
			return nil
		}
		eventID = stored
		if err := touchConnection(r.Context(), tx, c.ID); err != nil {
			return err
		}
		_, err = s.d.Jobs.InsertTx(r.Context(), tx, jobs.WhatsAppInboundArgs{WorkspaceID: c.WorkspaceID, ConnectionID: c.ID, EventID: stored},
			&river.InsertOpts{MaxAttempts: 10})
		return err
	})
	if err != nil {
		s.d.Log.Error("whatsapp webhook: store event", "connection_id", c.ID, "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if eventID == uuid.Nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
