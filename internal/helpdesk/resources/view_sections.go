package resources

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// A view section is the name views share (View.Section), matched case-insensitively. Its
// icon belongs to that name in the workspace (view_sections, keyed by the name in lower
// case): every view that names the section carries it as section_icon. It stays when the
// section's views are deleted or moved, and shows again when a view names the section.

// ViewSection is a section as PATCH /v1/view-sections leaves it.
type ViewSection struct {
	Name  string    `json:"name" doc:"The section's name, as its views now spell it"`
	Icon  *ViewIcon `json:"icon" doc:"What the sidebar shows beside the section's heading; null for none"`
	Views int       `json:"views" doc:"How many of the views the caller sees name the section"`
}

type viewSectionBody struct {
	Section string     `json:"section" maxLength:"200" doc:"The section as its views name it, in any case"`
	Name    *string    `json:"name,omitempty" maxLength:"200" doc:"Renames the section: the views the caller sees that name it take this name, and its icon goes with it"`
	Icon    viewIconIn `json:"icon,omitempty"`
}

// sectionIcon is the icon of the section a view names; nil without a section or an icon.
func sectionIcon(ctx context.Context, q db.Querier, wid uuid.UUID, section *string) (*ViewIcon, error) {
	if section == nil {
		return nil, nil
	}
	var raw []byte
	err := q.QueryRow(ctx, `SELECT icon FROM view_sections WHERE workspace_id = $1 AND key = lower($2::text)`, wid, *section).Scan(&raw)
	if db.IsNotFound(err) {
		return nil, nil
	}
	return parseViewIcon(raw), err
}

// setSectionIcon stores the icon of the section keyed key; nil removes it.
func setSectionIcon(ctx context.Context, tx pgx.Tx, wid uuid.UUID, key string, icon *ViewIcon) error {
	if icon == nil {
		_, err := tx.Exec(ctx, `DELETE FROM view_sections WHERE workspace_id = $1 AND key = $2`, wid, key)
		return err
	}
	raw, err := json.Marshal(icon)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO view_sections (workspace_id, key, icon) VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, key) DO UPDATE SET icon = EXCLUDED.icon, updated_at = now()`, wid, key, raw)
	return err
}

// publishSectionViews announces every view of the section keyed key, each to who can see
// it, as view.updated: their section_icon (and, after a rename, their section) changed.
func publishSectionViews(ctx context.Context, tx pgx.Tx, wid uuid.UUID, key string) error {
	rows, err := tx.Query(ctx, viewSelect+` WHERE v.workspace_id = $1 AND lower(v.section) = $2 ORDER BY v.position, v.id`, wid, key)
	if err != nil {
		return err
	}
	views, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (View, error) { return scanView(r) })
	if err != nil {
		return err
	}
	for _, v := range views {
		if err := publishView(ctx, tx, wid, "view.updated", v, map[string]any{"view": v}); err != nil {
			return err
		}
	}
	return nil
}

func registerViewSections(d *deps.Deps, api huma.API) {
	huma.Register(api, op("update-view-section", http.MethodPatch, "/v1/view-sections", "Update a view section", "Views", 0),
		func(ctx context.Context, in *struct{ Body viewSectionBody }) (*struct{ Body ViewSection }, error) {
			// A section's icon shows to everyone whose views name it: shared-view rights.
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			from, err := cleanName("section", in.Body.Section, maxViewSection)
			if err != nil {
				return nil, err
			}
			to := from
			if in.Body.Name != nil {
				if to, err = cleanName("name", *in.Body.Name, maxViewSection); err != nil {
					return nil, err
				}
			}
			icon, err := cleanViewIcon(in.Body.Icon)
			if err != nil {
				return nil, err
			}
			out := ViewSection{Name: to}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var fromKey, toKey string
				if err := tx.QueryRow(ctx, `SELECT lower($1::text), lower($2::text)`, from, to).Scan(&fromKey, &toKey); err != nil {
					return err
				}
				visible := ` WHERE v.workspace_id = $1 AND lower(v.section) = $2 AND ` + hd.ViewVisibleSQL("v", 3)
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM views v`+visible, p.WorkspaceID, fromKey, viewer(p)).Scan(&out.Views); err != nil {
					return err
				}
				if out.Views == 0 {
					return httpx.NotFound("View section")
				}
				current, err := sectionIcon(ctx, tx, p.WorkspaceID, &from)
				if err != nil {
					return err
				}
				next := current
				if in.Body.Icon.Set {
					next = icon
				}
				if to != from {
					// Every view the caller sees in the section: admins write them all.
					if _, err := tx.Exec(ctx, `UPDATE views v SET section = $4, updated_at = now()`+visible, p.WorkspaceID, fromKey, viewer(p), to); err != nil {
						return err
					}
				}
				if toKey != fromKey {
					// Into a section that has an icon of its own, without a new one: it keeps its own.
					target, err := sectionIcon(ctx, tx, p.WorkspaceID, &to)
					if err != nil {
						return err
					}
					if target != nil && !in.Body.Icon.Set {
						next = target
					}
					// The old name keeps its icon while a view (another member's own) still names it.
					if _, err := tx.Exec(ctx, `DELETE FROM view_sections vs WHERE vs.workspace_id = $1 AND vs.key = $2
						AND NOT EXISTS (SELECT 1 FROM views v WHERE v.workspace_id = $1 AND lower(v.section) = $2)`, p.WorkspaceID, fromKey); err != nil {
						return err
					}
				}
				if err := setSectionIcon(ctx, tx, p.WorkspaceID, toKey, next); err != nil {
					return err
				}
				out.Icon = next
				if toKey != fromKey {
					if err := tx.QueryRow(ctx, `SELECT count(*) FROM views v`+visible, p.WorkspaceID, toKey, viewer(p)).Scan(&out.Views); err != nil {
						return err
					}
				}
				return publishSectionViews(ctx, tx, p.WorkspaceID, toKey)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ViewSection }{out}, nil
		})
}
