// Two related databases for the engine's tests: tasks, and the projects they belong to.

import type { Database, DbProperty, DbRow, DbValue, UserRef } from "../../api/types";
import type { DbContext } from "./context";

/** Monday 26 October 2026, noon. */
export const NOW = new Date(2026, 9, 26, 12, 0);

export const ann: UserRef = { id: "u1", name: "Ann Lee", email: "ann@example.com", avatar_url: null };
export const bob: UserRef = { id: "u2", name: "Bob Ito", email: "bob@example.com", avatar_url: null };

export const taskProps: DbProperty[] = [
  { id: "title", name: "Name", type: "title" },
  {
    id: "status",
    name: "Status",
    type: "status",
    options: [
      { id: "done", name: "Done", color: "green" },
      { id: "todo", name: "Not started", color: "gray" },
      { id: "review", name: "Review", color: "purple" },
      { id: "prog", name: "In progress", color: "blue" },
    ],
    groups: [
      { id: "todo", option_ids: ["todo"] },
      { id: "doing", option_ids: ["prog", "review"] },
      { id: "done", option_ids: ["done"] },
    ],
  },
  {
    id: "priority",
    name: "Priority",
    type: "select",
    options: [
      { id: "high", name: "High", color: "red" },
      { id: "med", name: "Medium", color: "yellow" },
      { id: "low", name: "Low", color: "gray" },
    ],
  },
  {
    id: "tags",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "bug", name: "Bug", color: "red" },
      { id: "feature", name: "Feature", color: "blue" },
      { id: "docs", name: "Docs", color: "green" },
    ],
  },
  { id: "points", name: "Points", type: "number" },
  { id: "price", name: "Price", type: "number", number_format: "usd" },
  { id: "due", name: "Due", type: "date" },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "project", name: "Project", type: "relation", database_id: "projects" },
  { id: "notes", name: "Notes", type: "text" },
  { id: "uid", name: "ID", type: "unique_id", prefix: "TASK" },
  { id: "created", name: "Created", type: "created_time" },
  { id: "author", name: "Created by", type: "created_by" },
  { id: "ticket", name: "Ticket", type: "ticket" },
  { id: "files", name: "Files", type: "files" },
  { id: "budget", name: "Project budget", type: "rollup", rollup: { relation: "project", property: "budget", fn: "sum" } },
];

export const projectProps: DbProperty[] = [
  { id: "title", name: "Name", type: "title" },
  { id: "budget", name: "Budget", type: "number", number_format: "eur" },
  { id: "tasks", name: "Tasks", type: "relation", database_id: "tasks" },
  { id: "n", name: "Task count", type: "rollup", rollup: { relation: "tasks", property: "title", fn: "count" } },
  { id: "pts", name: "Points", type: "rollup", rollup: { relation: "tasks", property: "points", fn: "sum" } },
  { id: "pct", name: "Done", type: "rollup", rollup: { relation: "tasks", property: "done", fn: "percent_checked" } },
  { id: "states", name: "States", type: "rollup", rollup: { relation: "tasks", property: "status", fn: "show_original" } },
  { id: "first", name: "First due", type: "rollup", rollup: { relation: "tasks", property: "due", fn: "earliest" } },
  { id: "span", name: "Span", type: "rollup", rollup: { relation: "tasks", property: "due", fn: "range" } },
];

export const tasksDb: Database = { properties: taskProps, views: [{ id: "table", name: "Table", type: "table" }], next_id: 5 };
export const projectsDb: Database = { properties: projectProps, views: [{ id: "table", name: "Table", type: "table" }], next_id: 1 };

export function row(id: string, title: string, props: Record<string, DbValue> = {}, extra: Partial<DbRow> = {}): DbRow {
  return {
    id,
    parent_id: "db",
    title,
    icon: "",
    position: 0,
    version: 1,
    updated_at: "2026-10-20T10:00:00Z",
    created_by_id: ann.id,
    tags: [],
    props,
    cover: "",
    cover_y: 50,
    excerpt: "",
    created_at: "2026-10-01T09:00:00Z",
    created_by: ann,
    updated_by: bob,
    ...extra,
  };
}

/** Rows in the order given, positions numbered. */
export const ordered = (rows: DbRow[]): DbRow[] => rows.map((r, position) => ({ ...r, position }));

export const tasks = ordered([
  row("t1", "Fix login", { status: "prog", priority: "high", tags: ["bug"], points: 3, price: 1250, due: { start: "2026-10-26" }, done: false, owner: ["u1"], project: ["p1"], uid: 1, ticket: ["k1"] }),
  row("t2", "Write docs", { status: "todo", priority: "low", tags: ["docs", "feature"], points: 1, due: { start: "2026-10-30" }, owner: ["u2"], project: ["p1"], uid: 2, notes: "Café menu" }),
  row("t3", "Ship v2", { status: "done", priority: "med", tags: ["feature"], points: 8, price: 99.5, due: { start: "2026-10-20", end: "2026-10-27" }, done: true, owner: ["u1", "u2"], project: ["p2"], uid: 3, files: [{ url: "https://x.test/spec.pdf", name: "spec.pdf" }] }),
  row("t4", "Plan Q4", { uid: 4, done: false }, { created_at: "2026-10-25T09:00:00Z" }),
]);

export const projects = ordered([row("p1", "Website", { budget: 5000, tasks: ["t1", "t2"] }), row("p2", "Mobile", { budget: 1200, tasks: ["t3"] }), row("p3", "", { tasks: [] })]);

export function context(db: Database = tasksDb, overrides: Partial<DbContext> = {}): DbContext {
  return {
    db,
    rowsByDb: new Map([
      ["tasks", tasks],
      ["projects", projects],
    ]),
    members: new Map([
      [ann.id, ann],
      [bob.id, bob],
    ]),
    tickets: new Map([["k1", { id: "k1", number: 42, subject: "Login broken", status: "open" }]]),
    databases: new Map([
      ["tasks", tasksDb],
      ["projects", projectsDb],
    ]),
    now: NOW,
    ...overrides,
  };
}

/** The tasks database with more properties. */
export function withProps(...props: DbProperty[]): Database {
  return { ...tasksDb, properties: [...taskProps, ...props] };
}

export const ids = (rows: DbRow[]) => rows.map((r) => r.id);
