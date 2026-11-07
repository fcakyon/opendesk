// The wiki editor's extension set: the app's starter kit (as articles and notes write)
// with every Notion and Obsidian block added on top. Old pages load unchanged: each new
// block only reads its own data-type, and the KB's editor (RichEditor) is left as it is.

import { Extension, type Extensions } from "@tiptap/core";
import type { TFunction } from "i18next";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Mathematics } from "@tiptap/extension-mathematics";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import UniqueID from "@tiptap/extension-unique-id";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  AudioBlock,
  Bookmark,
  ButtonBlock,
  DatabaseBlock,
  PersonMention,
  Callout,
  Column,
  Columns,
  ContactMention,
  DateMention,
  Embed,
  FileBlock,
  HighlightTone,
  imageAttributes,
  imageView,
  PageLink,
  SubpageBlock,
  TableOfContents,
  TextTone,
  TicketMention,
  TicketsBlock,
  Transclusion,
  VideoBlock,
} from "./blocks";
import { Footnote, FootnoteRef, Footnotes } from "./footnotes";
import { printWikiPage, printRootOf } from "./print";
import { parseBlockLink } from "./transclude";
import { WikiCodeBlock } from "./code";
import { CommentMark, copyOfBlock, type CommentOptions } from "./comment";
import { moveBlock, blockAt } from "./handle";
import { embedItems, emojiItems, linkItems, mentionItems, mentionSearch, slashItems, ticketSearch, type MenuSources } from "./items";
import { typedMenu } from "./menu";
import { OllieExtension } from "./ollie";
import { parseTicketQuery } from "@/lib/wiki/desk";
import { isTone } from "./tones";
import { TagMarks } from "./tags";
import { embedFor } from "@/lib/wiki/embeds";

/** Blocks that carry an id (data-block-id): links to a block, comments, the outline. */
export const ID_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "callout",
  "details",
  "table",
  "image",
  "file",
  "video",
  "audio",
  "bookmark",
  "embed",
  "toc",
  "columns",
  "horizontalRule",
  "blockMath",
  "subpage",
  "database",
  "tickets",
  "transclusion",
  "button",
];

const LINE_HINT_PARENTS = new Set(["doc", "column", "callout", "detailsContent"]);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggleHeading: {
      /** The line becomes a toggle heading of that level (its text the heading), open to write under. */
      setToggleHeading: (level: 1 | 2 | 3) => ReturnType;
    };
  }
}

const headingLevel = (v: unknown) => (v === 1 || v === 2 || v === 3 ? v : null);

/**
 * Toggles, and toggle headings as Notion's: a toggle whose summary is a heading of level 1
 * to 3 (`<details data-heading>`), folding what is under it.
 */
export const WikiDetails = Details.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      heading: {
        default: null,
        parseHTML: (el: HTMLElement) => headingLevel(Number(el.getAttribute("data-heading"))),
        renderHTML: (a: { heading?: number | null }) => (a.heading ? { "data-heading": String(a.heading) } : {}),
      },
    };
  },
  addNodeView() {
    const make = this.parent?.();
    if (!make) return null;
    return (props) => {
      const view = make(props);
      // The toggle's own view sets its attributes once: keep its id, level and colours current.
      const sync = (n: typeof props.node) => {
        const dom = view.dom as HTMLElement;
        const set = (k: string, v: unknown) => (v ? dom.setAttribute(k, String(v)) : dom.removeAttribute(k));
        set("data-heading", n.attrs.heading);
        set("data-block-id", n.attrs["block-id"]);
        set("data-color", n.attrs.color);
        set("data-bg", n.attrs.background);
      };
      sync(props.node);
      const update = view.update?.bind(view);
      return {
        ...view,
        update: (n, decorations, inner) => {
          const ok = update ? update(n, decorations, inner) : false;
          if (ok) sync(n);
          return ok;
        },
      };
    };
  },
  addCommands() {
    return {
      ...this.parent?.(),
      setToggleHeading:
        (level) =>
        ({ state, chain }) => {
          const { $from } = state.selection;
          if (!$from.parent.isTextblock || $from.depth < 1) return false;
          const text = $from.parent.textContent;
          const from = $from.before();
          return chain()
            .insertContentAt(
              { from, to: $from.after() },
              {
                type: this.name,
                attrs: { heading: level },
                content: [
                  { type: "detailsSummary", content: text ? [{ type: "text", text }] : [] },
                  { type: "detailsContent", content: [{ type: "paragraph" }] },
                ],
              },
            )
            .setTextSelection(from + 2 + text.length)
            .run();
        },
    };
  },
});

