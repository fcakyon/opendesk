// A sidebar section's ⋯ menu, on its title's hover: rename it where it is, give it an emoji,
// add rows (Favorites and the member's own sections), move it up or down, hide or delete it,
// and the ways into arranging the whole sidebar. Built-in sections, the member's own and a
// Space's sections all have it (app/sidebarParts.tsx Section).

import { ArrowDown, ArrowUp, Ellipsis, EyeOff, Pencil, PencilRuler, Plus, RotateCcw, SlidersHorizontal, SmilePlus, Trash2 } from "lucide-react";
import { useContext, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SidebarDragCtx, type SectionEdit } from "@/app/sidebarParts";
import { toast } from "@/components/ui/toast";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { SidebarSectionId } from "@/lib/api/types";
import { ownSectionsUi } from "@/lib/collab/ownSectionsUi";
import { sidebarEdit, useSidebarEdit } from "@/lib/collab/sidebarEdit";
import { hid, nameOf, sectionKey, setHidden, setIcon, setName } from "@/lib/collab/sidebarPrefs";
import { collabUi } from "@/lib/collab/ui";
import { useOwnSidebar } from "./AddToSidebar";
import { PickerHere } from "./SidebarRow";

const headerBtn =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 outline-none transition-opacity hover:bg-chrome-hover hover:text-fg group-hover/section:opacity-100 focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:opacity-100 data-[state=open]:bg-chrome-hover data-[state=open]:text-fg";

export function SectionMenu({
  id,
  name,
  dragKey,
  emoji,
  onIcon,
  onReset,
  onAdd,
  addLabel,
  onHide,
  onDelete,
  extra,
  top,
}: {
  /** Its `data-sidebar-row` id ("section:<key>"): renaming and the emoji picker name it. */
  id: string;
  name: string;
  /** Its key among the sections that drag: moving up and down needs it. */
  dragKey?: string;
  emoji?: string;
  onIcon: (emoji: string) => void;
  /** Brings back its own name and emoji, while it has ones of the member's own. */
  onReset?: () => void;
  onAdd?: () => void;
  addLabel?: string;
  onHide?: () => void;
  onDelete?: () => void;
  /** More of its own (fold, the member's section's moves). */
  extra?: ReactNode;
  /** What the section itself does, above arranging it (Pages: new page, import, its home). */
  top?: ReactNode;
}) {
  const { t } = useTranslation("collab");
  const drag = useContext(SidebarDragCtx);
  const picking = useSidebarEdit((s) => s.picking === id);
  const source = dragKey ? ({ kind: "section", key: dragKey } as const) : null;
  // Read when the menu opens: the sections as they show now.
  const canMove = (dir: -1 | 1) => !!drag && !!source && drag.step(source, dir, true);
  // Renaming and the picker open on the title: the closing menu leaves the focus with them.
  const keep = useRef(false);
  const here = (f: () => void) => () => {
    keep.current = true;
    setTimeout(f, 0);
  };
  return (
    <span className="relative flex">
      {picking && <PickerHere value={emoji} onChange={onIcon} className="pointer-events-none absolute inset-0" />}
      <Menu>
        <Tooltip content={t("ownSections.menu", { name })}>
          <MenuTrigger asChild>
            <button type="button" aria-label={t("ownSections.menu", { name })} className={headerBtn}>
              <Ellipsis className="size-3.5" />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent
          align="end"
          className="w-[210px]"
          onCloseAutoFocus={(e) => {
            if (!keep.current) return;
            keep.current = false;
            e.preventDefault();
          }}
        >
          {top && (
            <>
              {top}
              <MenuSeparator />
            </>
          )}
          <MenuItem icon={<Pencil />} onSelect={here(() => sidebarEdit.rename(id))}>
            {t("ownSections.rename")}
          </MenuItem>
          <MenuItem icon={<SmilePlus />} onSelect={here(() => sidebarEdit.pickIcon(id))}>
            {t("edit.pickIcon")}
          </MenuItem>
          {onReset && (
            <MenuItem icon={<RotateCcw />} onSelect={onReset}>
              {t("edit.resetName")}
            </MenuItem>
          )}
          {onAdd && (
            <MenuItem icon={<Plus />} onSelect={onAdd}>
              {addLabel ?? t("ownSections.addRows")}
            </MenuItem>
          )}
          {source && drag && (
            <>
              <MenuSeparator />
              <MenuItem icon={<ArrowUp />} disabled={!canMove(-1)} onSelect={() => drag.step(source, -1)}>
                {t("ownSections.moveUp")}
              </MenuItem>
              <MenuItem icon={<ArrowDown />} disabled={!canMove(1)} onSelect={() => drag.step(source, 1)}>
                {t("ownSections.moveDown")}
              </MenuItem>
            </>
          )}
          {extra}
          {(onHide || onDelete) && <MenuSeparator />}
          {onHide && (
            <MenuItem icon={<EyeOff />} onSelect={onHide}>
              {t("section.hide")}
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem icon={<Trash2 />} onSelect={onDelete}>
              {t("ownSections.delete")}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<PencilRuler />} onSelect={() => sidebarEdit.start()}>
            {t("edit.title")}
          </MenuItem>
          <MenuItem icon={<SlidersHorizontal />} onSelect={() => collabUi.customize(true)}>
            {t("rowMenu.customize")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}

/**
 * The built-in sections' name and menu, for SectionEditCtx: the member's own name and emoji
 * (`names`, `icons`), Favorites' Add, hiding with Undo, and moving in the workspace's own sidebar
 * (`movable`; a whole section in a Space moves with the Space's rows).
 */
export function useBuiltinSectionEdit(movable: boolean): (id: SidebarSectionId, label: string, top?: ReactNode) => SectionEdit {
  const { t } = useTranslation("collab");
  const { prefs, change } = useOwnSidebar();
  return (id, label, top) => {
    const key = sectionKey(id);
    const name = nameOf(prefs, key, label);
    const rid = `section:${id}`;
    return {
      key: rid,
      placeholder: label,
      renameLabel: t("edit.rename", { name }),
      onName: (v) => change(setName(prefs, key, v === label ? "" : v)),
      menu: (
        <SectionMenu
          id={rid}
          name={name}
          dragKey={movable ? id : undefined}
          top={top}
          emoji={prefs.icons[key]}
          onIcon={(v) => change(setIcon(prefs, key, v))}
          onReset={prefs.names[key] || prefs.icons[key] ? () => change(setIcon(setName(prefs, key, ""), key, "")) : undefined}
          onAdd={id === "favorites" ? () => ownSectionsUi.addFavorites() : undefined}
          addLabel={id === "favorites" ? t("edit.favoritesTitle") : undefined}
          onHide={() => {
            const before = prefs;
            change(setHidden(prefs, hid.section(id), true));
            toast.undo(t("edit.hidden", { name }), () => change(before), t("edit.undo"));
          }}
        />
      ),
    };
  };
}
