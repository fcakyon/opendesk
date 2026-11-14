// Footnotes, as Obsidian's [^1] and Word's: a numbered reference in the text and its note in
// one list at the page's end (contracts/wiki.md "Blocks"). The reference stores the note's id
// (`<sup data-type="footnote" data-note>`) and the list the notes (`<div data-type="footnotes">`
// of `<div data-type="footnote" data-note>`). Numbers follow where each note is first
// referenced; the list keeps that order, gets a note for each new reference and loses the
// notes nothing references any more, in the same step as the edit (one undo).

import { InputRule, Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { HoverCard as H } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { floatingPanel } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { isUuid } from "@/lib/wiki/desk";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnotes: {
      /** A reference at the cursor and its note at the page's end, with the cursor in the note. */
      insertFootnote: () => ReturnType;
    };
  }
}

/** The notes in the order they are first referenced: each id once. */
export function footnoteOrder(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

/** Each note's number, from 1, by where it is first referenced. */
export function footnoteNumbers(refs: readonly string[]): Map<string, number> {
  return new Map(footnoteOrder(refs).map((id, i) => [id, i + 1]));
}

type Scan = { refs: { pos: number; node: PMNode }[]; lists: { pos: number; node: PMNode }[]; notes: Map<string, PMNode> };

function scan(doc: PMNode): Scan {
  const out: Scan = { refs: [], lists: [], notes: new Map() };
  doc.descendants((node, pos) => {
    if (node.type.name === "footnoteRef") out.refs.push({ pos, node });
    else if (node.type.name === "footnotes") {
      out.lists.push({ pos, node });
      node.forEach((note) => {
        const id = note.attrs.note as string;
        if (note.type.name === "footnote" && id && !out.notes.has(id)) out.notes.set(id, note);
      });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * Brings the footnotes of tr's document in order: each reference numbered, one list at the
 * page's end holding a note per referenced id in reference order (an empty one for a new
 * reference), and nothing else. Reports whether it changed anything.
 */
export function syncFootnotes(tr: Transaction): boolean {
  const { refs, lists, notes } = scan(tr.doc);
  const order = footnoteOrder(refs.map((r) => r.node.attrs.note as string));
  const numbers = footnoteNumbers(order);
  const doc = tr.doc;
  const list = lists[0]?.node;
  const listOk =
    order.length === 0
      ? lists.length === 0
      : lists.length === 1 &&
        atEnd(doc, list) &&
        list.childCount === order.length &&
        order.every((id, i) => list.child(i).attrs.note === id);
  const numbersOk = refs.every((r) => r.node.attrs.n === numbers.get(r.node.attrs.note as string));
  if (listOk && numbersOk) return false;
  const schema = doc.type.schema;
  // Numbers first: changing an inline atom's attributes moves no position.
  for (const r of refs) {
    const n = numbers.get(r.node.attrs.note as string);
    if (r.node.attrs.n !== n) tr.setNodeMarkup(r.pos, undefined, { ...r.node.attrs, n });
  }
  if (!listOk) {
    for (const l of [...lists].reverse()) tr.delete(l.pos, l.pos + l.node.nodeSize);
    if (order.length) {
      const items = order.map((id) => notes.get(id) ?? schema.nodes.footnote.create({ note: id }, schema.nodes.paragraph.create()));
      tr.insert(tr.doc.content.size, schema.nodes.footnotes.create(null, items));
    }
  }
  return true;
}

/** The list is the page's last block, but for empty lines after it (another plugin's trailing line). */
function atEnd(doc: PMNode, list: PMNode): boolean {
  let seen = false;
  let ok = true;
  doc.forEach((child) => {
    if (child === list) seen = true;
    else if (seen && !(child.type.name === "paragraph" && child.content.size === 0)) ok = false;
  });
  return seen && ok;
}

/** Where the note with this id is in a document: the position inside its first paragraph. */
export function notePos(doc: PMNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "footnote" && node.attrs.note === id) {
      found = pos + 2;
      return false;
    }
    return true;
  });
  return found;
}

/** Where the first reference to a note is, or null. */
export function refPos(doc: PMNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "footnoteRef" && node.attrs.note === id) found = pos;
    return found === null;
  });
  return found;
}

