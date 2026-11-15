import { describe, expect, it } from "vitest";
import type { DbProperty } from "../../api/types";
import { context, tasks, withProps } from "./fixtures";
import { evaluateFormula, isFormulaError, parseFormula, type FormulaResult } from "./formula";
import { cellText, cellValue } from "./values";

const ctx = context();
const t = (id: string) => tasks.find((r) => r.id === id)!;
const ev = (src: string, rowId = "t1") => evaluateFormula(src, t(rowId), ctx);
const err = (r: FormulaResult) => (isFormulaError(r) ? r.error : null);
const formula = (id: string, name: string, src: string): DbProperty => ({ id, name, type: "formula", formula: src });

describe("formula arithmetic and logic", () => {
  it("follows operator precedence", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("10 % 4 + 7 / 2")).toBe(5.5);
    expect(ev("2 * -3")).toBe(-6);
    expect(ev("1.5e2")).toBe(150);
  });

  it("leaves a division by zero empty", () => {
    expect(ev("1 / 0")).toBeNull();
    expect(ev("mod(5, 0)")).toBeNull();
  });

  it("compares and combines", () => {
    expect(ev("1 < 2 and not (3 == 4)")).toBe(true);
    expect(ev("true || false && false")).toBe(true);
    expect(ev("!true")).toBe(false);
    expect(ev("not 1 == 2")).toBe(true);
    expect(ev('"a" != "b" && 2 >= 2 && 3 <= 2')).toBe(false);
    expect(ev("2 > 1 ? \"yes\" : \"no\"")).toBe("yes");
    expect(ev("false ? 1 : true ? 2 : 3")).toBe(2);
  });

  it("joins text with +", () => {
    expect(ev('"Task " + 1 + "!"')).toBe("Task 1!");
    expect(ev('"a" + true')).toBe("atrue");
  });
});

describe("prop()", () => {
  it("reads properties by name", () => {
    expect(ev('prop("Points") * 2')).toBe(6);
    expect(ev('prop("points") + 1')).toBe(4);
    expect(ev('prop("Status")')).toBe("In progress");
    expect(ev('prop("Name") + " (" + prop("Priority") + ")"')).toBe("Fix login (High)");
    expect(ev('prop("Done")')).toBe(false);
    expect(ev('prop("ID")')).toBe(1);
    expect(ev('prop("Created by")')).toBe("Ann Lee");
  });

  it("reads lists as lists", () => {
    expect(ev('prop("Tags")', "t2")).toBe("Docs, Feature");
    expect(ev('length(prop("Tags"))', "t2")).toBe(2);
    expect(ev('contains(prop("Tags"), "Docs")', "t2")).toBe(true);
    expect(ev('join(prop("Owner"), " & ")', "t3")).toBe("Ann Lee & Bob Ito");
    expect(ev('prop("Project")')).toBe("Website");
  });

  it("counts an empty number as 0 and empty text as nothing", () => {
    expect(ev('prop("Points") + 1', "t4")).toBe(1);
    expect(ev('empty(prop("Points"))', "t4")).toBe(true);
    expect(ev('empty(prop("Notes"))', "t4")).toBe(true);
    expect(ev('prop("Notes") + "!"', "t4")).toBe("!");
  });

  it("refuses a property that doesn't exist", () => {
    expect(err(ev('prop("Nope")'))).toBe('There\'s no property named "Nope".');
  });
});

