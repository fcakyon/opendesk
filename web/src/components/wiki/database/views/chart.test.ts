import { describe, expect, it } from "vitest";
import { context, tasks } from "@/lib/wiki/db/fixtures";
import { chartData, foldTail, measureRows, niceTicks, shortNumber } from "./chart";

const ctx = context();
const labels = { none: "No value", checked: "Checked", unchecked: "Unchecked" };
const shape = (data: ReturnType<typeof chartData>) => data?.points.map((p) => [p.label, p.value, p.tone]);

describe("chart data", () => {
  it("counts rows per option, in the options' order, with their tones", () => {
    const data = chartData(tasks, { kind: "column", x: "priority" }, ctx, labels);
    expect(shape(data)).toEqual([
      ["High", 1, "red"],
      ["Medium", 1, "yellow"],
      ["Low", 1, "gray"],
      ["No value", 1, "gray"],
    ]);
  });

  it("sums and averages a number property", () => {
    const sum = chartData(tasks, { kind: "bar", x: "status", y: { property: "points", fn: "sum" } }, ctx, labels);
    expect(sum?.points.find((p) => p.key === "done")?.value).toBe(8);
    expect(sum?.format(1250)).toBe("1250");
    const avg = chartData(tasks, { kind: "bar", x: "done", y: { property: "points", fn: "avg" } }, ctx, labels);
    // Unchecked: 3, 1 and nothing → 2; checked: 8.
    expect(shape(avg)).toEqual([
      ["Unchecked", 2, undefined],
      ["Checked", 8, undefined],
    ]);
    expect(avg?.format(1 / 3)).toBe("0.33");
  });

  it("keeps a row in every group of a multi-select", () => {
    const data = chartData(tasks, { kind: "column", x: "tags" }, ctx, labels);
    expect(shape(data)).toEqual([
      ["Bug", 1, "red"],
      ["Feature", 2, "blue"],
      ["Docs", 1, "green"],
      ["No value", 1, "gray"],
    ]);
  });

  it("puts groups without an order of their own largest first", () => {
    const data = chartData(tasks, { kind: "bar", x: "owner" }, ctx, labels);
    expect(data?.points.map((p) => [p.label, p.value])).toEqual([
      ["Ann Lee", 2],
      ["Bob Ito", 2],
      ["No value", 1],
    ]);
  });

  it("has nothing to draw without rows or an x property", () => {
    expect(chartData([], { kind: "bar", x: "priority" }, ctx, labels)).toBeNull();
    expect(chartData(tasks, { kind: "bar", x: "gone" }, ctx, labels)).toBeNull();
    expect(chartData(tasks, undefined, ctx, labels)).toBeNull();
  });

  it("folds the tail into one group measured over its rows", () => {
    const data = chartData(tasks, { kind: "donut", x: "status", y: { property: "points", fn: "avg" } }, ctx, labels)!;
    const folded = foldTail(data, 2, "Other", ctx);
    expect(folded.map((p) => p.label)).toEqual(["Not started", "Other"]);
    // In progress (3), review (none), done (8), no value (none): the average of 3 and 8.
    expect(folded[1].value).toBe(5.5);
    expect(foldTail(data, 10, "Other", ctx)).toBe(data.points);
  });

  it("measures 0 for a sum or average of nothing", () => {
    const y = ctx.db.properties.find((p) => p.id === "points");
    expect(measureRows([tasks[3]], y, "avg", ctx)).toBe(0);
    expect(measureRows([tasks[3]], y, "count", ctx)).toBe(1);
  });
});

describe("axis ticks", () => {
  it("steps by 1, 2 or 5 from 0", () => {
    expect(niceTicks(0, 7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0, 1250)).toEqual([0, 500, 1000, 1500]);
  });

  it("reaches below 0 for negative values, and has a scale with nothing to show", () => {
    expect(niceTicks(-3, 5)).toEqual([-4, -2, 0, 2, 4, 6]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
});

describe("short numbers", () => {
  it("drops cents from whole amounts and goes compact from 10,000", () => {
    expect(shortNumber(1450, "usd", "en")).toBe("$1,450");
    expect(shortNumber(99.5, "usd", "en")).toBe("$99.50");
    expect(shortNumber(28430, "usd", "en")).toBe("$28.4K");
    expect(shortNumber(0, "usd", "en")).toBe("$0");
    expect(shortNumber(12000, "number", "en")).toBe("12K");
    expect(shortNumber(5000, "number", "en", 1000)).toBe("5K");
    expect(shortNumber(0.42, "percent", "en")).toMatch(/^42\s?%$/);
  });
});
