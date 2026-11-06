import { describe, expect, it } from "vitest";
import type { Database, DbProperty } from "../../api/types";
import { context, projects, projectsDb, row, tasks, tasksDb } from "./fixtures";
import { cellText, cellValue, isEmpty, optionOf, statusGroupOf } from "./values";

const ctx = context();
const pctx = context(projectsDb);
const prop = (db: Database, id: string) => db.properties.find((p) => p.id === id) as DbProperty;
const t = (id: string) => tasks.find((r) => r.id === id)!;
const p = (id: string) => projects.find((r) => r.id === id)!;
const value = (rowId: string, propId: string) => cellValue(t(rowId), prop(tasksDb, propId), ctx);
const text = (rowId: string, propId: string) => cellText(value(rowId, propId), prop(tasksDb, propId), ctx);
const pvalue = (rowId: string, propId: string) => cellValue(p(rowId), prop(projectsDb, propId), pctx);
const ptext = (rowId: string, propId: string) => cellText(pvalue(rowId, propId), prop(projectsDb, propId), pctx);

describe("cell values", () => {
  it("reads stored values by type", () => {
    expect(value("t1", "title")).toBe("Fix login");
    expect(value("t1", "points")).toBe(3);
    expect(value("t1", "status")).toBe("prog");
    expect(value("t2", "tags")).toEqual(["docs", "feature"]);
    expect(value("t1", "owner")).toEqual(["u1"]);
    expect(value("t1", "project")).toEqual(["p1"]);
    expect(value("t3", "done")).toBe(true);
    expect(value("t2", "done")).toBe(false);
    expect(value("t4", "points")).toBeNull();
    expect(value("t4", "tags")).toEqual([]);
  });

  it("reads a value of a removed option as none", () => {
    const r = row("x", "X", { priority: "gone", tags: ["bug", "gone"] });
    expect(cellValue(r, prop(tasksDb, "priority"), ctx)).toBeNull();
    expect(cellValue(r, prop(tasksDb, "tags"), ctx)).toEqual(["bug"]);
  });

  it("reads dates as local days, moments and ranges", () => {
    expect(value("t1", "due")).toEqual({ start: new Date(2026, 9, 26), end: undefined, time: false });
    expect(value("t3", "due")).toEqual({ start: new Date(2026, 9, 20), end: new Date(2026, 9, 27), time: false });
    const moment = cellValue(row("x", "X", { due: { start: "2026-10-26T08:30:00Z" } }), prop(tasksDb, "due"), ctx);
    expect(moment).toEqual({ start: new Date(Date.UTC(2026, 9, 26, 8, 30)), end: undefined, time: true });
    expect(cellValue(row("x", "X", { due: { start: "not a date" } }), prop(tasksDb, "due"), ctx)).toBeNull();
  });

  it("works out the computed ones", () => {
    expect(value("t1", "created")).toEqual(new Date("2026-10-01T09:00:00Z"));
    expect(value("t1", "author")).toEqual(["u1"]);
    expect(value("t1", "uid")).toBe(1);
    expect(text("t1", "uid")).toBe("TASK-1");
  });

  it("shows values as text", () => {
    expect(text("t1", "status")).toBe("In progress");
    expect(text("t2", "tags")).toBe("Docs, Feature");
    expect(text("t3", "owner")).toBe("Ann Lee, Bob Ito");
    expect(text("t1", "author")).toBe("Ann Lee");
    expect(text("t1", "project")).toBe("Website");
    expect(text("t1", "ticket")).toBe("#42 Login broken");
    expect(text("t3", "files")).toBe("spec.pdf");
    expect(text("t1", "price")).toBe("$1,250.00");
    expect(text("t1", "points")).toBe("3");
    expect(text("t3", "done")).toBe("true");
    expect(text("t2", "done")).toBe("false");
    expect(text("t1", "due")).toBe("Oct 26, 2026");
    expect(text("t3", "due")).toBe("Oct 20, 2026 → Oct 27, 2026");
    expect(text("t4", "points")).toBe("");
  });

  it("names untitled pages as the UI asks", () => {
    const r = row("x", "X", { project: ["p3"] });
    expect(cellText(cellValue(r, prop(tasksDb, "project"), ctx), prop(tasksDb, "project"), ctx)).toBe("Untitled");
    const nl = context(tasksDb, { untitled: "Naamloos" });
    expect(cellText(cellValue(r, prop(tasksDb, "project"), nl), prop(tasksDb, "project"), nl)).toBe("Naamloos");
  });

  it("formats numbers by their format", () => {
    const n = (format: DbProperty["number_format"], v: number) => cellText(v, { id: "n", name: "N", type: "number", number_format: format }, ctx);
    expect(n("number", 1234.5)).toBe("1234.5");
    expect(n("comma", 1234.5)).toBe("1,234.5");
    expect(n("percent", 0.425)).toBe("42.5%");
    expect(n("eur", 12)).toBe("€12.00");
    expect(n("jpy", 1200)).toBe("¥1,200");
  });

  it("knows what's empty", () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty("  ")).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
    expect(isEmpty(new Date())).toBe(false);
  });

  it("finds options and status groups", () => {
    const status = prop(tasksDb, "status");
    expect(optionOf(status, "prog")?.name).toBe("In progress");
    expect(optionOf(status, "nope")).toBeUndefined();
    expect(statusGroupOf(status, "review")).toBe("doing");
    expect(statusGroupOf(status, "nope")).toBeNull();
  });
});

describe("rollups", () => {
  it("count, sum and percent over the related pages", () => {
    expect(pvalue("p1", "n")).toBe(2);
    expect(pvalue("p1", "pts")).toBe(4);
    expect(pvalue("p2", "pct")).toBe(1);
    expect(ptext("p1", "pct")).toBe("0%");
    expect(ptext("p2", "pct")).toBe("100%");
    expect(pvalue("p3", "n")).toBe(0);
    expect(pvalue("p3", "pts")).toBe(0);
  });

  it("show the original values as text", () => {
    expect(pvalue("p1", "states")).toEqual(["In progress", "Not started"]);
    expect(ptext("p1", "states")).toBe("In progress, Not started");
  });

  it("sum up dates", () => {
    expect(pvalue("p1", "first")).toEqual(new Date(2026, 9, 26));
    expect(ptext("p2", "span")).toBe("7 days");
    expect(ptext("p1", "span")).toBe("4 days");
  });

  it("keep the format of the numbers they sum", () => {
    expect(value("t1", "budget")).toBe(5000);
    expect(text("t1", "budget")).toBe("€5,000.00");
  });

  it("read related titles without the related schema", () => {
    const bare = context(projectsDb, { databases: new Map() });
    expect(cellValue(p("p1"), prop(projectsDb, "n"), bare)).toBe(2);
    expect(cellValue(p("p1"), prop(projectsDb, "pts"), bare)).toBeNull();
  });

  it("give up on a rollup that reads itself", () => {
    // Tasks roll up their projects' rollup of the tasks' own rollup.
    const loopTasks: Database = { ...tasksDb, properties: [...tasksDb.properties, { id: "loop", name: "Loop", type: "rollup", rollup: { relation: "project", property: "loop", fn: "sum" } }] };
    const loopProjects: Database = { ...projectsDb, properties: [...projectsDb.properties, { id: "loop", name: "Loop", type: "rollup", rollup: { relation: "tasks", property: "loop", fn: "sum" } }] };
    const c = context(loopTasks, { databases: new Map([["tasks", loopTasks], ["projects", loopProjects]]) });
    expect(cellValue(t("t1"), prop(loopTasks, "loop"), c)).toBe(0);
  });
});