describe("formula functions", () => {
  it("work on text", () => {
    expect(ev('concat("a", "b", "c")')).toBe("abc");
    expect(ev('join(", ", "a", "b")')).toBe("a, b");
    expect(ev('contains("Fix login", "log")')).toBe(true);
    expect(ev('replace("a-b-c", "-", "+")')).toBe("a+b-c");
    expect(ev('replaceAll("a-b-c", "[-]", "+")')).toBe("a+b+c");
    expect(ev('replaceAll("2026-10-26", "(\\\\d+)-(\\\\d+)-(\\\\d+)", "$3.$2.$1")')).toBe("26.10.2026");
    expect(ev('lower("ABC") + upper("def") + trim("  x  ")')).toBe("abcDEFx");
    expect(ev('slice("opendesk", 4)')).toBe("desk");
    expect(ev('slice("opendesk", 0, 4)')).toBe("open");
    expect(ev('test("TASK-12", "^TASK-\\\\d+$")')).toBe(true);
    expect(ev('length("héllo")')).toBe(5);
    expect(ev("format(0.1 + 0.2)")).toBe("0.3");
    expect(ev('toNumber("42") + toNumber(true)')).toBe(43);
    expect(ev('toNumber("abc")')).toBeNull();
  });

  it("chain as methods", () => {
    expect(ev('prop("Name").upper()')).toBe("FIX LOGIN");
    expect(ev('prop("Tags").length()', "t2")).toBe(2);
  });

  it("work on numbers", () => {
    expect(ev("round(2.345, 2)")).toBe(2.35);
    expect(ev("round(2.5)")).toBe(3);
    expect(ev("floor(2.7) + ceil(2.1) + abs(-1)")).toBe(6);
    expect(ev("sqrt(16)")).toBe(4);
    expect(ev("sqrt(-1)")).toBeNull();
    expect(ev("min(4, 2, 8) + max(4, 2, 8)")).toBe(10);
    expect(ev("sum(1, 2, 3)")).toBe(6);
    expect(ev("pow(2, 10)")).toBe(1024);
    expect(ev("mod(7, 3)")).toBe(1);
  });

  it("choose with if and ifs", () => {
    expect(ev('if(prop("Points") > 2, "big", "small")')).toBe("big");
    expect(ev('if(prop("Points") > 2, "big", "small")', "t2")).toBe("small");
    const size = 'ifs(prop("Points") >= 5, "L", prop("Points") >= 2, "M", "S")';
    expect(["t1", "t2", "t3"].map((id) => ev(size, id))).toEqual(["M", "S", "L"]);
    expect(ev("ifs(false, 1)")).toBeNull();
    // Only the branch taken runs.
    expect(ev('if(true, 1, prop("Nope"))')).toBe(1);
  });

  it("name values with let", () => {
    expect(ev('let(x, prop("Points"), x * x)')).toBe(9);
    expect(ev("lets(a, 2, b, a + 1, a * b)")).toBe(6);
    expect(err(ev("x + 1"))).toContain('"x" isn\'t known');
  });
});

describe("formula dates", () => {
  it("adds and subtracts", () => {
    expect(ev('formatDate(dateAdd(prop("Due"), 1, "months"), "yyyy-MM-dd")')).toBe("2026-11-26");
    expect(ev('formatDate(dateSubtract(prop("Due"), 2, "weeks"), "yyyy-MM-dd")')).toBe("2026-10-12");
    expect(ev('formatDate(dateAdd(prop("Due"), 1, "quarter"), "yyyy-MM-dd")')).toBe("2027-01-26");
    expect(ev('formatDate(dateAdd(now(), 90, "minutes"), "HH:mm")')).toBe("13:30");
  });

  it("measures between dates", () => {
    expect(ev('dateBetween(prop("Due"), today(), "days")', "t2")).toBe(4);
    expect(ev('dateBetween(today(), prop("Due"), "days")', "t3")).toBe(6);
    expect(ev('dateBetween(parseDate("2027-03-01"), today(), "months")')).toBe(4);
    expect(err(ev('dateBetween(today(), today(), "fortnights")'))).toContain("takes a unit");
  });

  it("reads parts of dates", () => {
    expect(ev("year(today()) * 100 + month(today())")).toBe(202610);
    expect(ev("date(today())")).toBe(26);
    expect(ev("day(today())")).toBe(1);
    expect(ev("hour(now()) + minute(now())")).toBe(12);
    expect(ev("fromTimestamp(timestamp(now())) == now()")).toBe(true);
    expect(ev('formatDate(now(), "yyyy-MM-dd HH:mm")')).toBe("2026-10-26 12:00");
    expect(ev("formatDate(today())")).toBe("Oct 26, 2026");
  });

  it("reads the start and end of a range", () => {
    expect(ev('formatDate(start(prop("Due")), "d MMM")', "t3")).toBe("20 Oct");
    expect(ev('formatDate(end(prop("Due")), "d MMM")', "t3")).toBe("27 Oct");
    expect(ev('end(prop("Due")) == start(prop("Due"))')).toBe(true);
    expect(ev('prop("Due")', "t3")).toEqual({ start: new Date(2026, 9, 20), end: new Date(2026, 9, 27), time: false });
  });

  it("leaves dates of empty values empty", () => {
    expect(ev('dateAdd(prop("Due"), 1, "days")', "t4")).toBeNull();
    expect(ev('formatDate(prop("Due"), "yyyy")', "t4")).toBe("");
  });

  it("compares dates", () => {
    expect(ev('prop("Due") < today()', "t3")).toBe(true);
    expect(ev('prop("Due") > today()', "t2")).toBe(true);
  });
});