/** A text colour and a background for whole blocks, as Notion's block colours. */
const BlockColor = Extension.create({
  name: "blockColor",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "listItem", "taskItem", "blockquote", "details", "bulletList", "orderedList", "taskList"],
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => (isTone(el.getAttribute("data-color")) ? el.getAttribute("data-color") : null),
            renderHTML: (a) => (a.color ? { "data-color": a.color } : {}),
          },
          background: {
            default: null,
            parseHTML: (el) => (isTone(el.getAttribute("data-bg")) ? el.getAttribute("data-bg") : null),
            renderHTML: (a) => (a.background ? { "data-bg": a.background } : {}),
          },
        },
      },
    ];
  },
});

/** Notion's keys for blocks: move, duplicate, turn into. */
const BlockKeys = Extension.create({
  name: "blockKeys",
  addKeyboardShortcuts() {
    const current = () => {
      const { view, state } = this.editor;
      const coords = view.coordsAtPos(state.selection.from);
      return blockAt(view, coords.left + 1, (coords.top + coords.bottom) / 2);
    };
    return {
      "Mod-Shift-ArrowUp": () => {
        const b = current();
        if (b) moveBlock(this.editor, b, -1);
        return !!b;
      },
      "Mod-Shift-ArrowDown": () => {
        const b = current();
        if (b) moveBlock(this.editor, b, 1);
        return !!b;
      },
      "Mod-d": () => {
        const b = current();
        if (!b) return false;
        return this.editor.chain().insertContentAt(b.pos + b.node.nodeSize, copyOfBlock(b.node)).run();
      },
      "Mod-Alt-0": () => this.editor.chain().focus().setParagraph().run(),
      "Mod-Alt-1": () => this.editor.chain().focus().setHeading({ level: 1 }).run(),
      "Mod-Alt-2": () => this.editor.chain().focus().setHeading({ level: 2 }).run(),
      "Mod-Alt-3": () => this.editor.chain().focus().setHeading({ level: 3 }).run(),
      "Mod-Alt-4": () => this.editor.chain().focus().toggleTaskList().run(),
      "Mod-Alt-5": () => this.editor.chain().focus().toggleBulletList().run(),
      "Mod-Alt-6": () => this.editor.chain().focus().toggleOrderedList().run(),
      "Mod-Alt-7": () => this.editor.chain().focus().setDetails().run(),
      "Mod-Alt-8": () => this.editor.chain().focus().setCodeBlock().run(),
      // The page as paper: just its cover, title and text, light (print.ts).
      "Mod-p": () => {
        printWikiPage(printRootOf(this.editor.view.dom));
        return true;
      },
      "Mod-Enter": () => {
        // Ticks the to-do under the cursor, as Notion does.
        if (!this.editor.isActive("taskItem")) return false;
        const checked = this.editor.getAttributes("taskItem").checked as boolean;
        return this.editor.chain().updateAttributes("taskItem", { checked: !checked }).run();
      },
    };
  },
});

