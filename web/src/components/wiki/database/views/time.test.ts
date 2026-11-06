import { describe, expect, it } from "vitest";
import { context, row, tasks, tasksDb } from "@/lib/wiki/db/fixtures";
import { axisOf, barOf, dayAt, dayKey, editDates, layoutWeek, monthGrid, placeDates, shiftStored, spanOf, ticks, toneOf, type DaySpan } from "./time";

const d = (s: string) => new Date(`${s}T00:00:00`);
const span = (a: string, b = a): DaySpan => ({ start: d(a), end: d(b) });
const keys = (days: Date[]) => days.map(dayKey);

describe("the month grid", () => {
  it("shows whole weeks from Monday, from the week of the 1st to the week of the last day", () => {
    const weeks = monthGrid(d("2026-10-15"));
    expect(weeks).toHaveLength(5);
    expect(dayKey(weeks[0][0])).toBe("2026-09-28");
    expect(dayKey(weeks[4][6])).toBe("2026-11-01");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("takes six weeks when the month needs them", () => {
    // March 2026 starts on a Sunday and ends on a Tuesday.
    expect(monthGrid(d("2026-03-01"))).toHaveLength(6);
  });
});

describe("rows in a week", () => {
  const week = monthGrid(d("2026-10-01"))[3]; // 19 to 25 October
  it("puts each row on the first lane free for all its days, longer ranges first", () => {
    const { bars } = layoutWeek(
      week,
      [
        { id: "short", span: span("2026-10-20") },
        { id: "long", span: span("2026-10-20", "2026-10-23") },
        { id: "after", span: span("2026-10-24") },
      ],
      3,
    );
    expect(bars).toEqual([
      { id: "long", col: 1, len: 4, lane: 0, cutStart: false, cutEnd: false },
      { id: "short", col: 1, len: 1, lane: 1, cutStart: false, cutEnd: false },
      { id: "after", col: 5, len: 1, lane: 0, cutStart: false, cutEnd: false },
    ]);
  });

  it("cuts a range that goes on before or after the week", () => {
    const { bars } = layoutWeek(week, [{ id: "r", span: span("2026-10-15", "2026-10-30") }], 3);
    expect(bars).toEqual([{ id: "r", col: 0, len: 7, lane: 0, cutStart: true, cutEnd: true }]);
  });

  it("counts the rows past the last lane per day", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id, span: span("2026-10-21") }));
    const { bars, hidden, byDay } = layoutWeek(week, items, 3);
    expect(bars.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(hidden).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(byDay[2]).toEqual(["a", "b", "c", "d"]);
  });
});

describe("a row's days", () => {
  it("reads a day, a range and an end property's date", () => {
    expect(spanOf({ start: d("2026-10-26"), time: false })).toEqual(span("2026-10-26"));
    expect(spanOf({ start: d("2026-10-20"), end: d("2026-10-27"), time: false })).toEqual(span("2026-10-20", "2026-10-27"));
    expect(spanOf({ start: d("2026-10-20"), time: false }, { start: d("2026-10-22"), time: false })).toEqual(span("2026-10-20", "2026-10-22"));
    expect(spanOf(new Date(2026, 9, 3, 15, 30))).toEqual(span("2026-10-03"));
  });

  it("reads an end before the start as the start, and nothing without a start", () => {
    expect(spanOf({ start: d("2026-10-20"), time: false }, { start: d("2026-10-01"), time: false })).toEqual(span("2026-10-20"));
    expect(spanOf(null, { start: d("2026-10-01"), time: false })).toBeNull();
  });

  it("takes the tone of the row's first status or select", () => {
    const ctx = context();
    expect(toneOf(tasks[0], tasksDb, ctx)).toBe("blue");
    expect(toneOf(row("x", "x", { priority: "high" }), tasksDb, ctx)).toBe("red");
    expect(toneOf(tasks[3], tasksDb, ctx)).toBeUndefined();
  });
});

