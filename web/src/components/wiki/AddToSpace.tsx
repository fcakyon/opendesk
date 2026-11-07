// "Add to sidebar" and "Add to Space" in a wiki page's menus: the page in Favorites or one of
// the member's own sidebar sections (components/collab/AddToSidebar.tsx), or as a row of one
// of the person's Spaces (contracts/spaces.md, kind wiki_page), at the end of its first section.

import { Check, SquareStack } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSub } from "@/components/ui/menu";
import { useSpaceActions } from "@/components/spaces/actions";
import { useSession } from "@/lib/session";
import { useSpaces } from "@/lib/spaces/hooks";
import { AddToSidebar } from "@/components/collab/AddToSidebar";
import { useFavorites, useWikiTree } from "./hooks";
import { addItems, hasItem, replaceSpace } from "@/lib/spaces/model";

export function AddToSpace({ pageId }: { pageId: string }) {
  const { t } = useTranslation("wiki");
  const wid = useSession((s) => s.workspaceId) ?? "";
  const { spaces } = useSpaces();
  const { put } = useSpaceActions(spaces);
  const favorites = useFavorites();
  const node = useWikiTree().data?.find((n) => n.id === pageId);
  if (!wid) return null;
  const item = { workspace_id: wid, kind: "wiki_page" as const, id: pageId };
  const sidebar = <AddToSidebar item={{ kind: "wiki_page", id: pageId }} favorite={node ? { on: favorites.has(pageId), toggle: () => favorites.toggle(node) } : undefined} />;
  if (!spaces?.length) return sidebar;
  return (
    <>
    {sidebar}
    <MenuSub icon={<SquareStack />} label={t("spaces.addTo")}>
      {spaces.map((s) => {
        const there = hasItem(s, item);
        return (
          <MenuItem key={s.id} disabled={there} icon={there ? <Check /> : undefined} onSelect={() => put(replaceSpace(spaces, addItems(s, null, [item])))}>
            {s.name}
          </MenuItem>
        );
      })}
    </MenuSub>
    </>
  );
}
