import { describe, expect, it } from "vitest";
import { defaultSidebarPrefs, normalizePrefs } from "./sidebarPrefs";
import { entryKey, moveEntry, newOwnSection, reorderEntries, sectionOf, sidebarEntries, toggleInSection, visibleEntries } from "./ownSections";
import type { SidebarPrefs } from "../api/types";

const W = "11111111-1111-4111-8111-111111111111";
const keys = (p: SidebarPrefs, collab = true) => visibleEntries(p, collab).map(entryKey);

describe("own sidebar sections", () => {
  it("places each after the built-in it follows, and one the order lacks last", () => {
    const p = normalizePrefs({
      ...defaultSidebarPrefs(),
      order: ["custom:a", "inbox", "custom:b", "views", "gone", "custom:c"],
      sections: [
        { id: "a", title: "A", collapsed: false, items: [] },
        { id: "b", title: "B", collapsed: false, items: [] },
        { id: "c", title: "C", collapsed: false, items: [] },
        { id: "d", title: "D", collapsed: false, items: [] },
      ],
    });
    // The built-ins the order lacks go where the default puts them.
    expect(sidebarEntries(p).map(entryKey)).toEqual(["custom:a", "favorites", "inbox", "custom:b", "mail", "teams", "views", "pages", "workspace", "custom:c", "custom:d"]);
    expect(keys(p, false)).not.toContain("mail");
  });

  it("moves past sections not offered and keeps unknown ids", () => {
    let p = normalizePrefs({ ...defaultSidebarPrefs(), order: ["favorites", "inbox", "mail", "custom:a", "teams", "x:later"], sections: [{ id: "a", title: "", collapsed: false, items: [] }] });
    p = moveEntry(p, "custom:a", -1, false);
    expect(keys(p, false).slice(0, 3)).toEqual(["favorites", "custom:a", "inbox"]);
    expect(p.order).toContain("x:later");
    p = reorderEntries(p, ["custom:a"]);
    expect(entryKey(sidebarEntries(p)[0])).toBe("custom:a");
  });

  it("adds, moves and takes out rows", () => {
    const made = newOwnSection(defaultSidebarPrefs(), W, "Launch", { kind: "view", id: "v1" }, "inbox");
    const id = made.id;
    let p = made.prefs;
    expect(keys(p).indexOf(`custom:${id}`)).toBe(keys(p).indexOf("inbox") + 1);
    const second = newOwnSection(p, W, "Later");
    p = second.prefs;
    p = toggleInSection(p, W, second.id, { kind: "view", id: "v1" });
    expect(sectionOf(p, W, { kind: "view", id: "v1" })?.id).toBe(second.id);
    expect(p.sections[0].items).toEqual([]);
    p = toggleInSection(p, W, second.id, { kind: "view", id: "v1" });
    expect(sectionOf(p, W, { kind: "view", id: "v1" })).toBeNull();
    // Rows never carry the workspace: it is the sidebar's.
    p = toggleInSection(p, W, id, { kind: "wiki_page", id: "p1" });
    expect(p.sections[0].items).toEqual([{ kind: "wiki_page", id: "p1" }]);
  });

  it("reads an older answer without sections, and drops rows it can't be", () => {
    expect(normalizePrefs({ order: [] }).sections).toEqual([]);
    const p = normalizePrefs({ sections: [{ id: "a", title: "A", collapsed: true, items: [{ kind: "everywhere", id: "mine" }, { kind: "box", id: "inbox", badge: "nope" }] }] } as never);
    expect(p.sections[0]).toEqual({ id: "a", title: "A", collapsed: true, items: [{ kind: "box", id: "inbox" }] });
  });
});