describe("formula errors", () => {
  it("point at the mistake", () => {
    expect(parseFormula("1 +")).toEqual({ ok: false, error: "The formula ends too soon.", at: 3 });
    expect(parseFormula('"open')).toMatchObject({ ok: false, at: 0 });
    expect(parseFormula("1 2")).toMatchObject({ ok: false, at: 2 });
    expect(parseFormula("(1 + 2")).toMatchObject({ ok: false, error: 'A ")" is missing at the end.' });
    expect(parseFormula("1 # 2")).toMatchObject({ ok: false, at: 2 });
    expect(parseFormula("x".repeat(4001))).toMatchObject({ ok: false });
    expect(parseFormula("(".repeat(150) + "1" + ")".repeat(150))).toMatchObject({ ok: false, error: "This formula nests too deeply." });
  });

  it("come back as values, never thrown", () => {
    expect(err(ev("1 +"))).toBe("The formula ends too soon.");
    expect(err(ev("nope(1)"))).toBe("There's no function named nope().");
    expect(err(ev("toString(1)"))).toBe("There's no function named toString().");
    expect(err(ev("if(true, 1)"))).toBe("if() takes 3 arguments.");
    expect(err(ev('1 - "a"'))).toBe("Can't use - on number and text.");
    expect(err(ev('round("a")'))).toContain("round() takes a number");
    expect(err(ev('1 < "a"'))).toBe("Can't compare number with text.");
    expect(err(ev('test("a", "(")'))).toBe('"(" isn\'t a valid pattern.');
    expect(err(ev('formatDate(now(), "Do YYYY")'))).toContain("isn't a date pattern");
  });

  it("let formulas read other formulas, but not themselves", () => {
    const db = withProps(
      formula("double", "Double", 'prop("Points") * 2'),
      formula("more", "More", 'prop("Double") + 1'),
      formula("a", "A", 'prop("B") + 1'),
      formula("b", "B", 'prop("A") + 1'),
      formula("self", "Self", 'prop("Self")'),
      formula("broken", "Broken", "1 +"),
      formula("uses_broken", "Uses broken", 'prop("Broken")'),
    );
    const c = context(db);
    const f = (id: string) => db.properties.find((p) => p.id === id)!;
    expect(cellValue(t("t1"), f("more"), c)).toBe(7);
    expect(cellText(cellValue(t("t1"), f("more"), c), f("more"), c)).toBe("7");
    expect(evaluateFormula(f("a").formula!, t("t1"), c)).toMatchObject({ error: expect.stringContaining("refers to itself") });
    expect(cellValue(t("t1"), f("a"), c)).toBeNull();
    expect(cellValue(t("t1"), f("self"), c)).toBeNull();
    expect(evaluateFormula('prop("Uses broken")', t("t1"), c)).toMatchObject({ error: expect.stringContaining('The formula of "Broken" has a mistake') });
  });

  it("give an empty formula no value", () => {
    expect(ev("")).toBeNull();
    expect(ev("   ")).toBeNull();
  });
});
