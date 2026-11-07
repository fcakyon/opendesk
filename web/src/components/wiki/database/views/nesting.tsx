// Sub-items in the table and list layouts: rows nested under their parent item, a disclosure
// to open a row's sub-items, and "Add sub-item" on hover, whose composer sits under the row's
// last sub-item. Board, gallery and the date layouts show every row flat.

import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import type { DbRow, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { buildTree, flattenTree, type FlatRow } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";

/** A line of a nested layout: a row, or the composer of a new sub-item. */
export type NestedLine = { kind: "row"; line: FlatRow } | { kind: "add"; parentId: string; depth: number };

/** How far each level of sub-items steps in. */
export const INDENT = 20;

/** The lines with the composer of a new sub-item under its parent's last open sub-item. */
export function withComposer(lines: readonly FlatRow[], adding: string | null): NestedLine[] {
  const out: NestedLine[] = [];
  let open: { id: string; depth: number } | null = null;
  for (const line of lines) {
    if (open && line.depth <= open.depth) {
      out.push({ kind: "add", parentId: open.id, depth: open.depth + 1 });
      open = null;
    }
    out.push({ kind: "row", line });
    if (line.row.id === adding) open = { id: line.row.id, depth: line.depth };
  }
  if (open) out.push({ kind: "add", parentId: open.id, depth: open.depth + 1 });
  return out;
}

/** A layout's nesting: on when the database has sub-items. */
export function useNesting(p: ViewProps) {
  const parentProp = p.db.sub_items?.parent;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  return {
    on: !!parentProp,
    adding,
    lines: (list: DbRow[]): NestedLine[] =>
      parentProp ? withComposer(flattenTree(buildTree(list, parentProp), open), adding) : list.map((row) => ({ kind: "row", line: { row, depth: 0, hasChildren: false, open: false } })),
    toggle: (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id]))),
    addUnder: (id: string) => {
      setOpen((s) => new Set([...s, id]));
      setAdding(id);
    },
    stopAdding: () => setAdding(null),
    /** A new row under a parent item, with the values of the group it is in. */
    create: (parentId: string, title: string, values?: Record<string, DbValue>) => (parentProp ? p.onCreate({ ...values, [parentProp]: [parentId] }, { title }) : Promise.resolve(null)),
  };
}

export type Nesting = ReturnType<typeof useNesting>;

/** A row's disclosure: open or close its sub-items; a space for a row without any. */
export function Disclosure({ line, onToggle }: { line: FlatRow; onToggle: () => void }) {
  const { t } = useTranslation("wiki");
  if (!line.hasChildren) return <span className="size-5 shrink-0" aria-hidden />;
  return (
    <button
      type="button"
      aria-expanded={line.open}
      aria-label={line.open ? t("db.subItems.collapse") : t("db.subItems.expand")}
      onClick={(e) => (e.stopPropagation(), onToggle())}
      onKeyDown={(e) => e.stopPropagation()}
      className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 outline-none hover:bg-active hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    >
      <ChevronRight className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", line.open && "rotate-90")} />
    </button>
  );
}

/** "Add sub-item", shown while the row is hovered or the button has focus. */
export function AddSubItem({ onAdd, group }: { onAdd: () => void; group: "title" | "line" }) {
  const { t } = useTranslation("wiki");
  return (
    <Tooltip content={t("db.subItems.add")}>
      <button
        type="button"
        aria-label={t("db.subItems.add")}
        onClick={(e) => (e.stopPropagation(), onAdd())}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-3 opacity-0 shadow-xs outline-none transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--focus)] [@media(hover:none)]:opacity-100",
          group === "title" ? "group-hover/title:opacity-100" : "group-hover/line:opacity-100",
        )}
      >
        <Plus className="size-3.5" />
      </button>
    </Tooltip>
  );
}
