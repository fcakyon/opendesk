// What the wiki editor's typed menus offer (menu.tsx): the "/" blocks, "[[" pages, "@"
// people, contacts, tickets, pages and dates, "#" tickets, ":" emoji. Lists built from what
// the page knows, plus what the API finds for a query; the editor component passes its
// getters in so the lists stay current without remounting.

import type { Editor, Range } from "@tiptap/core";
import type { TFunction } from "i18next";
import {
  AtSign,
  BellRing,
  Bookmark,
  CalendarDays,
  Code2,
  Columns2,
  Columns3,
  Columns4,
  FileText,
  FilePlus2,
  Film,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Lightbulb,
  Link2,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  ListTree,
  Minus,
  Music,
  Paperclip,
  Pilcrow,
  Quote,
  Sigma,
  Smile,
  Table,
  Table2,
  KanbanSquare,
  LayoutGrid,
  GanttChart,
  Database as DatabaseIcon,
  Hash,
  ListChecks,
  MousePointerClick,
  Repeat2,
  Superscript,
  Workflow,
} from "lucide-react";
import type { Contact, DbViewType, Member, SearchResults, Ticket, WikiNode } from "@/lib/api/types";
import { OllieMark } from "@/components/assistant/OllieMark";
import { StatusIcon } from "@/components/indicators";
import { Avatar } from "@/components/ui/avatar";
import { parseTicketQuery, ticketsForNumber } from "@/lib/wiki/desk";
import { newReminderId } from "@/lib/wiki/reminder";
import { openViewPickerNext } from "./desk";
import { EMOJI, searchEmoji } from "../emoji";
import { bestName, rank, type MenuItem } from "./menu";
import { TONES } from "./tones";

export type MenuSources = {
  t: TFunction<"wiki">;
  pages: () => WikiNode[];
  members: () => Member[];
  /** The page being edited: never offered as a link to itself. */
  pageId: () => string;
  /** Makes a page under this one and resolves to its id. */
  createSubpage: (title?: string) => Promise<string | null>;
  /** Opens a page just made from here, once this page has saved the block that leads to it. */
  openSubpage: (id: string) => void;
  /** Asks for an image file and inserts it at the cursor. */
  pickImage: () => void;
  /** Makes a database inside the page, shown as a layout, and resolves to it. */
  createDatabase: (type: DbViewType) => Promise<{ id: string; view: string } | null>;
  untitled: string;
  /** The app's search (tickets and contacts the reader can see). */
  search: (q: string) => Promise<SearchResults>;
  /** One ticket by number, or null when there is none the reader can see. */
  ticket: (ref: string) => Promise<Ticket | null>;
  /** Ollie can write here: AI is on for the workspace and the page is editable. */
  ollie: () => boolean;
  /** Opens Ollie's prompt at the cursor. */
  askOllie: () => void;
};

const clear = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

function pageLabel(n: WikiNode, s: MenuSources) {
  return n.title.trim() || s.untitled;
}

