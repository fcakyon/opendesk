package tickets

// A live chat goes to one member who takes chats, at once, so a visitor gets a person while
// they are still on the page. Emails keep their own rules (a team's, an address's, the
// workspace default).

import (
	"context"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// registerChatAssigner lets the answer bot's hand-over (hd.MarkAIHandoff) and its decline when
// it reached its cap give the chat to a member.
func registerChatAssigner(d *deps.Deps) {
	hd.SetChatAssigner(func(ctx context.Context, tx pgx.Tx, wid, tid uuid.UUID) (*uuid.UUID, error) {
		return assignChat(ctx, tx, d, wid, tid)
	})
}

// autoAssignChat is auto-assignment for a chat when the workspace assigns chats by their own
// rule (settings.chat_assign): handled reports that the ticket is such a chat, assigned now or
// left for later, so the team's or address's rule does not apply to it. While the answer bot
// takes the chat on (widget answers on, not handed over), it waits: a chat with an assignee
// silences the bot, so the chat goes to a member when the bot hands over (MarkAIHandoff), or on
// the visitor's next message when nobody was free then.
func autoAssignChat(ctx context.Context, tx pgx.Tx, d *deps.Deps, wid, tid uuid.UUID) (handled bool, err error) {
	rule, err := hd.LoadChatAssignment(ctx, tx, wid)
	if err != nil || !rule.On() {
		return false, err
	}
	var team, mailbox, contact *uuid.UUID
	var channel string
	var custom map[string]any
	err = tx.QueryRow(ctx, `SELECT team_id, mailbox_id, contact_id, channel, custom FROM tickets WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
		wid, tid).Scan(&team, &mailbox, &contact, &channel, &custom)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil || channel != domain.ChannelChat {
		return false, err
	}
	if v, _ := custom["ai_handoff"].(bool); !v {
		s, err := hd.LoadSettings(ctx, tx, wid)
		if err != nil {
			return true, err
		}
		if bot, err := botAnswers(ctx, tx, d, s, wid, team, mailbox, contact, channel); err != nil || bot {
			return true, err
		}
	}
	_, err = assignChat(ctx, tx, d, wid, tid)
	return true, err
}

// assignChat gives the chat tid, unassigned, open and not spam, to the next member of its pool
// who holds the chat skill, is online (not away) and under their cap, by the chat rule's mode
// (load_balanced: the fewest open and pending tickets, ties round robin), as auto-assignment
// does: an assigned activity by system, via chat, and the member's assigned notification. It
// returns who, or nil when it leaves the chat as it is.
func assignChat(ctx context.Context, tx pgx.Tx, d *deps.Deps, wid, tid uuid.UUID) (*uuid.UUID, error) {
	rule, err := hd.LoadChatAssignment(ctx, tx, wid)
	if err != nil || !rule.On() {
		return nil, err
	}
	var assignee, team, mailbox *uuid.UUID
	var channel, status string
	var spam bool
	var required []uuid.UUID
	err = tx.QueryRow(ctx, `SELECT assignee_id, team_id, mailbox_id, channel, status, spam,
		COALESCE((SELECT array_agg(skill_id ORDER BY skill_id) FROM ticket_skills WHERE workspace_id = tickets.workspace_id AND ticket_id = tickets.id), '{}')
		FROM tickets WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, wid, tid).
		Scan(&assignee, &team, &mailbox, &channel, &status, &spam, &required)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if channel != domain.ChannelChat || assignee != nil || spam || closing(status) {
		return nil, nil
	}
	if rule.SkillID != nil && !slices.Contains(required, *rule.SkillID) {
		required = append(required, *rule.SkillID)
	}
	// The pool auto-assignment uses: the chat's team, else its address's team, else everyone.
	pool := team
	if pool == nil && mailbox != nil {
		if err := tx.QueryRow(ctx, `SELECT team_id FROM mailboxes WHERE workspace_id = $1 AND id = $2`, wid, *mailbox).Scan(&pool); err != nil && !db.IsNotFound(err) {
			return nil, err
		}
	}
	next, err := PickAssignee(ctx, tx, wid, pool, rule.Mode, required)
	if err != nil || next == nil {
		return nil, err
	}
	changes, err := applyPatch(ctx, tx, d, wid, tid, Actor{Type: "system", Meta: map[string]any{"via": "chat", "mode": rule.Mode}},
		Patch{Assignee: Opt[uuid.UUID]{Set: true, Value: *next}}, applyOpts{Lenient: true})
	if err != nil || !slices.Contains(changes, "assignee_id") {
		return nil, err
	}
	return next, nil
}
