import { describe, expect, it } from "vitest";
import type { Database, DbFilterGroup, DbFilterRule } from "../../api/types";
import { context, ids, projects, projectsDb, row, tasks, withProps } from "./fixtures";
import { FILTER_OPS, filterDefaults, filterOpsFor, filterRows, relativeRange, searchRows } from "./filter";

const ctx = context();
const where = (...rules: (DbFilterRule | DbFilterGroup)[]): string[] => ids(filterRows(tasks, { op: "and", rules }, ctx));
const rule = (property: string, op: string, value?: unknown): DbFilterRule => ({ property, op, value });

describe("filters by type", () => {
  it("text: case- and accent-insensitive", () => {
    expect(where(rule("title", "contains", "LOG"))).toEqual(["t1"]);
    expect(where(rule("title", "is", "fix login"))).toEqual(["t1"]);
    expect(where(rule("title", "starts_with", "w"))).toEqual(["t2"]);
    expect(where(rule("title", "ends_with", "v2"))).toEqual(["t3"]);
    expect(where(rule("notes", "contains", "cafe"))).toEqual(["t2"]);
    // Rows without a value pass the "not" rules.
    expect(where(rule("notes", "does_not_contain", "cafe"))).toEqual(["t1", "t3", "t4"]);
    expect(where(rule("notes", "is_not", "x"))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("number", () => {
    expect(where(rule("points", "gt", 2))).toEqual(["t1", "t3"]);
    expect(where(rule("points", "lte", 3))).toEqual(["t1", "t2"]);
    expect(where(rule("points", "eq", "8"))).toEqual(["t3"]);
    expect(where(rule("points", "neq", 8))).toEqual(["t1", "t2", "t4"]);
    expect(where(rule("points", "is_empty"))).toEqual(["t4"]);
    expect(where(rule("uid", "gte", 3))).toEqual(["t3", "t4"]);
  });

  it("select and status", () => {
    expect(where(rule("priority", "is", "high"))).toEqual(["t1"]);
    expect(where(rule("priority", "is_not", "high"))).toEqual(["t2", "t3", "t4"]);
    expect(where(rule("priority", "is_not_empty"))).toEqual(["t1", "t2", "t3"]);
    expect(where(rule("status", "group_is", "doing"))).toEqual(["t1"]);
    expect(where(rule("status", "group_is", "done"))).toEqual(["t3"]);
    expect(where(rule("status", "is", ["todo", "done"]))).toEqual(["t2", "t3"]);
  });

  it("lists: tags, people, relations, tickets, files", () => {
    expect(where(rule("tags", "contains", "feature"))).toEqual(["t2", "t3"]);
    expect(where(rule("tags", "does_not_contain", "feature"))).toEqual(["t1", "t4"]);
    expect(where(rule("owner", "contains", "u2"))).toEqual(["t2", "t3"]);
    expect(where(rule("project", "contains", "p2"))).toEqual(["t3"]);
    expect(where(rule("ticket", "is_not_empty"))).toEqual(["t1"]);
    expect(where(rule("files", "contains", "SPEC"))).toEqual(["t3"]);
    expect(where(rule("author", "contains", "u1"))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("checkbox", () => {
    expect(where(rule("done", "is", true))).toEqual(["t3"]);
    expect(where(rule("done", "is", false))).toEqual(["t1", "t2", "t4"]);
    expect(where(rule("done", "is", "true"))).toEqual(["t3"]);
  });

  it("dates by day, a range on any of its days", () => {
    expect(where(rule("due", "is", "2026-10-26"))).toEqual(["t1", "t3"]);
    expect(where(rule("due", "before", "2026-10-26"))).toEqual(["t3"]);
    expect(where(rule("due", "on_or_before", "2026-10-26"))).toEqual(["t1", "t3"]);
    expect(where(rule("due", "after", "2026-10-26"))).toEqual(["t2"]);
    expect(where(rule("due", "on_or_after", "2026-10-26"))).toEqual(["t1", "t2"]);
    expect(where(rule("due", "is_empty"))).toEqual(["t4"]);
    expect(where(rule("created", "after", "2026-10-10"))).toEqual(["t4"]);
  });

  it("relative dates against now", () => {
    expect(where(rule("due", "is_relative", "today"))).toEqual(["t1", "t3"]);
    expect(where(rule("due", "is_relative", "tomorrow"))).toEqual(["t3"]);
    expect(where(rule("due", "is_relative", "yesterday"))).toEqual(["t3"]);
    expect(where(rule("due", "is_relative", "this_week"))).toEqual(["t1", "t2", "t3"]);
    expect(where(rule("due", "is_relative", "past_week"))).toEqual(["t1", "t3"]);
    expect(where(rule("due", "is_relative", "next_week"))).toEqual(["t1", "t2", "t3"]);
    expect(where(rule("created", "is_relative", "past_month"))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(where(rule("created", "is_relative", "past_week"))).toEqual(["t4"]);
    expect(where(rule("due", "is_relative", "this_year"))).toEqual(["t1", "t2", "t3"]);
  });

  it("knows the days a relative date names; weeks start on Monday", () => {
    const now = new Date(2026, 9, 28, 15);
    expect(relativeRange("this_week", now)).toEqual([new Date(2026, 9, 26), new Date(2026, 10, 1)]);
    expect(relativeRange("this_month", now)).toEqual([new Date(2026, 9, 1), new Date(2026, 9, 31)]);
    expect(relativeRange("next_month", now)).toEqual([new Date(2026, 9, 28), new Date(2026, 10, 28)]);
  });

  it("formulas and rollups by what they give", () => {
    const db = withProps(
      { id: "size", name: "Size", type: "formula", formula: 'if(prop("Points") > 2, "big", "small")' },
      { id: "dbl", name: "Double", type: "formula", formula: 'prop("Points") * 2' },
      { id: "late", name: "Late", type: "formula", formula: 'prop("Due") < today()' },
      { id: "next", name: "Next", type: "formula", formula: 'dateAdd(prop("Due"), 7, "days")' },
    );
    const c = context(db);
    const w = (r: DbFilterRule) => ids(filterRows(tasks, { op: "and", rules: [r] }, c));
    expect(w(rule("size", "is", "big"))).toEqual(["t1", "t3"]);
    expect(w(rule("dbl", "gt", 5))).toEqual(["t1", "t3"]);
    expect(w(rule("late", "is", true))).toEqual(["t3"]);
    expect(w(rule("next", "after", "2026-11-01"))).toEqual(["t1", "t2"]);
    expect(w(rule("next", "is_empty"))).toEqual(["t4"]);
    expect(filterOpsFor(db.properties.find((p) => p.id === "dbl")!, tasks, c)).toEqual(FILTER_OPS.number);
    expect(filterOpsFor(db.properties.find((p) => p.id === "late")!, tasks, c)).toEqual(FILTER_OPS.checkbox);

    const pc = context(projectsDb);
    const pw = (r: DbFilterRule) => ids(filterRows(projects, { op: "and", rules: [r] }, pc));
    expect(pw(rule("pts", "gt", 5))).toEqual(["p2"]);
    expect(pw(rule("states", "contains", "progress"))).toEqual(["p1"]);
    expect(pw(rule("first", "before", "2026-10-25"))).toEqual(["p2"]);
  });
});

describe("filter groups", () => {
  it("joins rules with and/or, nested", () => {
    expect(ids(filterRows(tasks, { op: "or", rules: [rule("priority", "is", "high"), rule("priority", "is", "low")] }, ctx))).toEqual(["t1", "t2"]);
    const nested: DbFilterGroup = {
      op: "and",
      rules: [rule("done", "is", false), { op: "or", rules: [rule("tags", "contains", "bug"), rule("points", "is_empty")] }],
    };
    expect(ids(filterRows(tasks, nested, ctx))).toEqual(["t1", "t4"]);
  });

  it("ignores rules still being written and properties since removed", () => {
    expect(where(rule("title", "contains", ""))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(where(rule("points", "gt"))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(where(rule("gone", "is", "x"), rule("priority", "is", "high"))).toEqual(["t1"]);
    expect(ids(filterRows(tasks, { op: "or", rules: [rule("gone", "is", "x")] }, ctx))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(ids(filterRows(tasks, { op: "or", rules: [rule("gone", "is", "x"), rule("priority", "is", "low")] }, ctx))).toEqual(["t2"]);
    expect(ids(filterRows(tasks, undefined, ctx))).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("search", () => {
  it("matches every word against the cells' text", () => {
    expect(ids(searchRows(tasks, "login", ctx))).toEqual(["t1"]);
    expect(ids(searchRows(tasks, "CAFE", ctx))).toEqual(["t2"]);
    expect(ids(searchRows(tasks, "bob docs", ctx))).toEqual(["t2"]);
    expect(ids(searchRows(tasks, "task-3", ctx))).toEqual(["t3"]);
    expect(ids(searchRows(tasks, "#42", ctx))).toEqual(["t1"]);
    expect(ids(searchRows(tasks, "  ", ctx))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("looks only at the properties given", () => {
    const title = ctx.db.properties.filter((p) => p.type === "title");
    expect(ids(searchRows(tasks, "bob", ctx, title))).toEqual([]);
    expect(ids(searchRows([row("x", "Bob's list")], "bob", ctx, title))).toEqual(["x"]);
  });
});

describe("filterDefaults", () => {
  const db = {
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "st", name: "Status", type: "status", options: [{ id: "doing", name: "Doing", color: "blue" }] },
      { id: "tags", name: "Tags", type: "multi_select", options: [] },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "n", name: "Points", type: "number" },
    ],
  } as unknown as Database;

  it("gives a new row the values an and filter asks for", () => {
    const f: DbFilterGroup = {
      op: "and",
      rules: [
        { property: "st", op: "is", value: "doing" },
        { property: "tags", op: "contains", value: "a" },
        { property: "tags", op: "contains", value: "b" },
        { property: "done", op: "is", value: false },
        { property: "n", op: "gt", value: 3 },
        { op: "or", rules: [{ property: "n", op: "eq", value: 1 }] },
      ],
    };
    expect(filterDefaults(f, db)).toEqual({ st: "doing", tags: ["a", "b"], done: false });
  });

  it("gives nothing for an or filter or an option that is gone", () => {
    expect(filterDefaults({ op: "or", rules: [{ property: "st", op: "is", value: "doing" }] }, db)).toEqual({});
    expect(filterDefaults({ op: "and", rules: [{ property: "st", op: "is", value: "gone" }] }, db)).toEqual({});
  });
});
