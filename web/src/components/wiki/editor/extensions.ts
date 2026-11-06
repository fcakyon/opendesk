// The wiki editor's extension set: the app's starter kit (as articles and notes write)
// with every Notion and Obsidian block added on top. Old pages load unchanged: each new
// block only reads its own data-type, and the KB's editor (RichEditor) is left as it is.

import { Extension, type Extensions } from "@tiptap/core";
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
import { AudioBlock, Bookmark, PersonMention, Callout, Column, Columns, DateMention, Embed, FileBlock, HighlightTone, imageAttributes, imageView, PageLink, SubpageBlock, TableOfContents, TextTone, VideoBlock } from "./blocks";
import { WikiCodeBlock } from "./code";
import { moveBlock, blockAt } from "./handle";
import { emojiItems, linkItems, mentionItems, slashItems, type MenuSources } from "./items";
import { typedMenu } from "./menu";
import { isTone } from "./tones";
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
];

const LINE_HINT_PARENTS = new Set(["doc", "column", "callout", "detailsContent"]);

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
        return this.editor.chain().insertContentAt(b.pos + b.node.nodeSize, b.node.toJSON()).run();
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

export function wikiExtensions(opts: { placeholder: () => string; sources: MenuSources }): Extensions {
  const s = opts.sources;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      dropcursor: { color: "var(--tone-blue-solid)", width: 2 },
    }),
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node, editor, pos }) => {
        if (node.type.name === "heading") return s.t(`editor.placeholder.h${node.attrs.level as 1 | 2 | 3}`);
        if (node.type.name === "detailsSummary") return s.t("editor.placeholder.toggle");
        if (editor.isEmpty) return opts.placeholder();
        // The "/" hint only on lines of the page itself, not in table cells or list items.
        // Decorations are drawn for the state being made, which editor.state may not be yet.
        const doc = editor.state.doc;
        const parent = pos <= doc.content.size ? doc.resolve(pos).parent.type.name : "doc";
        return node.type.name === "paragraph" && LINE_HINT_PARENTS.has(parent) ? s.t("editor.placeholder.line") : "";
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
    Details.configure({ persist: false, HTMLAttributes: { class: "wiki-toggle" } }),
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
    PageLink,
    DateMention,
    TextTone,
    HighlightTone,
    BlockColor,
    BlockKeys,
    SmartPaste,
    Markdown,
    UniqueID.configure({ attributeName: "block-id", types: ID_TYPES }),
    typedMenu({ name: "slash", char: "/", items: (q) => slashItems(q, s), labels: () => ({ title: s.t("editor.menu.blocks"), empty: s.t("editor.menu.noBlocks") }) }),
    typedMenu({ name: "link", char: "[[", allowSpaces: true, items: (q) => linkItems(q, s), labels: () => ({ title: s.t("editor.menu.pages"), empty: s.t("editor.menu.noPages") }) }),
    typedMenu({ name: "mention", char: "@", allowSpaces: true, items: (q) => mentionItems(q, s), labels: () => ({ title: s.t("editor.menu.mention"), empty: s.t("editor.menu.noMatches") }) }),
    typedMenu({ name: "emoji", char: ":", items: (q) => emojiItems(q), labels: () => ({ title: s.t("editor.block.emoji"), empty: s.t("editor.menu.noMatches") }) }),
  ];
}
