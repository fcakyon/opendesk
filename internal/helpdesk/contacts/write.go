package contacts

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/images"
)

// insertContact creates a contact from b in tx and announces it: the one way a contact is
// created, by the API and by an import.
func insertContact(ctx context.Context, d *deps.Deps, tx pgx.Tx, p *auth.Principal, b *contactWriteBody) (domain.Contact, error) {
	row := contactRow{}
	if err := b.apply(ctx, tx, p.WorkspaceID, &row); err != nil {
		return domain.Contact{}, err
	}
	if row.Email == nil && row.Name == "" {
		return domain.Contact{}, httpx.Validation("a contact needs an email or a name")
	}
	if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityContact, &row.Fields, b.Fields); err != nil {
		return domain.Contact{}, err
	}
	id := ids.New()
	if _, err := tx.Exec(ctx, `INSERT INTO contacts (id, workspace_id, email, name, phone, company_id,
		external_id, notes, custom, blocked, fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, p.WorkspaceID, row.Email, row.Name, row.Phone, row.CompanyID, row.ExternalID,
		row.Notes, row.Custom, row.Blocked, row.Fields); err != nil {
		return domain.Contact{}, uniqueErr(err)
	}
	if _, err := pictureFromURL(ctx, d, tx, p.WorkspaceID, id, row.PictureURL); err != nil {
		return domain.Contact{}, err
	}
	if err := applyLabels(ctx, tx, p, domain.ContactLabels, id, b.Tags, b.AddTags, b.RemoveTags); err != nil {
		return domain.Contact{}, err
	}
	c, err := domain.LoadContact(ctx, tx, p.WorkspaceID, id)
	if err != nil {
		return domain.Contact{}, err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.created", Data: map[string]any{"contact": c}})
	return c, err
}

// patchContact merges b into a contact in tx and announces it: the one way a contact is
// edited, by the API and by an import.
func patchContact(ctx context.Context, d *deps.Deps, tx pgx.Tx, p *auth.Principal, id uuid.UUID, b *contactWriteBody) (domain.Contact, error) {
	var row contactRow
	err := tx.QueryRow(ctx, `SELECT email, name, phone, company_id, external_id, notes, custom, blocked, fields
		FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).
		Scan(&row.Email, &row.Name, &row.Phone, &row.CompanyID, &row.ExternalID, &row.Notes, &row.Custom, &row.Blocked, &row.Fields)
	oldEmail := row.Email
	if db.IsNotFound(err) {
		return domain.Contact{}, httpx.NotFound("Contact")
	}
	if err != nil {
		return domain.Contact{}, err
	}
	if err := b.apply(ctx, tx, p.WorkspaceID, &row); err != nil {
		return domain.Contact{}, err
	}
	if row.Email == nil && row.Name == "" {
		return domain.Contact{}, httpx.Validation("a contact needs an email or a name")
	}
	if row.Email == nil && oldEmail != nil {
		// Extra addresses sit beside a primary one.
		var extras bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM contact_emails WHERE workspace_id = $1 AND contact_id = $2)`, p.WorkspaceID, id).Scan(&extras); err != nil {
			return domain.Contact{}, err
		}
		if extras {
			return domain.Contact{}, httpx.Validation("a contact with other email addresses keeps a primary one: make one of them the primary instead")
		}
	}
	if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityContact, &row.Fields, b.Fields); err != nil {
		return domain.Contact{}, err
	}
	// The contacts_customer_identity trigger ends customer credentials, sessions
	// and reset links when the email changes or the contact is blocked.
	if _, err := tx.Exec(ctx, `UPDATE contacts SET email = $3, name = $4, phone = $5, company_id = $6,
		external_id = $7, notes = $8, custom = $9, blocked = $10, fields = $11, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
		p.WorkspaceID, id, row.Email, row.Name, row.Phone, row.CompanyID, row.ExternalID,
		row.Notes, row.Custom, row.Blocked, row.Fields); err != nil {
		return domain.Contact{}, uniqueErr(err)
	}
	if prefix, err := pictureFromURL(ctx, d, tx, p.WorkspaceID, id, row.PictureURL); err != nil {
		return domain.Contact{}, err
	} else if prefix != "" {
		defer images.Discard(d.Storage, prefix)
	}
	if !sameEmail(oldEmail, row.Email) {
		// A new address may have a different Gravatar picture.
		if _, err := tx.Exec(ctx, `UPDATE contacts SET avatar_retry_at = now(), avatar_failures = 0
			WHERE workspace_id = $1 AND id = $2 AND avatar_source IS DISTINCT FROM 'upload'`, p.WorkspaceID, id); err != nil {
			return domain.Contact{}, err
		}
	}
	if err := applyLabels(ctx, tx, p, domain.ContactLabels, id, b.Tags, b.AddTags, b.RemoveTags); err != nil {
		return domain.Contact{}, err
	}
	c, err := domain.LoadContact(ctx, tx, p.WorkspaceID, id)
	if err != nil {
		return domain.Contact{}, err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.updated", Data: map[string]any{"contact": c}})
	return c, err
}
