// The sidebar's own right-click menu (on its empty space and section headers; a row's menu
// is the row's): Edit sidebar, Add section and the customize dialog. And the one-time hint
// that the sidebar can be arranged, shown until the member edits it or dismisses it.

import { PencilRuler, Plus, SlidersHorizontal, X } from "lucide-react";
import { useState, type PointerEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useSidebarPrefs } from "@/lib/collab/hooks";
import { ownSectionsUi } from "@/lib/collab/ownSectionsUi";
import { dismissHint, hintDismissed, sidebarEdit } from "@/lib/collab/sidebarEdit";
import { collabUi } from "@/lib/collab/ui";
import { useSession } from "@/lib/session";
import { usePickedSpaceId } from "@/lib/spaces/store";

export function SidebarMenu({ enabled, children }: { enabled: boolean; children: ReactElement }) {
  const { t } = useTranslation("collab");
  const space = usePickedSpaceId();
  if (!enabled) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        // A long press on a row opens the row's menu alone, not this one as well.
        onPointerDown={(e: PointerEvent<HTMLElement>) => {
          if (e.pointerType !== "mouse" && (e.target as HTMLElement).closest("a, button")) e.preventDefault();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<PencilRuler />} onSelect={() => sidebarEdit.start()}>
          {t("edit.title")}
        </ContextMenuItem>
        {!space && (
          <ContextMenuItem icon={<Plus />} onSelect={() => ownSectionsUi.name({ mode: "new" })}>
            {t("ownSections.addSection")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem icon={<SlidersHorizontal />} onSelect={() => collabUi.customize(true)}>
          {t("edit.options")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** "Make the sidebar yours": once, while the member has arranged nothing, until they edit or dismiss it. */
export function EditHint() {
  const { t } = useTranslation("collab");
  const uid = useSession((s) => s.user?.id ?? "");
  const prefs = useSidebarPrefs();
  const space = usePickedSpaceId();
  const [gone, setGone] = useState(() => !uid || hintDismissed(uid));
  const untouched = !prefs.sections.length && !prefs.hidden.length && !Object.keys(prefs.row_order).length;
  if (gone || space || !untouched) return null;
  const close = () => {
    dismissHint(uid);
    setGone(true);
  };
  return (
    <div className="mx-2.5 mb-1 shrink-0 animate-rise-in rounded-lg bg-surface px-3 py-2.5 shadow-[0_0_0_1px_var(--line)] motion-reduce:animate-none">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] font-medium text-fg">{t("edit.hintTitle")}</p>
        <Tooltip content={t("edit.hintDismiss")}>
          <button type="button" aria-label={t("edit.hintDismiss")} onClick={close} className="-mr-1 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-fg-4 outline-none hover:bg-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)]">
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <p className="mt-0.5 text-[12px] leading-[17px] text-fg-3">{t("edit.hintBody")}</p>
      <Button
        size="xs"
        className="mt-2"
        icon={<PencilRuler />}
        onClick={() => {
          close();
          sidebarEdit.start();
        }}
      >
        {t("edit.title")}
      </Button>
    </div>
  );
}
