// A formula property's language, close to Notion's: prop("Name") reads another property
// by its name, with operators, if/ifs, text, number and date functions, and let.
// Parsing never throws; evaluating never throws either: a mistake comes back as { error }.

import {
  add,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInMonths,
  differenceInQuarters,
  differenceInWeeks,
  differenceInYears,
  format as formatDateFns,
  getISODay,
  getISOWeek,
  isValid,
  parseISO,
  startOfDay,
} from "date-fns";
import type { DbProperty, DbRow } from "../../api/types";
import { isDateRange, type DateRange } from "./cell";
import type { DbContext } from "./context";
import { formatDate } from "./format";
import { guarded } from "./guard";
import { cellTexts, cellValue } from "./values";

export const MAX_FORMULA_LENGTH = 4000;
const MAX_DEPTH = 100;
const MAX_STEPS = 100_000;
const MAX_TEXT = 100_000;
const MAX_PATTERN = 500;

/** What a formula gives: a date range when it reads one; lists come back as text. */
export type FormulaResult = string | number | boolean | Date | DateRange | null | { error: string };

export function isFormulaError(r: FormulaResult): r is { error: string } {
  return typeof r === "object" && r !== null && "error" in r;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | ">" | "<" | ">=" | "<=" | "and" | "or";

export type FormulaAst =
  | { k: "lit"; v: string | number | boolean | null; at: number }
  | { k: "name"; name: string; at: number }
  | { k: "unary"; op: "-" | "not"; x: FormulaAst; at: number }
  | { k: "binary"; op: BinaryOp; a: FormulaAst; b: FormulaAst; at: number }
  | { k: "cond"; test: FormulaAst; then: FormulaAst; else: FormulaAst; at: number }
  | { k: "call"; fn: string; args: FormulaAst[]; at: number };

export type ParseResult = { ok: true; ast: FormulaAst } | { ok: false; error: string; at: number };

type Token = { t: "num"; v: number; at: number } | { t: "str"; v: string; at: number } | { t: "id"; v: string; at: number } | { t: "op"; v: string; at: number } | { t: "end"; at: number };

class ParseError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", "^", ">", "<", "!", "?", ":", "(", ")", ",", "."];
// Closing quote for each opening one: curly quotes arrive when a formula is pasted from a document.
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i, i + 400));
    if (num) {
      out.push({ t: "num", v: Number(num[0]), at });
      i += num[0].length;
      continue;
    }
    const close = QUOTES[c];
    if (close) {
      let s = "";
      i++;
      while (i < src.length && src[i] !== close) {
        if (src[i] === "\\" && i + 1 < src.length) {
          i++;
          s += ESCAPES[src[i]] ?? src[i];
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new ParseError("This text has no closing quote.", at);
      i++;
      out.push({ t: "str", v: s, at });
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i, i + 200));
    if (id) {
      out.push({ t: "id", v: id[0], at });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ParseError(`"${c}" isn't part of a formula.`, at);
    out.push({ t: "op", v: op, at });
    i += op.length;
  }
  out.push({ t: "end", at: src.length });
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i];
  }
  private next(): Token {
    return this.toks[this.i++];
  }
  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t.t === "op" && ops.includes(t.v);
  }
  private isWord(...words: string[]): boolean {
    const t = this.peek();
    return t.t === "id" && words.includes(t.v);
  }
  private expect(op: string): void {
    const t = this.peek();
    if (t.t !== "op" || t.v !== op) throw new ParseError(t.t === "end" ? `A "${op}" is missing at the end.` : `Expected "${op}" here.`, t.at);
    this.i++;
  }
  private nest<T>(at: number, run: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ParseError("This formula nests too deeply.", at);
    try {
      return run();
    } finally {
      this.depth--;
    }
  }

  parse(): FormulaAst {
    if (this.peek().t === "end") return { k: "lit", v: null, at: 0 };
    const ast = this.expr();
    const t = this.peek();
    if (t.t !== "end") throw new ParseError("Unexpected text here: is an operator or a comma missing?", t.at);
    return ast;
  }

  private expr(): FormulaAst {
    return this.nest(this.peek().at, () => this.ternary());
  }

  private ternary(): FormulaAst {
    const test = this.or();
    if (!this.isOp("?")) return test;
    const at = this.next().at;
    const then = this.expr();
    this.expect(":");
    return { k: "cond", test, then, else: this.expr(), at };
  }

  private or(): FormulaAst {
    let a = this.and();
    while (this.isOp("||") || this.isWord("or")) {
      const at = this.next().at;
      a = { k: "binary", op: "or", a, b: this.and(), at };
    }
    return a;
  }

  private and(): FormulaAst {
    let a = this.not();
    while (this.isOp("&&") || this.isWord("and")) {
      const at = this.next().at;
      a = { k: "binary", op: "and", a, b: this.not(), at };
    }
    return a;
  }

  // As in Notion, `not a == b` negates the comparison; `!` reads the same.
  private not(): FormulaAst {
    if (this.isOp("!") || this.isWord("not")) {
      const at = this.next().at;
      return this.nest(at, () => ({ k: "unary", op: "not", x: this.not(), at }));
    }
    return this.comparison();
  }

  private comparison(): FormulaAst {
    let a = this.additive();
    while (this.isOp("==", "!=", ">", "<", ">=", "<=")) {
      const t = this.next() as { v: BinaryOp; at: number };
      a = { k: "binary", op: t.v, a, b: this.additive(), at: t.at };
    }
    return a;
  }

  private additive(): FormulaAst {
    let a = this.multiplicative();
    while (this.isOp("+", "-")) {
      const t = this.next() as { v: BinaryOp; at: number };
      a = { k: "binary", op: t.v, a, b: this.multiplicative(), at: t.at };
    }
    return a;
  }

  private multiplicative(): FormulaAst {
    let a = this.unary();
    while (this.isOp("*", "/", "%")) {
      const t = this.next() as { v: BinaryOp; at: number };
      a = { k: "binary", op: t.v, a, b: this.unary(), at: t.at };
    }
    return a;
  }

  // -2^2 is -(2^2), and 2^3^2 is 2^(3^2), as in maths.
  private unary(): FormulaAst {
    if (this.isOp("-", "+")) {
      const t = this.next();
      const x = this.nest(t.at, () => this.unary());
      return t.t === "op" && t.v === "-" ? { k: "unary", op: "-", x, at: t.at } : x;
    }
    const base = this.postfix();
    if (!this.isOp("^")) return base;
    const at = this.next().at;
    return { k: "binary", op: "^", a: base, b: this.nest(at, () => this.unary()), at };
  }

  // x.fn(a) is fn(x, a), as in Notion's newer formulas.
  private postfix(): FormulaAst {
    let x = this.primary();
    while (this.isOp(".")) {
      this.next();
      const t = this.next();
      if (t.t !== "id") throw new ParseError("A function name goes after a dot.", t.at);
      x = { k: "call", fn: t.v, args: [x, ...this.args()], at: t.at };
    }
    return x;
  }

  private args(): FormulaAst[] {
    this.expect("(");
    const args: FormulaAst[] = [];
    if (this.isOp(")")) {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.expr());
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      this.expect(")");
      return args;
    }
  }

  private primary(): FormulaAst {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { k: "lit", v: t.v, at: t.at };
      case "str":
        return { k: "lit", v: t.v, at: t.at };
      case "id":
        if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true", at: t.at };
        if (this.isOp("(")) return { k: "call", fn: t.v, args: this.args(), at: t.at };
        return { k: "name", name: t.v, at: t.at };
      case "op":
        if (t.v === "(") {
          const x = this.expr();
          this.expect(")");
          return x;
        }
        throw new ParseError(`"${t.v}" can't start a value.`, t.at);
      case "end":
        throw new ParseError("The formula ends too soon.", t.at);
    }
  }
}

