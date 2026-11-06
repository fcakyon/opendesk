// The wiki editor's typed menus, all drawn by one popup: "/" for blocks, "[[" for a link to
// a page (Obsidian's), "@" for people, pages and dates (Notion's), ":" for emoji. Tiptap's
// Suggestion finds the query; each item knows what it does with the typed range.

import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { placeBelowOrAbove, useCaretAnchor } from "@/components/editor/anchor";
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
  title: string;
  empty: string;
  items: MenuItem[];
  index: number;
  getRect: (() => DOMRect | null) | null;
  anchorEl: HTMLElement | null;
  pick: ((item: MenuItem) => void) | null;
};

export const useWikiMenu = create<MenuState>(() => ({ open: false, title: "", empty: "", items: [], index: 0, getRect: null, anchorEl: null, pick: null }));
const dismiss = () => useWikiMenu.setState({ open: false });

function renderer(labels: () => { title: string; empty: string }): SuggestionOptions<MenuItem>["render"] {
  return () => ({
    onStart: (p: SuggestionProps<MenuItem>) => {
      useWikiMenu.setState({ open: true, ...labels(), items: p.items, index: 0, getRect: p.clientRect ?? null, anchorEl: p.editor.view.dom, pick: (i) => p.command(i) });
    },
    onUpdate: (p: SuggestionProps<MenuItem>) => {
      useWikiMenu.setState((s) => ({ open: true, items: p.items, index: Math.min(s.index, Math.max(0, p.items.length - 1)), getRect: p.clientRect ?? s.getRect, pick: (i) => p.command(i) }));
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const s = useWikiMenu.getState();
      if (!s.open) return false;
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
        useWikiMenu.setState({ index: (s.index - 1 + s.items.length) % s.items.length });
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        s.pick?.(s.items[s.index]);
        return true;
      }
      return false;
    },
    onExit: () => useWikiMenu.setState({ open: false, pick: null, getRect: null, anchorEl: null }),
  });
}

export type TypedMenu = {
  name: string;
  char: string;
  /** Only where a word starts (a space or the line's start before it). */
  allowSpaces?: boolean;
  startOfLine?: boolean;
  items: (query: string, editor: Editor) => MenuItem[];
  labels: () => { title: string; empty: string };
};

/** One extension per trigger; they share the popup. Never inside code. */
export function typedMenu(m: TypedMenu) {
  const key = new PluginKey(`wiki-menu-${m.name}`);
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
          items: ({ query, editor }) => m.items(query, editor),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: renderer(m.labels),
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

/** The floating list; mount once beside the editor. */
export function WikiMenuPopup() {
  const { open, title, empty, items, index, getRect, anchorEl, pick } = useWikiMenu();
  const ref = useRef<HTMLDivElement>(null);
  const rect = useCaretAnchor({ open, getRect, anchorEl, popupRef: ref, onDismiss: dismiss });
  useEffect(() => {
    ref.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (!open || !rect) return null;
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={title}
      data-floating
      style={placeBelowOrAbove(rect, 320, 360)}
      className="z-[80] max-h-[360px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-line bg-raised p-1 shadow-pop animate-pop-in"
    >
      {items.length === 0 ? (
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
    </div>,
    document.body,
  );
}
