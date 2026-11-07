// A member's own sidebar section (contracts/collab.md SidebarPrefs `sections`): their title,
// folded like the built-in ones, and rows of anything the workspace offers, drawn as the
// sidebar draws its own (components/spaces/rows.tsx) with their live numbers. Rows drag to
// reorder, and into another own section. The header's ⋯ renames, adds rows, moves, folds
// and deletes; rows keep the Space row menu in the sidebar's words. "Add section" sits
// under the sections, shown on hover.

import { carriesSidebarRow, readSidebarDrag } from "@/lib/collab/sidebarDrag";
import { dropOnSidebar } from "@/lib/collab/sidebarEditModel";
import { ArrowDown, ArrowUp, ChevronsDownUp, ChevronsUpDown, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { lazy, Suspense, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Section } from "@/app/sidebarParts";
import { RenameRow, SpaceRowMenu } from "@/components/spaces/SpaceRowMenu";
import { buildRow, NavItemRow, useMailLocation, useRowLabels } from "@/components/spaces/rows";
import { useWaitingFor } from "@/components/tickets/useUrgentChats";
import { toast } from "@/components/ui/toast";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { SidebarSection, Space } from "@/lib/api/types";
import { useCollab } from "@/lib/collab/hooks";
import { asSpace, entryKey, moveEntry, ownKey, visibleEntries, withSpace } from "@/lib/collab/ownSections";
import { ownSectionsUi } from "@/lib/collab/ownSectionsUi";
import { cn } from "@/lib/cn";
import { useWorkspacesData } from "@/lib/spaces/hooks";
import { itemKey, moveItemTo, removeSection, reorderItems, updateItem, updateSection } from "@/lib/spaces/model";
import { useOwnSidebar } from "./AddToSidebar";

const LazyTeamspace = lazy(() => import("@/components/wiki/PagesSection").then((m) => ({ default: m.SpaceTeamspace })));

/** What a dragged row carries: its key and the section it comes from. */
const DRAG_TYPE = "application/x-od-own-row";
type Dragged = { key: string; from: string };

const readDrag = (e: DragEvent): Dragged | null => {
  try {
    const v = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Dragged;
    return typeof v?.key === "string" && typeof v.from === "string" ? v : null;
  } catch {
    return null;
  }
};
const carries = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || carriesSidebarRow(e);

const headerBtn =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 transition-opacity hover:bg-chrome-hover hover:text-fg group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

export function OwnSection({ section, first, rail }: { section: SidebarSection; first: boolean; rail: boolean }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const collab = useCollab();
  const folders = section.items.some((i) => i.kind === "folder");
  const wiki = section.items.some((i) => i.kind === "wiki_page" || i.kind === "wiki_space");
  const d = useWorkspacesData(wid ? [wid] : [], { folders: () => folders, wiki: () => wiki }).get(wid);
  const labels = useRowLabels();
  const here = useMailLocation();
  const waiting = useWaitingFor();
  const [renaming, setRenaming] = useState<string | null>(null);
  // Where a dragged row would land: before a row's key, or "" for the end.
  const [over, setOver] = useState<string | null>(null);

  const space = asSpace(prefs, wid);
  const sec = space.sections.find((s) => s.id === section.id);
  if (!sec || !d) return null;
  const save = (next: Space) => change(withSpace(prefs, next));
  const put = (list: Space[]) => list[0] && save(list[0]);
  const title = section.title || t("ownSections.untitled");
  const entries = visibleEntries(prefs, collab.enabled).map(entryKey);
  const at = entries.indexOf(ownKey(section.id));

  const drop = (e: DragEvent, before: string) => {
    const dragged = readDrag(e);
    setOver(null);
    // Something dragged in from the page (a page's or a list's title) is added where it lands.
    const outside = dragged ? null : readSidebarDrag(e);
    if (outside) {
      e.preventDefault();
      const row = { kind: outside.kind, id: outside.id };
      const r = dropOnSidebar(prefs, wid, { kind: "row", from: "page", key: itemKey({ workspace_id: wid, ...row }), row }, { kind: "row", section: ownKey(section.id), before: before || null }, () => []);
      if (r && "prefs" in r) change(r.prefs);
      else if (!sec.items.some((i) => i.kind === row.kind && i.id === row.id)) toast.error(t("ownSections.full"));
      return;
    }
    if (!dragged) return;
    e.preventDefault();
    let next = dragged.from === section.id ? space : moveItemTo(space, dragged.key, section.id);
    const keys = (next.sections.find((s) => s.id === section.id)?.items ?? []).map(itemKey).filter((k) => k !== dragged.key);
    const i = before ? keys.indexOf(before) : -1;
    keys.splice(i < 0 ? keys.length : i, 0, dragged.key);
    next = reorderItems(next, section.id, keys);
    save(next);
  };
  const dropZone = (before: string) =>
    rail
      ? {}
      : {
          onDragOver: (e: DragEvent) => {
            if (!carries(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (over !== before) setOver(before);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === before ? null : o));
          },
          onDrop: (e: DragEvent) => {
            e.stopPropagation();
            drop(e, before);
          },
        };
  const line = "relative before:pointer-events-none before:absolute before:inset-x-4 before:-top-px before:z-10 before:h-0.5 before:rounded-full before:bg-tone-blue-solid";

  // Deleted at once, with the way back in the toast.
  const remove = () => {
    const before = prefs;
    change(withSpace(prefs, removeSection(space, section.id)));
    toast.undo(t("edit.sectionDeleted", { name: title }), () => change(before), t("edit.undo"));
  };

  const action = (
    <div className="flex items-center gap-0.5">
      <Tooltip content={t("ownSections.addRows")}>
        <button type="button" aria-label={t("ownSections.addRows")} onClick={() => ownSectionsUi.add(section.id)} className={headerBtn}>
          <Plus className="size-3.5" />
        </button>
      </Tooltip>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label={t("ownSections.menu", { name: title })} className={headerBtn}>
            <Ellipsis className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-[200px]">
          <MenuItem icon={<Pencil />} onSelect={() => ownSectionsUi.name({ mode: "rename", id: section.id })}>
            {t("ownSections.rename")}
          </MenuItem>
          <MenuItem icon={<Plus />} onSelect={() => ownSectionsUi.add(section.id)}>
            {t("ownSections.addRows")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ArrowUp />} disabled={at <= 0} onSelect={() => change(moveEntry(prefs, ownKey(section.id), -1, collab.enabled))}>
            {t("ownSections.moveUp")}
          </MenuItem>
          <MenuItem icon={<ArrowDown />} disabled={at < 0 || at >= entries.length - 1} onSelect={() => change(moveEntry(prefs, ownKey(section.id), 1, collab.enabled))}>
            {t("ownSections.moveDown")}
          </MenuItem>
          <MenuItem
            icon={section.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            onSelect={() => save(updateSection(space, section.id, { collapsed: !section.collapsed }))}
          >
            {section.collapsed ? t("ownSections.expand") : t("ownSections.collapse")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} onSelect={remove}>
            {t("ownSections.delete")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );

  const rows = sec.items.map((item) => {
    const key = itemKey(item);
    if (item.kind === "wiki_space") {
      // A teamspace is its tree of pages, kept up to date.
      const team = d.teams?.find((x) => x.id === item.id);
      if (!team || !buildRow(item, d, { labels })) return null;
      return (
        <div key={key} className="flex flex-col gap-px">
          <Suspense fallback={null}>
            <LazyTeamspace team={team} />
          </Suspense>
        </div>
      );
    }
    const model = buildRow(item, d, { labels, here, waiting });
    if (!model) return null;
    if (renaming === key && !rail)
      return (
        <RenameRow
          key={key}
          initial={item.name ?? model.label}
          placeholder={model.label}
          label={t("ownSections.row.rename")}
          onDone={(v) => {
            setRenaming(null);
            if (v === null) return;
            const name = v.trim();
            save(updateItem(space, key, { name: !name || name === model.label ? null : name }));
          }}
        />
      );
    return (
      <div
        key={key}
        className={cn(over === key && line)}
        onDragStart={(e) => {
          if (rail) return;
          // The row's link drags as itself; it also carries which row it is.
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ key, from: section.id } satisfies Dragged));
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        {...dropZone(key)}
      >
        <NavItemRow
          model={model}
          rail={rail}
          prefs={prefs}
          own={item.badge}
          label={item.name}
          emoji={item.icon}
          place={`section:${section.id}`}
          menu={(row) => (
            <SpaceRowMenu spaces={[space]} space={space} item={item} model={model} put={put} onRename={() => setRenaming(key)} rail={rail} label={item.name || model.label} sidebar>
              {row}
            </SpaceRowMenu>
          )}
        />
      </div>
    );
  });
  const shown = rows.filter(Boolean);

  return (
    <div {...dropZone("")}>
      <Section
        id={`own-${section.id}`}
        label={title}
        rail={rail}
        first={first}
        folded={section.collapsed}
        onFold={(collapsed) => save(updateSection(space, section.id, { collapsed }))}
        icon={section.icon}
        action={action}
      >
        {shown}
        {!rail && !shown.length && (
          <button
            type="button"
            onClick={() => ownSectionsUi.add(section.id)}
            className="mx-2.5 flex h-7 w-[calc(100%-1.25rem)] items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-4 outline-none transition-colors hover:bg-chrome-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] [&>svg]:size-4"
          >
            <Plus />
            <span className="truncate">{t("ownSections.addRows")}</span>
          </button>
        )}
        {!rail && <div aria-hidden className={cn("h-1", over === "" && line)} />}
      </Section>
    </div>
  );
}

/** "Add section" under the sidebar's sections: quiet until the sidebar is hovered or it has focus (always shown in the drawer, which has no hover). */
export function AddSectionButton({ always }: { always?: boolean }) {
  const { t } = useTranslation("collab");
  return (
    <button
      type="button"
      onClick={() => ownSectionsUi.name({ mode: "new" })}
      className={cn(
        "mx-2.5 mt-4 flex h-7 w-[calc(100%-1.25rem)] items-center gap-2.5 rounded-md px-2 text-[12.5px] text-fg-4 opacity-0 outline-none transition-[opacity,color,background-color] duration-150 hover:bg-chrome-hover hover:text-fg-2 focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--focus)] group-hover/nav:opacity-100 motion-reduce:transition-none [&>svg]:size-3.5",
        always && "opacity-100",
      )}
    >
      <Plus />
      <span>{t("ownSections.addSection")}</span>
    </button>
  );
}
