import { describe, expect, it } from "vitest";
import { context, ids, NOW, tasks, withProps } from "./fixtures";
import { dateBucket, groupRows, NO_VALUE, type Group } from "./group";

const ctx = context();
const shape = (groups: Group[]) => groups.map((g) => [g.key, ids(g.rows)]);

describe("grouping rows", () => {
  it("lists a select's options in order, and rows without a value last", () => {
    const groups = groupRows(tasks, "priority", ctx);
    expect(shape(groups)).toEqual([
      ["high", ["t1"]],
      ["med", ["t3"]],
      ["low", ["t2"]],
      [NO_VALUE, ["t4"]],
    ]);
    expect(groups[0]).toMatchObject({ label: "High", color: "red", option: { id: "high" }, empty: false });
  });

  it("orders a status by its groups, keeping empty columns for a board", () => {
    const groups = groupRows(tasks, "status", ctx);
    expect(shape(groups)).toEqual([
      ["todo", ["t2"]],
      ["prog", ["t1"]],
      ["review", []],
      ["done", ["t3"]],
      [NO_VALUE, ["t4"]],
    ]);
    expect(groups[2].empty).toBe(true);
    expect(shape(groupRows(tasks, "status", ctx, { hide_empty_groups: true })).map(([k]) => k)).toEqual(["todo", "prog", "done", NO_VALUE]);
  });

  it("puts a row in each of its tags' and people's groups", () => {
    expect(shape(groupRows(tasks, "tags", ctx, { hide_empty_groups: true }))).toEqual([
      ["bug", ["t1"]],
      ["feature", ["t2", "t3"]],
      ["docs", ["t2"]],
      [NO_VALUE, ["t4"]],
    ]);
    const people = groupRows(tasks, "owner", ctx);
    expect(people.map((g) => [g.label, ids(g.rows)])).toEqual([
      ["Ann Lee", ["t1", "t3"]],
      ["Bob Ito", ["t2", "t3"]],
      ["", ["t4"]],
    ]);
  });

  it("splits checkboxes into unchecked and checked, with no empty group", () => {
    expect(shape(groupRows(tasks, "done", ctx))).toEqual([
      ["false", ["t1", "t2", "t4"]],
      ["true", ["t3"]],
    ]);
  });

  it("groups dates by day and numbers by value, in order", () => {
    expect(shape(groupRows(tasks, "due", ctx))).toEqual([
      ["2026-10-20", ["t3"]],
      ["2026-10-26", ["t1"]],
      ["2026-10-30", ["t2"]],
      [NO_VALUE, ["t4"]],
    ]);
    const points = groupRows(tasks, "points", ctx);
    expect(points.map((g) => g.label)).toEqual(["1", "3", "8", ""]);
  });

  it("groups formulas by their results", () => {
    const c = context(withProps({ id: "size", name: "Size", type: "formula", formula: 'if(prop("Points") > 2, "big", "small")' }));
    expect(shape(groupRows(tasks, "size", c))).toEqual([
      ["big", ["t1", "t3"]],
      ["small", ["t2", "t4"]],
      [NO_VALUE, []],
    ]);
  });

  it("keeps all rows together for a property since removed", () => {
    expect(shape(groupRows(tasks, "gone", ctx))).toEqual([["__all__", ["t1", "t2", "t3", "t4"]]]);
  });
});

describe("date buckets", () => {
  it("say where a date stands from today", () => {
    const day = (d: number) => new Date(2026, 9, d, 9);
    expect(dateBucket(day(26), NOW)).toBe("today");
    expect(dateBucket(day(25), NOW)).toBe("yesterday");
    expect(dateBucket(day(27), NOW)).toBe("tomorrow");
    expect(dateBucket(day(20), NOW)).toBe("past_7");
    expect(dateBucket(day(1), NOW)).toBe("past_30");
    expect(dateBucket(new Date(2026, 0, 1), NOW)).toBe("older");
    expect(dateBucket(day(31), NOW)).toBe("next_7");
    expect(dateBucket(new Date(2026, 10, 20), NOW)).toBe("next_30");
    expect(dateBucket(new Date(2027, 0, 1), NOW)).toBe("later");
  });
});
