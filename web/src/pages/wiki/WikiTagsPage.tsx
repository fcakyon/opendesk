// The wiki's #tags (/wiki/tags), as Obsidian's tag pane: every tag with how many pages
// carry it, nested tags (#process/billing) under their parents, and the pages of the one
// picked (?tag=).

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { SearchInput } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty";
import { PageIcon } from "@/components/wiki/PageTree";
import { useAreaTree, useTitle } from "@/components/wiki/hooks";
import { areaPath, pageTo, useArea } from "@/lib/wiki/area";
import { cn } from "@/lib/cn";
import { relLong } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { ancestorsOf } from "@/lib/wiki/tree";
import { PagesButton } from "./WikiLayout";


/** A tag and its nested ones ("process/billing" under "process"), each counted with everything under it. */
export function tagCounts(tags: string[][]): { tag: string; count: number; depth: number }[] {
  const count = new Map<string, number>();
  for (const list of tags) {
    const seen = new Set<string>();
    for (const tag of list) {
      const parts = tag.split("/");
      for (let i = 1; i <= parts.length; i++) seen.add(parts.slice(0, i).join("/"));
    }
    for (const t of seen) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, n]) => ({ tag, count: n, depth: tag.split("/").length - 1 }));
}

export default function WikiTagsPage() {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const now = useNow();
  const navigate = useNavigate();
  const { tag } = useSearch({ strict: false }) as { tag?: string };
  const area = useArea();
  const { data: nodes = [], tree } = useAreaTree();
  const [filter, setFilter] = useState("");
  useDocumentTitle(tag ? `#${tag}` : t("tags.title"));
  usePageCrumb(tag ? `#${tag}` : t("tags.title"));

  const all = useMemo(() => tagCounts(nodes.map((n) => n.tags ?? [])), [nodes]);
  const shown = filter.trim() ? all.filter((x) => x.tag.includes(filter.trim().toLowerCase().replace(/^#/, ""))) : all;
  const pages = tag ? nodes.filter((n) => (n.tags ?? []).some((x) => x === tag || x.startsWith(`${tag}/`))).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <PagesButton />
        <Hash className="size-4 text-fg-3" />
        <h1 className="text-[13px] font-medium text-fg">{t("tags.title")}</h1>
      </header>
      {all.length === 0 ? (
        <EmptyState art="wiki" title={t("tags.emptyTitle")} description={t("tags.emptyBody")} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[260px] shrink-0 flex-col border-r border-line">
            <div className="p-2">
              <SearchInput value={filter} onChange={setFilter} placeholder={t("tags.search")} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label={t("tags.title")}>
              {shown.map((x) => (
                <button
                  key={x.tag}
                  type="button"
                  role="option"
                  aria-selected={tag === x.tag}
                  onClick={() => void navigate({ to: areaPath(area, "tags"), search: { tag: x.tag }, replace: true })}
                  className={cn("flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors", tag === x.tag ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}
                  style={{ paddingLeft: 8 + x.depth * 14 }}
                >
                  <Hash className="size-3.5 shrink-0 text-tone-violet" />
                  <span className="min-w-0 flex-1 truncate">{x.tag.split("/").pop()}</span>
                  <span className="mono text-[11px] text-fg-4">{x.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!tag ? (
              <EmptyState art="wiki" title={t("tags.pickTitle")} description={t("tags.pickBody", { count: all.length })} />
            ) : (
              <div className="mx-auto max-w-[720px] px-6 py-8">
                <h2 className="flex items-center gap-1 text-[22px] font-semibold tracking-[-0.02em] text-fg">
                  <Hash className="size-5 text-tone-violet" />
                  {tag}
                </h2>
                <p className="mt-1 text-[12.5px] text-fg-3">{t("tags.pages", { count: pages.length })}</p>
                <div className="mt-5 overflow-hidden rounded-xl border border-line">
                  {pages.map((n) => {
                    const path = tree.byId.has(n.id) ? ancestorsOf(tree, n.id) : [];
                    return (
                      <Link key={n.id} {...pageTo(n)} className="flex items-center gap-3 border-b border-line-soft bg-surface px-4 py-3 transition-colors last:border-b-0 hover:bg-hover">
                        <PageIcon icon={n.icon} className="size-5 text-[16px]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-fg">{title(n.title)}</span>
                          {path.length > 0 && <span className="block truncate text-[11.5px] text-fg-4">{path.map((p) => title(p.title)).join(" / ")}</span>}
                        </span>
                        <span className="hidden gap-1 sm:flex">
                          {(n.tags ?? []).slice(0, 3).map((x) => (
                            <span key={x} className={cn("rounded px-1.5 py-0.5 text-[11px]", x === tag ? "bg-tone-violet-soft text-tone-violet" : "bg-hover text-fg-3")}>
                              #{x}
                            </span>
                          ))}
                        </span>
                        <span className="shrink-0 text-[11.5px] text-fg-4">{relLong(n.updated_at, now)}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
