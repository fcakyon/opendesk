// The wiki editor's typed menus, all drawn by one popup: "/" for blocks, "[[" for a link to
// a page (Obsidian's), "@" for people, contacts, tickets, pages and dates (Notion's), "#" for
// tickets, ":" for emoji. Tiptap's Suggestion finds the query; each item knows what it does
// with the typed range. A menu that searches the API shows what it knows at once and adds
// what the search finds once the typing settles.

import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { placeBelowOrAbove, useCaretAnchor } from "@/components/editor/anchor";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

export type MenuItem = {
  id: string;
  /** A header shown above the first item of each group. */
  group?: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  /** Right-aligned: a Markdown shortcut, a path, a key. */
  hint?: string;
  run: (editor: Editor, range: Range) => void;
};

type MenuState = {
  open: boolean;
  /** The typed menu showing ("slash", "mention", ...). */
  menu: string;
  title: string;
  empty: string;
  searching: string;
  items: MenuItem[];
  /** -1: nothing picked yet, so Enter and Tab go on to the text. */
  index: number;
  /** A search is still out. */
  loading: boolean;
  /** Shown only with something to offer: "#" starts a tag as often as a ticket. */
  quiet: boolean;
  getRect: (() => DOMRect | null) | null;
  anchorEl: HTMLElement | null;
  pick: ((item: MenuItem) => void) | null;
};

export const useWikiMenu = create<MenuState>(() => ({ open: false, menu: "", title: "", empty: "", searching: "", items: [], index: 0, loading: false, quiet: false, getRect: null, anchorEl: null, pick: null }));
const dismiss = () => useWikiMenu.setState({ open: false });
/** The popup shows: open, and for a quiet menu, with items. */
const visible = (s: MenuState) => s.open && (!s.quiet || s.items.length > 0);

type Labels = { title: string; empty: string; searching?: string };

/** What one typed menu tracks between its updates. */
type Live = { query: string; editor: Editor | null; loading: boolean };

function renderer(m: TypedMenu, live: Live, stop: () => void): SuggestionOptions<MenuItem>["render"] {
  const first = (query: string, s: { index: number }, n: number) => {
    if (m.preselect && !m.preselect(query)) return -1;
    return Math.min(Math.max(s.index, 0), Math.max(0, n - 1));
  };
  return () => ({
    onStart: (p: SuggestionProps<MenuItem>) => {
      const labels = m.labels();
      useWikiMenu.setState({
        open: true,
        menu: m.name,
        title: labels.title,
        empty: labels.empty,
        searching: labels.searching ?? "",
        quiet: !!m.quiet,
        items: p.items,
        loading: live.loading,
        index: first(p.query, { index: 0 }, p.items.length),
        getRect: p.clientRect ?? null,
        anchorEl: p.editor.view.dom,
        pick: (i) => p.command(i),
      });
    },
    onUpdate: (p: SuggestionProps<MenuItem>) => {
      useWikiMenu.setState((s) => ({ open: true, items: p.items, loading: live.loading, index: first(p.query, s, p.items.length), getRect: p.clientRect ?? s.getRect, pick: (i) => p.command(i) }));
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const s = useWikiMenu.getState();
      if (!visible(s)) return false;
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (!s.items.length) return false;
      if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
        useWikiMenu.setState({ index: (s.index + 1) % s.items.length });
        return true;
      }
      if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
        useWikiMenu.setState({ index: s.index < 0 ? s.items.length - 1 : (s.index - 1 + s.items.length) % s.items.length });
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && s.index >= 0) {
        s.pick?.(s.items[s.index]);
        return true;
      }
      return false;
    },
    onExit: () => {
      stop();
      useWikiMenu.setState({ open: false, pick: null, getRect: null, anchorEl: null, loading: false });
    },
  });
}

export type TypedMenu = {
  name: string;
  char: string;
  /** Only where a word starts (a space or the line's start before it). */
  allowSpaces?: boolean;
  startOfLine?: boolean;
  /** The items for a query; `found` is what the search found for it, undefined while it runs. */
  items: (query: string, editor: Editor, found?: MenuItem[]) => MenuItem[];
  labels: () => Labels;
  /** Items from the API, for the queries `when` accepts; merged into `items` as they arrive. */
  search?: { when: (query: string) => boolean; run: (query: string) => Promise<MenuItem[]> };
  /** Whether the first item is picked as the menu opens (default yes); otherwise Enter types on. */
  preselect?: (query: string) => boolean;
  /** Hidden while it has nothing to offer. */
  quiet?: boolean;
};

/** How long typing must pause before a menu searches. */
const SEARCH_DELAY = 180;

