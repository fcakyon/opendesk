package domain

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// MergeContacts folds contact src into dst and removes src: its tickets, messages, calls,
// uploads, labels and addresses become dst's. src's widget sessions end with it: a browser
// holding one proves only that it was src, so it never reads dst's conversations. dst keeps its own name, phone, company,
// external id and primary email, taking src's where it has none; notes are joined and custom
// values and fields merged with dst's winning. It returns the tickets that moved, for the
// caller to announce. Two contacts with different external ids (two identities the host
// product vouches for) are never merged, and neither are a blocked and a not blocked one.
func MergeContacts(ctx context.Context, tx pgx.Tx, wid, src, dst uuid.UUID) ([]uuid.UUID, error) {
	if src == dst {
		return nil, httpx.Validation("a contact can't be merged into itself")
	}
	type row struct {
		id                 uuid.UUID
		email, externalID  *string
		name, phone, notes string
		companyID          *uuid.UUID
		custom, fields     map[string]any
		blocked            bool
	}
	rows, err := tx.Query(ctx, `SELECT id, email, name, phone, company_id, external_id, notes, custom, fields, blocked FROM contacts
		WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE`, wid, []uuid.UUID{src, dst})
	if err != nil {
		return nil, err
	}
	got, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var c row
		err := r.Scan(&c.id, &c.email, &c.name, &c.phone, &c.companyID, &c.externalID, &c.notes, &c.custom, &c.fields, &c.blocked)
		return c, err
	})
	if err != nil {
		return nil, err
	}
	if len(got) != 2 {
		return nil, httpx.NotFound("Contact")
	}
	from, into := got[0], got[1]
	if from.id != src {
		from, into = into, from
	}
	if from.blocked != into.blocked {
		return nil, httpx.E(422, "contacts_blocked_differ", "A blocked contact can't be merged with one that is not blocked. Unblock or block them first.")
	}
	if from.externalID != nil && into.externalID != nil && *from.externalID != *into.externalID {
		return nil, httpx.E(409, "external_id_conflict", "These contacts have different external ids, so they are different people to your product.")
	}

	// Addresses: src's primary and extras become dst's extras. src gives them up first, so the
	// one-owner triggers see them free.
	var addrs []string
	if from.email != nil {
		addrs = append(addrs, *from.email)
	}
	erows, err := tx.Query(ctx, `SELECT email::text FROM contact_emails WHERE workspace_id = $1 AND contact_id = $2 ORDER BY created_at, email`, wid, src)
	if err != nil {
		return nil, err
	}
	extra, err := pgx.CollectRows(erows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	addrs = append(addrs, extra...)
	// A stayer without a primary address takes src's first one as its primary: extras sit
	// beside a primary.
	primary := into.email
	if primary == nil && len(addrs) > 0 {
		primary, addrs = &addrs[0], addrs[1:]
	}
	var have int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM contact_emails WHERE workspace_id = $1 AND contact_id = $2`, wid, dst).Scan(&have); err != nil {
		return nil, err
	}
	if have+len(addrs) > MaxContactEmails {
		return nil, httpx.Validation("the merged contact would have more than 20 extra email addresses")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM contact_emails WHERE workspace_id = $1 AND contact_id = $2`, wid, src); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE contacts SET email = NULL, external_id = NULL WHERE workspace_id = $1 AND id = $2`, wid, src); err != nil {
		return nil, err
	}
	for _, a := range addrs {
		if _, err := tx.Exec(ctx, `INSERT INTO contact_emails (workspace_id, contact_id, email) VALUES ($1, $2, $3)`, wid, dst, a); err != nil {
			return nil, err
		}
	}

	// What src did and was part of.
	moved, err := uuidsFrom(ctx, tx, `UPDATE tickets SET contact_id = $3 WHERE workspace_id = $1 AND contact_id = $2 RETURNING id`, wid, src, dst)
	if err != nil {
		return nil, err
	}
	for _, q := range []string{
		`UPDATE messages SET author_contact_id = $3 WHERE workspace_id = $1 AND author_contact_id = $2`,
		`UPDATE phone_calls SET contact_id = $3 WHERE workspace_id = $1 AND contact_id = $2`,
		`UPDATE attachments SET uploaded_by_contact_id = $3 WHERE workspace_id = $1 AND uploaded_by_contact_id = $2`,
		`UPDATE api_key_requests SET contact_id = $3 WHERE workspace_id = $1 AND contact_id = $2`,
	} {
		if _, err := tx.Exec(ctx, q, wid, src, dst); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO contact_tags (contact_id, tag_id) SELECT $2, tag_id FROM contact_tags WHERE contact_id = $1
		ON CONFLICT DO NOTHING`, src, dst); err != nil {
		return nil, err
	}

	// dst's own details win; blanks take src's.
	name, phone, notes, company, external := into.name, into.phone, into.notes, into.companyID, into.externalID
	if name == "" {
		name = from.name
	}
	if phone == "" {
		phone = from.phone
	}
	if company == nil {
		company = from.companyID
	}
	if external == nil {
		external = from.externalID
	}
	if s := strings.TrimSpace(from.notes); s != "" {
		if strings.TrimSpace(notes) == "" {
			notes = from.notes
		} else {
			notes = strings.TrimRight(notes, "\n ") + "\n\n" + from.notes
		}
	}
	custom, fields := map[string]any{}, map[string]any{}
	for _, m := range []map[string]any{from.custom, into.custom} {
		for k, v := range m {
			custom[k] = v
		}
	}
	for _, m := range []map[string]any{from.fields, into.fields} {
		for k, v := range m {
			fields[k] = v
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE contacts SET name = $3, phone = $4, company_id = $5, external_id = $6, notes = $7, custom = $8,
		fields = $9, email = $10, updated_at = now() WHERE workspace_id = $1 AND id = $2`, wid, dst, name, phone, company, external, notes, custom, fields, primary); err != nil {
		return nil, err
	}
	// Its portal sign-in, sessions and reset links, widget sessions, labels and extra rows go with it.
	if _, err := tx.Exec(ctx, `DELETE FROM contacts WHERE workspace_id = $1 AND id = $2`, wid, src); err != nil {
		return nil, err
	}
	return moved, nil
}

func uuidsFrom(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}
