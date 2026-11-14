package resources_test

import (
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/resources"
)

type viewSection struct {
	Name  string    `json:"name"`
	Icon  *viewIcon `json:"icon"`
	Views int       `json:"views"`
}

func TestViewSectionIcons(t *testing.T) {
	e := hdtest.New(t, resources.Register)
	ws := e.NewWorkspace()
	other := e.NewWorkspace()
	admin, agent := ws.Admin.As(ws), ws.Agent.As(ws)
	star := map[string]any{"kind": "emoji", "value": "⭐"}

	// Two shared views and an agent's own name the section, in any case.
	var damaged, returns, mine view
	e.Do("POST", "/v1/views", admin, map[string]any{"name": "Damaged", "shared": true, "section": "After sales"}).Want(t, 201).JSON(t, &damaged)
	e.Do("POST", "/v1/views", admin, map[string]any{"name": "Returns", "shared": true, "section": "after SALES"}).Want(t, 201).JSON(t, &returns)
	e.Do("POST", "/v1/views", agent, map[string]any{"name": "My returns", "section": "After sales"}).Want(t, 201).JSON(t, &mine)
	if damaged.SectionIcon != nil || mine.SectionIcon != nil {
		t.Fatalf("no icon yet %+v %+v", damaged, mine)
	}

	// Shared-view rights: admins and settings:write keys.
	e.Do("PATCH", "/v1/view-sections", agent, map[string]any{"section": "After sales", "icon": star}).Want(t, 403)
	e.Do("PATCH", "/v1/view-sections", ws.Viewer.As(ws), map[string]any{"section": "After sales", "icon": star}).Want(t, 403)
	e.Do("PATCH", "/v1/view-sections", hdtest.Auth{Bearer: e.APIKey(ws, "tickets:read")}, map[string]any{"section": "After sales", "icon": star}).Want(t, 403)
	// A section no view the caller sees names, here or in another workspace, is not found.
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "Nowhere", "icon": star}).Want(t, 404)
	e.Do("PATCH", "/v1/view-sections", other.Admin.As(other), map[string]any{"section": "After sales", "icon": star}).Want(t, 404)
	// The icon is checked as a view's.
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "After sales", "icon": map[string]any{"kind": "emoji", "value": "ab"}}).Want(t, 422)
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "<b>", "icon": star}).Want(t, 422)

	_, since := e.Events(ws.ID, 0)
	var sec viewSection
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "AFTER   sales", "icon": star}).Want(t, 200).JSON(t, &sec)
	if sec.Name != "AFTER sales" || sec.Icon == nil || sec.Icon.Value != "⭐" || sec.Views != 2 {
		t.Fatalf("set %+v", sec)
	}
	// Every view of the section is announced, the agent's own too.
	types, _ := e.Events(ws.ID, since)
	if len(types) != 3 || slices.ContainsFunc(types, func(s string) bool { return s != "view.updated" }) {
		t.Fatalf("events %v", types)
	}
	// Every view that names the section carries it, whoever's it is.
	e.Do("GET", "/v1/views/"+mine.ID, agent, nil).Want(t, 200).JSON(t, &mine)
	e.Do("GET", "/v1/views/"+returns.ID, agent, nil).Want(t, 200).JSON(t, &returns)
	if mine.SectionIcon == nil || mine.SectionIcon.Value != "⭐" || returns.SectionIcon == nil {
		t.Fatalf("carried %+v %+v", mine, returns)
	}
	// Another workspace's view of that name does not.
	var theirs view
	e.Do("POST", "/v1/views", other.Admin.As(other), map[string]any{"name": "Theirs", "shared": true, "section": "After sales"}).Want(t, 201).JSON(t, &theirs)
	if theirs.SectionIcon != nil {
		t.Fatalf("other workspace %+v", theirs)
	}

	// A view joining the section takes its icon; one leaving it loses it.
	var joined view
	e.Do("POST", "/v1/views", admin, map[string]any{"name": "Claims", "shared": true, "section": "After Sales"}).Want(t, 201).JSON(t, &joined)
	if joined.SectionIcon == nil {
		t.Fatalf("joined %+v", joined)
	}
	e.Do("PATCH", "/v1/views/"+joined.ID, admin, map[string]any{"section": nil}).Want(t, 200).JSON(t, &joined)
	if joined.SectionIcon != nil {
		t.Fatalf("left %+v", joined)
	}

	// A colour and an icon of the list, then a patch without icon keeps it.
	e.Do("PATCH", "/v1/view-sections", hdtest.Auth{Bearer: e.APIKey(ws, "settings:write")}, map[string]any{"section": "After sales", "icon": map[string]any{"kind": "icon", "value": "truck", "color": "teal"}}).
		Want(t, 200).JSON(t, &sec)
	if sec.Icon == nil || sec.Icon.Value != "truck" || sec.Icon.Color == nil || *sec.Icon.Color != "teal" {
		t.Fatalf("icon %+v", sec)
	}

	// Renamed: the views the admin sees take the name and the icon goes with them. The
	// agent's own view keeps its name, and the icon while it names it.
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "after sales", "name": " Post  sale "}).Want(t, 200).JSON(t, &sec)
	if sec.Name != "Post sale" || sec.Views != 2 || sec.Icon == nil || sec.Icon.Value != "truck" {
		t.Fatalf("renamed %+v", sec)
	}
	e.Do("GET", "/v1/views/"+damaged.ID, admin, nil).Want(t, 200).JSON(t, &damaged)
	if damaged.Section == nil || *damaged.Section != "Post sale" || damaged.SectionIcon == nil || damaged.SectionIcon.Value != "truck" {
		t.Fatalf("renamed view %+v", damaged)
	}
	e.Do("GET", "/v1/views/"+mine.ID, agent, nil).Want(t, 200).JSON(t, &mine)
	if mine.Section == nil || *mine.Section != "After sales" || mine.SectionIcon == nil || mine.SectionIcon.Value != "truck" {
		t.Fatalf("agent's own %+v", mine)
	}
	// The agent's view joins the new name, then the admin renames it again: the agent's view
	// still names it, so it keeps its icon.
	e.Do("PATCH", "/v1/views/"+mine.ID, agent, map[string]any{"section": "Post sale"}).Want(t, 200).JSON(t, &mine)
	if mine.SectionIcon == nil || mine.SectionIcon.Value != "truck" {
		t.Fatalf("agent moved %+v", mine)
	}
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "Post sale", "name": "Escalations"}).Want(t, 200)
	var left int
	e.Scalar(`SELECT count(*) FROM view_sections WHERE workspace_id = $1 AND key = 'post sale'`, &left, ws.ID)
	if left != 1 {
		t.Fatalf("old name dropped while the agent's view names it: %d", left)
	}

	// Into a section with an icon of its own, without a new icon: it keeps its own.
	var urgent view
	e.Do("POST", "/v1/views", admin, map[string]any{"name": "Urgent", "shared": true, "section": "Hot"}).Want(t, 201).JSON(t, &urgent)
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "Hot", "icon": map[string]any{"kind": "emoji", "value": "🔴"}}).Want(t, 200)
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "Escalations", "name": "hot"}).Want(t, 200).JSON(t, &sec)
	if sec.Icon == nil || sec.Icon.Value != "🔴" || sec.Views != 3 {
		t.Fatalf("merged %+v", sec)
	}
	e.Do("GET", "/v1/views/"+urgent.ID, admin, nil).Want(t, 200).JSON(t, &urgent)
	if urgent.SectionIcon == nil || urgent.SectionIcon.Value != "🔴" {
		t.Fatalf("target kept %+v", urgent)
	}
	e.Scalar(`SELECT count(*) FROM view_sections WHERE workspace_id = $1 AND key = 'escalations'`, &left, ws.ID)
	if left != 0 {
		t.Fatalf("emptied name kept its icon: %d", left)
	}

	// The icon stays with the name while no view names it, and shows again when one does.
	for _, id := range []string{urgent.ID, damaged.ID, returns.ID} {
		e.Do("DELETE", "/v1/views/"+id, admin, nil).Want(t, 204)
	}
	var back view
	e.Do("POST", "/v1/views", admin, map[string]any{"name": "Back", "shared": true, "section": "HOT"}).Want(t, 201).JSON(t, &back)
	if back.SectionIcon == nil || back.SectionIcon.Value != "🔴" {
		t.Fatalf("came back %+v", back)
	}

	// null clears it.
	e.Do("PATCH", "/v1/view-sections", admin, map[string]any{"section": "hot", "icon": nil}).Want(t, 200).JSON(t, &sec)
	e.Do("GET", "/v1/views/"+back.ID, admin, nil).Want(t, 200).JSON(t, &back)
	if sec.Icon != nil || back.SectionIcon != nil {
		t.Fatalf("cleared %+v %+v", sec, back)
	}
}