function noteText(doc: PMNode, id: string): string {
  let text = "";
  doc.descendants((node) => {
    if (text) return false;
    if (node.type.name === "footnote" && node.attrs.note === id) {
      text = node.textBetween(0, node.content.size, " ", " ").trim();
      return false;
    }
    return true;
  });
  return text;
}

const footnoteKey = new PluginKey<Map<string, number>>("wiki-footnotes");

function flash(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  const el = dom instanceof HTMLElement ? dom : null;
  if (!el) return;
  el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el.classList.remove("wiki-flash");
  void el.offsetWidth;
  el.classList.add("wiki-flash");
}

/** Moves to a note (from its reference) or back (from the note), editing there when the page is editable. */
function jump(editor: Editor, to: number | null, cursor: number | null) {
  if (to === null) return;
  if (editor.isEditable && cursor !== null) editor.chain().focus().setTextSelection(cursor).run();
  flash(editor, to);
}

export function FootnoteRefView({ node, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const id = node.attrs.note as string;
  const n = footnoteKey.getState(editor.state)?.get(id) ?? (node.attrs.n as number | null) ?? "?";
  const text = open ? noteText(editor.state.doc, id) : "";
  return (
    <NodeViewWrapper as="span" className="wiki-fnref-wrap">
      <H.Root openDelay={200} closeDelay={100} open={open} onOpenChange={setOpen}>
        <H.Trigger asChild>
          <button
            type="button"
            contentEditable={false}
            className="wiki-fnref"
            aria-label={t("editor.footnote.ref", { n })}
            onClick={() => {
              const at = notePos(editor.state.doc, id);
              jump(editor, at === null ? null : at - 2, at === null ? null : editor.state.doc.resolve(at).end());
            }}
          >
            {n}
          </button>
        </H.Trigger>
        <H.Portal>
          <H.Content side="top" align="start" sideOffset={6} collisionPadding={12} className={cn(floatingPanel, "z-[70] max-w-[320px] px-3 py-2 text-[12.5px] leading-[18px] text-fg-2")}>
            <span className="mr-1.5 font-medium text-fg-3">{n}.</span>
            {text || <span className="text-fg-4">{t("editor.footnote.empty")}</span>}
          </H.Content>
        </H.Portal>
      </H.Root>
    </NodeViewWrapper>
  );
}

/** The reference, inline: its number, the note on hover; a click goes to the note. */
export const FootnoteRef = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      note: { default: "", parseHTML: (el) => (isUuid(el.getAttribute("data-note")) ? el.getAttribute("data-note")!.toLowerCase() : "") },
      // Its number when last saved: what other readers of the HTML (exports, search) see.
      n: { default: null, parseHTML: (el) => Number(el.textContent) || null },
    };
  },
  parseHTML: () => [{ tag: 'sup[data-type="footnote"]', getAttrs: (el) => (isUuid((el as HTMLElement).getAttribute("data-note")) ? null : false) }],
  renderHTML: ({ node }) => ["sup", { "data-type": "footnote", "data-note": node.attrs.note }, String(node.attrs.n ?? "")],
  renderText: ({ node }) => `[^${node.attrs.n ?? ""}]`,
  addNodeView() {
    return ReactNodeViewRenderer(FootnoteRefView, { as: "span" });
  },
  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ tr, state, dispatch }) => {
          const $from = state.selection.$from;
          for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "footnotes") return false;
          if ($from.parent.type.spec.code) return false;
          if (!dispatch) return true;
          const id = crypto.randomUUID();
          tr.replaceSelectionWith(state.schema.nodes.footnoteRef.create({ note: id }), false);
          syncFootnotes(tr);
          const at = notePos(tr.doc, id);
          if (at !== null) tr.setSelection(TextSelection.create(tr.doc, at));
          tr.scrollIntoView();
          return true;
        },
    };
  },
  addInputRules() {
    // "[^" starts a footnote, as Obsidian's [^1].
    return [
      new InputRule({
        find: /\[\^$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).insertFootnote().run();
        },
      }),
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<Map<string, number>>({
        key: footnoteKey,
        state: {
          init: (_, state) => numbersOf(state),
          apply: (tr, prev, _old, state) => (tr.docChanged ? numbersOf(state) : prev),
        },
        props: {
          // A reference is redrawn when its number changes.
          decorations: (state) => {
            const numbers = footnoteKey.getState(state);
            if (!numbers?.size) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === "footnoteRef") decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": String(numbers.get(node.attrs.note as string) ?? "") }));
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
        appendTransaction: (transactions, _old, state) => {
          // Only edits: a page loading (setContent without an update) is never changed here.
          if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta("preventUpdate"))) return null;
          const tr = state.tr;
          return syncFootnotes(tr) ? tr : null;
        },
      }),
    ];
  },
});

