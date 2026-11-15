// Pages' home (/pages, contracts/pages.md): ways to start something (a page, a database, a
// canvas, an import), then the member's favorites, the pages edited lately and the databases.
// A workspace without pages yet gets the shared empty state with the same ways in.

import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, FileText, FileUp, Hash, LayoutDashboard, MoreHorizontal, Network, Plus, Shuffle, Table2 } from "lucide-react";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { openImport, quickAdd } from "@/app/quickAdd";
import { Button } from "@/components/ui/button";
import { EmptyState, GhostList } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { starterDatabase } from "@/components/wiki/database/starter";
import { ExportWikiItems } from "@/components/wiki/Export";
import { useAreaTree, useCreatePage, useFavorites, useTitle } from "@/components/wiki/hooks";
import { PageIcon } from "@/components/wiki/PageTree";
import { StarterTemplates } from "@/components/wiki/TemplateCards";
import { TEMPLATES, templatePage } from "@/components/wiki/templates";
import type { WikiNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { fullDate, relLong } from "@/lib/format";
import { atLeast, useRole } from "@/lib/session";
import { inArea, pageTo } from "@/lib/wiki/area";
import { ancestorsOf, childrenOf, type Tree } from "@/lib/wiki/tree";
import { PagesButton } from "./WikiLayout";

export default function PagesHome() {
  const { t } = useTranslation("wiki");
  const { tree, data, isLoading } = useAreaTree();
  const canEdit = atLeast(useRole(), "agent");
  const create = useCreatePage();
  const navigate = useNavigate();
  useDocumentTitle(t("pages.title"));
  // Rows of a database are its own, not pages to list here.
  const databases = new Set((data ?? []).filter((n) => n.kind === "database").map((n) => n.id));
  const pages = (data ?? []).filter((n) => !n.parent_id || !databases.has(n.parent_id));
  const openRandom = () => {
    const pick = pages[Math.floor(Math.random() * pages.length)];
    if (pick) void navigate(pageTo(pick));
  };

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      <PagesButton />
      <h1 className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">{t("pages.title")}</h1>
      <div className="ml-auto flex items-center gap-0.5">
        {pages.length > 0 && (
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/pages/graph">
                <Network className="size-3.5" />
                {t("graph.title")}
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/pages/tags">
                <Hash className="size-3.5" />
                {t("tags.title")}
              </Link>
            </Button>
            <Tooltip content={t("home.random")}>
              <Button variant="ghost" size="sm" square aria-label={t("home.random")} onClick={openRandom}>
                <Shuffle className="size-4" />
              </Button>
            </Tooltip>
          </>
        )}
        <Menu>
          <Tooltip content={t("home.more")}>
            <MenuTrigger asChild>
              <Button variant="ghost" size="sm" square aria-label={t("home.more")}>
                <MoreHorizontal className="size-4" />
              </Button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end">
            {canEdit && (
              <MenuItem icon={<FileUp />} onSelect={() => openImport(null, { area: "pages" })}>
                {t("import.action")}
              </MenuItem>
            )}
            <ExportWikiItems />
          </MenuContent>
        </Menu>
        {canEdit && (
          <Button variant="primary" size="sm" className="ml-1.5" icon={<Plus />} onClick={() => quickAdd.page(undefined, "pages")}>
            {t("tree.newPage")}
          </Button>
        )}
      </div>
    </header>
  );

  const start = canEdit && (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Start icon={<FileText />} label={t("newPage.page")} hint={t("newPage.pageHint")} busy={create.isPending} onPick={() => create.mutate({})} />
      <Start icon={<Table2 />} label={t("newPage.database")} hint={t("newPage.databaseHint")} busy={create.isPending} onPick={() => create.mutate({ kind: "database", database: starterDatabase("table", t) })} />
      <Start icon={<LayoutDashboard />} label={t("newPage.canvas")} hint={t("newPage.canvasHint")} busy={create.isPending} onPick={() => create.mutate({ kind: "canvas" })} />
      <Start icon={<FileUp />} label={t("import.action")} hint={t("pages.importHint")} busy={false} onPick={() => openImport(null, { area: "pages" })} />
    </div>
  );

  if (isLoading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="mx-auto w-full max-w-[860px] px-6 pt-12">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="mt-6 h-20 w-full" />
          <Skeleton className="mt-2 h-12 w-full" />
        </div>
      </div>
    );

  if (!pages.length)
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-16 pt-[4vh]">
          <EmptyState
            className="min-h-0 w-full flex-none pb-2 pt-6"
            art="wiki"
            ghost={<GhostList rows={7} variant="table" />}
            title={t("pages.emptyTitle")}
            description={canEdit ? t("pages.emptyBody") : t("pages.emptyViewer")}
            tips={canEdit ? [{ label: t("pages.tipSidebar") }, { label: t("empty.tipOllie") }] : undefined}
          />
          {start && <div className="relative z-10 mt-6 w-full max-w-[720px]">{start}</div>}
          {canEdit && <StarterTemplates ids={TEMPLATES.slice(0, 6).map((x) => x.id)} onPick={(id) => create.mutate(templatePage(t, id))} busy={create.isPending} />}
        </div>
      </div>
    );

  const recent = [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 6);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-6 pb-20 pt-10 animate-rise-in motion-reduce:animate-none">
          <p className="max-w-[560px] text-[13px] leading-5 text-fg-3">{t("pages.intro")}</p>
          {start && <div className="mt-6">{start}</div>}
          <Favorites tree={tree} />
          <h2 className="label-caps mb-2 mt-8">{t("home.recent")}</h2>
          <PageList tree={tree} nodes={recent} />
          <Databases tree={tree} nodes={pages.filter((n) => n.kind === "database")} />
          {canEdit && <StarterTemplates ids={TEMPLATES.slice(0, 6).map((x) => x.id)} onPick={(id) => create.mutate(templatePage(t, id))} busy={create.isPending} compact more />}
          <p className="mt-10 text-xs text-fg-4">
            {t("home.paletteHint")} <Kbd>mod k</Kbd>
          </p>
        </div>
      </div>
    </div>
  );
}

