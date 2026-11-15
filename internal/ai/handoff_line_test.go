package ai

import (
	"encoding/json"
	"strings"
	"testing"
)

// A chat handoff always comes with a line to the visitor: a person will reply here, and what
// the team will need.
func TestWidgetHandoffLine(t *testing.T) {
	e := newEnv(t, opts{billing: true})
	e.settings(map[string]any{"widget_answers": true})

	// A handoff called before anything was written is sent back once for its line.
	e.F.queue("widget",
		"@tool handoff_to_human {\"reason\":\"quote\"}",
		"A person from the team will reply here. Which model and what delivery postcode?\n@tool handoff_to_human {\"reason\":\"quote\"}")
	before := e.F.calls()
	_, tid, _ := widgetConversation(e, "What would shipping cost for 200 desk lamps to Chile?")
	e.runWidgetJobs()
	if got := e.loadTicket(tid); got.Custom["ai_handoff"] != true || e.F.calls() != before+2 {
		t.Fatalf("handoff %+v, model calls %d", got.Custom, e.F.calls()-before)
	}
	if raw, _ := json.Marshal(e.F.last()["messages"]); !strings.Contains(string(raw), "Not handed off yet") {
		t.Fatalf("no ask for the line: %s", raw)
	}
	if ms := publicMessages(e, tid); len(ms) != 2 || !ms[1].AI || !strings.Contains(ms[1].BodyText, "postcode") {
		t.Fatalf("no line before the handoff: %+v", ms)
	}

	// A handoff with its line goes through at once.
	e.F.queue("widget", "A person from the team will reply here.\n@tool handoff_to_human {\"reason\":\"refund\"}")
	before = e.F.calls()
	_, tid2, _ := widgetConversation(e, "I want my money back for last year")
	e.runWidgetJobs()
	if got := e.loadTicket(tid2); got.Custom["ai_handoff"] != true || e.F.calls() != before+1 {
		t.Fatalf("handoff %+v, model calls %d", got.Custom, e.F.calls()-before)
	}

	// Sent back, the agent writes its line without calling the tool again: it still hands off.
	e.F.queue("widget", "@tool handoff_to_human {\"reason\":\"damaged\"}", "A person from the team will reply here. Could you send a photo?")
	_, tid3, _ := widgetConversation(e, "My parcel arrived damaged")
	e.runWidgetJobs()
	if got := e.loadTicket(tid3); got.Custom["ai_handoff"] != true || !strings.Contains(lastMessage(e, tid3).BodyText, "photo") {
		t.Fatalf("handoff %+v", got.Custom)
	}

	// When the model fails, a visitor asking for a person gets the handoff alone.
	e.F.fail(400)
	before = e.F.calls()
	_, tid4, _ := widgetConversation(e, "Can I talk to a real person?")
	e.runWidgetJobs()
	if got := e.loadTicket(tid4); got.Custom["ai_handoff"] != true || e.F.calls() != before+1 || len(publicMessages(e, tid4)) != 1 {
		t.Fatalf("handoff on failure %+v", got.Custom)
	}

	// Past the monthly cap, the handoff alone without a model call.
	e.settings(map[string]any{"widget_monthly_cap_usd": 0.01})
	before = e.F.calls()
	_, tid5, _ := widgetConversation(e, "Can I talk to a real person?")
	e.runWidgetJobs()
	if got := e.loadTicket(tid5); got.Custom["ai_handoff"] != true || e.F.calls() != before || len(publicMessages(e, tid5)) != 1 {
		t.Fatalf("handoff over the cap %+v", got.Custom)
	}
}
