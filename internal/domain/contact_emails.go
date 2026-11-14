package domain

import (
	"context"
	"net/mail"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// A contact has one primary email (contacts.email) and any number of extra addresses
// (contact_emails). An address belongs to one contact in a workspace, primary or extra: the
// triggers of migration 000733 hold that for every writer. Mail from an extra address lands on
// the contact (UpsertContactByEmail); a contact is blocked, and signs in to the customer
// portal, by its primary address alone.

// MaxContactEmails bounds the extra addresses of one contact.
const MaxContactEmails = 20

// ExtraEmailLikeSQL is a condition for a contact search (alias ct): one of the contact's extra
// addresses starts like the lowercased LIKE pattern in the placeholder arg, such as "$3".
func ExtraEmailLikeSQL(arg string) string {
	return `EXISTS (SELECT 1 FROM contact_emails x WHERE x.workspace_id = ct.workspace_id AND x.contact_id = ct.id AND lower(x.email::text) LIKE ` + arg + `)`
}

// CleanContactEmail validates and lowercases an address a person typed.
func CleanContactEmail(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || len(s) > 254 || !strings.Contains(s[strings.LastIndex(s, "@")+1:], ".") {
		return "", httpx.Validation("email is not a valid address")
	}
	return s, nil
}

// ContactByAddress finds the contact an address belongs to, primary or extra.
func ContactByAddress(ctx context.Context, q db.Querier, wid uuid.UUID, email string) (uuid.UUID, bool, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM contacts WHERE workspace_id = $1 AND email = $2
		UNION ALL SELECT contact_id FROM contact_emails WHERE workspace_id = $1 AND email = $2 LIMIT 1`, wid, email).Scan(&id)
	if db.IsNotFound(err) {
		return uuid.Nil, false, nil
	}
	return id, err == nil, err
}

// AddContactEmail gives the contact an extra address. An address that already belongs to a
// contact, this one included, is a 409. Extras sit beside a primary address, so a contact
// without one gets its primary first.
func AddContactEmail(ctx context.Context, tx pgx.Tx, wid, contactID uuid.UUID, email string) error {
	var hasPrimary bool
	var n int
	if err := tx.QueryRow(ctx, `SELECT c.email IS NOT NULL, (SELECT count(*) FROM contact_emails e WHERE e.workspace_id = c.workspace_id AND e.contact_id = c.id)
		FROM contacts c WHERE c.workspace_id = $1 AND c.id = $2`, wid, contactID).Scan(&hasPrimary, &n); err != nil {
		return err
	}
	if !hasPrimary {
		return httpx.Validation("give the contact an email address before adding other addresses")
	}
	if n >= MaxContactEmails {
		return httpx.Validation("a contact can have at most 20 extra email addresses")
	}
	_, err := tx.Exec(ctx, `INSERT INTO contact_emails (workspace_id, contact_id, email) VALUES ($1, $2, $3)`, wid, contactID, email)
	if db.IsUniqueViolation(err, "") {
		return httpx.Conflict("A contact with this email already exists.")
	}
	return err
}

// RemoveContactEmail takes an extra address off the contact, and reports whether it had it.
func RemoveContactEmail(ctx context.Context, tx pgx.Tx, wid, contactID uuid.UUID, email string) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM contact_emails WHERE workspace_id = $1 AND contact_id = $2 AND email = $3`, wid, contactID, email)
	return tag.RowsAffected() > 0, err
}

// MakeContactEmailPrimary swaps one of the contact's extra addresses with its primary: the
// extra becomes the primary and the old primary an extra. It reports whether the contact had
// the address as an extra. Changing the primary ends the contact's customer-portal
// credentials (the contacts_customer_identity trigger).
func MakeContactEmailPrimary(ctx context.Context, tx pgx.Tx, wid, contactID uuid.UUID, email string) (bool, error) {
	var old *string
	if err := tx.QueryRow(ctx, `SELECT email FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, wid, contactID).Scan(&old); err != nil {
		return false, err
	}
	ok, err := RemoveContactEmail(ctx, tx, wid, contactID, email)
	if err != nil || !ok {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE contacts SET email = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`, wid, contactID, email); err != nil {
		return false, err
	}
	if old != nil {
		_, err = tx.Exec(ctx, `INSERT INTO contact_emails (workspace_id, contact_id, email) VALUES ($1, $2, $3)`, wid, contactID, *old)
	}
	return true, err
}
