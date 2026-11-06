// Inline comments in the wiki editor (contracts/wiki.md "Comments"): the text a thread is
// on carries `<span data-comment="<thread id>">`, a mark saved with the body. Only open
// threads are drawn (a soft amber underline, stronger for the thread in hand); a resolved
// or deleted thread's mark stays in the body and shows nothing. Clicking drawn text opens
// its thread. A new thread's text is held (and drawn) from "Comment" until the thread
// exists; the mark goes on then, so a comment never sent leaves nothing in the page.
// Pasted text never brings marks along: a copy is not the commented text.

import { Mark, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommentRange = { from: number; to: number };

/** What the drawing reads: open threads, the one in hand, the one under the pointer, a thread being written. */
export type CommentView = { open: ReadonlySet<string>; active: string | null; hover: string | null; pending: CommentRange | null };

type PluginState = CommentView & { decos: DecorationSet };

export const commentKey = new PluginKey<PluginState>("wiki-comments");

type Meta = Partial<CommentView>;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    wikiComment: {
      /** Asks the page to start a thread on the selected text (Mod+Alt+M, the toolbar's "Comment"). */
      startComment: () => ReturnType;
    };
  }
}

/** The thread ids marked in a document, by where each first starts. */
export function anchorPositions(doc: PMNode): Map<string, number> {
  const out = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) if (m.type.name === "comment" && !out.has(m.attrs.id as string)) out.set(m.attrs.id as string, pos);
  });
  return out;
}

/** The drawing: open threads' text, the thread in hand (or under the pointer) stronger, and the text a new thread is on. */
export function commentDecorations(doc: PMNode, view: Omit<CommentView, "pending"> & { pending?: CommentRange | null }): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      const id = m.attrs.id as string;
      if (m.type.name !== "comment" || !view.open.has(id)) continue;
      const on = id === view.active || id === view.hover;
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: on ? "wiki-comment is-active" : "wiki-comment", "data-comment-thread": id }));
    }
  });
  const p = view.pending;
  if (p && p.to > p.from && p.to <= doc.content.size) decos.push(Decoration.inline(p.from, p.to, { class: "wiki-comment is-active is-pending" }));
  return DecorationSet.create(doc, decos);
}

/** A slice without comment marks, and without reminders on its dates: pasted text is a copy, never the commented text or someone's reminder. */
export function stripComments(slice: Slice): Slice {
  const clean = (frag: Fragment): Fragment => {
    const out: PMNode[] = [];
    frag.forEach((n) => {
      let node = n;
      if (node.isText && node.marks.some((m) => m.type.name === "comment")) node = node.mark(node.marks.filter((m) => m.type.name !== "comment"));
      if (node.type.name === "dateMention" && node.attrs.reminder) node = node.type.create({ ...node.attrs, reminder: null }, node.content, node.marks);
      if (!node.isText && node.content.size) node = node.copy(clean(node.content));
      out.push(node);
    });
    return Fragment.from(out);
  };
  return new Slice(clean(slice.content), slice.openStart, slice.openEnd);
}

/** A block's copy as Mod+D and "Duplicate" insert it: without its comments and reminders. */
export function copyOfBlock(node: PMNode): Record<string, unknown> {
  return stripComments(new Slice(Fragment.from(node), 0, 0)).content.firstChild!.toJSON() as Record<string, unknown>;
}

/** The id of a thread whose drawn text an element is in. */
const threadOf = (el: EventTarget | null) => (el instanceof Element ? (el.closest("[data-comment-thread]")?.getAttribute("data-comment-thread") ?? null) : null);

export type CommentOptions = {
  /** Someone clicked an open thread's text. */
  onOpen: (threadId: string) => void;
  /** Someone asked to comment on the selection (the range is held until `applyComment` or `cancelComment`). */
  onStart: (range: CommentRange, quote: string) => void;
};

