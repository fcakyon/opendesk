package contacts

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

type contactWriteBody struct {
	Email      Nullable[string] `json:"email,omitempty" doc:"Email address; null clears it"`
	Name       *string          `json:"name,omitempty" maxLength:"200"`
	Phone      *string          `json:"phone,omitempty" maxLength:"50"`
	AvatarURL  *string          `json:"avatar_url,omitempty" maxLength:"2000" doc:"An https picture URL to copy (fetched and processed server-side, counts as an upload), or empty to remove the uploaded picture"`
	CompanyID  Nullable[string] `json:"company_id,omitempty" doc:"Company id; null clears it"`
	ExternalID Nullable[string] `json:"external_id,omitempty" doc:"Your system's id; null clears it"`
	Notes      *string          `json:"notes,omitempty" maxLength:"10000"`
	Custom     map[string]any   `json:"custom,omitempty"`
	Blocked    *bool            `json:"blocked,omitempty"`
	Tags       *[]string        `json:"tags,omitempty" maxItems:"50" doc:"Replaces the labels, by name"`
	AddTags    []string         `json:"add_tags,omitempty" maxItems:"50" doc:"Adds these labels, by name"`
	RemoveTags []string         `json:"remove_tags,omitempty" maxItems:"50" doc:"Removes these labels, by name"`
	Fields     map[string]any   `json:"fields,omitempty" doc:"Custom field values by key, merged; null clears a field"`
}

type contactOut struct{ Body domain.Contact }

// contactSorts are the orders the People list can take, by their `sort` value; newest first is
// the default. The ticket count is the one ContactSelect reads.
var contactSorts = func() map[string]listSort[domain.Contact] {
	created := timeSort("ct.created_at", func(c domain.Contact) time.Time { return c.CreatedAt })
	updated := timeSort("ct.updated_at", func(c domain.Contact) time.Time { return c.UpdatedAt })
	name := nameSort("ct.name", func(c domain.Contact) string { return c.Name })
	tickets := countSort("(SELECT count(*) FROM tickets tk WHERE tk.contact_id = ct.id AND tk.deleted_at IS NULL)", func(c domain.Contact) int { return c.TicketCount })
	return map[string]listSort[domain.Contact]{"-created": created, "created": created, "-updated": updated, "updated": updated,
		"name": name, "-name": name, "-tickets": tickets, "tickets": tickets}
}()

type ticketCursor struct {
	T  time.Time `json:"t"`
	ID uuid.UUID `json:"id"`
}

// contactRow is the editable state of a contact.
type contactRow struct {
	Email      *string
	Name       string
	Phone      string
	PictureURL *string // set: copy this picture ("" removes the manual one)
	CompanyID  *uuid.UUID
	ExternalID *string
	Notes      string
	Custom     map[string]any
	Blocked    bool
	Fields     map[string]any
}

// apply validates b and merges it into row.
func (b *contactWriteBody) apply(ctx context.Context, q db.Querier, wid uuid.UUID, row *contactRow) error {
	if b.Email.Set {
		if b.Email.Null {
			row.Email = nil
		} else {
			e, err := cleanEmail(b.Email.Value)
			if err != nil {
				return err
			}
			if e == "" {
				row.Email = nil
			} else {
				row.Email = &e
			}
		}
	}
	if b.Name != nil {
		n, err := displayname.Validate("Name", *b.Name, displayname.Person, true)
		if err != nil {
			return err
		}
		row.Name = n
	}
	if row.Name == "" && row.Email != nil {
		row.Name = displayname.FromEmail(*row.Email)
	}
	if b.Phone != nil {
		s, err := cleanText("phone", *b.Phone, 50, false)
		if err != nil {
			return err
		}
		row.Phone = s
	}
	if b.AvatarURL != nil {
		s, err := cleanAvatar(*b.AvatarURL)
		if err != nil {
			return err
		}
		row.PictureURL = &s
	}
	if b.CompanyID.Set {
		if b.CompanyID.Null || strings.TrimSpace(b.CompanyID.Value) == "" {
			row.CompanyID = nil
		} else {
			id, err := hd.ParseRef(b.CompanyID.Value, "company_id")
			if err != nil {
				return err
			}
			if err := hd.CheckRef(ctx, q, wid, "company", id); err != nil {
				return err
			}
			row.CompanyID = &id
		}
	}
	if b.ExternalID.Set {
		s := strings.TrimSpace(b.ExternalID.Value)
		if b.ExternalID.Null || s == "" {
			row.ExternalID = nil
		} else {
			s, err := cleanText("external_id", s, 200, false)
			if err != nil {
				return err
			}
			row.ExternalID = &s
		}
	}
	if b.Notes != nil {
		s, err := cleanText("notes", *b.Notes, 10000, true)
		if err != nil {
			return err
		}
		row.Notes = s
	}
	if b.Custom != nil {
		m, err := cleanCustom(b.Custom)
		if err != nil {
			return err
		}
		row.Custom = m
	}
	if b.Blocked != nil {
		row.Blocked = *b.Blocked
	}
	if row.Custom == nil {
		row.Custom = map[string]any{}
	}
	return nil
}

