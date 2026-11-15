// One row of the sidebar as the member arranges it, outside edit mode too: it drags (by the
// row itself, past a few pixels or a finger's hold; components/collab/SidebarDrag.tsx), a
// double-click or F2 renames it where it is, and its menu's Change icon opens the emoji picker
// on it. Its menu (RowMenu, SpaceRowMenu) reads what the row can do from useSidebarRow: rename
// in place, change its icon, move up or down.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { InlineRename, MENU_SETTLE_MS, SidebarDragCtx } from "@/app/sidebarParts";
import { IconPicker } from "@/components/wiki/IconPicker";
import { cn } from "@/lib/cn";
import type { EditSource } from "@/lib/collab/sidebarEditModel";
import { registerRowKeys, sidebarEdit, useSidebarEdit, type RowAction } from "@/lib/collab/sidebarEdit";
import { iconOf, nameOf, setIcon, setName } from "@/lib/collab/sidebarPrefs";
import { useOwnSidebar } from "./AddToSidebar";

/** The member's own name and emoji for a row. */
export type RowEdit = {
  /** The name it shows. */
  name: string;
  /** Its own name, which an empty one brings back. */
  placeholder: string;
  label: string;
  emoji?: string;
  onName: (name: string) => void;
  onIcon: (emoji: string) => void;
};

type RowCtx = {
  /** Its `data-sidebar-row` id: renaming and picking an icon name it. */
  id: string;
  edit?: RowEdit;
  /** Moves it one place up (-1) or down (1) among its section's rows; `dry` only says whether it can. */
  move?: (dir: -1 | 1, dry?: boolean) => boolean;
};

const Ctx = createContext<RowCtx | null>(null);

/** What the row a menu belongs to can do (null outside a SidebarRow). */
export function useSidebarRow(): RowCtx | null {
  return useContext(Ctx);
}

/**
 * A built-in row's name and emoji of the member's own (`names`, `icons` by its key as in
 * `hidden`): `own` is the row's own name, which an empty name brings back.
 */
export function useRowEdit(): (key: string, own: string) => RowEdit {
  const { t } = useTranslation("collab");
  const { prefs, change } = useOwnSidebar();
  return (key, own) => {
    const name = nameOf(prefs, key, own);
    return {
      name,
      placeholder: own,
      label: t("edit.rename", { name }),
      emoji: iconOf(prefs, key),
      onName: (v) => change(setName(prefs, key, v === own ? "" : v)),
      onIcon: (v) => change(setIcon(prefs, key, v)),
    };
  };
}

export function SidebarRow({
  id,
  source,
  label,
  edit,
  rail,
  scope = "sidebar",
  className,
  children,
}: {
  /** Unique in the sidebar: where the row sits and what it is ("inbox|ticket_folder:mine"). */
  id: string;
  /** What it drags as; left out, it does not drag. */
  source?: EditSource;
  label: string;
  edit?: RowEdit;
  rail: boolean;
  /** Whose rows it moves among: the workspace's own sidebar's, or a picked Space's. */
  scope?: "sidebar" | "space";
  className?: string;
  children: ReactElement;
}) {
  const drag = useContext(SidebarDragCtx);
  const renaming = useSidebarEdit((s) => s.renaming === id);
  const picking = useSidebarEdit((s) => s.picking === id);
  const live = !!drag && drag.scope === scope && !!source && !rail;
  const ctx = useMemo<RowCtx>(
    () => ({ id, edit, move: live ? (dir, dry) => drag!.step(source!, dir, dry) : undefined }),
    [id, edit, live, drag, source],
  );
  // Its keys while it has the focus (move, pin, hide, remove): the drag provider does them. Read
  // through a ref, so the row registers once and the keys always act on the latest prefs.
  const acts = useRef<((a: RowAction) => boolean) | null>(null);
  acts.current = live ? (a) => drag!.act(source!, a, label) : null;
  useEffect(() => registerRowKeys(id, (a) => acts.current?.(a) ?? false), [id]);

  if (renaming && edit && !rail)
    return (
      <RenameInPlace edit={edit}>
        {children}
      </RenameInPlace>
    );

  const rename = (e: MouseEvent) => {
    if (!edit || rail || (e.target as Element).closest("button:not([data-row-self])")) return;
    e.preventDefault();
    sidebarEdit.rename(id);
  };
  return (
    <Ctx.Provider value={ctx}>
      <div
        data-sidebar-row={id}
        data-renamable={edit && !rail ? "true" : undefined}
        onDoubleClick={rename}
        className={cn("relative", className)}
        {...(live ? drag!.row(source!, label) : undefined)}
      >
        {children}
        {picking && edit && <PickerHere value={edit.emoji} onChange={edit.onIcon} className="pointer-events-none absolute left-4 top-0 h-full w-5" />}
      </div>
    </Ctx.Provider>
  );
}

/**
 * The row being renamed: drawn as it is, its icon and indent included, with the name's field laid
 * over its label from where the label starts.
 */
function RenameInPlace({ edit, children }: { edit: RowEdit; children: ReactElement }) {
  const box = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(LABEL_LEFT);
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    // The innermost element showing the name is the label.
    const hits = [...root.querySelectorAll<HTMLElement>("span")].filter((el) => el.textContent?.trim() === edit.name.trim());
    const label = hits[hits.length - 1];
    if (label) setLeft(Math.max(0, Math.round(label.getBoundingClientRect().left - root.getBoundingClientRect().left) - 5));
  }, [edit.name]);
  return (
    <div ref={box} className="relative">
      <div aria-hidden inert className="pointer-events-none">
        {children}
      </div>
      <div className="absolute inset-y-0 right-2.5 flex items-center" style={{ left }}>
        <InlineRename
          initial={edit.name}
          placeholder={edit.placeholder}
          label={edit.label}
          onDone={(v) => {
            sidebarEdit.done();
            if (v !== null && v !== edit.name) edit.onName(v === edit.placeholder ? "" : v);
          }}
        />
      </div>
    </div>
  );
}

/** Where a top-level row's label starts, until the row is measured. */
const LABEL_LEFT = 36;

/**
 * The emoji picker opened from a menu, on the row or section it is for. The menu closing gives
 * the focus back to its ⋯ just after it opens, which is not the person closing the picker.
 */
export function PickerHere({ value, onChange, className }: { value?: string; onChange: (emoji: string) => void; className: string }) {
  const [opened] = useState(() => Date.now());
  return (
    <IconPicker
      value={value ?? ""}
      onChange={(v) => {
        onChange(v);
        sidebarEdit.done();
      }}
      open
      onOpenChange={(o) => {
        if (!o && Date.now() - opened > MENU_SETTLE_MS) sidebarEdit.done();
      }}
      trigger={<span aria-hidden className={className} />}
    />
  );
}