export function parseFormula(src: string): ParseResult {
  if (src.length > MAX_FORMULA_LENGTH) return { ok: false, error: `A formula has up to ${MAX_FORMULA_LENGTH} characters.`, at: MAX_FORMULA_LENGTH };
  try {
    return { ok: true, ast: new Parser(tokenize(src)).parse() };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, at: e.at };
    throw e;
  }
}

// Every cell of a formula column parses the same source: keep the trees.
const parsed = new Map<string, ParseResult>();

function parseCached(src: string): ParseResult {
  let r = parsed.get(src);
  if (!r) {
    if (parsed.size >= 500) parsed.clear();
    r = parseFormula(src);
    parsed.set(src, r);
  }
  return r;
}

// ─── Values ─────────────────────────────────────────────────────────────────

/** A value while a formula runs; lists become text at the end. */
type Value = string | number | boolean | Date | DateRange | null | Value[];

class EvalError extends Error {}

function fail(message: string): never {
  throw new EvalError(message);
}

type State = { row: DbRow; ctx: DbContext; budget: { steps: number }; scopes: Map<string, Value>[] };

function isBlank(v: Value): boolean {
  return v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function truthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return !isBlank(v);
}

function capped(s: string): string {
  return s.length > MAX_TEXT ? fail("The text is too long.") : s;
}

