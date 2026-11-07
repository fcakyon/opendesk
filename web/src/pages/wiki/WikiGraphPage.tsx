// The whole wiki as a graph (/wiki/graph), as Obsidian's graph view: every page and the
// links between them, subpages joined to their parents if wanted, filtered by a search or
// a tag, and centred on a page when one is picked (?focus=).

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Network, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb } from "@/app/useBreadcrumbs";
import { SearchInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty";
import { WikiGraph } from "@/components/wiki/Graph";
import { PageIcon } from "@/components/wiki/PageTree";
import { useAreaTree, useTitle } from "@/components/wiki/hooks";
import { areaPath, pageTo, useArea } from "@/lib/wiki/area";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { PagesButton } from "./WikiLayout";


export default function WikiGraphPage() {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const navigate = useNavigate();
  // The wiki's graph or Pages', the same view under either route.
  const { focus, tag } = useSearch({ strict: false }) as { focus?: string; tag?: string };
  const area = useArea();
  const { data: nodes = [] } = useAreaTree();
  const { data: links = [] } = useQuery(q.wikiGraph());
  const [query, setQuery] = useState("");
  const [subpages, setSubpages] = useState(true);
  const [orphans, setOrphans] = useState(true);
  const [depth, setDepth] = useState<1 | 2>(2);
  useDocumentTitle(t("graph.title"));
  usePageCrumb(t("graph.title"));

  const focused = focus ? nodes.find((n) => n.id === focus) : undefined;
  const tags = useMemo(() => [...new Set(nodes.flatMap((n) => n.tags ?? []))].sort(), [nodes]);
  const setSearch = (next: { focus?: string; tag?: string }) => void navigate({ to: areaPath(area, "graph"), search: { focus: next.focus, tag: next.tag }, replace: true });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <PagesButton />
        <Network className="size-4 text-fg-3" />
        <h1 className="text-[13px] font-medium text-fg">{t("graph.title")}</h1>
        <span className="mono text-[11.5px] text-fg-4">{t("graph.counts", { pages: nodes.length, links: links.length })}</span>
      </header>
      {nodes.length === 0 ? (
        <EmptyState art="wiki" title={t("graph.emptyTitle")} description={t("graph.emptyBody")} />
      ) : (
        <div className="relative min-h-0 flex-1 bg-sunken">
          <WikiGraph
            nodes={nodes}
            links={links}
            focus={focused?.id}
            depth={focused ? depth : undefined}
            subpageLinks={subpages}
            orphans={orphans}
            tag={tag}
            query={query}
            height="100%"
            onOpen={(id) => void navigate(pageTo({ id, area }))}
          />
          <div className="absolute left-3 top-3 flex w-[260px] flex-col gap-2 rounded-xl border border-line bg-raised/95 p-2.5 shadow-pop backdrop-blur">
            <SearchInput value={query} onChange={setQuery} placeholder={t("graph.search")} />
            {focused && (
              <div className="flex items-center gap-1.5 rounded-lg bg-tone-violet-soft px-2 py-1.5 text-[12px] text-tone-violet">
                <PageIcon icon={focused.icon} />
                <span className="min-w-0 flex-1 truncate font-medium">{title(focused.title)}</span>
                {([1, 2] as const).map((d) => (
                  <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)} className={cn("h-5 rounded px-1.5 text-[11px]", depth === d ? "bg-surface font-medium text-fg" : "hover:bg-surface/60")}>
                    {t("panel.depth", { count: d })}
                  </button>
                ))}
                <button type="button" aria-label={t("graph.clearFocus")} onClick={() => setSearch({ tag })} className="rounded p-0.5 hover:bg-surface/60">
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <label className="flex items-center justify-between gap-2 px-0.5 text-[12.5px] text-fg-2">
              {t("graph.subpages")}
              <Switch checked={subpages} onCheckedChange={setSubpages} />
            </label>
            <label className="flex items-center justify-between gap-2 px-0.5 text-[12.5px] text-fg-2">
              {t("graph.orphans")}
              <Switch checked={orphans} onCheckedChange={setOrphans} />
            </label>
            {tags.length > 0 && (
              <div className="border-t border-line pt-2">
                <div className="label-caps px-0.5 pb-1">{t("panel.tags")}</div>
                <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                  {tags.map((x) => (
                    <button
                      key={x}
                      type="button"
                      aria-pressed={tag === x}
                      onClick={() => setSearch({ focus, tag: tag === x ? undefined : x })}
                      className={cn("h-6 rounded-md px-1.5 text-[11.5px] transition-colors", tag === x ? "bg-tone-violet text-white" : "bg-tone-violet-soft text-tone-violet hover:brightness-95")}
                    >
                      #{x}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-raised/90 px-3 py-1 text-[11.5px] text-fg-3 shadow-xs">{t("graph.hint")}</p>
        </div>
      )}
    </div>
  );
}
