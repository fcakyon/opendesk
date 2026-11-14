import { describe, expect, it } from "vitest";
import type { DbProperty } from "@/lib/api/types";
import { NO_VALUE } from "@/lib/wiki/db";
import { ordered, row, taskProps } from "@/lib/wiki/db/fixtures";
import { dropPosition, regroup } from "./cards";

const prop = (id: string) => taskProps.find((p) => p.id === id) as DbProperty;

describe("putting a row in a group", () => {
  it("sets an option, and clears it in the no-value group", () => {
    const r = row("a", "A", { priority: "low" });
    expect(regroup(prop("priority"), "high", r, "low")).toEqual({ priority: "high" });
    expect(regroup(prop("priority"), NO_VALUE, r, "low")).toEqual({ priority: null });
    expect(regroup(prop("priority"), NO_VALUE)).toEqual({});
  });

  it("swaps one value of a multi-select and keeps the others", () => {
    const r = row("a", "A", { tags: ["bug", "docs"] });
    expect(regroup(prop("tags"), "feature", r, "bug")).toEqual({ tags: ["docs", "feature"] });
    expect(regroup(prop("tags"), "docs", r, "bug")).toEqual({ tags: ["docs"] });
    expect(regroup(prop("tags"), "bug")).toEqual({ tags: ["bug"] });
  });

  it("moves a date to the day, keeping the length of a range", () => {
    expect(regroup(prop("due"), "2026-11-02", row("a", "A", { due: { start: "2026-10-30", end: "2026-11-01" } }))).toEqual({ due: { start: "2026-11-02", end: "2026-11-04" } });
    expect(regroup(prop("due"), "2026-11-02")).toEqual({ due: { start: "2026-11-02" } });
  });

  it("ticks a checkbox and refuses computed properties", () => {
    expect(regroup(prop("done"), "true", row("a", "A"))).toEqual({ done: true });
    expect(regroup(prop("uid"), "3", row("a", "A"))).toBeNull();
  });
});

describe("where a dropped row goes", () => {
  const all = ordered(["a", "b", "c", "d", "e"].map((id) => row(id, id)));
  const group = [all[1], all[3], all[4]]; // b, d, e

  it("lands before the row it was dropped on, among all rows", () => {
    expect(dropPosition(all, "a", group, 1)).toBe(2); // before d, once a is out: b c [a] d e
    expect(dropPosition(all, "e", group, 0)).toBe(1); // before b
  });

  it("lands after the group's last row when dropped at its end", () => {
    expect(dropPosition(all, "a", group, 3)).toBe(4);
  });

  it("stays put when dropped where it is", () => {
    expect(dropPosition(all, "d", group, 1)).toBeNull();
    expect(dropPosition(all, "d", group, 2)).toBeNull();
  });

  it("joins an empty group without moving", () => {
    expect(dropPosition(all, "a", [], 0)).toBeNull();
  });
});
