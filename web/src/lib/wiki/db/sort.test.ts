import { describe, expect, it } from "vitest";
import type { DbSort } from "../../api/types";
import { context, ids, ordered, row, tasks, withProps } from "./fixtures";
import { sortRows } from "./sort";

const ctx = context();
const by = (...sorts: DbSort[]) => ids(sortRows(tasks, sorts, ctx));
const asc = (property: string): DbSort => ({ property, dir: "asc" });
const desc = (property: string): DbSort => ({ property, dir: "desc" });

describe("sorting rows", () => {
  it("keeps the rows' own order without sorts", () => {
    const shuffled = [tasks[2], tasks[0], tasks[3], tasks[1]];
    expect(ids(sortRows(shuffled, undefined, ctx))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(ids(sortRows(shuffled, [], ctx))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("puts empty values last in either direction", () => {
    expect(by(asc("points"))).toEqual(["t2", "t1", "t3", "t4"]);
    expect(by(desc("points"))).toEqual(["t3", "t1", "t2", "t4"]);
    expect(by(desc("price"))).toEqual(["t1", "t3", "t2", "t4"]);
  });

  it("orders options by their place, status by group first", () => {
    expect(by(asc("priority"))).toEqual(["t1", "t3", "t2", "t4"]);
    // Status options are listed Done, Not started, Review, In progress; groups say to do, doing, done.
    expect(by(asc("status"))).toEqual(["t2", "t1", "t3", "t4"]);
    expect(by(desc("status"))).toEqual(["t3", "t1", "t2", "t4"]);
    expect(by(asc("tags"))).toEqual(["t1", "t3", "t2", "t4"]);
  });

  it("orders dates in time, a range by its start", () => {
    expect(by(asc("due"))).toEqual(["t3", "t1", "t2", "t4"]);
    expect(by(desc("created"))).toEqual(["t4", "t1", "t2", "t3"]);
  });

  it("orders text as people read numbers in it", () => {
    const rows = ordered([row("a", "Task 10"), row("b", "task 2"), row("c", "Task 1"), row("d", "")]);
    expect(ids(sortRows(rows, [asc("title")], ctx))).toEqual(["c", "b", "a", "d"]);
    expect(ids(sortRows(rows, [desc("title")], ctx))).toEqual(["a", "b", "c", "d"]);
  });

  it("orders checkboxes unchecked first, and people by name", () => {
    expect(by(desc("done"))).toEqual(["t3", "t1", "t2", "t4"]);
    expect(by(asc("owner"))).toEqual(["t1", "t3", "t2", "t4"]);
  });

  it("sorts by each key in turn, stably", () => {
    expect(by(asc("done"), desc("points"))).toEqual(["t1", "t2", "t4", "t3"]);
    expect(by(asc("done"))).toEqual(["t1", "t2", "t4", "t3"]);
  });

  it("sorts formulas by their results and skips removed properties", () => {
    const db = withProps({ id: "dbl", name: "Double", type: "formula", formula: 'prop("Points") * 2' });
    expect(ids(sortRows(tasks, [desc("dbl")], context(db)))).toEqual(["t3", "t1", "t2", "t4"]);
    expect(by(asc("gone"), asc("points"))).toEqual(["t2", "t1", "t3", "t4"]);
  });
});