func uniqueErr(err error) error {
	switch {
	case db.IsUniqueViolation(err, "contacts_ws_email_uq"):
		return httpx.Conflict("A contact with this email already exists.")
	case db.IsUniqueViolation(err, "contacts_ws_external_uq"):
		return httpx.Conflict("A contact with this external_id already exists.")
	}
	return err
}

// deleteContact deletes a contact of the caller's workspace, audits and announces it: the one
// way a contact is deleted, alone or in bulk (meta is the audit entry's). Its tickets stay,
// without a contact.
func deleteContact(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID, meta map[string]any) error {
	tag, err := tx.Exec(ctx, `DELETE FROM contacts WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("Contact")
	}
	if err := audit.Log(ctx, tx, p, p.WorkspaceID, "contact.deleted", "contact", &id, meta); err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.deleted", Data: map[string]any{"contact_id": id}})
	return err
}

func registerContacts(d *deps.Deps, api huma.API) {
	huma.Register(api, op("list-contacts", http.MethodGet, "/v1/contacts", "List contacts", "Contacts", 0),
		func(ctx context.Context, in *contactListIn) (*struct{ Body httpx.Page[domain.Contact] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if in.fieldsErr != nil {
				return nil, in.fieldsErr
			}
			f := contactFilter{Q: in.Q, CompanyID: in.CompanyID, Tag: in.Tag, Blocked: in.Blocked, ExternalID: in.ExternalID, Fields: in.fields}
			where, args, err := f.where(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			pg, err := pageOf(contactSorts, in.Sort, "-created", "ct.id", func(c domain.Contact) uuid.UUID { return c.ID }, in.Cursor, len(args)+1)
			if err != nil {
				return nil, err
			}
			args = append(args, pg.args...)
			args = append(args, in.Limit+1)
			rows, err := d.DB.Pool.Query(ctx, domain.ContactSelect+where+pg.after+pg.orderBy()+" LIMIT $"+strconv.Itoa(len(args)), args...)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Contact, error) { return domain.ScanContact(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(list, in.Limit, pg.cursor)
			return &struct{ Body httpx.Page[domain.Contact] }{page}, nil
		})

	huma.Register(api, op("create-contact", http.MethodPost, "/v1/contacts", "Create a contact", "Contacts", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body contactWriteBody }) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var c domain.Contact
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var err error
				c, err = insertContact(ctx, d, tx, p, &in.Body)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("get-contact", http.MethodGet, "/v1/contacts/{id}", "Get a contact", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			c, err := domain.LoadContact(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Contact")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("update-contact", http.MethodPatch, "/v1/contacts/{id}", "Update a contact", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body contactWriteBody
		}) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			var c domain.Contact
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var err error
				c, err = patchContact(ctx, d, tx, p, id, &in.Body)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("delete-contact", http.MethodDelete, "/v1/contacts/{id}", "Delete a contact", "Contacts", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error { return deleteContact(ctx, tx, p, id, nil) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})

	huma.Register(api, op("list-contact-tickets", http.MethodGet, "/v1/contacts/{id}/tickets", "List a contact's tickets", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
			httpx.ListParams
		}) (*struct{ Body httpx.Page[domain.Ticket] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind == auth.KindAPIKey && !p.HasScope(auth.ScopeTicketsRead) {
				return nil, httpx.Forbidden()
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			if err := hd.CheckRef(ctx, d.DB.Pool, p.WorkspaceID, "contact", id); err != nil {
				return nil, httpx.NotFound("Contact")
			}
			var cur ticketCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			var curT *time.Time
			if in.Cursor != "" {
				curT = &cur.T
			}
			hidden, err := domain.HiddenTeams(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, domain.TicketSelect+` WHERE t.workspace_id = $1 AND t.contact_id = $2 AND t.deleted_at IS NULL
				AND ($3::timestamptz IS NULL OR (t.last_message_at, t.id) < ($3, $4))
				AND `+domain.VisibleSQLUser("t", 6, 7)+`
				ORDER BY t.last_message_at DESC, t.id DESC LIMIT $5`, p.WorkspaceID, id, curT, cur.ID, in.Limit+1, hidden, p.ActorUserID())
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Ticket, error) { return domain.ScanTicket(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(list, in.Limit, func(t domain.Ticket) any { return ticketCursor{T: t.LastMessageAt, ID: t.ID} })
			return &struct{ Body httpx.Page[domain.Ticket] }{page}, nil
		})
}
