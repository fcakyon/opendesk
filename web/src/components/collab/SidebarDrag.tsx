// Arranging the sidebar without edit mode: a row or a section's title drags as itself (past a
// few pixels with the mouse, after a short hold with a finger), lands where the same line edit
// mode draws shows, and follows edit mode's rules (lib/collab/sidebarEditModel.ts): sections
// among sections, a row within its section where the member orders it, into Favorites or into
// a section of their own. With a Space picked, its sections and rows move the same way.
//
// Rows and sections mark themselves as edit mode's do (`data-edit-section`, `data-edit-head`,
// `data-edit-row`), so the drop targets are read from what the sidebar shows.

import { GripVertical } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { SidebarDragCtx } from "@/app/sidebarParts";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import type { SidebarPrefs } from "@/lib/api/types";
import { toggleInSection } from "@/lib/collab/ownSections";
import type { RowAction } from "@/lib/collab/sidebarEdit";
import { canDrop, dropInSpace, dropOnSidebar, FAVORITES, type EditSource, type EditTarget } from "@/lib/collab/sidebarEditModel";
import { isPinned, MAX_PINS, setHidden, togglePin } from "@/lib/collab/sidebarPrefs";
import { useSpaces } from "@/lib/spaces/hooks";
import { pickedSpace, replaceSpace } from "@/lib/spaces/model";
import { usePickedSpaceId } from "@/lib/spaces/store";
import { useSpaceActions } from "@/components/spaces/actions";
import { useFavorites, useWikiTree } from "@/components/wiki/hooks";
import { useOwnSidebar } from "./AddToSidebar";
import { useEditDrag } from "./useEditDrag";

/** The sections the sidebar shows, top level only, in order. */
function sectionEls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-edit-section]")].filter((el) => {
    const outer = el.parentElement?.closest("[data-edit-section]");
    return !outer || !root.contains(outer);
  });
}

function sectionEl(root: HTMLElement, key: string): HTMLElement | null {
  return sectionEls(root).find((el) => el.dataset.editSection === key) ?? null;
}

/** A section's rows as they show, in order. */
function rowEls(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>("[data-edit-row]")].filter((el) => el.closest("[data-edit-section]") === section);
}

