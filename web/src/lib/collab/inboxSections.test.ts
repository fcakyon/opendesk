import { describe, expect, it } from "vitest";
import { inboxSections, isInboxSection, moveInboxSection, parseInboxKey, placeInboxSections, setInboxSection } from "./inboxSections";
import { defaultSidebarPrefs } from "./sidebarPrefs";

const base = () => ({ ...defaultSidebarPrefs(), order: ["favorites", "inbox", "mail", "teams", "views", "pages", "workspace"] });

describe("inbox sections", () => {
  it("reads only mailbox and team entries", () => {
    expect(parseInboxKey("mailbox:m1")).toEqual({ kind: "mailbox", id: "m1" });
    expect(parseInboxKey("team:mine")).toEqual({ kind: "team", id: "mine" });
    expect(parseInboxKey("custom:x")).toBeNull();
    expect(parseInboxKey("inbox")).toBeNull();
    expect(parseInboxKey("mailbox:")).toBeNull();
  });

  it("puts a mailbox after Tickets, then after the last one, and takes it back out", () => {
    let p = setInboxSection(base(), { kind: "mailbox", id: "a" }, true);
    expect(p.order.slice(0, 4)).toEqual(["favorites", "inbox", "mailbox:a", "mail"]);
    p = setInboxSection(p, { kind: "mailbox", id: "b" }, true);
    expect(p.order.slice(1, 5)).toEqual(["inbox", "mailbox:a", "mailbox:b", "mail"]);
    p = setInboxSection(p, { kind: "team", id: "t" }, true);
    expect(p.order.indexOf("team:t")).toBe(p.order.indexOf("teams") + 1);
    expect(inboxSections(p).map((s) => s.id)).toEqual(["a", "b", "t"]);
    expect(setInboxSection(p, { kind: "mailbox", id: "a" }, true)).toBe(p);
    p = setInboxSection(p, { kind: "mailbox", id: "a" }, false);
    expect(isInboxSection(p, { kind: "mailbox", id: "a" })).toBe(false);
    expect(isInboxSection(p, { kind: "mailbox", id: "b" })).toBe(true);
  });

  it("places each section after the nearest one before it that shows", () => {
    const order = ["mailbox:z", "favorites", "inbox", "mailbox:a", "mailbox:b", "mail", "views", "team:t"];
    // Mail is hidden: team:t follows Views; mailbox:z had nothing before it and goes first.
    expect(placeInboxSections(order, ["favorites", "inbox", "views"], ["mailbox:z", "mailbox:a", "mailbox:b", "team:t"])).toEqual([
      "mailbox:z",
      "favorites",
      "inbox",
      "mailbox:a",
      "mailbox:b",
      "views",
      "team:t",
    ]);
  });

  it("moves a section past its neighbours", () => {
    const p = { ...base(), order: ["favorites", "inbox", "mailbox:a", "mail"] };
    const shown = ["favorites", "inbox", "mailbox:a", "mail"];
    expect(moveInboxSection(p, "mailbox:a", -1, shown).order).toEqual(["favorites", "mailbox:a", "inbox", "mail"]);
    expect(moveInboxSection(p, "mailbox:a", 1, shown).order).toEqual(["favorites", "inbox", "mail", "mailbox:a"]);
    expect(moveInboxSection(p, "favorites", -1, shown)).toBe(p);
  });
});
