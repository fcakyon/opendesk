package resources

// The chat rule in GET and PATCH /v1/assignment.

import (
	"context"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// loadChatAssignment fills a's chat rule: its mode (none when off) and its skill, null when the
// skill is not set or no longer exists (a chat then waits for nobody: see chatAssignmentPatch).
func loadChatAssignment(ctx context.Context, q db.Querier, wid uuid.UUID, a *Assignment) error {
	c, err := hd.LoadChatAssignment(ctx, q, wid)
	if err != nil {
		return err
	}
	a.ChatMode = "none"
	if c.On() {
		a.ChatMode = c.Mode
	}
	if c.SkillID != nil {
		var ok bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM skills WHERE workspace_id = $1 AND id = $2)`, wid, *c.SkillID).Scan(&ok); err != nil {
			return err
		}
		if ok {
			s := c.SkillID.String()
			a.ChatSkillID = &s
		}
	}
	return nil
}

// chatAssignmentPatch validates a change to the chat rule and adds it to the settings patch.
// The skill must be one of the workspace's, not archived; empty means anyone in the pool.
func chatAssignmentPatch(ctx context.Context, q db.Querier, wid uuid.UUID, mode, skill *string, patch map[string]any) error {
	if mode != nil {
		if !slices.Contains(assignModes, *mode) {
			return httpx.Validation("chat_mode must be none, round_robin or load_balanced.")
		}
		patch["chat_assign"] = *mode
	}
	if skill != nil {
		v := strings.TrimSpace(*skill)
		if v == "" {
			patch["chat_assign_skill_id"] = nil
			return nil
		}
		id, err := uuid.Parse(v)
		if err != nil {
			return httpx.Validation("chat_skill_id must be a skill's id.")
		}
		var ok bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM skills WHERE workspace_id = $1 AND id = $2 AND NOT archived)`, wid, id).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return httpx.Validation("chat_skill_id must be a skill of this workspace.")
		}
		patch["chat_assign_skill_id"] = id.String()
	}
	return nil
}