export function SidebarDragProvider({ rootRef, children }: { rootRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const { spaces } = useSpaces();
  const space = pickedSpace(spaces, usePickedSpaceId());
  const actions = useSpaceActions(spaces);
  const fav = useFavorites();
  const { tree } = useWikiTree();

  const rowsOf = useCallback(
    (key: string) => {
      const el = rootRef.current && sectionEl(rootRef.current, key);
      return el ? rowEls(el).map((r) => r.dataset.editRow ?? "") : [];
    },
    [rootRef],
  );
  const accepts = (s: EditSource, t: EditTarget) => (space ? (s.kind === "section" ? t.kind === "section" : t.kind === "row") : canDrop(prefs, wid, s, t));
  const apply = (s: EditSource, t: EditTarget) => {
    if (space && spaces) {
      const next = dropInSpace(space, s, t);
      if (next) actions.put(replaceSpace(spaces, next));
      return;
    }
    const r = dropOnSidebar(prefs, wid, s, t, rowsOf);
    if (!r) return;
    if ("prefs" in r) change(r.prefs);
    else if ("stars" in r) fav.reorder(r.stars);
    else {
      // A page dropped on Favorites is starred where it lands (the wiki keeps the list).
      const node = tree.byId.get(r.star);
      if (node) fav.place(node, r.before);
    }
  };
  const { drag, target, pressable } = useEditDrag<EditSource>({ root: rootRef, accepts, onDrop: apply });

  // One place up or down, from a row's or section's menu.
  const step = (source: EditSource, dir: -1 | 1, dry?: boolean): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    const keys = source.kind === "section" ? sectionEls(root).map((el) => el.dataset.editSection ?? "") : rowsOf(source.from);
    const i = keys.indexOf(source.key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return false;
    const before = dir < 0 ? keys[j] : (keys[j + 1] ?? null);
    const t: EditTarget = source.kind === "section" ? { kind: "section", before } : { kind: "row", section: source.from, before };
    if (!accepts(source, t)) return false;
    if (!dry) apply(source, t);
    return true;
  };

  // What a key does to the focused row (lib/collab/sidebarEdit.ts `actOnFocused`): move it, pin
  // or star it in Favorites, hide it in its built-in section, or take it out of Favorites or a
  // section of the member's own, with Undo for what takes something away.
  const undoable = (next: SidebarPrefs, message: string) => {
    const before = prefs;
    change(next);
    toast.undo(message, () => change(before), t("edit.undo"));
  };
  const act = (s: EditSource, action: RowAction, label: string): boolean => {
    if (s.kind !== "row") return false;
    if (action === "up" || action === "down") return step(s, action === "up" ? -1 : 1);
    if (space) return false;
    const node = s.page ? tree.byId.get(s.page) : undefined;
    if (action === "pin") {
      if (node) {
        fav.toggle(node);
        return true;
      }
      if (!s.pin || s.pin.kind === "view_section") return false;
      if (isPinned(prefs, s.pin)) undoable(togglePin(prefs, s.pin), t("edit.unpinned", { name: label }));
      else if (prefs.pinned.length >= MAX_PINS) toast.error(t("customize.pinLimit"));
      else change(togglePin(prefs, s.pin));
      return true;
    }
    if (action === "hide") {
      // A built-in section's row: its key is its hidden id.
      if (s.from === FAVORITES || s.from.startsWith("custom:")) return false;
      undoable(setHidden(prefs, s.key, true), t("edit.hidden", { name: label }));
      return true;
    }
    if (s.from === FAVORITES) {
      if (node) {
        fav.toggle(node);
        toast.undo(t("edit.unpinned", { name: label }), () => fav.toggle(node), t("edit.undo"));
        return true;
      }
      if (!s.pin) return false;
      undoable(togglePin(prefs, s.pin), t("edit.unpinned", { name: label }));
      return true;
    }
    if (s.from.startsWith("custom:") && s.row) {
      undoable(toggleInSection(prefs, wid, s.from.slice("custom:".length), s.row), t("edit.removed", { name: label }));
      return true;
    }
    return false;
  };

  const scope: "sidebar" | "space" = space ? "space" : "sidebar";
  const value = {
    scope,
    row: (source: EditSource, label: string) => ({ "data-edit-row": source.key, ...pressable(source, label) }),
    section: (key: string, label: string) => pressable({ kind: "section", key }, label),
    step,
    act,
  };

  return (
    <SidebarDragCtx.Provider value={value}>
      <div ref={rootRef} className="relative">
        {children}
        <DropLine rootRef={rootRef} target={target} />
      </div>
      {drag &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed z-[90] flex h-7 max-w-[220px] items-center gap-2 rounded-md bg-surface px-2.5 text-[12.5px] text-fg shadow-lg ring-1 ring-line"
            style={{ left: drag.x + 10, top: drag.y - 14 }}
          >
            <GripVertical className="size-3.5 shrink-0 text-fg-4" />
            <span className="truncate">{drag.label}</span>
          </div>,
          document.body,
        )}
    </SidebarDragCtx.Provider>
  );
}

/** The line where a drag would land, laid over the sidebar. */
function DropLine({ rootRef, target }: { rootRef: RefObject<HTMLDivElement | null>; target: EditTarget | null }) {
  const [top, setTop] = useState<number | null>(null);
  const key = useMemo(() => (target ? JSON.stringify(target) : ""), [target]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !target) return setTop(null);
    const base = root.getBoundingClientRect().top;
    const at = (y: number) => setTop(Math.round(y - base));
    if (target.kind === "section") {
      const els = sectionEls(root);
      const el = target.before === null ? null : els.find((x) => x.dataset.editSection === target.before);
      if (el) return at(el.getBoundingClientRect().top + (els.indexOf(el) === 0 ? -2 : -10));
      const last = els[els.length - 1];
      return last ? at(last.getBoundingClientRect().bottom + 4) : setTop(null);
    }
    const sec = sectionEl(root, target.section);
    if (!sec) return setTop(null);
    const rows = rowEls(sec);
    const el = target.before === null ? null : rows.find((r) => r.dataset.editRow === target.before);
    if (el) return at(el.getBoundingClientRect().top - 1);
    const last = rows[rows.length - 1];
    if (last) return at(last.getBoundingClientRect().bottom);
    const head = sec.querySelector<HTMLElement>("[data-edit-head]") ?? sec;
    at(head.getBoundingClientRect().bottom + 2);
    // `key` stands for the target's value: a new object for the same place draws nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rootRef]);
  if (top === null) return null;
  return <div aria-hidden className="pointer-events-none absolute inset-x-4 z-20 h-0.5 rounded-full bg-tone-blue-solid" style={{ top: top - 1 }} />;
}