function numberText(n: number): string {
  // 0.1 + 0.2 reads 0.3.
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : "";
}

function hasTime(d: Date): boolean {
  return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
}

function toText(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return formatDate(v, hasTime(v));
  if (Array.isArray(v)) return v.map(toText).join(", ");
  const start = formatDate(v.start, v.time);
  return v.end ? `${start} → ${formatDate(v.end, v.time)}` : start;
}

function kindName(v: Value): string {
  if (v === null) return "empty";
  if (v instanceof Date || isDateRange(v)) return "date";
  if (Array.isArray(v)) return "list";
  return typeof v === "string" ? "text" : typeof v === "number" ? "number" : "yes or no";
}

function num(v: Value, fn: string): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  return fail(`${fn}() takes a number, not ${kindName(v)}. toNumber() turns text into a number.`);
}

function date(v: Value, fn: string): Date | null {
  if (v === null || v === "") return null;
  if (v instanceof Date) return v;
  if (isDateRange(v)) return v.start;
  if (typeof v === "string") {
    const d = parseISO(v);
    if (isValid(d)) return d;
  }
  return fail(`${fn}() takes a date, not ${kindName(v)}.`);
}

function same(a: Value, b: Value): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (isDateRange(a) && isDateRange(b)) return a.start.getTime() === b.start.getTime() && a.end?.getTime() === b.end?.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}

function order(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const da = a instanceof Date ? a : isDateRange(a) ? a.start : null;
  const db = b instanceof Date ? b : isDateRange(b) ? b.start : null;
  if (da && db) return da.getTime() - db.getTime();
  return fail(`Can't compare ${kindName(a)} with ${kindName(b)}.`);
}

function arithmetic(op: BinaryOp, a: Value, b: Value): Value {
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return capped(toText(a) + toText(b));
  if (op === "+" && Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  // An empty number counts as 0, as in a spreadsheet.
  const x = a === null ? 0 : a;
  const y = b === null ? 0 : b;
  if (typeof x !== "number" || typeof y !== "number") return fail(`Can't use ${op} on ${kindName(x)} and ${kindName(y)}.`);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    case "%":
      return y === 0 ? null : x % y;
    default: {
      const p = x ** y;
      return Number.isFinite(p) ? p : null;
    }
  }
}

// ─── Reading properties ─────────────────────────────────────────────────────