/** Pasting: a link alone becomes an embed or stays a link; Markdown becomes blocks. */
const SmartPaste = Extension.create({
  name: "smartPaste",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("wiki-smart-paste"),
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            if (!data || data.types.includes("text/html") || editor.isActive("codeBlock")) return false;
            const text = data.getData("text/plain");
            if (!text) return false;
            const trimmed = text.trim();
            const onEmptyLine = editor.state.selection.empty && editor.state.selection.$from.parent.content.size === 0;
            // A link to a block of this wiki on an empty line: that block, synced.
            const block = onEmptyLine && editor.state.selection.$from.parent.type.name === "paragraph" ? parseBlockLink(trimmed, location.origin) : null;
            if (block) {
              editor.chain().focus().insertContent({ type: "transclusion", attrs: block }).run();
              return true;
            }
            // A link pasted on an empty line: a player when one plays it.
            if (/^https:\/\/\S+$/.test(trimmed) && editor.state.selection.empty && editor.state.selection.$from.parent.content.size === 0 && embedFor(trimmed)) {
              editor.chain().focus().insertContent({ type: "embed", attrs: { url: trimmed } }).run();
              return true;
            }
            if (looksLikeMarkdown(text)) {
              editor.chain().focus().insertContent(text, { contentType: "markdown" }).run();
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export function looksLikeMarkdown(text: string): boolean {
  if (!text.includes("\n")) return /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:)/.test(text);
  return /^(#{1,6} |[-*+] |\d+\. |> |```|- \[[ xX]\] |\|.+\|)/m.test(text);
}

export function wikiExtensions(opts: { placeholder: () => string; sources: MenuSources; onOpenTag: (tag: string) => void; comments: CommentOptions }): Extensions {
  const s = opts.sources;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      dropcursor: { color: "var(--tone-blue-solid)", width: 2 },
      // The footnotes list ends the page: no empty line is kept after it.
      trailingNode: { notAfter: ["footnotes"] },
    }),
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node, editor, pos }) => {
        if (node.type.name === "heading") return s.t(`editor.placeholder.h${node.attrs.level as 1 | 2 | 3}`);
        if (node.type.name === "detailsSummary") return s.t("editor.placeholder.toggle");
        const doc = editor.state.doc;
        const parent = pos <= doc.content.size ? doc.resolve(pos).parent.type.name : "doc";
        if (parent === "footnote") return s.t("editor.footnote.placeholder");
        if (editor.isEmpty) return opts.placeholder();
        // The "/" hint only on lines of the page itself, not in table cells or list items.
        // Decorations are drawn for the state being made, which editor.state may not be yet.
        if (node.type.name !== "paragraph" || !LINE_HINT_PARENTS.has(parent)) return "";
        return s.t(s.ollie() ? "ollie.lineHint" : "editor.placeholder.line");
      },
      showOnlyCurrent: true,
    }),
    Image.extend({
      addAttributes() {
        return { ...this.parent?.(), ...imageAttributes };
      },
      addNodeView: imageView,
    }).configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    WikiDetails.configure({ persist: false, HTMLAttributes: { class: "wiki-toggle" } }),
    DetailsSummary,
    DetailsContent,
    TableKit.configure({ table: { resizable: true, cellMinWidth: 80, allowTableNodeSelection: true } }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Mathematics.configure({ katexOptions: { throwOnError: false, strict: false } }),
    PersonMention,
    WikiCodeBlock,
    Callout,
    Columns,
    Column,
    FileBlock,
    VideoBlock,
    AudioBlock,
    Bookmark,
    Embed,
    TableOfContents,
    SubpageBlock,
    DatabaseBlock,
    TicketsBlock,
    Transclusion,
    ButtonBlock,
    FootnoteRef,
    Footnotes.configure({ label: () => s.t("editor.footnote.title") }),
    Footnote.configure({ backLabel: () => s.t("editor.footnote.back") }),
    TicketMention,
    ContactMention,
    PageLink,
    DateMention,
    TextTone,
    HighlightTone,
    BlockColor,
    BlockKeys,
    SmartPaste,
    TagMarks.configure({ onOpen: (tag) => opts.onOpenTag(tag) }),
    CommentMark.configure(opts.comments),
    Markdown,
    UniqueID.configure({ attributeName: "block-id", types: ID_TYPES }),
    OllieExtension.configure({ enabled: () => s.ollie(), ask: () => s.askOllie() }),
    typedMenu({ name: "slash", char: "/", items: (q) => slashItems(q, s), labels: () => ({ title: s.t("editor.menu.blocks"), empty: s.t("editor.menu.noBlocks") }) }),
    typedMenu({ name: "link", char: "[[", allowSpaces: true, items: (q) => linkItems(q, s), labels: () => ({ title: s.t("editor.menu.pages"), empty: s.t("editor.menu.noPages") }) }),
    // "![[": a page shown in place, as Obsidian's embeds.
    typedMenu({ name: "embed", char: "![[", allowSpaces: true, items: (q) => embedItems(q, s), labels: () => ({ title: s.t("editor.synced.menu"), empty: s.t("editor.menu.noPages") }) }),
    typedMenu({
      name: "mention",
      char: "@",
      allowSpaces: true,
      items: (q, _e, found) => mentionItems(q, s, found),
      search: mentionSearch(s),
      labels: () => ({ title: s.t("editor.menu.mention"), empty: s.t("editor.menu.noMatches"), searching: s.t("desk.searching") }),
    }),
    // "#123" or "#words": tickets. A #tag types on: the menu only shows with tickets to offer,
    // and Enter picks one only for a number or after an arrow key chose it.
    typedMenu({
      name: "ticket",
      char: "#",
      quiet: true,
      preselect: (q) => parseTicketQuery(q).kind === "number",
      items: (_q, _e, found) => found ?? [],
      search: ticketSearch(s),
      labels: () => ({ title: s.t("desk.tickets"), empty: s.t("desk.noTickets"), searching: s.t("desk.searching") }),
    }),
    typedMenu({ name: "emoji", char: ":", items: (q) => emojiItems(q), labels: () => ({ title: s.t("editor.block.emoji"), empty: s.t("editor.menu.noMatches") }) }),
  ];
}

/**
 * The extensions for reading a page inside another (synced blocks): every block drawn as on
 * its own page, nothing that writes (no menus' items, comments or Ollie to act on).
 */
export function readerExtensions(opts: { t: TFunction<"wiki">; onOpenTag: (tag: string) => void }): Extensions {
  const none = () => [];
  return wikiExtensions({
    placeholder: () => "",
    onOpenTag: opts.onOpenTag,
    comments: { onOpen: () => {}, onStart: () => {} },
    sources: {
      t: opts.t,
      untitled: opts.t("untitled"),
      pages: none,
      members: none,
      pageId: () => "",
      createSubpage: async () => null,
      openSubpage: () => {},
      pickImage: () => {},
      createDatabase: async () => null,
      search: async () => ({ tickets: [], contacts: [], articles: [] }),
      ticket: async () => null,
      ollie: () => false,
      askOllie: () => {},
    },
  });
}
