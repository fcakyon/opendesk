// The wiki editor's own blocks and marks (contracts/wiki.md "Blocks"), on top of the
// starter kit the rest of the app writes with. Each one reads and writes the HTML the API
// keeps (hd.SanitizeWiki): data attributes on plain elements, never an iframe, a script or
// a style the reader's theme can't follow. The React views live in views.tsx.

import { InputRule, Mark, mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { isTone, type Tone } from "./tones";
import { BookmarkView, CalloutView, DateView, EmbedView, FileView, ImageView, MediaView, PageLinkView, SubpageView, TocView } from "./views";


/** A link that the editor should open in the app: our own attachments, or https. */
export const SAFE_SRC = /^(https:\/\/[^\s"'<>]+|\/v1\/attachments\/[0-9a-fA-F-]{36}(\?[^\s"'<>]*)?)$/;
export const safeSrc = (v: string | null | undefined) => (v && SAFE_SRC.test(v) ? v : "");
export const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    wikiBlocks: {
      setCallout: (attrs?: { icon?: string; tone?: Tone }) => ReturnType;
      setColumns: (count: number) => ReturnType;
      setTextTone: (tone: Tone | null) => ReturnType;
      setHighlightTone: (tone: Tone | null) => ReturnType;
    };
  }
}

/** A box with an emoji that holds blocks: tips, warnings, notes. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      icon: { default: "💡", parseHTML: (el) => el.getAttribute("data-icon") || "", renderHTML: (a) => ({ "data-icon": a.icon }) },
      tone: { default: "gray", parseHTML: (el) => (isTone(el.getAttribute("data-tone")) ? el.getAttribute("data-tone") : "gray"), renderHTML: (a) => ({ "data-tone": a.tone }) },
    };
  },
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0],
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { icon: "💡", tone: "gray", ...attrs }),
    };
  },
  addInputRules() {
    // "> " is a quote (the starter kit's); ">! " starts a callout, like a note in Markdown.
    return [
      new InputRule({
        find: /^>!\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).wrapIn(this.name).run();
        },
      }),
    ];
  },
});

/** Columns side by side; each holds blocks. Two to five. */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,5}",
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  // Plain HTML, no React view: the columns must be the grid's own children.
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns" }), 0],
  addCommands() {
    return {
      setColumns:
        (count) =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              content: Array.from({ length: Math.min(5, Math.max(2, count)) }, () => ({ type: "column", content: [{ type: "paragraph" }] })),
            })
            .run(),
    };
  },
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "column" }), 0],
});