function findProp(ctx: DbContext, name: string): DbProperty {
  const props = ctx.db.properties;
  const p = props.find((x) => x.name === name) ?? props.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return p ?? fail(`There's no property named "${name}".`);
}

function readProp(prop: DbProperty, s: State): Value {
  if (prop.type === "formula") {
    return guarded(
      `${s.row.id}:${prop.id}`,
      () => {
        const p = parseCached(prop.formula ?? "");
        if (!p.ok) return fail(`The formula of "${prop.name}" has a mistake: ${p.error}`);
        return evalNode(p.ast, { ...s, scopes: [] });
      },
      () => fail(`"${prop.name}" refers to itself through other formulas.`),
    );
  }
  const v = cellValue(s.row, prop, s.ctx);
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof v === "string" ? v : "";
    case "select":
    case "status":
      return cellTexts(v, prop, s.ctx)[0] ?? "";
    case "created_by":
    case "edited_by":
      return cellTexts(v, prop, s.ctx)[0] ?? null;
    case "multi_select":
    case "person":
    case "relation":
    case "ticket":
    case "files":
      return cellTexts(v, prop, s.ctx);
    case "date":
      return isDateRange(v) && !v.end ? v.start : (v as DateRange | null);
    default:
      // number, unique_id, checkbox, created/edited time, rollup.
      return v as Value;
  }
}

// ─── Evaluating ─────────────────────────────────────────────────────────────

function evalNode(n: FormulaAst, s: State): Value {
  if (++s.budget.steps > MAX_STEPS) fail("This formula takes too many steps.");
  switch (n.k) {
    case "lit":
      return n.v;
    case "name":
      for (let i = s.scopes.length - 1; i >= 0; i--) if (s.scopes[i].has(n.name)) return s.scopes[i].get(n.name) as Value;
      return fail(`"${n.name}" isn't known here. Write text in quotes, and properties as prop("${n.name}").`);
    case "unary": {
      const x = evalNode(n.x, s);
      if (n.op === "not") return !truthy(x);
      const v = num(x, "-");
      return v === null ? null : -v;
    }
    case "cond":
      return truthy(evalNode(n.test, s)) ? evalNode(n.then, s) : evalNode(n.else, s);
    case "binary": {
      if (n.op === "and") return truthy(evalNode(n.a, s)) && truthy(evalNode(n.b, s));
      if (n.op === "or") return truthy(evalNode(n.a, s)) || truthy(evalNode(n.b, s));
      const a = evalNode(n.a, s);
      const b = evalNode(n.b, s);
      switch (n.op) {
        case "==":
          return same(a, b);
        case "!=":
          return !same(a, b);
        case ">":
        case "<":
        case ">=":
        case "<=": {
          const c = order(a, b);
          if (c === null) return false;
          return n.op === ">" ? c > 0 : n.op === "<" ? c < 0 : n.op === ">=" ? c >= 0 : c <= 0;
        }
        default:
          return arithmetic(n.op, a, b);
      }
    }
    case "call":
      return call(n, s);
  }
}

function letName(n: FormulaAst, fn: string): string {
  return n.k === "name" ? n.name : fail(`${fn}() takes a name first, without quotes.`);
}

function call(n: Extract<FormulaAst, { k: "call" }>, s: State): Value {
  const { fn: name, args } = n;
  switch (name) {
    // These read their arguments only as needed.
    case "if":
      arity(name, args, 3, 3);
      return truthy(evalNode(args[0], s)) ? evalNode(args[1], s) : evalNode(args[2], s);
    case "ifs": {
      arity(name, args, 2, Infinity);
      for (let i = 0; i + 1 < args.length; i += 2) if (truthy(evalNode(args[i], s))) return evalNode(args[i + 1], s);
      return args.length % 2 ? evalNode(args[args.length - 1], s) : null;
    }
    case "and":
      return args.every((a) => truthy(evalNode(a, s)));
    case "or":
      return args.some((a) => truthy(evalNode(a, s)));
    case "let":
    case "lets": {
      arity(name, args, 3, Infinity);
      if (args.length % 2 === 0) fail(`${name}() takes names and values in pairs, then the result.`);
      const scope = new Map<string, Value>();
      const inner = { ...s, scopes: [...s.scopes, scope] };
      for (let i = 0; i + 1 < args.length; i += 2) scope.set(letName(args[i], name), evalNode(args[i + 1], inner));
      return evalNode(args[args.length - 1], inner);
    }
  }
  const f = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (!f) return fail(`There's no function named ${name}().`);
  arity(name, args, f.min, f.max);
  return f.run(
    args.map((a) => evalNode(a, s)),
    s,
  );
}

