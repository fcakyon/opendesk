package wiki

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
)

// Viewer is who reads the wiki (contracts/wiki.md "Private pages and teamspaces"): a page
// in the trash, a template, someone else's private page or a page of a private team they
// are not on is never theirs to see, except where a query asks for the trash or templates.
type Viewer struct {
	// Me sees their own private pages; nil (an API key, a procedure) sees none.
	Me *uuid.UUID
	// Hidden are the private teams whose pages stay out of sight.
	Hidden []uuid.UUID
}

// ViewerOf is the principal's view of the wiki.
func ViewerOf(ctx context.Context, q db.Querier, p *auth.Principal) (Viewer, error) {
	hidden, err := domain.HiddenTeams(ctx, q, p)
	if err != nil {
		return Viewer{}, err
	}
	if hidden == nil {
		hidden = []uuid.UUID{}
	}
	return Viewer{Me: p.ActorUserID(), Hidden: hidden}, nil
}

// WorkspaceViewer sees what the whole workspace shares: no private pages and no page of a
// private team. Procedures and other workspace-wide readers use it.
func WorkspaceViewer(ctx context.Context, q db.Querier, wid uuid.UUID) (Viewer, error) {
	var hidden []uuid.UUID
	err := q.QueryRow(ctx, `SELECT COALESCE(array_agg(id), '{}') FROM teams WHERE workspace_id = $1 AND private`, wid).Scan(&hidden)
	return Viewer{Hidden: hidden}, err
}

// seesSQL is the predicate for a page aliased alias that the viewer may see in its space,
// with the viewer's id bound as $me and its hidden teams as $hidden. It says nothing about
// the trash or templates: see liveSQL.
func seesSQL(alias string, me, hidden int) string {
	return fmt.Sprintf(`((%[1]s.private_to IS NULL OR %[1]s.private_to = $%[2]d::uuid) AND (%[1]s.team_id IS NULL OR NOT %[1]s.team_id = ANY($%[3]d::uuid[])))`, alias, me, hidden)
}

// liveSQL is seesSQL for pages of the tree: not in the trash, not a template.
func liveSQL(alias string, me, hidden int) string {
	return fmt.Sprintf(`(%[1]s.deleted_at IS NULL AND NOT %[1]s.template AND %[2]s)`, alias, seesSQL(alias, me, hidden))
}

// args are the values seesSQL and liveSQL bind.
func (v Viewer) args() (any, any) { return v.Me, v.Hidden }
