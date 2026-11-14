package hd

// Chat assignment: the workspace's own rule for live chats (contracts/api.md "Assignment"),
// apart from the team and address rules emails follow.

import (
	"context"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
)

// ChatAssignment is settings.chat_assign (none, round_robin or load_balanced; none or absent is
// off) and settings.chat_assign_skill_id: the skill a member must hold to be given a chat, nil
// for anyone in the pool.
type ChatAssignment struct {
	Mode    string
	SkillID *uuid.UUID
}

// On reports whether chats are assigned by their own rule.
func (c ChatAssignment) On() bool { return c.Mode == "round_robin" || c.Mode == "load_balanced" }

// LoadChatAssignment reads the workspace's chat assignment.
func LoadChatAssignment(ctx context.Context, q db.Querier, wid uuid.UUID) (ChatAssignment, error) {
	var c ChatAssignment
	var skill *string
	err := q.QueryRow(ctx, `SELECT COALESCE(settings->>'chat_assign', ''), settings->>'chat_assign_skill_id' FROM workspaces WHERE id = $1`, wid).
		Scan(&c.Mode, &skill)
	if err != nil {
		return c, err
	}
	if skill != nil {
		if id, err := uuid.Parse(*skill); err == nil {
			c.SkillID = &id
		}
	}
	return c, nil
}

// ChatAssigner gives an unassigned open chat to a member by the chat rule and returns who, or
// nil when it leaves the chat as it is (not a chat, the rule off, nobody eligible). The tickets
// package sets it (it holds the assignment path); nil before then.
type ChatAssigner func(ctx context.Context, tx pgx.Tx, wid, tid uuid.UUID) (*uuid.UUID, error)

var chatAssigner atomic.Pointer[ChatAssigner]

// SetChatAssigner registers the chat assignment the answer bot calls when it hands over.
func SetChatAssigner(f ChatAssigner) { chatAssigner.Store(&f) }

// AssignChat runs the registered chat assignment; nil when there is none.
func AssignChat(ctx context.Context, tx pgx.Tx, wid, tid uuid.UUID) (*uuid.UUID, error) {
	f := chatAssigner.Load()
	if f == nil || *f == nil {
		return nil, nil
	}
	return (*f)(ctx, tx, wid, tid)
}