function arity(name: string, args: FormulaAst[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    fail(min === max ? `${name}() takes ${min} argument${min === 1 ? "" : "s"}.` : args.length < min ? `${name}() takes at least ${min} arguments.` : `${name}() takes at most ${max} arguments.`);
  }
}

// ─── Functions ──────────────────────────────────────────────────────────────

type Fn = { min: number; max: number; run: (args: Value[], s: State) => Value };

const fn = (min: number, max: number, run: Fn["run"]): Fn => ({ min, max, run });
const math = (name: string, f: (n: number) => number): Fn =>
  fn(1, 1, ([x]) => {
    const v = num(x, name);
    if (v === null) return null;
    const r = f(v);
    return Number.isFinite(r) ? r : null;
  });

function regex(pattern: Value, flags: string): RegExp {
  const p = toText(pattern);
  if (p.length > MAX_PATTERN) fail("The pattern is too long.");
  try {
    return new RegExp(p, flags);
  } catch {
    return fail(`"${p}" isn't a valid pattern.`);
  }
}

function flat(values: Value[]): Value[] {
  return values.flatMap((v) => (Array.isArray(v) ? flat(v) : [v]));
}

function numbersOf(args: Value[], name: string): number[] {
  return flat(args).flatMap((v) => {
    const n = num(v, name);
    return n === null ? [] : [n];
  });
}

type Unit = "years" | "quarters" | "months" | "weeks" | "days" | "hours" | "minutes";
const UNITS: Unit[] = ["years", "quarters", "months", "weeks", "days", "hours", "minutes"];

function unit(v: Value, name: string): Unit {
  const u = toText(v).trim().toLowerCase();
  const found = UNITS.find((x) => x === u || x === `${u}s`);
  return found ?? fail(`${name}() takes a unit: ${UNITS.join(", ")}.`);
}

function shift(d: Date, n: number, u: Unit): Date {
  return u === "quarters" ? add(d, { months: 3 * n }) : add(d, { [u]: n });
}

const BETWEEN: Record<Unit, (a: Date, b: Date) => number> = {
  years: differenceInYears,
  quarters: differenceInQuarters,
  months: differenceInMonths,
  weeks: differenceInWeeks,
  days: differenceInDays,
  hours: differenceInHours,
  minutes: differenceInMinutes,
};

function dateFn(name: string, f: (d: Date) => Value): Fn {
  return fn(1, 1, ([x]) => {
    const d = date(x, name);
    return d ? f(d) : null;
  });
}

function sliceOf(x: Value, start: number, end: number | undefined): Value {
  if (Array.isArray(x)) return x.slice(start, end);
  return Array.from(toText(x)).slice(start, end).join("");
}

