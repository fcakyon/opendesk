// The wiki's templates (/wiki/templates): the team's own, made like any page and kept out of
// the tree, and the starter ones. Using one makes a new page from it, with its subpages.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LayoutTemplate, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { StarterTemplates } from "@/components/wiki/TemplateCards";
import { TrashItem } from "@/components/wiki/PageMenu";
import { PageIcon } from "@/components/wiki/WikiTree";
import { useCreatePage, useTitle } from "@/components/wiki/hooks";
import { TEMPLATES, templatePage } from "@/components/wiki/templates";
import { api } from "@/lib/api/endpoints";
import type { WikiNode } from "@/lib/api/types";
import { qk, q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { PagesButton } from "./WikiLayout";

/** Makes a page from a template of the team, beside it in its space, and opens it. */
export function useUseTemplate() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const title = useTitle();
  const { t } = useTranslation("wiki");
  return async (tpl: WikiNode, parent?: string | null) => {
    try {
      const page = await api.wiki.duplicate(tpl.id, { template: false, parent_id: parent ?? null, title: title(tpl.title) });
      qc.setQueryData(qk.wikiPage(page.id), page);
      void qc.invalidateQueries({ queryKey: qk.wikiTree });
      void navigate({ to: "/wiki/$pageId", params: { pageId: page.id } });
    } catch (e) {
      toast.error(e, t("templatesPage.failed"));
    }
  };
}

export default function WikiTemplatesPage() {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const canEdit = atLeast(useRole(), "agent");
  const create = useCreatePage();
  const use = useUseTemplate();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery(q.wikiTemplates());
  useDocumentTitle(t("templatesPage.title"));
  usePageCrumb(t("templatesPage.title"));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <PagesButton />
        <LayoutTemplate className="size-4 text-fg-3" />
        <h1 className="text-[13px] font-medium text-fg">{t("templatesPage.title")}</h1>
        {canEdit && (
          <Button variant="primary" size="sm" className="ml-auto" icon={<Plus />} loading={create.isPending} onClick={() => create.mutate({ template: true })}>
            {t("templatesPage.new")}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-20 pt-10 animate-rise-in motion-reduce:animate-none">
          <p className="max-w-[560px] text-[13px] leading-5 text-fg-3">{t("templatesPage.intro")}</p>
          <h2 className="label-caps mb-2 mt-8">{t("templatesPage.yours")}</h2>
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : data?.length ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.map((tpl) => (
                <div key={tpl.id} className="group flex items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-3 shadow-xs transition-[border-color] hover:border-line-strong">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken">
                    <PageIcon icon={tpl.icon} className="size-4 text-[16px]" />
                  </span>
                  <Link to="/wiki/$pageId" params={{ pageId: tpl.id }} className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg hover:underline">
                    {title(tpl.title)}
                  </Link>
                  {canEdit && (
                    <>
                      <Button
                        size="sm"
                        loading={busy === tpl.id}
                        onClick={async () => {
                          setBusy(tpl.id);
                          await use(tpl);
                          setBusy(null);
                        }}
                      >
                        {t("templatesPage.use")}
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button square size="sm" variant="ghost" aria-label={t("page.more")}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem icon={<Pencil />} onSelect={() => void navigate({ to: "/wiki/$pageId", params: { pageId: tpl.id } })}>
                            {t("templatesPage.edit")}
                          </MenuItem>
                          <MenuSeparator />
                          <TrashItem node={tpl} />
                        </MenuContent>
                      </Menu>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-fg-3">{t("templatesPage.yoursEmpty")}</p>
          )}
          {canEdit && <StarterTemplates ids={TEMPLATES.map((x) => x.id)} onPick={(id) => create.mutate(templatePage(t, id))} busy={create.isPending} compact />}
        </div>
      </div>
    </div>
  );
}
