// "Add to sidebar" in a row's menus: Favorites, each of the member's own sections (a check
// where the row is; picking another moves it, picking it again takes it out) and a new
// section with the row in it. The same items in the ⋯ dropdown and the right-click menu.

import { BookmarkPlus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuChoice, ContextMenuItem, ContextMenuSeparator, ContextMenuSub } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Menu, MenuChoice, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import type { SidebarPin, SidebarPrefs } from "@/lib/api/types";
import { isPinned, MAX_PINS, togglePin } from "@/lib/collab/sidebarPrefs";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { hasRoom, sectionOf, toggleInSection } from "@/lib/collab/ownSections";
import { ownSectionsUi, type OwnRow } from "@/lib/collab/ownSectionsUi";
import { useSession } from "@/lib/session";

/** The open workspace's sidebar prefs and a save that says when it fails. */
export function useOwnSidebar() {
  const { t } = useTranslation("collab");
  const prefs = useSidebarPrefs();
  const wid = useSession((s) => s.workspaceId) ?? "";
  const save = useSaveSidebarPrefs();
  const change = (next: SidebarPrefs) => {
    if (next !== prefs) save.mutate(next, { onError: (e) => toast.error(e, t("customize.saveFailed")) });
  };
  return { prefs, wid, change };
}

const dropdown = { Sub: MenuSub, Choice: MenuChoice, Item: MenuItem, Separator: MenuSeparator };
const context = { Sub: ContextMenuSub, Choice: ContextMenuChoice, Item: ContextMenuItem, Separator: ContextMenuSeparator };

type Favorite = { on: boolean; toggle: () => void; disabled?: boolean };

/** The choices themselves: Favorites, the member's own sections, a new section. */
function AddToSidebarItems({ item, favorite, inContext }: { item: OwnRow; favorite?: Favorite; inContext?: boolean }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const P = inContext ? context : dropdown;
  const here = sectionOf(prefs, wid, item);
  return (
    <>
      {favorite && (
        <P.Choice checked={favorite.on} onSelect={favorite.disabled && !favorite.on ? () => undefined : favorite.toggle}>
          {t("nav.favorites")}
        </P.Choice>
      )}
      {prefs.sections.map((s) => (
        <P.Choice
          key={s.id}
          checked={here?.id === s.id}
          onSelect={() => {
            if (here?.id !== s.id && !hasRoom(prefs, s.id, !!here)) return toast.error(t("ownSections.full"));
            change(toggleInSection(prefs, wid, s.id, item));
          }}
        >
          {s.title || t("ownSections.untitled")}
        </P.Choice>
      ))}
      {(favorite || prefs.sections.length > 0) && <P.Separator />}
      <P.Item icon={<Plus />} onSelect={() => ownSectionsUi.name({ mode: "new", item })}>
        {t("ownSections.newSection")}
      </P.Item>
    </>
  );
}

/** "Add to sidebar" as a submenu of a row's or a page's menu. */
export function AddToSidebar({
  item,
  favorite,
  inContext,
}: {
  item: OwnRow;
  /** Favorites, where the row can be one: checked when it is. */
  favorite?: Favorite;
  /** In the right-click menu rather than the ⋯ dropdown. */
  inContext?: boolean;
}) {
  const { t } = useTranslation("collab");
  const wid = useSession((s) => s.workspaceId);
  if (!wid) return null;
  const P = inContext ? context : dropdown;
  return (
    <P.Sub icon={<BookmarkPlus />} label={t("ownSections.addTo")}>
      <AddToSidebarItems item={item} favorite={favorite} inContext={inContext} />
    </P.Sub>
  );
}

/** "Add to sidebar" beside a page's title (an inbox folder, a team, a view): Favorites through its pin. */
export function AddToSidebarButton({ item }: { item: OwnRow & { kind: SidebarPin["kind"] } }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  if (!wid) return null;
  const pin: SidebarPin = { kind: item.kind, id: item.id };
  const on = isPinned(prefs, pin);
  return (
    <Menu>
      <Tooltip content={t("ownSections.addTo")}>
        <MenuTrigger asChild>
          <Button variant="ghost" size="sm" square aria-label={t("ownSections.addTo")} icon={<BookmarkPlus className="size-3.5" />} />
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" className="w-[220px]">
        <MenuLabel>{t("ownSections.addTo")}</MenuLabel>
        <AddToSidebarItems item={item} favorite={{ on, disabled: !on && prefs.pinned.length >= MAX_PINS, toggle: () => change(togglePin(prefs, pin)) }} />
      </MenuContent>
    </Menu>
  );
}