export const CommentMark = Mark.create<CommentOptions>({
  name: "comment",
  // Outside the other marks, so one span holds the whole commented text.
  priority: 1001,
  inclusive: false,
  // Threads may overlap: text can be in two of them.
  excludes: "",
  spanning: true,
  addOptions() {
    return { onOpen: () => {}, onStart: () => {} };
  },
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute("data-comment"), renderHTML: (a) => ({ "data-comment": a.id }) } };
  },
  parseHTML() {
    return [{ tag: "span[data-comment]", getAttrs: (el) => (UUID.test((el as HTMLElement).getAttribute("data-comment") ?? "") ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
  addCommands() {
    return {
      startComment:
        () =>
        ({ state, editor }) => {
          const { from, to, empty } = state.selection;
          if (empty || !editor.isEditable) return false;
          const quote = state.doc.textBetween(from, to, " ", " ").replace(/\s+/g, " ").trim();
          if (!quote) return false;
          this.options.onStart({ from, to }, quote.slice(0, 500));
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Alt-m": () => this.editor.commands.startComment() };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<PluginState>({
        key: commentKey,
        state: {
          init: (_, state) => {
            const v: CommentView = { open: new Set(), active: null, hover: null, pending: null };
            return { ...v, decos: commentDecorations(state.doc, v) };
          },
          apply: (tr, prev, _old, state) => {
            const meta = tr.getMeta(commentKey) as Meta | undefined;
            let pending = prev.pending;
            if (pending && tr.docChanged) {
              const from = tr.mapping.map(pending.from, 1);
              const to = tr.mapping.map(pending.to, -1);
              pending = to > from ? { from, to } : null;
            }
            const next: CommentView = { open: prev.open, active: prev.active, hover: prev.hover, pending, ...meta };
            if (!meta && !tr.docChanged) return prev;
            return { ...next, decos: commentDecorations(state.doc, next) };
          },
        },
        props: {
          decorations: (state) => commentKey.getState(state)?.decos,
          transformPasted: (slice, view) => (view.dragging?.move ? slice : stripComments(slice)),
          handleDOMEvents: {
            click: (view, e) => {
              const id = threadOf(e.target);
              // A click that ends selecting text is not one that opens a thread.
              if (id && view.state.selection.empty) options.onOpen(id);
              return false;
            },
            mouseover: (view, e) => {
              const id = threadOf(e.target);
              if (id !== commentKey.getState(view.state)?.hover) view.dispatch(view.state.tr.setMeta(commentKey, { hover: id }).setMeta("addToHistory", false));
              return false;
            },
            mouseleave: (view) => {
              if (commentKey.getState(view.state)?.hover) view.dispatch(view.state.tr.setMeta(commentKey, { hover: null }).setMeta("addToHistory", false));
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** Tells the editor which threads are open and which is in hand. */
export function showThreads(editor: Editor, open: Iterable<string>, active: string | null) {
  if (editor.isDestroyed) return;
  const st = commentKey.getState(editor.state);
  const set = new Set(open);
  if (st && st.active === active && st.open.size === set.size && [...set].every((id) => st.open.has(id))) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentKey, { open: set, active }).setMeta("addToHistory", false));
}

/** Holds (and draws) the text a thread is being written on, or lets it go. */
export function holdComment(editor: Editor, range: CommentRange | null) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentKey, { pending: range }).setMeta("addToHistory", false));
}

/** The text held for a new thread, where it is now. */
export function heldComment(state: EditorState): CommentRange | null {
  return commentKey.getState(state)?.pending ?? null;
}

/**
 * Marks the held text with the thread made for it, as an edit (the page saves it), and
 * lets go of it. False when the text is gone.
 */
export function applyComment(editor: Editor, threadId: string): boolean {
  if (editor.isDestroyed) return false;
  const range = heldComment(editor.state);
  const tr: Transaction = editor.state.tr.setMeta(commentKey, { pending: null });
  const type = editor.schema.marks.comment;
  if (range && type) tr.addMark(range.from, range.to, type.create({ id: threadId }));
  editor.view.dispatch(tr);
  return !!range;
}

/** The text a thread is on (open or resolved), scrolled to the middle of the page; false when it isn't there. */
export function revealThread(editor: Editor, threadId: string): boolean {
  if (editor.isDestroyed) return false;
  const el = editor.view.dom.querySelector(`[data-comment="${CSS.escape(threadId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  return true;
}
