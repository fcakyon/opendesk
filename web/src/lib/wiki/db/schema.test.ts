import { describe, expect, it } from "vitest";
import type { Database, DbView } from "../../api/types";
import { context, projectsDb, tasksDb } from "./fixtures";
import { addOption, addProperty, changePropertyType, defaultValueFor, defaultView, newOptionId, newPropId, newViewId, removeProperty, TONE_ORDER, visibleProps } from "./schema";

const ctx = context();
const ID = /^[a-z0-9_]{1,24}$/;
const find = (db: Database, id: string) => db.properties.find((p) => p.id === id);

describe("ids", () => {
  it("are valid for the API and not taken", () => {
    const made = new Set(Array.from({ length: 50 }, () => newPropId(tasksDb)));
    expect(made.size).toBe(50);
    for (const id of made) expect(id).toMatch(ID);
    expect(newViewId(tasksDb)).toMatch(ID);
    expect(newOptionId(find(tasksDb, "tags")!)).toMatch(ID);
  });
});

describe("new views", () => {
  it("are set up to show something", () => {
    expect(defaultView("board", tasksDb).settings).toEqual({ group_by: "status" });
    expect(defaultView("calendar", tasksDb).settings).toEqual({ date_property: "due" });
    expect(defaultView("timeline", tasksDb).settings).toEqual({ date_property: "due", timeline_scale: "week" });
    expect(defaultView("gallery", tasksDb).settings).toEqual({ card_preview: "cover" });
    expect(defaultView("chart", tasksDb).settings).toEqual({ chart: { kind: "column", x: "status" } });
    const table = defaultView("table", tasksDb, "Everything");
    expect(table).toMatchObject({ name: "Everything", type: "table" });
    expect(table.settings).toBeUndefined();
  });

  it("fall back where the database has no such property", () => {
    const bare: Database = { properties: [{ id: "title", name: "Name", type: "title" }], views: [], next_id: 1 };
    expect(defaultView("board", bare).settings).toBeUndefined();
    expect(defaultView("calendar", bare).settings).toBeUndefined();
    expect(defaultView("board", projectsDb).name).toBe("Board");
  });
});

describe("properties", () => {
  it("are added at the end with a name of their own", () => {
    const { db, id, prop } = addProperty(tasksDb, "status", "status");
    expect(db.properties.at(-1)).toBe(prop);
    expect(prop).toMatchObject({ id, name: "status 2", type: "status" });
    expect(prop.options?.map((o) => o.name)).toEqual(["Not started", "In progress", "Done"]);
    expect(prop.groups?.map((g) => g.id)).toEqual(["todo", "doing", "done"]);
    expect(addProperty(tasksDb, "number", "Cost").prop).toMatchObject({ name: "Cost", number_format: "number" });
    expect(addProperty(tasksDb, "title", "Another").prop.type).toBe("text");
    expect(addProperty(tasksDb, "status", "Stage", { todo: "Offen", doing: "Läuft", done: "Fertig" }).prop.options?.map((o) => o.name)).toEqual(["Offen", "Läuft", "Fertig"]);
  });

  it("change type keeping options between select, multi-select and status", () => {
    const asStatus = changePropertyType(tasksDb, "priority", "status");
    expect(find(asStatus, "priority")).toMatchObject({
      type: "status",
      options: find(tasksDb, "priority")!.options,
      groups: [
        { id: "todo", option_ids: ["high", "med", "low"] },
        { id: "doing", option_ids: [] },
        { id: "done", option_ids: [] },
      ],
    });
    const asSelect = changePropertyType(tasksDb, "status", "select");
    expect(find(asSelect, "status")!.options).toEqual(find(tasksDb, "status")!.options);
    expect(find(asSelect, "status")!.groups).toBeUndefined();
    expect(find(changePropertyType(tasksDb, "priority", "text"), "priority")).toEqual({ id: "priority", name: "Priority", type: "text" });
    expect(changePropertyType(tasksDb, "title", "text")).toBe(tasksDb);
  });

  it("drop the filters and calculations a new type doesn't offer", () => {
    const view: DbView = {
      id: "v",
      name: "V",
      type: "table",
      settings: { filter: { op: "and", rules: [{ property: "points", op: "gt", value: 1 }, { property: "points", op: "is_empty" }] }, calculations: { points: "sum", title: "count" } },
    };
    const db = changePropertyType({ ...tasksDb, views: [view] }, "points", "text");
    expect(db.views[0].settings).toEqual({ filter: { op: "and", rules: [{ property: "points", op: "is_empty" }] }, calculations: { title: "count" } });
  });

  it("take their rollups along when a relation goes", () => {
    expect(find(removeProperty(projectsDb, "tasks"), "n")).toBeUndefined();
    expect(removeProperty(projectsDb, "tasks").properties.map((p) => p.id)).toEqual(["title", "budget"]);
    expect(find(changePropertyType(projectsDb, "tasks", "text"), "pts")).toBeUndefined();
  });

  it("leave no mention behind in views when removed", () => {
    const view: DbView = {
      id: "v",
      name: "V",
      type: "board",
      settings: {
        filter: { op: "and", rules: [{ property: "priority", op: "is", value: "high" }, { op: "or", rules: [{ property: "priority", op: "is_empty" }] }, { property: "done", op: "is", value: true }] },
        sorts: [{ property: "priority", dir: "asc" }, { property: "points", dir: "desc" }],
        group_by: "priority",
        hidden: ["priority", "notes"],
        order: ["notes", "priority"],
        widths: { priority: 120, notes: 200 },
        calculations: { priority: "count_empty" },
        chart: { kind: "bar", x: "priority" },
      },
    };
    const db = removeProperty({ ...tasksDb, views: [view] }, "priority");
    expect(find(db, "priority")).toBeUndefined();
    expect(db.views[0].settings).toEqual({
      filter: { op: "and", rules: [{ property: "done", op: "is", value: true }] },
      sorts: [{ property: "points", dir: "desc" }],
      hidden: ["notes"],
      order: ["notes"],
      widths: { notes: 200 },
    });
    expect(removeProperty(tasksDb, "title")).toBe(tasksDb);
  });

  it("show in the view's order, title first, hidden ones left out", () => {
    const view: DbView = { id: "v", name: "V", type: "table", settings: { order: ["points", "title", "status"], hidden: ["title", "tags", "notes"] } };
    const shown = visibleProps(tasksDb, view).map((p) => p.id);
    expect(shown.slice(0, 4)).toEqual(["title", "points", "status", "priority"]);
    expect(shown).not.toContain("tags");
    expect(shown).not.toContain("notes");
    expect(shown).toHaveLength(tasksDb.properties.length - 2);
  });
});

describe("options and new rows", () => {
  it("give new options the next colour", () => {
    const tags = find(tasksDb, "tags")!;
    const { prop, option } = addOption(tags, "  Urgent ");
    expect(option).toMatchObject({ name: "Urgent", color: TONE_ORDER[3] });
    expect(prop.options?.at(-1)).toBe(option);
  });

  it("start a status at its first to-do option and a checkbox unchecked", () => {
    expect(defaultValueFor(find(tasksDb, "status")!, ctx)).toBe("todo");
    expect(defaultValueFor(find(tasksDb, "done")!, ctx)).toBe(false);
    expect(defaultValueFor(find(tasksDb, "points")!, ctx)).toBeNull();
  });
});
