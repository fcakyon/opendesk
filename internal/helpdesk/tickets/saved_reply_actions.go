package tickets

// applySavedReplyActions applies the actions of the saved replies a message used
// (MessageInput.SavedReplyIDs) in the message's transaction: labels added and removed, then the
// team, then the assignee (a later reply's team or assignee wins). They apply only once the
// message is sent, so a discarded draft changes nothing. Unknown or deleted replies, and those of
// a private team the sender does not see, are skipped; a label that no longer exists is created
// when the sender may create labels (settings.label_creation), else skipped.

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

func applySavedReplyActions(ctx context.Context, tx pgx.Tx, d *deps.Deps, p *auth.Principal, tid uuid.UUID, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(refs))
	for _, r := range refs {
		if id, err := uuid.Parse(r); err == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	wid := p.WorkspaceID
	hidden, err := domain.HiddenTeams(ctx, tx, p)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, actions FROM saved_replies WHERE workspace_id = $1 AND id = ANY($2)
		AND (team_id IS NULL OR team_id <> ALL($3::uuid[]))`, wid, ids, append([]uuid.UUID{}, hidden...))
	if err != nil {
		return err
	}
	byID := map[uuid.UUID]hd.SavedReplyActions{}
	for rows.Next() {
		var id uuid.UUID
		var a hd.SavedReplyActions
		if err := rows.Scan(&id, &a); err != nil {
			rows.Close()
			return err
		}
		byID[id] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var all hd.SavedReplyActions
	for _, id := range ids { // in the order the agent used them
		if a, ok := byID[id]; ok {
			all = all.Merge(a)
		}
	}
	if all.Empty() {
		return nil
	}
	create, err := hd.CanCreateLabels(ctx, tx, p)
	if err != nil {
		return err
	}
	patch := Patch{AddTags: all.AddTags, RemoveTags: all.RemoveTags, CreateLabels: create}
	if all.TeamID != nil {
		patch.Team = Opt[uuid.UUID]{Set: true, Value: *all.TeamID}
	}
	if all.AssigneeID != nil {
		patch.Assignee = Opt[uuid.UUID]{Set: true, Value: *all.AssigneeID}
	}
	_, err = applyPatch(ctx, tx, d, wid, tid, actorOf(p), patch, applyOpts{Enqueue: true, Lenient: true})
	return err
}
