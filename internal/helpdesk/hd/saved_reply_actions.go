package hd

// SavedReplyActions is what a saved reply does to the ticket when a message using it is sent
// (contracts/api.md, saved replies).

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// SavedReplyActions is the shape stored in saved_replies.actions and sent by the API.
type SavedReplyActions struct {
	AddTags    []string   `json:"add_tags,omitempty" maxItems:"20" doc:"Labels added to the ticket, by name"`
	RemoveTags []string   `json:"remove_tags,omitempty" maxItems:"20" doc:"Labels removed from the ticket, by name"`
	TeamID     *uuid.UUID `json:"team_id,omitempty" doc:"The ticket moves to this team"`
	AssigneeID *uuid.UUID `json:"assignee_id,omitempty" doc:"The ticket is assigned to this member"`
}

// Empty reports no action.
func (a SavedReplyActions) Empty() bool {
	return len(a.AddTags) == 0 && len(a.RemoveTags) == 0 && a.TeamID == nil && a.AssigneeID == nil
}

// Clean trims and dedupes the label names and checks the team and the assignee exist in the
// workspace. A name both added and removed is only added.
func (a *SavedReplyActions) Clean(ctx context.Context, q db.Querier, wid uuid.UUID) error {
	clean := func(in []string) ([]string, error) {
		var out []string
		seen := map[string]bool{}
		for _, s := range in {
			if strings.TrimSpace(s) == "" {
				continue
			}
			name, err := CleanTagName(s)
			if err != nil {
				return nil, err
			}
			if k := strings.ToLower(name); !seen[k] {
				seen[k] = true
				out = append(out, name)
			}
		}
		return out, nil
	}
	var err error
	if a.AddTags, err = clean(a.AddTags); err != nil {
		return err
	}
	if a.RemoveTags, err = clean(a.RemoveTags); err != nil {
		return err
	}
	added := map[string]bool{}
	for _, s := range a.AddTags {
		added[strings.ToLower(s)] = true
	}
	kept := a.RemoveTags[:0]
	for _, s := range a.RemoveTags {
		if !added[strings.ToLower(s)] {
			kept = append(kept, s)
		}
	}
	a.RemoveTags = kept
	if a.TeamID != nil {
		if err := CheckRef(ctx, q, wid, "team", *a.TeamID); err != nil {
			return err
		}
	}
	if a.AssigneeID != nil {
		if err := CheckMember(ctx, q, wid, *a.AssigneeID); err != nil {
			return err
		}
	}
	return nil
}

// Merge folds b into a: labels add up, a later team or assignee wins.
func (a SavedReplyActions) Merge(b SavedReplyActions) SavedReplyActions {
	out := SavedReplyActions{TeamID: a.TeamID, AssigneeID: a.AssigneeID}
	add := map[string]bool{}
	for _, s := range append(append([]string{}, a.AddTags...), b.AddTags...) {
		if k := strings.ToLower(s); !add[k] {
			add[k] = true
			out.AddTags = append(out.AddTags, s)
		}
	}
	rm := map[string]bool{}
	for _, s := range append(append([]string{}, a.RemoveTags...), b.RemoveTags...) {
		if k := strings.ToLower(s); !rm[k] && !add[k] {
			rm[k] = true
			out.RemoveTags = append(out.RemoveTags, s)
		}
	}
	if b.TeamID != nil {
		out.TeamID = b.TeamID
	}
	if b.AssigneeID != nil {
		out.AssigneeID = b.AssigneeID
	}
	return out
}