const FUNCTIONS: Record<string, Fn> = {
  prop: fn(1, 1, ([name], s) => readProp(findProp(s.ctx, toText(name)), s)),
  empty: fn(0, 1, (args) => (args.length ? isBlank(args[0]) || args[0] === 0 : null)),
  length: fn(1, 1, ([x]) => (Array.isArray(x) ? x.length : x === null ? 0 : typeof x === "string" ? Array.from(x).length : fail("length() takes text or a list."))),
  format: fn(1, 1, ([x]) => toText(x)),
  concat: fn(1, Infinity, (args) => (args.every(Array.isArray) ? args.flat() : capped(args.map(toText).join("")))),
  // join(list, separator), or the older join(separator, values…).
  join: fn(1, Infinity, (args) => {
    const [first, ...rest] = args;
    if (Array.isArray(first)) return capped(first.map(toText).join(rest.length ? toText(rest[0]) : ""));
    return capped(rest.map(toText).join(toText(first)));
  }),
  contains: fn(2, 2, ([x, y]) => {
    if (Array.isArray(x)) return x.some((v) => same(v, y) || (typeof v === "string" && v === toText(y)));
    return toText(x).includes(toText(y));
  }),
  replace: fn(3, 3, ([x, p, r]) => capped(toText(x).replace(regex(p, ""), toText(r)))),
  replaceAll: fn(3, 3, ([x, p, r]) => capped(toText(x).replace(regex(p, "g"), toText(r)))),
  test: fn(2, 2, ([x, p]) => regex(p, "").test(toText(x))),
  lower: fn(1, 1, ([x]) => toText(x).toLowerCase()),
  upper: fn(1, 1, ([x]) => toText(x).toUpperCase()),
  trim: fn(1, 1, ([x]) => toText(x).trim()),
  slice: fn(2, 3, ([x, a, b]) => sliceOf(x, num(a, "slice") ?? 0, b === undefined ? undefined : (num(b, "slice") ?? undefined))),
  toNumber: fn(1, 1, ([x]) => {
    if (x === null || typeof x === "number") return x;
    if (typeof x === "boolean") return x ? 1 : 0;
    if (x instanceof Date) return x.getTime();
    if (isDateRange(x)) return x.start.getTime();
    const t = toText(x).trim();
    const n = t === "" ? NaN : Number(t);
    return Number.isFinite(n) ? n : null;
  }),
  round: fn(1, 2, ([x, places]) => {
    const v = num(x, "round");
    if (v === null) return null;
    const f = 10 ** Math.max(0, Math.min(10, Math.trunc(num(places ?? 0, "round") ?? 0)));
    return Math.round(v * f) / f;
  }),
  floor: math("floor", Math.floor),
  ceil: math("ceil", Math.ceil),
  abs: math("abs", Math.abs),
  sqrt: math("sqrt", Math.sqrt),
  sign: math("sign", Math.sign),
  ln: math("ln", Math.log),
  log10: math("log10", Math.log10),
  exp: math("exp", Math.exp),
  min: fn(1, Infinity, (args) => {
    const ns = numbersOf(args, "min");
    return ns.length ? Math.min(...ns) : null;
  }),
  max: fn(1, Infinity, (args) => {
    const ns = numbersOf(args, "max");
    return ns.length ? Math.max(...ns) : null;
  }),
  sum: fn(1, Infinity, (args) => numbersOf(args, "sum").reduce((a, b) => a + b, 0)),
  mod: fn(2, 2, ([a, b]) => arithmetic("%", num(a, "mod"), num(b, "mod"))),
  pow: fn(2, 2, ([a, b]) => arithmetic("^", num(a, "pow"), num(b, "pow"))),
  pi: fn(0, 0, () => Math.PI),
  e: fn(0, 0, () => Math.E),
  now: fn(0, 0, (_, s) => new Date(s.ctx.now)),
  today: fn(0, 0, (_, s) => startOfDay(s.ctx.now)),
  dateAdd: fn(3, 3, ([d, n, u]) => {
    const v = date(d, "dateAdd");
    const by = num(n, "dateAdd");
    return v && by !== null ? shift(v, by, unit(u, "dateAdd")) : null;
  }),
  dateSubtract: fn(3, 3, ([d, n, u]) => {
    const v = date(d, "dateSubtract");
    const by = num(n, "dateSubtract");
    return v && by !== null ? shift(v, -by, unit(u, "dateSubtract")) : null;
  }),
  // How many whole units a is after b.
  dateBetween: fn(3, 3, ([a, b, u]) => {
    const x = date(a, "dateBetween");
    const y = date(b, "dateBetween");
    return x && y ? BETWEEN[unit(u, "dateBetween")](x, y) : null;
  }),
  dateRange: fn(2, 2, ([a, b]) => {
    const x = date(a, "dateRange");
    const y = date(b, "dateRange");
    return x && y ? { start: x, end: y, time: hasTime(x) || hasTime(y) } : null;
  }),
  parseDate: fn(1, 1, ([x]) => date(x, "parseDate")),
  // A date pattern of date-fns: "yyyy-MM-dd", "MMMM d, yyyy", "HH:mm".
  formatDate: fn(1, 2, ([d, pattern]) => {
    const v = date(d, "formatDate");
    if (!v) return "";
    if (pattern === undefined) return formatDate(v, hasTime(v));
    const p = toText(pattern);
    if (p.length > MAX_PATTERN) fail("The pattern is too long.");
    try {
      return formatDateFns(v, p);
    } catch {
      return fail(`"${p}" isn't a date pattern: letters stand for parts of a date, and other text goes in single quotes.`);
    }
  }),
  year: dateFn("year", (d) => d.getFullYear()),
  month: dateFn("month", (d) => d.getMonth() + 1),
  // As in Notion: day() is the day of the week, 1 (Monday) to 7 (Sunday); date() the day of the month.
  day: dateFn("day", getISODay),
  date: dateFn("date", (d) => d.getDate()),
  week: dateFn("week", getISOWeek),
  hour: dateFn("hour", (d) => d.getHours()),
  minute: dateFn("minute", (d) => d.getMinutes()),
  timestamp: dateFn("timestamp", (d) => d.getTime()),
  fromTimestamp: fn(1, 1, ([x]) => {
    const v = num(x, "fromTimestamp");
    return v === null ? null : new Date(v);
  }),
  start: fn(1, 1, ([x]) => date(x, "start")),
  end: fn(1, 1, ([x]) => (isDateRange(x) ? (x.end ?? x.start) : date(x, "end"))),
  dateStart: fn(1, 1, ([x]) => date(x, "dateStart")),
  dateEnd: fn(1, 1, ([x]) => (isDateRange(x) ? (x.end ?? x.start) : date(x, "dateEnd"))),
};

