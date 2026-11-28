package domain

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Contact verification (contracts/api.md "Contact verification"). A chat visitor proves who
// they are by opening a link emailed to the address they gave in the widget, or by signing
// in on a widget with identity verification (user_hash). An address typed in the widget, or
// sent by the host page without user_hash, proves nothing until then.
const (
	VerificationVerified   = "verified"
	VerificationUnverified = "unverified"
	VerificationNone       = "none"

	VerifiedViaEmail    = "email"
	VerifiedViaIdentity = "identity"
)

// ContactVerification is whether a contact proved who they are.
type ContactVerification struct {
	Status     string     `json:"status" enum:"verified,unverified,none" doc:"verified: they opened a link emailed to their address, or signed in on a widget with identity verification; unverified: a chat visitor whose address came through the widget and is not confirmed yet; none: neither (an anonymous visitor, or a contact the widget did not create)"`
	Via        *string    `json:"via" enum:"email,identity" doc:"How a verified contact proved it; null otherwise"`
	VerifiedAt *time.Time `json:"verified_at"`
}

// verifiedProof is what contacts.verified_* hold.
type verifiedProof struct {
	via, email *string
	at         *time.Time
}

// of decides c's verification. An email proof counts while the address it confirmed is still
// one of c's: the primary, an extra or the address the visitor gave in the widget. A changed
// address is not verified until it is confirmed in turn.
func (p verifiedProof) of(c Contact) ContactVerification {
	if p.via != nil && p.at != nil {
		switch *p.via {
		case VerifiedViaIdentity:
			return ContactVerification{Status: VerificationVerified, Via: p.via, VerifiedAt: p.at}
		case VerifiedViaEmail:
			if p.email != nil && HasAddress(c, *p.email) {
				return ContactVerification{Status: VerificationVerified, Via: p.via, VerifiedAt: p.at}
			}
		}
	}
	if FromWidget(c) && ClaimedEmail(c) != "" {
		return ContactVerification{Status: VerificationUnverified}
	}
	return ContactVerification{Status: VerificationNone}
}

// FromWidget reports whether the chat widget created the contact.
func FromWidget(c Contact) bool {
	s, _ := c.Custom["source"].(string)
	return s == "widget"
}

// ClaimedEmail is the address a contact goes by: their email, else the address they gave in
// the widget while another contact holds it (custom.widget_email). "" when neither.
func ClaimedEmail(c Contact) string {
	if c.Email != nil && *c.Email != "" {
		return *c.Email
	}
	s, _ := c.Custom["widget_email"].(string)
	return strings.TrimSpace(s)
}

// HasAddress reports whether addr is one of c's addresses, the widget's claim included.
func HasAddress(c Contact, addr string) bool {
	if addr == "" {
		return false
	}
	if c.Email != nil && strings.EqualFold(addr, *c.Email) {
		return true
	}
	if claim, _ := c.Custom["widget_email"].(string); strings.EqualFold(addr, strings.TrimSpace(claim)) {
		return true
	}
	for _, e := range c.Emails {
		if strings.EqualFold(addr, e) {
			return true
		}
	}
	return false
}

// MarkIdentityVerified records that the contact signed in on a widget with identity
// verification. It reports whether that changed the contact; the caller publishes
// contact.updated when it did.
func MarkIdentityVerified(ctx context.Context, tx pgx.Tx, wid, cid uuid.UUID) (bool, error) {
	tag, err := tx.Exec(ctx, `UPDATE contacts SET verified_via = 'identity', verified_email = NULL, verified_at = now(), updated_at = now()
		WHERE workspace_id = $1 AND id = $2 AND verified_via IS DISTINCT FROM 'identity'`, wid, cid)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// MarkEmailVerified records that the contact confirmed addr with an emailed link. A contact
// verified by identity stays so. It reports whether that changed the contact.
func MarkEmailVerified(ctx context.Context, tx pgx.Tx, wid, cid uuid.UUID, addr string) (bool, error) {
	tag, err := tx.Exec(ctx, `UPDATE contacts SET verified_via = 'email', verified_email = $3, verified_at = now(), updated_at = now()
		WHERE workspace_id = $1 AND id = $2 AND verified_via IS DISTINCT FROM 'identity'
			AND (verified_via IS NULL OR verified_email IS DISTINCT FROM $3::citext)`, wid, cid, addr)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
