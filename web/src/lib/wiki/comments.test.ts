import { describe, expect, it } from "vitest";
import type { WikiComments, WikiThread } from "../api/types";
import { draftKey, forgetDraft, keepDraft, openCount, orderThreads, readDraft, threadUrl, withoutComment, withThread } from "./comments";

const comment = (id: string, thread: string) => ({ id, thread_id: thread, author: null, body_html: "<p>x</p>", mentions: [], created_at: "2026-11-01T00:00:00Z", edited_at: null, reactions: [] });
const thread = (id: string, over: Partial<WikiThread> = {}): WikiThread => ({
  id,
  page_id: "p",
  quote: "",
  inline: false,
  created_at: "2026-11-01T00:00:00Z",
  resolved_at: null,
  resolved_by: null,
  comments: [comment(id, id)],
  ...over,
});

describe("orderThreads", () => {
  it("reads inline threads in the page's order, then those whose text is gone, then the page's own", () => {
    const threads = [
      thread("page-old", { created_at: "2026-11-01T00:00:00Z" }),
      thread("lost", { inline: true, created_at: "2026-11-02T00:00:00Z" }),
      thread("late-in-page", { inline: true, created_at: "2026-11-03T00:00:00Z" }),
      thread("early-in-page", { inline: true, created_at: "2026-11-04T00:00:00Z" }),
      thread("page-new", { created_at: "2026-11-05T00:00:00Z" }),
      thread("lost-older", { inline: true, created_at: "2026-10-30T00:00:00Z" }),
    ];
    const pos = new Map([
      ["late-in-page", 40],
      ["early-in-page", 3],
    ]);
    expect(orderThreads(threads, pos).map((t) => t.id)).toEqual(["early-in-page", "late-in-page", "lost-older", "lost", "page-old", "page-new"]);
  });

  it("falls back to the order they were made without positions", () => {
    const a = thread("a", { inline: true, created_at: "2026-11-02T00:00:00Z" });
    const b = thread("b", { inline: true, created_at: "2026-11-01T00:00:00Z" });
    expect(orderThreads([a, b], new Map()).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("the comments cache", () => {
  const cur: WikiComments = { data: [thread("t1"), thread("t2", { comments: [comment("t2", "t2"), comment("r", "t2")] })], following: true };

  it("replaces a thread in place and adds a new one last", () => {
    const resolved = thread("t1", { resolved_at: "2026-11-06T00:00:00Z" });
    expect(withThread(cur, resolved)?.data.map((t) => [t.id, !!t.resolved_at])).toEqual([
      ["t1", true],
      ["t2", false],
    ]);
    expect(withThread(cur, thread("t3"))?.data.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(withThread(undefined, thread("t3"))).toBeUndefined();
  });

  it("removes a reply, and the whole thread with its first comment", () => {
    expect(withoutComment(cur, "r")?.data.find((t) => t.id === "t2")?.comments.map((c) => c.id)).toEqual(["t2"]);
    expect(withoutComment(cur, "t2")?.data.map((t) => t.id)).toEqual(["t1"]);
  });

  it("counts the comments of open threads only", () => {
    expect(openCount(cur.data)).toBe(3);
    expect(openCount([thread("x", { resolved_at: "2026-11-06T00:00:00Z" })])).toBe(0);
  });

  it("links to a thread on its page", () => {
    expect(threadUrl("https://app.opendesk.sh", "p1", "t1")).toBe("https://app.opendesk.sh/wiki/p1?comment=t1");
  });
});

describe("comment drafts", () => {
  it("keeps what was typed per page and thread, and forgets a blank one", () => {
    const a = draftKey("p1", "t1");
    const b = draftKey("p1", "new");
    keepDraft(a, "<p>half a thought</p>", false);
    expect(readDraft(a)).toBe("<p>half a thought</p>");
    expect(readDraft(b)).toBe("");
    expect(readDraft(draftKey("p2", "t1"))).toBe("");
    keepDraft(a, "<p></p>", true);
    expect(readDraft(a)).toBe("");
    keepDraft(b, "<p>x</p>", false);
    forgetDraft(b);
    expect(readDraft(b)).toBe("");
  });
});
