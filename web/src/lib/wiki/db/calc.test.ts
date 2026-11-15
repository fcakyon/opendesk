import { describe, expect, it } from "vitest";
import type { DbCalc, DbProperty } from "../../api/types";
import { CALCS_FOR, calcsFor, calculate, rollup } from "./calc";
import { context, tasks, tasksDb, withProps } from "./fixtures";

const ctx = context();
const prop = (id: string) => tasksDb.properties.find((p) => p.id === id) as DbProperty;
const calc = (id: string, c: DbCalc) => calculate(tasks, prop(id), c, ctx);

describe("calculations", () => {
  it("count rows and values", () => {
    expect(calc("title", "count")).toBe("4");
    expect(calc("tags", "count_values")).toBe("4");
    expect(calc("tags", "count_unique")).toBe("3");
    expect(calc("owner", "count_unique")).toBe("2");
    expect(calc("points", "count_empty")).toBe("1");
    expect(calc("points", "count_not_empty")).toBe("3");
    expect(calc("priority", "percent_empty")).toBe("25%");
    expect(calc("notes", "percent_not_empty")).toBe("25%");
    expect(calc("title", "none")).toBe("");
  });

  it("sum numbers in their format", () => {
    expect(calc("points", "sum")).toBe("12");
    expect(calc("price", "sum")).toBe("$1,349.50");
    expect(calc("points", "avg")).toBe("4");
    expect(calc("points", "median")).toBe("3");
    expect(calc("points", "min")).toBe("1");
    expect(calc("points", "max")).toBe("8");
    expect(calc("points", "range")).toBe("7");
  });

  it("sum dates up as dates and lengths of time", () => {
    expect(calc("due", "earliest")).toBe("Oct 20, 2026");
    expect(calc("due", "latest")).toBe("Oct 30, 2026");
    expect(calc("due", "range")).toBe("10 days");
    expect(calc("created", "range")).toBe("24 days");
  });

  it("count checkboxes", () => {
    expect(calc("done", "checked")).toBe("1");
    expect(calc("done", "unchecked")).toBe("3");
    expect(calc("done", "percent_checked")).toBe("25%");
  });

  it("offer what fits the type, a formula's by its results", () => {
    expect(CALCS_FOR.checkbox).toEqual(["none", "count", "checked", "unchecked", "percent_checked"]);
    expect(CALCS_FOR.number).toContain("median");
    expect(CALCS_FOR.text).not.toContain("sum");
    expect(CALCS_FOR.date).toContain("earliest");
    const db = withProps({ id: "dbl", name: "Double", type: "formula", formula: 'prop("Points") * 2' });
    const dbl = db.properties.find((p) => p.id === "dbl")!;
    const c = context(db);
    expect(calcsFor(dbl, tasks, c)).toEqual(CALCS_FOR.number);
    expect(calculate(tasks, dbl, "sum", c)).toBe("24");
  });

  it("are empty where nothing can be summed", () => {
    expect(calculate([], prop("points"), "avg", ctx)).toBe("");
    expect(calculate([], prop("points"), "sum", ctx)).toBe("0");
    expect(calculate([], prop("done"), "percent_checked", ctx)).toBe("0%");
  });
});

describe("rollup()", () => {
  it("sums up plain values", () => {
    expect(rollup([1, 2, null, 4], "sum")).toBe(7);
    expect(rollup([1, 2, null, 4], "count")).toBe(4);
    expect(rollup([1, 2, null, 4], "count_values")).toBe(3);
    expect(rollup([3, 1, 2, 10], "median")).toBe(2.5);
    expect(rollup([true, false, true, true], "percent_checked")).toBe(0.75);
    expect(rollup([new Date(2026, 0, 2), new Date(2026, 0, 1)], "earliest")).toEqual(new Date(2026, 0, 1));
    expect(rollup(["a", "b"], "avg")).toBeNull();
    expect(rollup([["a", "b"], ["b"], []], "count_unique")).toBe(2);
  });
});
