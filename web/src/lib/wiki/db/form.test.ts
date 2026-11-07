import { describe, expect, it } from "vitest";
import type { Database } from "../../api/types";
import { tasksDb } from "./fixtures";
import { answers, defaultForm, formQuestions, missingAnswers, unasked } from "./form";
import { changePropertyType, defaultView, disablePair, enablePair, removeProperty } from "./schema";

describe("forms", () => {
  it("asks the title and every stored property at first, never a computed one", () => {
    const ids = defaultForm(tasksDb).fields.map((f) => f.property);
    expect(ids[0]).toBe("title");
    expect(ids).toContain("status");
    expect(ids).not.toContain("uid");
    expect(ids).not.toContain("budget");
    expect(defaultView("form", tasksDb).settings?.form?.fields[0]).toEqual({ property: "title", required: true });
  });

  it("puts the title first and required, and drops fields of properties gone, computed or named twice", () => {
    const q = formQuestions(tasksDb, { fields: [{ property: "notes", help: "Say more" }, { property: "title", help: "Short" }, { property: "uid" }, { property: "nope" }, { property: "notes" }, { property: "due", required: true }] });
    expect(q.map((x) => [x.prop.id, x.required, x.help])).toEqual([
      ["title", true, "Short"],
      ["notes", false, "Say more"],
      ["due", true, ""],
    ]);
    expect(unasked(tasksDb, { fields: [{ property: "title" }] }).map((p) => p.id)).not.toContain("title");
  });

  it("finds required questions left unanswered", () => {
    const q = formQuestions(tasksDb, { fields: [{ property: "title" }, { property: "tags", required: true }, { property: "done", required: true }, { property: "notes" }] });
    expect(missingAnswers(q, " ", { tags: [], done: false })).toEqual(["title", "tags", "done"]);
    expect(missingAnswers(q, "Bug", { tags: ["bug"], done: true })).toEqual([]);
  });

  it("gives the new row only what was asked and answered", () => {
    const q = formQuestions(tasksDb, { fields: [{ property: "title" }, { property: "tags" }, { property: "notes" }, { property: "done" }, { property: "points" }] });
    expect(answers(q, { tags: [], notes: "  ", done: false, points: 0, status: "todo" })).toEqual({ done: false, points: 0 });
  });

  it("forgets a property removed, or one turned into a computed type", () => {
    const db: Database = { ...tasksDb, views: [defaultView("form", tasksDb)] };
    const fields = (d: Database) => d.views[0]!.settings!.form!.fields.map((f) => f.property);
    expect(fields(removeProperty(db, "notes"))).not.toContain("notes");
    expect(fields(changePropertyType(db, "notes", "formula"))).not.toContain("notes");
    expect(fields(changePropertyType(db, "notes", "number"))).toContain("notes");
  });
});

describe("turning sub-items and dependencies on and off", () => {
  const base: Database = { properties: [{ id: "title", name: "Name", type: "title" }], views: [{ id: "t", name: "Table", type: "table" }, { id: "b", name: "Board", type: "board" }], next_id: 1 };
  const names = { first: "Parent item", second: "Sub-items" };

  it("adds two relations of the database to itself, hidden in tables and lists", () => {
    const db = enablePair(base, "db1", "sub_items", names);
    const [parent, children] = db.properties.slice(1);
    expect(parent).toMatchObject({ name: "Parent item", type: "relation", database_id: "db1" });
    expect(children).toMatchObject({ name: "Sub-items", type: "relation", database_id: "db1" });
    expect(db.sub_items).toEqual({ parent: parent!.id, children: children!.id });
    expect(db.views[0]!.settings?.hidden).toEqual([parent!.id, children!.id]);
    expect(db.views[1]!.settings).toBeUndefined();
  });

  it("keeps the relations when turned off, and takes them up again when turned back on", () => {
    const on = enablePair(base, "db1", "dependencies", { first: "Blocked by", second: "Blocking" });
    const off = disablePair(on, "dependencies");
    expect(off.dependencies).toBeUndefined();
    expect(off.properties).toHaveLength(3);
    const again = enablePair(off, "db1", "dependencies", { first: "Blocked by", second: "Blocking" });
    expect(again.properties).toHaveLength(3);
    expect(again.dependencies).toEqual(on.dependencies);
  });

  it("turns off when one of its relations is removed or changes type", () => {
    const on = enablePair(base, "db1", "sub_items", names);
    expect(removeProperty(on, on.sub_items!.children).sub_items).toBeUndefined();
    expect(changePropertyType(on, on.sub_items!.parent, "text").sub_items).toBeUndefined();
    expect(removeProperty(on, "title").sub_items).toEqual(on.sub_items);
  });
});
