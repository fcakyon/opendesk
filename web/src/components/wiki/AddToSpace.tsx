// "Add to Space" in a wiki page's menus (contracts/spaces.md, kind wiki_page): the page as a
// row of one of the person's Spaces, at the end of its first section.

import { Check, SquareStack } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSub } from "@/components/ui/menu";
import { useSpaceActions } from "@/components/spaces/actions";
import { useSession } from "@/lib/session";
import { useSpaces } from "@/lib/spaces/hooks";
import { addItems, hasItem, replaceSpace } from "@/lib/spaces/model";

export function AddToSpace({ pageId }: { pageId: string }) {
  const { t } = useTranslation("wiki");
  const wid = useSession((s) => s.workspaceId) ?? "";
  const { spaces } = useSpaces();
  const { put } = useSpaceActions(spaces);
  if (!spaces?.length || !wid) return null;
  const item = { workspace_id: wid, kind: "wiki_page" as const, id: pageId };
  return (
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
  );
}