/** The functions a formula can call, for the editor's suggestions. */
export const FORMULA_FUNCTIONS: readonly string[] = ["if", "ifs", "and", "or", "let", "lets", ...Object.keys(FUNCTIONS)].sort();

function toResult(v: Value): FormulaResult {
  if (Array.isArray(v)) return toText(v);
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (v instanceof Date && Number.isNaN(v.getTime())) return null;
  return v;
}

/** Works a formula out for a row; a mistake comes back as { error }, never thrown. */
export function evaluateFormula(f: string | FormulaAst, row: DbRow, ctx: DbContext): FormulaResult {
  const p: ParseResult = typeof f === "string" ? parseCached(f) : { ok: true, ast: f };
  if (!p.ok) return { error: p.error };
  try {
    return toResult(evalNode(p.ast, { row, ctx, budget: { steps: 0 }, scopes: [] }));
  } catch (e) {
    if (e instanceof EvalError) return { error: e.message };
    if (e instanceof RangeError) return { error: "This formula nests too deeply." };
    return { error: "This formula can't be worked out." };
  }
}

/** A formula property's value for a row, refusing a formula that reads itself. */
export function evaluateProperty(row: DbRow, prop: DbProperty, ctx: DbContext): FormulaResult {
  return guarded(
    `${row.id}:${prop.id}`,
    () => evaluateFormula(prop.formula ?? "", row, ctx),
    () => ({ error: `"${prop.name}" refers to itself through other formulas.` }),
  );
}