function Start({ icon, label, hint, busy, onPick }: { icon: ReactNode; label: string; hint: string; busy: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className="flex flex-col items-start gap-1 rounded-lg border border-line bg-surface p-3 text-left shadow-xs outline-none transition-[border-color,background-color] hover:border-line-strong hover:bg-canvas focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:opacity-60 [&_svg]:size-4 [&_svg]:text-fg-3"
    >
      {icon}
      <span className="mt-1 text-[13px] font-medium text-fg">{label}</span>
      <span className="text-[11.5px] leading-[16px] text-fg-3">{hint}</span>
    </button>
  );
}

/** The member's favorites of Pages, as cards. */
function Favorites({ tree }: { tree: Tree }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const fav = useFavorites();
  const list = fav.list.filter(inArea("pages")).map((n) => tree.byId.get(n.id)).filter((n): n is WikiNode => !!n);
  if (!list.length) return null;
  return (
    <>
      <h2 className="label-caps mb-2 mt-8">{t("favorites.title")}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {list.slice(0, 9).map((n) => (
          <Link
            key={n.id}
            {...pageTo(n)}
            className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-xs outline-none transition-[border-color,box-shadow] hover:border-line-strong focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          >
            <PageIcon icon={n.icon} kind={n.kind} />
            <span className={cn("min-w-0 truncate text-[13px] font-medium text-fg", !n.title.trim() && "text-fg-3")}>{title(n.title)}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

function PageList({ tree, nodes }: { tree: Tree; nodes: WikiNode[] }) {
  const title = useTitle();
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {nodes.map((n) => {
        const path = ancestorsOf(tree, n.id);
        return (
          <li key={n.id}>
            <Link {...pageTo(n)} className="flex h-11 items-center gap-2.5 px-3.5 outline-none transition-colors hover:bg-hover focus-visible:bg-hover">
              <PageIcon icon={n.icon} kind={n.kind} />
              <span className={cn("min-w-0 truncate text-[13px] font-medium text-fg", !n.title.trim() && "text-fg-3")}>{title(n.title)}</span>
              {path.length > 0 && <span className="hidden min-w-0 truncate text-xs text-fg-4 sm:inline">{path.map((p) => title(p.title)).join(" / ")}</span>}
              <span className="ml-auto shrink-0 text-xs text-fg-4" title={fullDate(n.updated_at)}>
                {relLong(n.updated_at)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Pages' databases, each with how many rows it has. */
function Databases({ tree, nodes }: { tree: Tree; nodes: WikiNode[] }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  if (!nodes.length) return null;
  return (
    <>
      <h2 className="label-caps mb-2 mt-8">{t("pages.databases")}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {nodes.map((n) => {
          const rows = childrenOf(tree, n.id).length;
          return (
            <Link
              key={n.id}
              {...pageTo(n)}
              className="group flex items-center gap-3 rounded-lg border border-line bg-surface px-3.5 py-3 shadow-xs outline-none transition-[border-color,box-shadow] hover:border-line-strong focus-visible:shadow-[0_0_0_2px_var(--focus)]"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken">
                <PageIcon icon={n.icon} kind={n.kind} className="size-4 text-[16px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13px] font-medium text-fg", !n.title.trim() && "text-fg-3")}>{title(n.title)}</span>
                <span className="block text-xs text-fg-3">{t("pages.rows", { count: rows })}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </Link>
          );
        })}
      </div>
    </>
  );
}
