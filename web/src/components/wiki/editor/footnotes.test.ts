import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { Footnote, FootnoteRef, Footnotes, footnoteNumbers, footnoteOrder } from "./footnotes";

const A = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";
const B = "9a1f7c2e-1b4d-4e8a-9c3f-2d5e6f7a8b9c";
const C = "5b0a9f8e-7d6c-4b5a-8e9f-0a1b2c3d4e5f";

const ref = (id: string, n = 9) => `<sup data-type="footnote" data-note="${id}">${n}</sup>`;
const note = (id: string, text: string) => `<div data-type="footnote" data-note="${id}"><p>${text}</p></div>`;
const notes = (...items: string[]) => `<div data-type="footnotes">${items.join("")}</div>`;

describe("footnote numbering", () => {
  it("numbers notes by where each is first referenced", () => {
    expect(footnoteOrder([B, A, B, C, A])).toEqual([B, A, C]);
    expect([...footnoteNumbers([B, A, B, C])]).toEqual([
      [B, 1],
      [A, 2],
      [C, 3],
    ]);
    expect(footnoteNumbers([]).size).toBe(0);
  });
});

let editor: Editor | null = null;
// The footnote views draw with React; plain renderHTML is enough to test the document.
const plain = [FootnoteRef.extend({ addNodeView: () => null }), Footnotes.extend({ addNodeView: () => null }), Footnote.extend({ addNodeView: () => null })];
// As the wiki editor configures it: no empty line kept after the footnotes.
const kit = StarterKit.configure({ trailingNode: { notAfter: ["footnotes"] } });
const make = (content: string) => (editor = new Editor({ element: document.createElement("div"), extensions: [kit, ...plain], content }));
const notesOf = (html: string) => [...html.matchAll(/<div data-type="footnote" data-note="([^"]+)"><p>([^<]*)<\/p><\/div>/g)].map((m) => [m[1], m[2]]);
const refsOf = (html: string) => [...html.matchAll(/<sup data-type="footnote" data-note="([^"]+)">(\d*)<\/sup>/g)].map((m) => [m[1], m[2]]);

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("the footnotes list", () => {
  it("loads a page as it is: loading is never an edit", () => {
    const e = make(`<p>a${ref(A)}</p>`);
    expect(e.getHTML()).toBe(`<p>a${ref(A)}</p>`);
  });

  it("inserting a reference adds its note at the end and puts the cursor there", () => {
    const e = make(`<p>One</p><p>Two</p>`);
    e.chain().setTextSelection(4).insertFootnote().run();
    e.commands.insertContent("the source");
    const html = e.getHTML();
    const [[id, n]] = refsOf(html);
    expect(n).toBe("1");
    expect(notesOf(html)).toEqual([[id, "the source"]]);
    expect(html.endsWith(`${notes(note(id, "the source"))}`)).toBe(true);
  });

  it("typing [^ starts a footnote", () => {
    const e = make(`<p>Claim</p>`);
    e.commands.setTextSelection(6);
    // Input rules run on typed text: type the two characters as the view would.
    for (const ch of ["[", "^"]) {
      const { from, to } = e.state.selection;
      const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
    }
    const html = e.getHTML();
    expect(html).not.toContain("[^");
    expect(refsOf(html)).toHaveLength(1);
    expect(notesOf(html)).toHaveLength(1);
  });

  it("keeps the notes in reference order, numbered, and drops a note nothing references", () => {
    const e = make(`<p>x${ref(A, 1)} y${ref(B, 2)}</p>${notes(note(A, "first"), note(B, "second"))}`);
    // Move B's reference before A's: the list and the numbers follow.
    e.commands.setContent(`<p>x${ref(A, 1)} y${ref(B, 2)}</p>${notes(note(A, "first"), note(B, "second"))}`, { emitUpdate: false });
    e.chain().setTextSelection(1).insertContent({ type: "footnoteRef", attrs: { note: B } }).run();
    let html = e.getHTML();
    expect(refsOf(html)).toEqual([
      [B, "1"],
      [A, "2"],
      [B, "1"],
    ]);
    expect(notesOf(html)).toEqual([
      [B, "second"],
      [A, "first"],
    ]);
    // Deleting A's only reference takes its note along.
    let at = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.type.name === "footnoteRef" && n.attrs.note === A) at = pos;
    });
    e.chain().deleteRange({ from: at, to: at + 1 }).run();
    html = e.getHTML();
    expect(notesOf(html)).toEqual([[B, "second"]]);
    expect(refsOf(html).every(([, n]) => n === "1")).toBe(true);
    // And the last reference going takes the list along.
    e.commands.setContent(`<p>x${ref(C, 1)}</p>${notes(note(C, "only"))}`, { emitUpdate: false });
    e.chain().setTextSelection({ from: 2, to: 3 }).deleteSelection().run();
    expect(e.getHTML()).toBe("<p>x</p>");
  });

  it("gathers notes written anywhere into one list at the end", () => {
    const e = make(`<p>a${ref(A, 1)}</p>${notes(note(A, "kept"))}<p>written after</p>`);
    e.chain().setTextSelection(e.state.doc.content.size - 1).insertContent("!").run();
    const html = e.getHTML();
    expect(html).toBe(`<p>a${ref(A, 1)}</p><p>written after!</p>${notes(note(A, "kept"))}`);
  });

  it("never nests a footnote in a note", () => {
    const e = make(`<p>a${ref(A, 1)}</p>${notes(note(A, "text"))}`);
    const inNote = e.state.doc.content.size - 3;
    e.commands.setTextSelection(inNote);
    expect(e.commands.insertFootnote()).toBe(false);
  });
});