/** An atom block whose attributes are data-* on a div: files, media, bookmarks, embeds. */
function atomBlock(name: string, attrs: Record<string, { default: unknown; clean?: (v: string | null) => unknown }>, view: Parameters<typeof ReactNodeViewRenderer>[0]) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return Object.fromEntries(
        Object.entries(attrs).map(([k, spec]) => [
          k,
          {
            default: spec.default,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute(`data-${k}`);
              return spec.clean ? spec.clean(raw) : (raw ?? spec.default);
            },
            renderHTML: (a: Record<string, unknown>) => (a[k] === null || a[k] === "" || a[k] === undefined ? {} : { [`data-${k}`]: String(a[k]) }),
          },
        ]),
      );
    },
    parseHTML: () => [{ tag: `div[data-type="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": name })],
    addNodeView() {
      return ReactNodeViewRenderer(view);
    },
  });
}

const num = (v: string | null) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const text = (max: number) => (v: string | null) => (v ?? "").slice(0, max);

/** An uploaded file: a card that downloads it. */
export const FileBlock = atomBlock(
  "file",
  { src: { default: "", clean: safeSrc }, name: { default: "", clean: text(255) }, size: { default: null, clean: num }, mime: { default: "", clean: text(120) } },
  FileView,
);

/** A video or audio file played in place. */
export const VideoBlock = atomBlock("video", { src: { default: "", clean: safeSrc }, name: { default: "", clean: text(255) } }, MediaView);
export const AudioBlock = atomBlock("audio", { src: { default: "", clean: safeSrc }, name: { default: "", clean: text(255) } }, MediaView);

/** A link shown as a card: its site, title and description, read once by the API. */
export const Bookmark = atomBlock(
  "bookmark",
  {
    url: { default: "", clean: (v) => (v && HTTPS_URL.test(v) ? v : "") },
    title: { default: "", clean: text(300) },
    description: { default: "", clean: text(500) },
    image: { default: "", clean: (v) => (v && HTTPS_URL.test(v) ? v : "") },
  },
  BookmarkView,
);

/** Another site's player or document (lib/wiki/embeds.ts allows which), in a sandboxed frame. */
export const Embed = atomBlock(
  "embed",
  { url: { default: "", clean: (v) => (v && HTTPS_URL.test(v) ? v : "") }, height: { default: null, clean: num } },
  EmbedView,
);

/** The page's headings as links, kept up to date. */
export const TableOfContents = atomBlock("toc", {}, TocView);

/** A subpage, shown where it sits in the text; the page itself is in the tree. */
export const SubpageBlock = atomBlock("subpage", { id: { default: "", clean: (v) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : "") } }, SubpageView);

/** An image with a width (percent of the column), an alignment and a caption. */
export const imageAttributes = {
  width: { default: null, parseHTML: (el: HTMLElement) => num(el.getAttribute("data-width")), renderHTML: (a: { width?: number | null }) => (a.width ? { "data-width": String(Math.min(100, a.width)) } : {}) },
  align: {
    default: "center",
    parseHTML: (el: HTMLElement) => (["left", "center", "right"].includes(el.getAttribute("data-align") ?? "") ? el.getAttribute("data-align") : "center"),
    renderHTML: (a: { align?: string }) => (a.align && a.align !== "center" ? { "data-align": a.align } : {}),
  },
  caption: { default: "", parseHTML: (el: HTMLElement) => (el.getAttribute("data-caption") ?? "").slice(0, 500), renderHTML: (a: { caption?: string }) => (a.caption ? { "data-caption": a.caption } : {}) },
};
export const imageView = () => ReactNodeViewRenderer(ImageView);

/** A link to another wiki page, inline: its live title and icon, as Notion's @page and Obsidian's [[ ]]. */
export const PageLink = Node.create({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: "", parseHTML: (el) => (/^[0-9a-f-]{36}$/i.test(el.getAttribute("data-id") ?? "") ? el.getAttribute("data-id") : "") },
      // The title when it was linked: what other readers of the HTML (search, Ollie, exports) see.
      label: { default: "", parseHTML: (el) => (el.textContent ?? "").slice(0, 200) },
      // A heading or block of that page (#block id), as Obsidian's [[page#heading]].
      block: { default: "", parseHTML: (el) => el.getAttribute("data-block") ?? "" },
    };
  },
  // Before the link mark's a[href], which would otherwise take it as a plain link.
  parseHTML: () => [{ tag: 'a[data-type="page"]', priority: 100 }],
  renderHTML: ({ node }) => [
    "a",
    { "data-type": "page", "data-id": node.attrs.id, ...(node.attrs.block ? { "data-block": node.attrs.block } : {}), href: `/wiki/${node.attrs.id}${node.attrs.block ? `#${node.attrs.block}` : ""}` },
    node.attrs.label || "Untitled",
  ],
  renderText: ({ node }) => `[[${node.attrs.label || "Untitled"}]]`,
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { as: "span" });
  },
});

/** A date, inline: today, tomorrow, a day picked; a reminder's anchor later. */
export const DateMention = Node.create({
  name: "dateMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      date: { default: "", parseHTML: (el) => (/^\d{4}-\d{2}-\d{2}$/.test(el.getAttribute("datetime") ?? "") ? el.getAttribute("datetime") : "") },
    };
  },
  parseHTML: () => [{ tag: 'time[data-type="date"]' }],
  renderHTML: ({ node }) => ["time", { "data-type": "date", datetime: node.attrs.date }, node.attrs.date],
  renderText: ({ node }) => node.attrs.date,
  addNodeView() {
    return ReactNodeViewRenderer(DateView, { as: "span" });
  },
});

/** Text in one of the soft tones. */
export const TextTone = Mark.create({
  name: "textTone",
  addAttributes() {
    return { tone: { default: "gray", parseHTML: (el) => el.getAttribute("data-color"), renderHTML: (a) => ({ "data-color": a.tone }) } };
  },
  parseHTML: () => [{ tag: "span[data-color]", getAttrs: (el) => (isTone((el as HTMLElement).getAttribute("data-color")) ? null : false) }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
  addCommands() {
    return {
      setTextTone:
        (tone) =>
        ({ commands }) =>
          tone ? commands.setMark(this.name, { tone }) : commands.unsetMark(this.name),
    };
  },
});

/** A highlight behind text, in one of the soft tones. */
export const HighlightTone = Mark.create({
  name: "highlightTone",
  addAttributes() {
    return { tone: { default: "yellow", parseHTML: (el) => el.getAttribute("data-bg"), renderHTML: (a) => ({ "data-bg": a.tone }) } };
  },
  parseHTML: () => [
    { tag: "mark[data-bg]", getAttrs: (el) => (isTone((el as HTMLElement).getAttribute("data-bg")) ? null : false) },
    // A plain <mark> (pasted, or ==text== in Markdown) is yellow.
    { tag: "mark", getAttrs: () => ({ tone: "yellow" }) },
  ],
  renderHTML: ({ HTMLAttributes }) => ["mark", HTMLAttributes, 0],
  addCommands() {
    return {
      setHighlightTone:
        (tone) =>
        ({ commands }) =>
          tone ? commands.setMark(this.name, { tone }) : commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Shift-h": () => this.editor.commands.toggleMark(this.name, { tone: "yellow" }) };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|\s)==([^=]+)==$/,
        handler: ({ state, range, match }) => {
          const start = range.from + match[0].indexOf("==");
          const inner = match[1];
          const tr = state.tr;
          tr.replaceWith(start, range.to, state.schema.text(inner, [state.schema.marks[this.name].create({ tone: "yellow" })]));
        },
      }),
    ];
  },
});

/** A teammate, inline: the HTML notes and articles already use for mentions. The "@" menu inserts it. */
export const PersonMention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: "", parseHTML: (el) => el.getAttribute("data-id") ?? el.getAttribute("data-mention") ?? "" },
      label: { default: "", parseHTML: (el) => (el.textContent ?? "").replace(/^@/, "") },
    };
  },
  parseHTML: () => [{ tag: 'span[data-type="mention"]' }, { tag: "span[data-mention]" }],
  renderHTML: ({ node }) => ["span", { "data-type": "mention", "data-id": node.attrs.id, class: "mention" }, `@${node.attrs.label}`],
  renderText: ({ node }) => `@${node.attrs.label}`,
});
