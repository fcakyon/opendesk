package whatsapp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/whatsapp/thread"
)

// connectionColumns is the select list scanConnection reads.
const connectionColumns = `c.id, c.workspace_id, c.brand_id, c.name, c.phone_number_id, c.waba_id,
	c.display_phone, c.verified_name, c.api_version, c.status, c.last_error, c.last_event_at,
	c.created_at, c.updated_at, c.credentials_enc`

func scanConnection(row pgx.Row) (connection, error) {
	var c connection
	err := row.Scan(&c.ID, &c.WorkspaceID, &c.BrandID, &c.Name, &c.PhoneNumberID, &c.WABAID,
		&c.DisplayPhone, &c.VerifiedName, &c.APIVersion, &c.Status, &c.LastError, &c.LastEventAt,
		&c.CreatedAt, &c.UpdatedAt, &c.credentialsEnc)
	return c, err
}

// loadConnectionByID reads one connection by id, for the public webhook before a workspace
// is known.
func loadConnectionByID(ctx context.Context, q db.Querier, id uuid.UUID) (connection, error) {
	return scanConnection(q.QueryRow(ctx, `SELECT `+connectionColumns+` FROM whatsapp_connections c WHERE c.id = $1`, id))
}

// loadConnection reads one connection by id.
func loadConnection(ctx context.Context, q db.Querier, wid, id uuid.UUID) (connection, error) {
	return scanConnection(q.QueryRow(ctx, `SELECT `+connectionColumns+` FROM whatsapp_connections c
		WHERE c.workspace_id = $1 AND c.id = $2`, wid, id))
}

// listConnections lists a workspace's connections.
func listConnections(ctx context.Context, q db.Querier, wid uuid.UUID) ([]connection, error) {
	rows, err := q.Query(ctx, `SELECT `+connectionColumns+` FROM whatsapp_connections c
		WHERE c.workspace_id = $1 ORDER BY c.created_at`, wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []connection
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// loadConnectionByPhoneNumber reads the workspace's connection for a number. Meta posts every
// number of an app to one callback URL, so the payload's phone_number_id decides the connection.
func loadConnectionByPhoneNumber(ctx context.Context, q db.Querier, wid uuid.UUID, phoneNumberID string) (connection, error) {
	return scanConnection(q.QueryRow(ctx, `SELECT `+connectionColumns+` FROM whatsapp_connections c
		WHERE c.workspace_id = $1 AND c.phone_number_id = $2`, wid, phoneNumberID))
}

// insertConnection stores a new connection.
func insertConnection(ctx context.Context, q db.Querier, c connection) error {
	_, err := q.Exec(ctx, `INSERT INTO whatsapp_connections (id, workspace_id, brand_id, name, phone_number_id,
		waba_id, display_phone, verified_name, api_version, status, last_error, created_by, created_at, updated_at, credentials_enc)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, c.ID, c.WorkspaceID, c.BrandID, c.Name,
		c.PhoneNumberID, c.WABAID, c.DisplayPhone, c.VerifiedName, c.APIVersion, c.Status, c.LastError,
		c.CreatedBy, c.CreatedAt, c.UpdatedAt, c.credentialsEnc)
	return err
}

// updateConnection stores a connection's mutable fields: name, credentials, the account it
// points at and its health.
func updateConnection(ctx context.Context, q db.Querier, c connection) error {
	_, err := q.Exec(ctx, `UPDATE whatsapp_connections SET name = $3, phone_number_id = $4, waba_id = $5,
		display_phone = $6, verified_name = $7, api_version = $8, status = $9, last_error = $10,
		credentials_enc = $11, updated_at = $12 WHERE workspace_id = $1 AND id = $2`, c.WorkspaceID, c.ID,
		c.Name, c.PhoneNumberID, c.WABAID, c.DisplayPhone, c.VerifiedName, c.APIVersion, c.Status,
		c.LastError, c.credentialsEnc, c.UpdatedAt)
	return err
}

// deleteConnection removes a connection, its inbound events and its templates. Its tickets
// and their windows stay with the number, for when it is connected again.
func deleteConnection(ctx context.Context, q db.Querier, wid, id uuid.UUID) error {
	_, err := q.Exec(ctx, `DELETE FROM whatsapp_connections WHERE workspace_id = $1 AND id = $2`, wid, id)
	return err
}

// insertInboundEvent stores a verified Meta delivery. false means Meta's retry of one already
// stored, so the dispatcher stops here.
func insertInboundEvent(ctx context.Context, q db.Querier, wid, connID uuid.UUID, externalID string, payload []byte) (uuid.UUID, bool, error) {
	id := ids.New()
	tag, err := q.Exec(ctx, `INSERT INTO whatsapp_inbound_events (id, workspace_id, connection_id, external_event_id, payload, received_at)
		VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (connection_id, external_event_id) DO NOTHING`, id, wid, connID, externalID, json.RawMessage(payload))
	if err != nil {
		return uuid.Nil, false, err
	}
	return id, tag.RowsAffected() == 1, nil
}

// loadInboundEvent reads one stored delivery by id.
func loadInboundEvent(ctx context.Context, q db.Querier, wid, id uuid.UUID) (connID uuid.UUID, payload []byte, err error) {
	err = q.QueryRow(ctx, `SELECT connection_id, payload FROM whatsapp_inbound_events
		WHERE workspace_id = $1 AND id = $2`, wid, id).Scan(&connID, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, pgx.ErrNoRows
	}
	return connID, payload, err
}

// touchConnection records the latest delivery on a connection and clears its error.
func touchConnection(ctx context.Context, q db.Querier, id uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE whatsapp_connections SET last_event_at = now(), status = 'connected', last_error = '' WHERE id = $1`, id)
	return err
}

// markConnectionError records why a connection cannot send, so the settings page can say it.
func markConnectionError(ctx context.Context, q db.Querier, id uuid.UUID, msg string) error {
	_, err := q.Exec(ctx, `UPDATE whatsapp_connections SET status = 'error', last_error = $2 WHERE id = $1`, id, msg)
	return err
}

// errNoConversation and errDisconnected are why a ticket's WhatsApp message cannot go out.
var (
	errNoConversation = errors.New("ticket has no whatsapp conversation")
	errDisconnected   = errors.New("ticket's whatsapp number is not connected")
)

// ticketConnection is where a ticket's messages go out: its conversation (thread.ForTicket)
// and the connection that holds the conversation's number now, so a number disconnected and
// connected again keeps its tickets.
func ticketConnection(ctx context.Context, q db.Querier, wid, ticketID uuid.UUID) (connection, thread.Thread, error) {
	th, err := thread.ForTicket(ctx, q, wid, ticketID)
	if errors.Is(err, pgx.ErrNoRows) {
		return connection{}, th, errNoConversation
	}
	if err != nil {
		return connection{}, th, err
	}
	if th.ConnectionID == nil {
		return connection{}, th, errDisconnected
	}
	c, err := loadConnection(ctx, q, wid, *th.ConnectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return connection{}, th, errDisconnected
	}
	return c, th, err
}

// pruneEvents removes applied deliveries older than eventRetention.
func pruneEvents(ctx context.Context, q db.Querier) error {
	_, err := q.Exec(ctx, `DELETE FROM whatsapp_inbound_events WHERE received_at < now() - interval '7 days'`)
	return err
}