function numbersOf(state: EditorState): Map<string, number> {
  const refs: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "footnoteRef") refs.push(node.attrs.note as string);
    return node.type.name !== "footnotes";
  });
  return footnoteNumbers(refs);
}

/** The notes, one list at the end of the page. */
export const Footnotes = Node.create<{ label: () => string }>({
  name: "footnotes",
  group: "block",
  content: "footnote+",
  isolating: true,
  selectable: false,
  draggable: false,
  addOptions: () => ({ label: () => "Notes" }),
  parseHTML: () => [{ tag: 'div[data-type="footnotes"]' }],
  renderHTML: () => ["div", { "data-type": "footnotes" }, 0],
  addNodeView() {
    return () => {
      const dom = document.createElement("div");
      dom.dataset.type = "footnotes";
      dom.className = "wiki-footnotes";
      const head = document.createElement("div");
      head.contentEditable = "false";
      head.className = "wiki-footnotes-head";
      head.textContent = this.options.label();
      const list = document.createElement("div");
      list.className = "wiki-footnotes-list";
      dom.append(head, list);
      return { dom, contentDOM: list, ignoreMutation: (m) => head.contains(m.target as globalThis.Node) };
    };
  },
});

/** One note: its number, its text, and a way back to where it is referenced. */
export const Footnote = Node.create<{ backLabel: () => string }>({
  name: "footnote",
  content: "paragraph+",
  isolating: true,
  defining: true,
  addOptions: () => ({ backLabel: () => "Back to the text" }),
  addAttributes() {
    return { note: { default: "", parseHTML: (el) => (isUuid(el.getAttribute("data-note")) ? el.getAttribute("data-note")!.toLowerCase() : "") } };
  },
  parseHTML: () => [{ tag: 'div[data-type="footnote"]' }],
  renderHTML: ({ node }) => ["div", { "data-type": "footnote", "data-note": node.attrs.note }, 0],
  addNodeView() {
    return ({ node: first, editor }) => {
      let node = first;
      const dom = document.createElement("div");
      dom.dataset.type = "footnote";
      dom.className = "wiki-footnote";
      const marker = document.createElement("span");
      marker.contentEditable = "false";
      marker.className = "wiki-footnote-marker";
      const back = document.createElement("button");
      back.type = "button";
      back.className = "wiki-footnote-back";
      back.setAttribute("aria-label", this.options.backLabel());
      back.title = this.options.backLabel();
      back.textContent = "↩";
      back.addEventListener("mousedown", (e) => e.preventDefault());
      back.addEventListener("click", () => {
        const at = refPos(editor.state.doc, node.attrs.note as string);
        jump(editor, at, at === null ? null : at + 1);
      });
      marker.append(back);
      const content = document.createElement("div");
      content.className = "wiki-footnote-text";
      dom.append(marker, content);
      return {
        dom,
        contentDOM: content,
        ignoreMutation: (m) => marker.contains(m.target as globalThis.Node),
        update: (next) => {
          if (next.type !== node.type) return false;
          node = next;
          return true;
        },
      };
    };
  },
});
