import { describe, expect, it } from "vitest";
import { FINISHED_DAYS, HOME_MAX, homeConversations, isFinished, sortConversations } from "./conversations";

const NOW = Date.parse("2026-03-10T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const conv = (id: string, status: string, days: number) => ({ id, status, last_message_at: daysAgo(days) });
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("isFinished", () => {
  it("counts solved and closed conversations as finished", () => {
    expect(["open", "pending", "on_hold", "solved", "closed"].map((status) => isFinished({ status }))).toEqual([false, false, false, true, true]);
  });
});

describe("sortConversations", () => {
  it("puts open conversations first, then finished ones, each newest first", () => {
    const list = [conv("done-new", "solved", 1), conv("open-old", "open", 10), conv("done-old", "closed", 5), conv("open-new", "pending", 2)];
    expect(ids(sortConversations(list))).toEqual(["open-new", "open-old", "done-new", "done-old"]);
  });

  it("leaves the list it was given untouched", () => {
    const list = [conv("a", "solved", 1), conv("b", "open", 2)];
    sortConversations(list);
    expect(ids(list)).toEqual(["a", "b"]);
  });
});

describe("homeConversations", () => {
  it(`leaves finished conversations over ${FINISHED_DAYS} days old to the full list, but keeps old open ones`, () => {
    const list = [conv("open-90", "open", 90), conv("done-29", "solved", 29), conv("done-31", "closed", 31)];
    const { shown, hidden } = homeConversations(list, NOW);
    expect(ids(shown)).toEqual(["open-90", "done-29"]);
    expect(hidden).toBe(1);
  });

  it(`shows ${HOME_MAX} at most and counts the rest`, () => {
    const list = Array.from({ length: HOME_MAX + 3 }, (_, i) => conv(`o${i}`, "open", i));
    const { shown, hidden } = homeConversations(list, NOW);
    expect(ids(shown)).toEqual(ids(list.slice(0, HOME_MAX)));
    expect(hidden).toBe(3);
  });

  it("hides nothing when everything fits", () => {
    expect(homeConversations([conv("a", "open", 1), conv("b", "solved", 3)], NOW)).toMatchObject({ hidden: 0 });
    expect(homeConversations([], NOW)).toEqual({ shown: [], hidden: 0 });
  });

  it("treats an unreadable date as very old", () => {
    const { shown, hidden } = homeConversations([{ id: "x", status: "solved", last_message_at: "" }], NOW);
    expect(shown).toEqual([]);
    expect(hidden).toBe(1);
  });
});
