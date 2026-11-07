import { describe, expect, it } from "vitest";
import { inboxSections, isInboxSection, parseInboxKey, setInboxSection } from "./inboxSections";
import { entryKey, moveEntry, reorderEntries, sidebarEntries, visibleEntries } from "./ownSections";
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

  it("is a section among the others: placed after the entry before it, moved and hidden like them", () => {
    const p = { ...base(), order: ["mailbox:z", "favorites", "inbox", "mailbox:a", "mailbox:b", "mail", "views", "team:t"] };
    expect(sidebarEntries(p).map(entryKey)).toEqual(["mailbox:z", "favorites", "inbox", "mailbox:a", "mailbox:b", "mail", "teams", "views", "team:t", "pages", "workspace"]);
    // Mail hidden: the inboxes after it still follow Tickets.
    expect(visibleEntries({ ...p, hidden: ["section:mail"] }).map(entryKey).slice(1, 5)).toEqual(["favorites", "inbox", "mailbox:a", "mailbox:b"]);
    expect(visibleEntries({ ...p, hidden: ["section:mailbox:a"] }).map(entryKey)).not.toContain("mailbox:a");
    // Moving any section keeps the inbox sections where they are.
    const moved = moveEntry(p, "views", -1);
    expect(sidebarEntries(moved).map(entryKey)).toEqual(["mailbox:z", "favorites", "inbox", "mailbox:a", "mailbox:b", "mail", "views", "teams", "team:t", "pages", "workspace"]);
    expect(sidebarEntries(moveEntry(p, "mailbox:a", -1)).map(entryKey).slice(1, 5)).toEqual(["favorites", "mailbox:a", "inbox", "mailbox:b"]);
    expect(sidebarEntries(reorderEntries(p, ["team:t", "favorites"])).map(entryKey).slice(0, 2)).toEqual(["team:t", "favorites"]);
  });
});
