// A database row opened beside its database (Notion's side peek): the row's page in a
// drawer, its properties and text editable, with a way to open it as a full page.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { q } from "@/lib/queries";
import { PageScreen } from "@/pages/wiki/WikiPageView";
import { useTitle } from "../hooks";

export function RowPeek({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const page = useQuery({ ...q.wikiPage(id ?? ""), enabled: !!id });
  return (
    <Drawer
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={page.data ? title(page.data.title) : t("db.row")}
      width={820}
      header={
        <div className="flex items-center gap-1">
          <Tooltip content={t("db.openAsPage")}>
            <Link to="/wiki/$pageId" params={{ pageId: id ?? "" }} onClick={onClose} aria-label={t("db.openAsPage")} className="flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
              <Maximize2 className="size-3.5" />
            </Link>
          </Tooltip>
          <span className="truncate text-[12.5px] text-fg-3">{page.data ? title(page.data.title) : ""}</span>
        </div>
      }
    >
      {page.data ? (
        <PageScreen key={page.data.id} page={page.data} peek />
      ) : (
        <div className="p-10">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="mt-4 h-3 w-full" />
        </div>
      )}
    </Drawer>
  );
}
