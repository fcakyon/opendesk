import { Editor, getHTMLFromFragment, getSchema } from "@tiptap/core";
import { DOMParser as PMDOMParser, Fragment, Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { DateMention } from "./blocks";
import { anchorPositions, applyComment, CommentMark, commentDecorations, commentKey, copyOfBlock, heldComment, holdComment, showThreads, stripComments } from "./comment";

const A = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";
const B = "9a1f7c2e-1b4d-4e8a-9c3f-2d5e6f7a8b9c";
const R = "5b0a9f8e-7d6c-4b5a-8e9f-0a1b2c3d4e5f";

const schema = getSchema([StarterKit, CommentMark, DateMention]);
const parse = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(el);
};
const html = (doc: ReturnType<typeof parse>) => getHTMLFromFragment(doc.content, schema);

let editor: Editor | null = null;
const make = (content: string) => (editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit, CommentMark], content }));

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("the comment mark", () => {
  it("keeps data-comment spans with a thread id, and only those", () => {
    const doc = parse(`<p>One <span data-comment="${A}">two</span> <span data-comment="nope">three</span></p>`);
    expect(html(doc)).toBe(`<p>One <span data-comment="${A}">two</span> three</p>`);
  });

  it("finds where each thread's text starts, overlapping threads included", () => {
    const doc = parse(`<p>ab<span data-comment="${A}">cd<span data-comment="${B}">ef</span></span></p><p><span data-comment="${A}">again</span></p>`);
    expect([...anchorPositions(doc)]).toEqual([
      [A, 3],
      [B, 5],
    ]);
  });

  it("draws open threads only, the one in hand stronger", () => {
    const doc = parse(`<p><span data-comment="${A}">open</span> <span data-comment="${B}">resolved</span></p>`);
    const decos = commentDecorations(doc, { open: new Set([A]), active: A, hover: null }).find();
    expect(decos).toHaveLength(1);
    expect(decos[0].from).toBe(1);
    expect(decos[0].to).toBe(5);
    expect((decos[0] as unknown as { type: { attrs: Record<string, string> } }).type.attrs).toMatchObject({ class: "wiki-comment is-active", "data-comment-thread": A });
    const quiet = commentDecorations(doc, { open: new Set([A, B]), active: null, hover: null }).find();
    expect(quiet.map((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class)).toEqual(["wiki-comment", "wiki-comment"]);
  });

  it("leaves comments and reminders out of pasted and duplicated text", () => {
    const doc = parse(`<p><span data-comment="${A}"><strong>bold</strong> text</span> <time data-type="date" datetime="2026-11-07" data-reminder="${R}">2026-11-07</time></p>`);
    const clean = stripComments(new Slice(Fragment.from(doc.firstChild!), 0, 0));
    const out = getHTMLFromFragment(clean.content, schema);
    expect(out).not.toContain("data-comment");
    expect(out).not.toContain("data-reminder");
    expect(out).toContain("<strong>bold</strong>");
    expect(JSON.stringify(copyOfBlock(doc.firstChild!))).not.toContain(A);
  });

  it("marks the held text with the thread once it exists, as an edit", () => {
    const ed = make("<p>Refund within 30 days.</p>");
    let edits = 0;
    ed.on("update", () => edits++);
    holdComment(ed, { from: 15, to: 22 });
    expect(heldComment(ed.state)).toEqual({ from: 15, to: 22 });
    // Typing before it moves what is held along.
    ed.commands.insertContentAt(1, "Please: ");
    expect(heldComment(ed.state)).toEqual({ from: 23, to: 30 });
    expect(applyComment(ed, A)).toBe(true);
    expect(ed.getHTML()).toBe(`<p>Please: Refund within <span data-comment="${A}">30 days</span>.</p>`);
    expect(heldComment(ed.state)).toBeNull();
    expect(edits).toBe(2);
  });

  it("is told which threads are open without making an edit", () => {
    const ed = make(`<p><span data-comment="${A}">x</span></p>`);
    let edits = 0;
    ed.on("update", () => edits++);
    showThreads(ed, [A], A);
    expect(commentKey.getState(ed.state)?.decos.find()).toHaveLength(1);
    showThreads(ed, [], null);
    expect(commentKey.getState(ed.state)?.decos.find()).toHaveLength(0);
    expect(edits).toBe(0);
  });
});

describe("the date mention's reminder", () => {
  it("reads and writes the day, a time and the reminder", () => {
    const doc = parse(`<p><time data-type="date" datetime="2026-11-07T09:30" data-reminder="${R}">x</time> <time data-type="date" datetime="2026-11-08">y</time></p>`);
    const [a, , b] = doc.firstChild!.content.content;
    expect(a.attrs).toEqual({ date: "2026-11-07", time: "09:30", reminder: R });
    expect(b.attrs).toEqual({ date: "2026-11-08", time: "", reminder: null });
    expect(html(doc)).toBe(
      `<p><time data-type="date" datetime="2026-11-07T09:30" data-reminder="${R}">2026-11-07T09:30</time> <time data-type="date" datetime="2026-11-08">2026-11-08</time></p>`,
    );
  });

  it("drops a reminder id that isn't one", () => {
    const doc = parse(`<p><time data-type="date" datetime="2026-11-07" data-reminder="soon">x</time></p>`);
    expect(doc.firstChild!.firstChild!.attrs.reminder).toBeNull();
  });
});
