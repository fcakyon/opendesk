import { describe, expect, it } from "vitest";
import type { DbProperty } from "@/lib/api/types";
import { buttonReady, cleanLabel, cleanPresets, MAX_LABEL, parsePresets, storePresets, type ButtonAttrs } from "./buttons";

const ID = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";
const base: ButtonAttrs = { label: "Go", action: "", template: "", database: "", url: "", title: "", props: "" };

describe("buttonReady", () => {
  it("needs what each action uses", () => {
    expect(buttonReady(base)).toBe(false);
    expect(buttonReady({ ...base, action: "todo" })).toBe(true);
    expect(buttonReady({ ...base, action: "template" })).toBe(false);
    expect(buttonReady({ ...base, action: "template", template: ID })).toBe(true);
    expect(buttonReady({ ...base, action: "row", database: ID })).toBe(true);
    expect(buttonReady({ ...base, action: "link", url: "https://x.example/a" })).toBe(true);
    expect(buttonReady({ ...base, action: "link", url: "http://x.example" })).toBe(false);
    expect(buttonReady({ ...base, action: "link", url: "javascript:alert(1)" })).toBe(false);
  });
});

describe("cleanLabel", () => {
  it("keeps one line of at most the API's length", () => {
    expect(cleanLabel("New\nbug\t!")).toBe("Newbug!");
    expect(cleanLabel("x".repeat(MAX_LABEL + 5))).toHaveLength(MAX_LABEL);
    expect(cleanLabel(null)).toBe("");
  });
});

const props: DbProperty[] = [
  { id: "title", name: "Name", type: "title" },
  { id: "status", name: "Status", type: "status", options: [{ id: "todo", name: "To do", color: "gray" }] },
  { id: "urgent", name: "Urgent", type: "checkbox" },
  { id: "hits", name: "Hits", type: "number" },
  { id: "note", name: "Note", type: "text" },
  { id: "people", name: "People", type: "person" },
];

describe("presets", () => {
  it("keeps the values that fit the database as it is now", () => {
    const raw = JSON.stringify({ status: "todo", urgent: true, hits: 3, note: "hi", people: ["u1"], gone: "x", title: "T" });
    expect(cleanPresets(raw, props)).toEqual({ status: "todo", urgent: true, hits: 3, note: "hi" });
  });
  it("drops a removed option, a value of the wrong type and empty text", () => {
    expect(cleanPresets(JSON.stringify({ status: "done", urgent: "yes", hits: "3", note: "" }), props)).toEqual({});
  });
  it("reads anything but one JSON object as none", () => {
    expect(parsePresets("")).toEqual({});
    expect(parsePresets("[1,2]")).toEqual({});
    expect(parsePresets("{oops")).toEqual({});
    expect(parsePresets(`{"a":"${"x".repeat(2000)}"}`)).toEqual({});
  });
  it("stores only set values, and nothing for none", () => {
    expect(storePresets({ a: 1, b: null, c: "", d: false })).toBe(`{"a":1,"d":false}`);
    expect(storePresets({ a: null })).toBe("");
    expect(storePresets({ a: "x".repeat(2000) })).toBe("");
  });
});
