package domain

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
)

var (
	// TicketNumberRef is a ticket's number as people write it: "123" or "#123".
	TicketNumberRef = regexp.MustCompile(`^#?(\d{1,18})$`)
	// TicketAliasPattern is the shape of a ticket alias; an alias also has a letter.
	TicketAliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{1,39}$`)
)

// ResolveTicket finds a ticket of the workspace by uuid, alias, "#123" or "123". A deleted
// or missing ticket is not found.
func ResolveTicket(ctx context.Context, q db.Querier, wid uuid.UUID, ref string) (uuid.UUID, error) {
	ref = strings.TrimSpace(ref)
	if id, err := uuid.Parse(ref); err == nil {
		var exists bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tickets WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL)`,
			wid, id).Scan(&exists); err != nil {
			return uuid.Nil, err
		}
		if !exists {
			return uuid.Nil, httpx.NotFound("Ticket")
		}
		return id, nil
	}
	m := TicketNumberRef.FindStringSubmatch(ref)
	if m != nil {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		var id uuid.UUID
		err := q.QueryRow(ctx, `SELECT id FROM tickets WHERE workspace_id = $1 AND number = $2 AND deleted_at IS NULL`, wid, n).Scan(&id)
		if db.IsNotFound(err) {
			return uuid.Nil, httpx.NotFound("Ticket")
		}
		return id, err
	}
	alias := strings.TrimLeft(ref, "# ")
	if !TicketAliasPattern.MatchString(alias) || !strings.ContainsAny(alias, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") {
		return uuid.Nil, httpx.NotFound("Ticket")
	}
	var id uuid.UUID
	err := q.QueryRow(ctx, `SELECT id FROM tickets WHERE workspace_id = $1 AND lower(alias) = lower($2) AND deleted_at IS NULL`, wid, alias).Scan(&id)
	if db.IsNotFound(err) {
		return uuid.Nil, httpx.NotFound("Ticket")
	}
	return id, err
}

// ResolveVisibleTicket is ResolveTicket for a caller: a ticket of a private team the caller
// may not see is not found, like a missing one.
func ResolveVisibleTicket(ctx context.Context, q db.Querier, p *auth.Principal, ref string) (uuid.UUID, error) {
	id, err := ResolveTicket(ctx, q, p.WorkspaceID, ref)
	if err != nil {
		return id, err
	}
	var team, assignee *uuid.UUID
	if err := q.QueryRow(ctx, `SELECT team_id, assignee_id FROM tickets WHERE workspace_id = $1 AND id = $2`,
		p.WorkspaceID, id).Scan(&team, &assignee); err != nil {
		return id, err
	}
	ok, err := CanSee(ctx, q, p, team, assignee)
	if err != nil {
		return id, err
	}
	if !ok {
		return uuid.Nil, httpx.NotFound("Ticket")
	}
	return id, nil
}