/** One extension per trigger; they share the popup. Never inside code. */
export function typedMenu(m: TypedMenu) {
  const key = new PluginKey(`wiki-menu-${m.name}`);
  const live: Live = { query: "", editor: null, loading: false };
  const cache = new Map<string, MenuItem[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    cache.clear();
    live.loading = false;
  };
  const search = (query: string) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let found: MenuItem[] = [];
      try {
        found = (await m.search?.run(query)) ?? [];
      } catch {
        // A failed search offers what the menu knows without it.
      }
      cache.set(query, found);
      const s = useWikiMenu.getState();
      if (live.query !== query || !live.editor || !s.open || s.menu !== m.name) return;
      live.loading = false;
      const items = m.items(query, live.editor, found);
      useWikiMenu.setState({ items, loading: false, index: s.index < 0 ? -1 : Math.min(s.index, Math.max(0, items.length - 1)) });
    }, SEARCH_DELAY);
  };
  return Extension.create({
    name: `wikiMenu-${m.name}`,
    addProseMirrorPlugins() {
      return [
        Suggestion<MenuItem>({
          editor: this.editor,
          pluginKey: key,
          char: m.char,
          allowSpaces: m.allowSpaces ?? false,
          startOfLine: m.startOfLine ?? false,
          allowedPrefixes: [" ", "(", String.fromCharCode(160)],
          allow: ({ editor }) => editor.isEditable && !editor.isActive("codeBlock") && !editor.isActive("code"),
          items: ({ query, editor }) => {
            live.query = query;
            live.editor = editor;
            if (!m.search?.when(query)) {
              live.loading = false;
              clearTimeout(timer);
              return m.items(query, editor, []);
            }
            const hit = cache.get(query);
            live.loading = !hit;
            if (!hit) search(query);
            return m.items(query, editor, hit);
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: renderer(m, live, stop),
        }),
      ];
    },
  });
}

/** How well an item matches a query: its label first, then its words; 0 is no match. */
export function score(query: string, label: string, words = ""): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (words.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) return 40;
  if (l.includes(q)) return 20;
  // Letters in order ("h2" finds "Heading 2", "td" "To-do list").
  let i = 0;
  for (const c of l) if (c === q[i]) i++;
  return i === q.length ? 5 : 0;
}

export function rank<T>(query: string, list: T[], key: (x: T) => [string, string?]): T[] {
  if (!query.trim()) return list;
  return list
    .map((x, i) => ({ x, i, s: score(query, ...key(x)) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.x);
}

/** What a query finds a page by: its title or the alias it matches best (contracts/wiki.md "Aliases"). */
export function bestName(query: string, label: string, aliases: string[] = []): string {
  let best = label;
  for (const a of aliases) if (score(query, a) > score(query, best)) best = a;
  return best;
}

/** The floating list; mount once beside the editor. */
export function WikiMenuPopup() {
  const st = useWikiMenu();
  const { title, empty, searching, items, index, getRect, anchorEl, pick, loading } = st;
  const show = visible(st);
  const ref = useRef<HTMLDivElement>(null);
  const rect = useCaretAnchor({ open: show, getRect, anchorEl, popupRef: ref, onDismiss: dismiss });
  useEffect(() => {
    ref.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (!show || !rect) return null;
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={title}
      aria-busy={loading || undefined}
      data-floating
      style={placeBelowOrAbove(rect, 320, 360)}
      className="z-[80] max-h-[360px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-line bg-raised p-1 shadow-pop animate-pop-in"
    >
      {items.length === 0 && !loading ? (
        <div className="px-2.5 py-3 text-[12.5px] text-fg-3">{empty}</div>
      ) : (
        items.map((it, i) => (
          <div key={it.id}>
            {it.group && it.group !== items[i - 1]?.group && <div className={cn("label-caps px-2.5 pb-1", i === 0 ? "pt-1.5" : "pt-3")}>{it.group}</div>}
            <button
              type="button"
              data-i={i}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault();
                pick?.(it);
              }}
              onMouseMove={() => i !== index && useWikiMenu.setState({ index: i })}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left", it.sub ? "min-h-11" : "min-h-8", i === index && "bg-hover")}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-2 [&_svg]:size-4">{it.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">{it.label}</span>
                {it.sub && <span className="block truncate text-[11.5px] text-fg-4">{it.sub}</span>}
              </span>
              {it.hint && <span className="mono shrink-0 pr-1 text-[11px] text-fg-4">{it.hint}</span>}
            </button>
          </div>
        ))
      )}
      {loading && (
        <div role="status" className="flex h-8 items-center gap-2 px-2.5 text-[12px] text-fg-4">
          <Spinner className="size-3" />
          {searching}
        </div>
      )}
    </div>,
    document.body,
  );
}
