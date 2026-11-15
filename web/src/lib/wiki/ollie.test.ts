import { describe, expect, it } from "vitest";
import { costFeature, previewReducer, previewText, writeRequest, type Preview } from "./ollie";

const src = { title: " Refunds ", page: "<p>All of it</p>", before: "<p>Up to here</p>", selection: "<p>This bit</p>" };

describe("what Ollie is asked", () => {
  it("edits a selection with its HTML and the page's title", () => {
    expect(writeRequest({ mode: "shorter" }, "selection", src)).toEqual({ mode: "shorter", html: "<p>This bit</p>", title: "Refunds", instructions: undefined });
    expect(writeRequest({ mode: "custom", instructions: " Make it a table " }, "selection", src)).toMatchObject({ mode: "custom", html: "<p>This bit</p>", instructions: "Make it a table" });
  });
  it("writes at the cursor from what comes before it, or from the whole page", () => {
    expect(writeRequest({ mode: "continue" }, "cursor", src)).toEqual({ mode: "continue", context_html: "<p>Up to here</p>", title: "Refunds", instructions: undefined });
    expect(writeRequest({ mode: "summarize" }, "cursor", src)).toMatchObject({ context_html: "<p>All of it</p>" });
    expect(writeRequest({ mode: "custom", instructions: "A checklist" }, "cursor", { ...src, title: "" })).toEqual({ mode: "custom", context_html: "<p>All of it</p>", title: undefined, instructions: "A checklist" });
  });
  it("costs a rewrite for edits and wiki writing for the rest", () => {
    expect(costFeature("fix_grammar")).toBe("rewrite");
    expect(costFeature("action_items")).toBe("rewrite");
    expect(["summarize", "continue", "custom"].map((m) => costFeature(m as "custom"))).toEqual(["wiki_write", "wiki_write", "wiki_write"]);
  });
});

describe("the streamed preview", () => {
  const ask = { mode: "improve" as const };
  const start = (run: number): Preview => previewReducer({ status: "idle" }, { type: "start", run, ask });

  it("shows the text as it streams, then the sanitized HTML", () => {
    let s = start(1);
    s = previewReducer(s, { type: "delta", run: 1, soFar: "<p>Hello <str" });
    expect(s).toEqual({ status: "writing", run: 1, ask, text: "Hello" });
    s = previewReducer(s, { type: "delta", run: 1, soFar: "<p>Hello <strong>there</strong></p><ul><li>one</li>" });
    expect(s).toMatchObject({ text: "Hello there\n• one" });
    s = previewReducer(s, { type: "done", run: 1, html: "<p>Hello <strong>there</strong></p>" });
    expect(s).toEqual({ status: "done", run: 1, ask, html: "<p>Hello <strong>there</strong></p>" });
  });

  it("ignores what an earlier run still sends after Try again", () => {
    let s = start(1);
    s = previewReducer(s, { type: "start", run: 2, ask });
    s = previewReducer(s, { type: "delta", run: 1, soFar: "old" });
    s = previewReducer(s, { type: "done", run: 1, html: "<p>old</p>" });
    expect(s).toEqual({ status: "writing", run: 2, ask, text: "" });
  });

  it("tells a stop from a failure, and changes nothing once finished", () => {
    expect(previewReducer(start(3), { type: "fail", run: 3, stopped: true })).toEqual({ status: "failed", run: 3, ask, stopped: true });
    expect(previewReducer(start(3), { type: "fail", run: 3 })).toMatchObject({ status: "failed", stopped: false });
    const done = previewReducer(start(4), { type: "done", run: 4, html: "<p>x</p>" });
    expect(previewReducer(done, { type: "fail", run: 4 })).toBe(done);
    expect(previewReducer(done, { type: "reset" })).toEqual({ status: "idle" });
  });

  it("reads model HTML as text, a code fence and entities included", () => {
    expect(previewText("```html\n<h2>Steps</h2><ol><li>Check &amp; refund</li><li>Tell them</li></ol>")).toBe("Steps\n• Check & refund\n• Tell them");
    expect(previewText("<p>It&#39;s <a href")).toBe("It's");
    expect(previewText("<p>Hi</p><script>alert(1)</script><style>p{}</style><p>&lt;b&gt; stays text</p>")).toBe("Hi\n<b> stays text");
  });
});
