package core

import (
	"github.com/useopendesk/opendesk/internal/plan"
	"testing"
)

func TestWorkspaceCannotDisableOnlyAvailableProduct(t *testing.T) {
	for _, tc := range []struct {
		name            string
		instance, cloud bool
		pages           bool
		want            int
	}{
		{"instance disabled", false, false, false, 422},
		{"plan unavailable", true, true, false, 422},
		{"mail available", true, false, false, 200},
		// Pages counts: a workspace may keep Pages alone.
		{"pages only", false, false, true, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			e.d.Cfg.Collab = tc.instance
			e.d.Plan = plan.New(tc.cloud, 1)
			c, _ := e.signup("product-availability")
			c.workspace = c.newWorkspace("Availability review")
			r := c.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"tickets_enabled": false, "pages_enabled": tc.pages}})
			if r.Status != tc.want {
				t.Fatalf("disable Tickets: status=%d want=%d body=%s", r.Status, tc.want, r.Raw)
			}
			current := c.do("GET", "/v1/workspace", nil)
			if tc.want == 422 && current.Body["settings"].(map[string]any)["tickets_enabled"] == false {
				t.Fatal("refused disable changed Tickets")
			}
			if tc.pages && tc.want == 200 {
				// Pages can't go too while it is the last product left.
				if r := c.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"pages_enabled": false}}); r.Status != 422 {
					t.Fatalf("disable Pages last: status=%d body=%s", r.Status, r.Raw)
				}
			}
		})
	}
}
