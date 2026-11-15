import { describe, expect, it } from "vitest";
import type { View } from "@/lib/api/types";
import { groupViews } from "./viewSections";
import { dropSpot, placeViews, sameLayout, sectionSpot, stepSpot, viewPatches, type DropRow } from "./viewMoves";

const view = (name: string, position: number, section?: string | null): View => ({ id: name, name, shared: true, filters: {}, position, section });

// Urgent | [After sales] Damaged, Returns | Mine | [Escalations] Bugs
const views = [view("Urgent", 0), view("Damaged", 1, "After sales"), view("Returns", 2, "After sales"), view("Mine", 3), view("Bugs", 4, "Escalations")];

/** The list as the page reads it: loose views by name, a section as [Name] and its views. */
const read = (vs: View[]) => groupViews(vs).map((e) => (e.kind === "view" ? e.view.name : `[${e.name}] ${e.views.map((v) => v.name).join(", ")}`));

describe("placeViews", () => {
  it("moves a view into another section, where it was dropped, and numbers every view in order", () => {
    const next = placeViews(views, { view: "Mine" }, { section: "after sales", before: "Returns" });
    expect(read(next)).toEqual(["Urgent", "[After sales] Damaged, Mine, Returns", "[Escalations] Bugs"]);
    expect(next.find((v) => v.id === "Mine")).toMatchObject({ section: "After sales", position: 2 });
    expect(next.map((v) => v.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("moves a view from one section to the end of another", () => {
    expect(read(placeViews(views, { view: "Damaged" }, { section: "escalations", before: null }))).toEqual(["Urgent", "[After sales] Returns", "Mine", "[Escalations] Bugs, Damaged"]);
  });

  it("takes a view out of its section to the top level as a loose view", () => {
    const next = placeViews(views, { view: "Returns" }, { section: null, before: "Mine" });
    expect(read(next)).toEqual(["Urgent", "[After sales] Damaged", "Returns", "Mine", "[Escalations] Bugs"]);
    expect(next.find((v) => v.id === "Returns")?.section).toBeNull();
  });

  it("drops a section once its last view leaves it", () => {
    expect(read(placeViews(views, { view: "Bugs" }, { section: null, before: "Urgent" }))).toEqual(["Bugs", "Urgent", "[After sales] Damaged, Returns", "Mine"]);
    expect(read(placeViews(views, { view: "Bugs" }, { section: "after sales", before: "Damaged" }))).toEqual(["Urgent", "[After sales] Bugs, Damaged, Returns", "Mine"]);
  });

  it("reorders within a section and among the top-level entries, as before", () => {
    expect(read(placeViews(views, { view: "Returns" }, { section: "after sales", before: "Damaged" }))).toEqual(["Urgent", "[After sales] Returns, Damaged", "Mine", "[Escalations] Bugs"]);
    expect(read(placeViews(views, { view: "Urgent" }, { section: null, before: null }))).toEqual(["[After sales] Damaged, Returns", "Mine", "[Escalations] Bugs", "Urgent"]);
  });

  it("moves a whole section among the top-level entries, never into another", () => {
    expect(read(placeViews(views, { section: "escalations" }, { section: null, before: "section:after sales" }))).toEqual(["Urgent", "[Escalations] Bugs", "[After sales] Damaged, Returns", "Mine"]);
    expect(sameLayout(views, placeViews(views, { section: "escalations" }, { section: "after sales", before: null }))).toBe(true);
  });

  it("joins a section as the section spells it, whatever the dragged view's own spelling", () => {
    const mixed = [view("a", 0, "After sales"), view("b", 1, "AFTER  sales"), view("c", 2)];
    expect(placeViews(mixed, { view: "c" }, { section: "after sales", before: null }).find((v) => v.id === "c")?.section).toBe("After sales");
    // Moving within its own section keeps its spelling: nothing to write but the position.
    expect(placeViews(mixed, { view: "b" }, { section: "after sales", before: "a" }).find((v) => v.id === "b")?.section).toBe("AFTER  sales");
  });

  it("gives a view the icon of the section it joins, and none once it leaves its section", () => {
    const bug = { kind: "icon", value: "bug", color: "red" } as const;
    const box = { kind: "icon", value: "package", color: null } as const;
    const iconed = views.map((v) => ({ ...v, section_icon: v.section === "Escalations" ? bug : v.section === "After sales" ? box : null }));
    const into = placeViews(iconed, { view: "Damaged" }, { section: "escalations", before: "Bugs" });
    expect(into.find((v) => v.id === "Damaged")?.section_icon).toEqual(bug);
    // First in the section now, it reads with the section's own icon.
    expect(groupViews(into).find((e) => e.kind === "section" && e.key === "escalations")).toMatchObject({ icon: bug });
    expect(placeViews(iconed, { view: "Returns" }, { section: null, before: "Mine" }).find((v) => v.id === "Returns")?.section_icon).toBeNull();
  });

  it("leaves the list as it reads when the view lands where it is", () => {
    expect(sameLayout(views, placeViews(views, { view: "Damaged" }, { section: "after sales", before: "Returns" }))).toBe(true);
    expect(sameLayout(views, placeViews(views, { view: "Mine" }, { section: null, before: "section:escalations" }))).toBe(true);
    expect(sameLayout(views, placeViews(views, { view: "nope" }, { section: null, before: null }))).toBe(true);
  });
});

describe("viewPatches", () => {
  it("writes the moved view's section and position, and the position of every view that shifted", () => {
    const next = placeViews(views, { view: "Mine" }, { section: "after sales", before: "Damaged" });
    expect(viewPatches(views, next)).toEqual([
      { id: "Mine", position: 1, section: "After sales" },
      { id: "Damaged", position: 2 },
      { id: "Returns", position: 3 },
    ]);
  });

  it("clears the section of a view taken out of one, and writes nothing when nothing moved", () => {
    expect(viewPatches(views, placeViews(views, { view: "Bugs" }, { section: null, before: null }))).toEqual([{ id: "Bugs", position: 4, section: null }]);
    expect(viewPatches(views, placeViews(views, { view: "Mine" }, { section: null, before: "Mine" }))).toEqual([]);
  });
});

describe("stepSpot", () => {
  it("moves a view one place within its section, and stops at its ends", () => {
    expect(stepSpot(views, { view: "Returns" }, -1)).toEqual({ section: "after sales", before: "Damaged" });
    expect(stepSpot(views, { view: "Damaged" }, 1)).toEqual({ section: "after sales", before: null });
    expect(stepSpot(views, { view: "Damaged" }, -1)).toBeNull();
    expect(stepSpot(views, { view: "Returns" }, 1)).toBeNull();
  });

  it("moves a loose view or a section one place among the top-level entries", () => {
    expect(read(placeViews(views, { view: "Mine" }, stepSpot(views, { view: "Mine" }, -1)!))).toEqual(["Urgent", "Mine", "[After sales] Damaged, Returns", "[Escalations] Bugs"]);
    expect(read(placeViews(views, { section: "after sales" }, stepSpot(views, { section: "after sales" }, 1)!))).toEqual(["Urgent", "Mine", "[After sales] Damaged, Returns", "[Escalations] Bugs"]);
    expect(stepSpot(views, { section: "escalations" }, 1)).toBeNull();
    expect(stepSpot(views, { view: "Urgent" }, -1)).toBeNull();
  });
});

describe("sectionSpot", () => {
  it("sends a view to the end of a section, or out of its own to right after it", () => {
    expect(read(placeViews(views, { view: "Urgent" }, sectionSpot(views, "Urgent", "escalations")))).toEqual(["[After sales] Damaged, Returns", "Mine", "[Escalations] Bugs, Urgent"]);
    expect(read(placeViews(views, { view: "Damaged" }, sectionSpot(views, "Damaged", null)))).toEqual(["Urgent", "[After sales] Returns", "Damaged", "Mine", "[Escalations] Bugs"]);
    expect(read(placeViews(views, { view: "Bugs" }, sectionSpot(views, "Bugs", null)))).toEqual(["Urgent", "[After sales] Damaged, Returns", "Mine", "Bugs"]);
  });
});

describe("dropSpot", () => {
  // Rows 20px high from 0: Urgent, [After sales], Damaged, Returns, Mine, [Escalations], Bugs.
  const all: DropRow[] = [
    { kind: "view", id: "Urgent", section: null },
    { kind: "header", id: "after sales", section: null },
    { kind: "view", id: "Damaged", section: "after sales" },
    { kind: "view", id: "Returns", section: "after sales" },
    { kind: "view", id: "Mine", section: null },
    { kind: "header", id: "escalations", section: null },
    { kind: "view", id: "Bugs", section: "escalations" },
  ].map((r, i) => ({ ...(r as Omit<DropRow, "top" | "bottom">), top: i * 20, bottom: i * 20 + 20 }));
  const without = (...ids: string[]) => all.filter((r) => !ids.includes(r.id));

  it("puts a view before or after a view of a section, in that section", () => {
    const rows = without("Mine");
    expect(dropSpot(rows, { view: "Mine" }, 45)).toEqual({ section: "after sales", before: "Damaged" });
    expect(dropSpot(rows, { view: "Mine" }, 52)).toEqual({ section: "after sales", before: "Returns" });
  });

  it("takes a view out of a section at the bottom of its last view", () => {
    const rows = without("Urgent");
    expect(dropSpot(rows, { view: "Urgent" }, 72)).toEqual({ section: "after sales", before: null });
    expect(dropSpot(rows, { view: "Urgent" }, 78)).toEqual({ section: null, before: "Mine" });
    expect(dropSpot(rows, { view: "Urgent" }, 138)).toEqual({ section: null, before: null });
  });

  it("puts a view into a section, first, from its header, and before the section from the header's top", () => {
    const rows = without("Urgent");
    expect(dropSpot(rows, { view: "Urgent" }, 112)).toEqual({ section: "escalations", before: "Bugs" });
    expect(dropSpot(rows, { view: "Urgent" }, 102)).toEqual({ section: null, before: "section:escalations" });
  });

  it("puts a view before or after a loose view, at the top level, and at either end beyond the rows", () => {
    const rows = without("Bugs");
    expect(dropSpot(rows, { view: "Bugs" }, 82)).toEqual({ section: null, before: "Mine" });
    expect(dropSpot(rows, { view: "Bugs" }, 95)).toEqual({ section: null, before: "section:escalations" });
    expect(dropSpot(rows, { view: "Bugs" }, -5)).toEqual({ section: null, before: "Urgent" });
  });

  it("stays where it is over the place the dragged row left", () => {
    expect(dropSpot(without("Returns"), { view: "Returns" }, 65, { top: 60, bottom: 80 })).toBeNull();
  });

  it("moves a section by whole top-level entries", () => {
    const rows = without("escalations", "Bugs");
    expect(dropSpot(rows, { section: "escalations" }, 30)).toEqual({ section: null, before: "section:after sales" });
    expect(dropSpot(rows, { section: "escalations" }, 75)).toEqual({ section: null, before: "Mine" });
    expect(dropSpot(rows, { section: "escalations" }, 5)).toEqual({ section: null, before: "Urgent" });
  });
});