describe("moving dates", () => {
  it("moves a day as a day and a moment with its time of day", () => {
    expect(shiftStored("2026-10-30", 3)).toBe("2026-11-02");
    const moment = new Date(2026, 9, 24, 14, 30);
    const moved = new Date(shiftStored(moment.toISOString(), 2));
    expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([26, 14, 30]);
  });

  it("moves a whole range, keeping its length", () => {
    expect(editDates({ due: { start: "2026-10-20", end: "2026-10-27" } }, "due", undefined, "move", -5)).toEqual({ due: { start: "2026-10-15", end: "2026-10-22" } });
  });

  it("stretches a single day into a range from either edge", () => {
    expect(editDates({ due: { start: "2026-10-20" } }, "due", undefined, "end", 2)).toEqual({ due: { start: "2026-10-20", end: "2026-10-22" } });
    expect(editDates({ due: { start: "2026-10-20" } }, "due", undefined, "start", -2)).toEqual({ due: { start: "2026-10-18", end: "2026-10-20" } });
  });

  it("makes a range one day again when its end comes back to its start", () => {
    expect(editDates({ due: { start: "2026-10-20", end: "2026-10-22" } }, "due", undefined, "end", -2)).toEqual({ due: { start: "2026-10-20" } });
  });

  it("writes the end to the end property when the view has one", () => {
    const props = { start: { start: "2026-10-20" }, end: { start: "2026-10-22" } };
    expect(editDates(props, "start", "end", "move", 1)).toEqual({ start: { start: "2026-10-21" }, end: { start: "2026-10-23" } });
    expect(editDates(props, "start", "end", "end", 3)).toEqual({ end: { start: "2026-10-25" } });
    expect(editDates({ start: { start: "2026-10-20" } }, "start", "end", "start", -1)).toEqual({ start: { start: "2026-10-19" }, end: { start: "2026-10-20" } });
  });

  it("does nothing without a date or a move", () => {
    expect(editDates({}, "due", undefined, "move", 2)).toBeNull();
    expect(editDates({ due: { start: "2026-10-20" } }, "due", undefined, "move", 0)).toBeNull();
  });

  it("places a row without dates on a day, or a run of days", () => {
    expect(placeDates("due", undefined, d("2026-10-20"), 1)).toEqual({ due: { start: "2026-10-20" } });
    expect(placeDates("due", undefined, d("2026-10-20"), 7)).toEqual({ due: { start: "2026-10-20", end: "2026-10-26" } });
    expect(placeDates("s", "e", d("2026-10-20"), 3)).toEqual({ s: { start: "2026-10-20" }, e: { start: "2026-10-22" } });
  });
});

describe("the timeline axis", () => {
  const today = d("2026-10-26");

  it("covers every row and today with room around them, from a Monday to a Sunday", () => {
    const axis = axisOf([span("2026-12-01", "2026-12-20")], today, "day");
    expect(axis.from.getDay()).toBe(1);
    expect(axis.to.getDay()).toBe(0);
    expect(axis.from < today && axis.to > d("2026-12-20")).toBe(true);
  });

  it("grows when scrolled to an edge", () => {
    const a = axisOf([], today, "week");
    const b = axisOf([], today, "week", { before: 1, after: 0 });
    expect(b.from < a.from).toBe(true);
    expect(b.to).toEqual(a.to);
  });

  it("places bars and days by whole days", () => {
    const axis = { from: d("2026-10-05"), to: d("2026-11-29") };
    expect(barOf(span("2026-10-07", "2026-10-09"), axis, 20)).toEqual({ x: 40, width: 60 });
    expect(dayKey(dayAt(axis, 59, 20))).toBe("2026-10-07");
    expect(dayKey(dayAt(axis, 60, 20))).toBe("2026-10-08");
  });

  it("cuts header units to the axis", () => {
    const axis = { from: d("2026-10-05"), to: d("2026-11-29") };
    const months = ticks(axis, "month", 10);
    expect(keys(months.map((m) => m.start))).toEqual(["2026-10-01", "2026-11-01"]);
    expect(months.map((m) => [m.x, m.width])).toEqual([
      [0, 270],
      [270, 290],
    ]);
    expect(ticks(axis, "week", 10)).toHaveLength(8);
  });
});