/** The pages' paths, for the sub line: "Support handbook / Refunds". */
function pathOf(n: WikiNode, byId: Map<string, WikiNode>, s: MenuSources): string {
  const parts: string[] = [];
  let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
  while (cur && parts.length < 4) {
    parts.unshift(pageLabel(cur, s));
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(" / ");
}

export function pageItems(query: string, s: MenuSources, insert: (editor: Editor, range: Range, n: WikiNode) => void, opts: { group?: string; limit?: number } = {}): MenuItem[] {
  const all = s.pages().filter((n) => n.id !== s.pageId());
  const byId = new Map(all.map((n) => [n.id, n]));
  const recent = query.trim() ? all : [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return rank(query, recent, (n) => [bestName(query, pageLabel(n, s), n.aliases), pathOf(n, byId, s)])
    .slice(0, opts.limit ?? 8)
    .map((n) => ({
      id: `page-${n.id}`,
      group: opts.group,
      label: pageLabel(n, s),
      sub: pathOf(n, byId, s) || undefined,
      icon: n.icon ? <span className="text-[16px] leading-none">{n.icon}</span> : <FileText />,
      run: (editor: Editor, range: Range) => insert(editor, range, n),
    }));
}

const linkPage = (editor: Editor, range: Range, n: WikiNode) =>
  clear(editor, range)
    .insertContent([{ type: "pageLink", attrs: { id: n.id, label: n.title } }, { type: "text", text: " " }])
    .run();

const embedPage = (editor: Editor, range: Range, n: WikiNode) => clear(editor, range).insertContent({ type: "transclusion", attrs: { id: n.id } }).run();

/** "![[": a page to show in place (a synced block); its heading can be picked on the block. */
export function embedItems(query: string, s: MenuSources): MenuItem[] {
  return pageItems(query.replace(/\]+$/, "").replace(/#.*$/, ""), s, embedPage, { limit: 10 });
}

/** "[[": pages, and a new page named as typed. */
export function linkItems(query: string, s: MenuSources): MenuItem[] {
  const q = query.replace(/\]+$/, "");
  const found = pageItems(q, s, linkPage, { limit: 10 });
  const exact = s.pages().some((n) => n.title.trim().toLowerCase() === q.trim().toLowerCase());
  if (q.trim() && !exact)
    found.push({
      id: "new-page",
      label: s.t("editor.newPageNamed", { title: q.trim() }),
      icon: <FilePlus2 />,
      run: async (editor, range) => {
        const id = await s.createSubpage(q.trim());
        if (id) linkPage(editor, range, { id, title: q.trim() } as WikiNode);
      },
    });
  return found;
}

function today(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const insertDate = (date: string) => (editor: Editor, range: Range) =>
  clear(editor, range)
    .insertContent([{ type: "dateMention", attrs: { date } }, { type: "text", text: " " }])
    .run();

/** "Remind me": tomorrow, with a reminder for whoever writes it (contracts/wiki.md "Reminders"). */
const insertReminder = (editor: Editor, range: Range) =>
  clear(editor, range)
    .insertContent([{ type: "dateMention", attrs: { date: today(1), reminder: newReminderId() } }, { type: "text", text: " " }])
    .run();

const insertTicket = (t: Ticket) => (editor: Editor, range: Range) =>
  clear(editor, range)
    .insertContent([{ type: "ticketMention", attrs: { id: t.id, number: t.number, label: t.subject.slice(0, 200) } }, { type: "text", text: " " }])
    .run();

export function ticketItem(t: Ticket, group?: string): MenuItem {
  return { id: `ticket-${t.id}`, group, label: t.subject, sub: t.contact?.name || t.contact?.email || undefined, hint: `#${t.number}`, icon: <StatusIcon status={t.status} />, run: insertTicket(t) };
}

export function contactItem(c: Contact, group?: string): MenuItem {
  const name = c.name || c.email || "";
  return {
    id: `contact-${c.id}`,
    group,
    label: name,
    sub: c.name && c.email ? c.email : c.company?.name,
    icon: <Avatar name={name} src={c.avatar_url} size="xs" />,
    run: (editor, range) =>
      clear(editor, range)
        .insertContent([{ type: "contactMention", attrs: { id: c.id, label: name.slice(0, 200) } }, { type: "text", text: " " }])
        .run(),
  };
}

/** "@" searches contacts and tickets once two letters are typed. */
export const mentionSearch = (s: MenuSources) => ({
  when: (q: string) => q.trim().length >= 2,
  run: async (q: string): Promise<MenuItem[]> => {
    const r = await s.search(q.trim());
    return [...r.contacts.slice(0, 4).map((c) => contactItem(c, s.t("desk.contacts"))), ...r.tickets.slice(0, 4).map((t) => ticketItem(t, s.t("desk.tickets")))];
  },
});

/** "#": a ticket by number ("#123"), or tickets found by words ("#refund"). */
export const ticketSearch = (s: MenuSources) => ({
  when: (q: string) => {
    const p = parseTicketQuery(q);
    return p.kind === "number" || (p.kind === "text" && p.text.length >= 2);
  },
  run: async (q: string): Promise<MenuItem[]> => {
    const p = parseTicketQuery(q);
    if (p.kind === "number") {
      const [exact, found] = await Promise.all([s.ticket(p.digits), s.search(p.digits).catch(() => null)]);
      return ticketsForNumber(p.digits, exact, found?.tickets ?? []).map((t) => ticketItem(t));
    }
    if (p.kind === "text") return (await s.search(p.text)).tickets.slice(0, 6).map((t) => ticketItem(t));
    return [];
  },
});

/** "@": people, contacts and tickets found, then dates, then pages. */
export function mentionItems(query: string, s: MenuSources, found: MenuItem[] = []): MenuItem[] {
  const t = s.t;
  const people = rank(
    query,
    s.members().filter((m) => m.role !== "viewer"),
    (m) => [m.user.name, m.user.email],
  )
    .slice(0, 5)
    .map<MenuItem>((m) => ({
      id: `user-${m.user.id}`,
      group: t("editor.menu.people"),
      label: m.user.name,
      sub: m.user.email,
      icon: <Avatar name={m.user.name} src={m.user.avatar_url} size="xs" />,
      run: (editor, range) =>
        clear(editor, range)
          .insertContent([{ type: "mention", attrs: { id: m.user.id, label: m.user.name } }, { type: "text", text: " " }])
          .run(),
    }));
  const dates = rank(
    query,
    [
      { id: "today", label: t("editor.today"), date: today(0) },
      { id: "tomorrow", label: t("editor.tomorrow"), date: today(1) },
      { id: "yesterday", label: t("editor.yesterday"), date: today(-1) },
      { id: "nextweek", label: t("editor.nextWeek"), date: today(7) },
    ],
    (d) => [d.label, "date day"],
  ).map<MenuItem>((d) => ({ id: `date-${d.id}`, group: t("editor.menu.dates"), label: d.label, hint: d.date, icon: <CalendarDays />, run: insertDate(d.date) }));
  const remind = rank(query, [{ id: "remind", label: t("reminder.remindMe") }], (d) => [d.label, "remind reminder alarm"]).map<MenuItem>((d) => ({
    id: d.id,
    group: t("editor.menu.dates"),
    label: d.label,
    hint: t("editor.tomorrow"),
    icon: <BellRing />,
    run: insertReminder,
  }));
  const pages = pageItems(query, s, linkPage, { group: t("editor.menu.pages"), limit: 5 });
  return [...people, ...found, ...dates.slice(0, 2), ...remind, ...pages];
}

/** ":": emoji, after two letters so "a:b" and times stay as typed. */
export function emojiItems(query: string): MenuItem[] {
  if (query.length < 2) return [];
  const found = searchEmoji(query).slice(0, 8);
  const words = new Map(EMOJI.flatMap((g) => g.emoji));
  return found.map((e) => ({
    id: `emoji-${e}`,
    label: (words.get(e) ?? "").split(" ")[0] ?? e,
    icon: <span className="text-[17px] leading-none">{e}</span>,
    run: (editor: Editor, range: Range) => clear(editor, range).insertContent(e).run(),
  }));
}

/** "/": every block, grouped, and the colours. */
export function slashItems(query: string, s: MenuSources): MenuItem[] {
  const t = s.t;
  const basic = t("editor.menu.basic");
  const media = t("editor.menu.media");
  const advanced = t("editor.menu.advanced");
  const inline = t("editor.menu.inline");
  const colors = t("editor.menu.colors");
  const databases = t("editor.menu.databases");
  const desk = t("desk.group");
  const database = (type: DbViewType) => async (e: Editor, r: Range) => {
    e.chain().focus().deleteRange(r).run();
    const made = await s.createDatabase(type);
    if (made) e.chain().focus().insertContent({ type: "database", attrs: { id: made.id, view: made.view } }).run();
  };
  type Def = Omit<MenuItem, "id"> & { id: string; words?: string };
  const defs: Def[] = [
    { id: "text", group: basic, label: t("editor.block.text"), icon: <Pilcrow />, words: "paragraph plain", run: (e, r) => clear(e, r).setParagraph().run() },
    { id: "h1", group: basic, label: t("editor.block.h1"), icon: <Heading1 />, hint: "#", words: "title big heading", run: (e, r) => clear(e, r).setHeading({ level: 1 }).run() },
    { id: "h2", group: basic, label: t("editor.block.h2"), icon: <Heading2 />, hint: "##", words: "heading subtitle", run: (e, r) => clear(e, r).setHeading({ level: 2 }).run() },
    { id: "h3", group: basic, label: t("editor.block.h3"), icon: <Heading3 />, hint: "###", words: "heading small", run: (e, r) => clear(e, r).setHeading({ level: 3 }).run() },
    ...([1, 2, 3] as const).map<Def>((level) => ({
      id: `toggleH${level}`,
      group: basic,
      label: t("editor.block.toggleHeading", { level }),
      icon: <ListCollapse />,
      words: `toggle heading collapse fold section h${level}`,
      run: (e, r) => clear(e, r).setToggleHeading(level).run(),
    })),
    { id: "bullet", group: basic, label: t("editor.block.bullet"), icon: <List />, hint: "-", words: "unordered bullets list", run: (e, r) => clear(e, r).toggleBulletList().run() },
    { id: "ordered", group: basic, label: t("editor.block.ordered"), icon: <ListOrdered />, hint: "1.", words: "numbers ordered list", run: (e, r) => clear(e, r).toggleOrderedList().run() },
    { id: "todo", group: basic, label: t("editor.block.todo"), icon: <ListTodo />, hint: "[]", words: "task checkbox check checklist", run: (e, r) => clear(e, r).toggleTaskList().run() },
    { id: "toggle", group: basic, label: t("editor.block.toggle"), icon: <ListCollapse />, hint: ">>", words: "details collapse fold accordion", run: (e, r) => clear(e, r).setDetails().run() },
    { id: "quote", group: basic, label: t("editor.block.quote"), icon: <Quote />, hint: ">", words: "blockquote citation", run: (e, r) => clear(e, r).toggleBlockquote().run() },
    { id: "callout", group: basic, label: t("editor.block.callout"), icon: <Lightbulb />, hint: ">!", words: "note tip warning info box admonition", run: (e, r) => clear(e, r).setCallout().run() },
    { id: "divider", group: basic, label: t("editor.block.divider"), icon: <Minus />, hint: "---", words: "hr separator line rule", run: (e, r) => clear(e, r).setHorizontalRule().run() },
    {
      id: "page",
      group: basic,
      label: t("editor.block.page"),
      icon: <FilePlus2 />,
      words: "subpage new child document",
      run: async (e, r) => {
        e.chain().focus().deleteRange(r).run();
        const id = await s.createSubpage();
        if (!id) return;
        e.chain().focus().insertContent({ type: "subpage", attrs: { id } }).run();
        // Like Notion, "/page" opens the new page; its block here and the breadcrumbs lead back.
        s.openSubpage(id);
      },
    },
    {
      id: "synced",
      group: basic,
      label: t("editor.block.synced"),
      icon: <Repeat2 />,
      hint: "![[",
      words: "embed page transclusion transclude synced block mirror include note heading section",
      run: (e, r) => clear(e, r).insertContent({ type: "transclusion" }).run(),
    },
    {
      id: "link",
      group: basic,
      label: t("editor.block.linkPage"),
      icon: <Link2 />,
      hint: "[[",
      words: "mention reference wikilink backlink",
      run: (e, r) => clear(e, r).insertContent("[[").run(),
    },
    { id: "image", group: media, label: t("editor.block.image"), icon: <ImageIcon />, words: "picture photo screenshot upload", run: (e, r) => (clear(e, r).run(), s.pickImage()) },
    { id: "video", group: media, label: t("editor.block.video"), icon: <Film />, words: "movie clip recording upload", run: (e, r) => clear(e, r).insertContent({ type: "video" }).run() },
    { id: "audio", group: media, label: t("editor.block.audio"), icon: <Music />, words: "sound voice recording mp3", run: (e, r) => clear(e, r).insertContent({ type: "audio" }).run() },
    { id: "file", group: media, label: t("editor.block.file"), icon: <Paperclip />, words: "attachment upload pdf document", run: (e, r) => clear(e, r).insertContent({ type: "file" }).run() },
    { id: "bookmark", group: media, label: t("editor.block.bookmark"), icon: <Bookmark />, words: "link card preview url web", run: (e, r) => clear(e, r).insertContent({ type: "bookmark" }).run() },
    {
      id: "embed",
      group: media,
      label: t("editor.block.embed"),
      icon: <Globe />,
      words: "youtube figma loom vimeo google docs sheets slides miro maps codepen spotify iframe",
      run: (e, r) => clear(e, r).insertContent({ type: "embed" }).run(),
    },
    { id: "dbTable", group: databases, label: t("editor.block.dbTable"), icon: <Table2 />, words: "database table spreadsheet rows inline", run: database("table") },
    { id: "dbBoard", group: databases, label: t("editor.block.dbBoard"), icon: <KanbanSquare />, words: "database board kanban columns status", run: database("board") },
    { id: "dbList", group: databases, label: t("editor.block.dbList"), icon: <List />, words: "database list", run: database("list") },
    { id: "dbGallery", group: databases, label: t("editor.block.dbGallery"), icon: <LayoutGrid />, words: "database gallery cards grid", run: database("gallery") },
    { id: "dbCalendar", group: databases, label: t("editor.block.dbCalendar"), icon: <CalendarDays />, words: "database calendar month dates", run: database("calendar") },
    { id: "dbTimeline", group: databases, label: t("editor.block.dbTimeline"), icon: <GanttChart />, words: "database timeline gantt roadmap", run: database("timeline") },
    { id: "dbLinked", group: databases, label: t("editor.block.dbLinked"), icon: <DatabaseIcon />, words: "linked database view existing", run: (e, r) => clear(e, r).insertContent({ type: "database" }).run() },
    {
      id: "tickets",
      group: desk,
      label: t("desk.ticketList"),
      icon: <ListChecks />,
      words: "tickets view queue inbox list desk",
      run: (e, r) => {
        openViewPickerNext();
        clear(e, r).insertContent({ type: "tickets" }).run();
      },
    },
    { id: "ticket", group: desk, label: t("desk.mentionTicket"), icon: <Hash />, hint: "#", words: "ticket mention conversation case", run: (e, r) => clear(e, r).insertContent("#").run() },
    { id: "table", group: advanced, label: t("editor.block.table"), icon: <Table />, words: "grid rows columns spreadsheet", run: (e, r) => clear(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "col2", group: advanced, label: t("editor.block.columns", { count: 2 }), icon: <Columns2 />, words: "layout side by side columns", run: (e, r) => clear(e, r).setColumns(2).run() },
    { id: "col3", group: advanced, label: t("editor.block.columns", { count: 3 }), icon: <Columns3 />, words: "layout columns", run: (e, r) => clear(e, r).setColumns(3).run() },
    { id: "col4", group: advanced, label: t("editor.block.columns", { count: 4 }), icon: <Columns4 />, words: "layout columns", run: (e, r) => clear(e, r).setColumns(4).run() },
    { id: "code", group: advanced, label: t("editor.block.code"), icon: <Code2 />, hint: "```", words: "snippet pre programming", run: (e, r) => clear(e, r).setCodeBlock().run() },
    { id: "math", group: advanced, label: t("editor.block.math"), icon: <Sigma />, hint: "$$$", words: "equation latex katex formula tex", run: (e, r) => clear(e, r).insertBlockMath({ latex: "" }).run() },
    {
      id: "mermaid",
      group: advanced,
      label: t("editor.block.mermaid"),
      icon: <Workflow />,
      words: "diagram flowchart chart sequence graph gantt mermaid",
      run: (e, r) => clear(e, r).setCodeBlock({ language: "mermaid" }).run(),
    },
    {
      id: "button",
      group: advanced,
      label: t("editor.block.button"),
      icon: <MousePointerClick />,
      words: "button action template insert todo link row automation",
      run: (e, r) => clear(e, r).insertContent({ type: "button" }).run(),
    },
    { id: "toc", group: advanced, label: t("editor.block.toc"), icon: <ListTree />, words: "table of contents outline headings index", run: (e, r) => clear(e, r).insertContent({ type: "toc" }).run() },
    { id: "mention", group: inline, label: t("editor.block.mention"), icon: <AtSign />, hint: "@", words: "person user teammate", run: (e, r) => clear(e, r).insertContent("@").run() },
    { id: "date", group: inline, label: t("editor.block.date"), icon: <CalendarDays />, words: "today day reminder when", run: insertDate(today(0)) },
    { id: "remind", group: inline, label: t("reminder.remindMe"), icon: <BellRing />, words: "remind reminder alarm notify tomorrow", run: insertReminder },
    { id: "footnote", group: inline, label: t("editor.block.footnote"), icon: <Superscript />, hint: "[^", words: "footnote note reference citation source", run: (e, r) => clear(e, r).insertFootnote().run() },
    { id: "inlineMath", group: inline, label: t("editor.block.inlineMath"), icon: <Sigma />, hint: "$$", words: "equation latex inline formula", run: (e, r) => clear(e, r).insertInlineMath({ latex: "x" }).run() },
    { id: "emoji", group: inline, label: t("editor.block.emoji"), icon: <Smile />, hint: ":", words: "emoticon smiley icon", run: (e, r) => clear(e, r).insertContent(":").run() },
    ...TONES.map<Def>((tone) => ({
      id: `color-${tone}`,
      group: colors,
      label: t(`editor.tone.${tone}`),
      icon: <span className="wiki-swatch-text" data-color={tone}>A</span>,
      words: `color colour text ${tone}`,
      run: (e, r) => clear(e, r).setTextTone(tone).run(),
    })),
    ...TONES.map<Def>((tone) => ({
      id: `bg-${tone}`,
      group: colors,
      label: t("editor.toneBackground", { tone: t(`editor.tone.${tone}`) }),
      icon: <span className="wiki-swatch-bg" data-bg={tone}>A</span>,
      words: `background highlight colour color ${tone}`,
      run: (e, r) => clear(e, r).setHighlightTone(tone).run(),
    })),
  ];
  if (s.ollie())
    defs.unshift({
      id: "ai",
      group: t("ollie.name"),
      label: t("ollie.askAtLine"),
      icon: <OllieMark size={16} eyes={false} />,
      hint: t("ollie.spaceHint"),
      words: "ai ollie write continue summarize assistant generate",
      run: (e, r) => {
        clear(e, r).run();
        s.askOllie();
      },
    });
  // The colours only show for a query: twenty swatches would bury the blocks.
  const list = query.trim() ? defs : defs.filter((d) => d.group !== colors);
  return rank(query, list, (d) => [d.label, `${d.words ?? ""} ${d.id}`]).map((d) => ({ ...d, group: query.trim() ? undefined : d.group }));
}
