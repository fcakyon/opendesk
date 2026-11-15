// The wiki's trash (/wiki/trash): pages moved to the trash, with what went with them, where
// they were and when they go for good. Restore puts one back; delete for good asks first.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { PageIcon } from "@/components/wiki/PageTree";
import { useDeleteRule, useRestorePage, useTitle } from "@/components/wiki/hooks";
import { inArea, pageTo, useArea } from "@/lib/wiki/area";
import { api } from "@/lib/api/endpoints";
import type { WikiTrashed } from "@/lib/api/types";
import { fullDate, relLong, shortDate } from "@/lib/format";
import { qk, q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { useNow } from "@/lib/useNow";
import { PagesButton } from "./WikiLayout";

export default function WikiTrashPage() {
  const { t } = useTranslation("wiki");
  const area = useArea();
  const { data: both, isLoading } = useQuery(q.wikiTrash());
  const data = both?.filter(inArea(area));
  const [term, setTerm] = useState("");
  const title = useTitle();
  useDocumentTitle(t("trash.title"));
  usePageCrumb(t("trash.title"));
  const shown = (data ?? []).filter((p) => !term.trim() || title(p.title).toLowerCase().includes(term.trim().toLowerCase()));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <PagesButton />
        <Trash2 className="size-4 text-fg-3" />
        <h1 className="text-[13px] font-medium text-fg">{t("trash.title")}</h1>
      </header>
      {isLoading ? (
        <div className="mx-auto w-full max-w-[760px] px-6 pt-10">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="mt-2 h-14 w-full" />
        </div>
      ) : !data?.length ? (
        <EmptyState art="wiki" title={t("trash.empty")} description={t("trash.emptyBody")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-6 pb-20 pt-8">
            <p className="mb-4 max-w-[560px] text-[13px] leading-5 text-fg-3">{t("trash.emptyBody")}</p>
            <SearchInput value={term} onChange={setTerm} placeholder={t("trash.search")} className="mb-3 max-w-[320px]" />
            {shown.length ? (
              <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
                {shown.map((p) => (
                  <TrashRow key={p.id} page={p} />
                ))}
              </ul>
            ) : (
              <p className="px-1 py-4 text-[12.5px] text-fg-3">{t("trash.noMatch")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TrashRow({ page }: { page: WikiTrashed }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const now = useNow();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const restore = useRestorePage();
  const canEdit = atLeast(useRole(), "agent");
  const rule = useDeleteRule()(page.id);
  const [busy, setBusy] = useState(false);
  const forever = () =>
    confirm.show(
      page.subpages ? t("delete.withSubpages", { count: page.subpages }) : t("delete.body"),
      async () => {
        await api.wiki.remove(page.id);
        qc.setQueryData<WikiTrashed[]>(qk.wikiTrash, (old) => old?.filter((x) => x.id !== page.id));
        qc.removeQueries({ queryKey: qk.wikiPage(page.id) });
        toast.success(t("toast.deleted", { title: title(page.title) }));
      },
      { title: t("delete.title", { title: title(page.title) }), confirmLabel: t("trash.deleteForever"), danger: true },
    );
  return (
    <li className="group flex items-center gap-3 px-3.5 py-2.5">
      <PageIcon icon={page.icon} className="size-5 text-[16px]" />
      <button type="button" onClick={() => void navigate(pageTo(page))} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-fg">
          {title(page.title)}
          {page.subpages > 0 && <span className="ml-1.5 font-normal text-fg-3">{t("trash.subpages", { count: page.subpages })}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-fg-4">
          {page.deleted_by && <Avatar name={page.deleted_by.name} src={page.deleted_by.avatar_url} size="xs" />}
          <span title={fullDate(page.deleted_at)}>{page.deleted_by ? t("trash.bannerBy", { name: page.deleted_by.name, when: relLong(page.deleted_at, now) }) : relLong(page.deleted_at, now)}</span>
          {page.path.length > 0 && <span className="truncate">· {t("trash.from", { path: page.path.map((x) => title(x.title)).join(" / ") })}</span>}
        </span>
      </button>
      <span className="hidden shrink-0 text-[11.5px] text-fg-4 sm:block" title={fullDate(page.purge_at)}>
        {t("trash.purge", { date: shortDate(page.purge_at) })}
      </span>
      {canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            icon={<RotateCcw />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const back = await restore(page.id);
              setBusy(false);
              if (back) qc.setQueryData<WikiTrashed[]>(qk.wikiTrash, (old) => old?.filter((x) => x.id !== page.id));
            }}
          >
            {t("trash.restore")}
          </Button>
          {rule === "yes" && (
            <Tooltip content={t("trash.deleteForever")}>
              <Button square size="sm" variant="ghost" aria-label={t("trash.deleteForever")} onClick={forever}>
                <Trash2 className="size-4 text-danger-fg" />
              </Button>
            </Tooltip>
          )}
        </span>
      )}
    </li>
  );
}
