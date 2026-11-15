// The wiki's sidebar, beside every wiki page: search on top, then sections the member
// arranges (Favorites, Recent, a section per teamspace, the workspace's pages, their private
// pages), and the wiki's places at the bottom (today's note, templates, the graph, tags,
// the trash). In each space the pages nest: rows expand and collapse, "+" adds a subpage, the
// menu copies a link, favorites, duplicates, moves (Move to…, also on touch screens) or moves
// to the trash, and pages drag onto, above or below each other, also into another section.
// Keyboard: arrows move through the rows (Right opens, Left closes or goes up), Enter opens a
// page, and Alt+arrows move the focused page up, down, in under the one above, or out.
// The trees are PageTree's, shared with the main sidebar's Pages section.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronRight,
  Clock,
  EyeOff,
  FileText,
  FileUp,
  Hash,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Network,
  Plus,
  Settings2,
  StarOff,
  Table2,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";

import { useDebounced } from "@/components/contacts/hooks";
import { TeamDot } from "@/components/tickets/teams";

import type { Team, WikiNode, WikiSearchHit } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { buildTree, childrenOf, spaceBody, type SpaceKey, type Tree } from "@/lib/wiki/tree";
import { areaPath, inArea, pageTo, useArea } from "@/lib/wiki/area";
import { useAreaTree, useCreatePage, useFavorites, useOpenPageId, useTitle } from "./hooks";
import { DragProvider, EmptyRow, PageIcon, TreeView, useSpaceView } from "./PageTree";

import { useOpenToday } from "./journal";
import { arrange, useSidebarLayout, type SectionKey } from "./sidebarLayout";
import { CustomizeSidebar } from "./CustomizeSidebar";

import { starterDatabase } from "./database/starter";
import { openImport } from "@/app/quickAdd";

/** The sections a member can have, in their default order: teamspaces first, as Notion does. */
export function useSections(): { key: SectionKey; team?: Team }[] {
  const { data } = useAreaTree();
  const { data: teams = [] } = useQuery(q.teams());
  return useMemo(() => {
    const withPages = new Set((data ?? []).map((n) => n.team_id).filter((x): x is string => !!x));
    // A teamspace shows when it has pages the member sees.
    const spaces = teams.filter((t) => withPages.has(t.id)).sort((a, b) => a.name.localeCompare(b.name));
    return [
      { key: "favorites" as SectionKey },
      ...spaces.map((team) => ({ key: `team:${team.id}` as SectionKey, team })),
      { key: "workspace" as SectionKey },
      { key: "private" as SectionKey },
      { key: "recent" as SectionKey },
    ];
  }, [data, teams]);
}

export function WikiTree({ onNavigate, autoFocusSearch }: { onNavigate?: () => void; autoFocusSearch?: boolean }) {
  const { t } = useTranslation("wiki");
  const area = useArea();
  const { isLoading } = useAreaTree();
  const canEdit = atLeast(useRole(), "agent");
  const create = useCreatePage();
  const openId = useOpenPageId();
  const [term, setTerm] = useState("");
  const debounced = useDebounced(term.trim(), 180);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-3">
        <SearchInput
          inputRef={searchRef}
          autoFocus={autoFocusSearch}
          value={term}
          onChange={setTerm}
          placeholder={t("tree.search")}
          className="min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === "Escape" && term) {
              e.preventDefault();
              e.stopPropagation();
              setTerm("");
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              (e.currentTarget.closest("[data-wiki-sidebar]")?.querySelector<HTMLElement>("[data-wiki-row]") ?? null)?.focus();
            }
          }}
        />
        {canEdit && (
          <Menu>
            <Tooltip content={t("tree.newPage")}>
              <MenuTrigger asChild>
                <Button square variant="ghost" size="sm" aria-label={t("tree.newPage")} loading={create.isPending && !create.variables?.parent_id}>
                  <Plus className="size-4" />
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end">
              <MenuItem icon={<FileText />} onSelect={() => create.mutate({})}>
                {t("tree.newPage")}
              </MenuItem>
              <MenuItem icon={<Table2 />} onSelect={() => create.mutate({ kind: "database", database: starterDatabase("table", t) })}>
                {t("tree.newDatabase")}
              </MenuItem>
              <MenuItem icon={<LayoutDashboard />} onSelect={() => create.mutate({ kind: "canvas" })}>
                {t("canvas.newCanvas")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<FileUp />} onSelect={() => {
                  onNavigate?.();
                  openImport(openId ?? null, { area });
                }}
              >
                {t("import.action")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4" data-wiki-sidebar>
        {debounced ? (
          <div data-wiki-panel>
            <SearchResults term={debounced} onNavigate={onNavigate} />
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 px-2 pt-1">
            {[70, 52, 64, 40, 58].map((w, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${w}%`, marginLeft: i % 3 === 1 ? 16 : 0 }} />
            ))}
          </div>
        ) : (
          <Sections canEdit={canEdit} onNavigate={onNavigate} onSearch={() => searchRef.current?.focus()} />
        )}
      </div>
      <Places onNavigate={onNavigate} />
    </div>
  );
}

// ─── Search ────────────────────────────────────────────────────────────────

function SearchResults({ term, onNavigate }: { term: string; onNavigate?: () => void }) {
  const { t } = useTranslation("wiki");
  const area = useArea();
  const { data: hits, isFetching, isError } = useQuery(q.wikiSearch(term));
  // The search finds both areas' pages; the column lists its own.
  const data = hits?.filter(inArea(area));
  const title = useTitle();
  const openId = useOpenPageId();
  if (!data) return <p className="px-2.5 pt-2 text-[12.5px] text-fg-3">{isError ? t("tree.searchFailed") : t("tree.searching")}</p>;
  if (!data.length) return <p className="px-2.5 pt-2 text-[12.5px] text-fg-3">{t("tree.noMatches", { term })}</p>;
  return (
    <ul className={cn("flex flex-col gap-px transition-opacity", isFetching && "opacity-70")} aria-label={t("tree.results")}>
      {data.map((h) => (
        <li key={h.id}>
          <Link
            {...pageTo(h)}
            onClick={onNavigate}
            data-wiki-row
            className={cn(
              "block rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)]",
              h.id === openId && "bg-active",
            )}
            onKeyDown={(e) => moveFocus(e)}
          >
            <span className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
              <PageIcon icon={h.icon} />
              <span className="truncate">
                <Highlight text={title(h.title)} term={term} />
              </span>
            </span>
            {h.path.length > 0 && <span className="mt-0.5 block truncate pl-6 text-[11.5px] text-fg-4">{h.path.map((p) => title(p.title)).join(" / ")}</span>}
            {h.snippet && <Snippet hit={h} term={term} />}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Snippet({ hit, term }: { hit: WikiSearchHit; term: string }) {
  return (
    <span className="mt-0.5 line-clamp-2 pl-6 text-[11.5px] leading-[16px] text-fg-3">
      <Highlight text={hit.snippet} term={term} />
    </span>
  );
}

/** Marks the words of term (as prefixes) in text. */
export function Highlight({ text, term }: { text: string; term: string }) {
  const words = term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-tone-amber-soft px-px text-fg">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const rows = [...(e.currentTarget.closest("[data-wiki-panel]")?.querySelectorAll<HTMLElement>("[data-wiki-row]") ?? [])];
  const i = rows.indexOf(e.currentTarget);
  rows[e.key === "ArrowDown" ? i + 1 : i - 1]?.focus();
}

// ─── Sections ──────────────────────────────────────────────────────────────

/** The page being dragged, shared by every section so a page drops into another space. */
function Sections({ canEdit, onNavigate, onSearch }: { canEdit: boolean; onNavigate?: () => void; onSearch: () => void }) {
  const { data = [] } = useAreaTree();
  const full = useMemo(() => buildTree(data), [data]);
  const sections = useSections();
  const { layout, toggleFold, setHidden } = useSidebarLayout();
  const [customize, setCustomize] = useState(false);
  const order = arrange(
    sections.map((s) => s.key),
    layout,
  ).filter((k) => !layout.hidden.includes(k));
  const byKey = new Map(sections.map((s) => [s.key, s]));

  return (
    <DragProvider>
      <div className="flex flex-col gap-3">
        {order.map((key) => {
          const s = byKey.get(key);
          if (!s) return null;
          const folded = layout.folded.includes(key);
          const head = (label: ReactNode, extra?: ReactNode) => (
            <SectionHead
              label={label}
              folded={folded}
              onFold={() => toggleFold(key)}
              onHide={() => setHidden(key, true)}
              onCustomize={() => setCustomize(true)}
              extra={extra}
            />
          );
          if (key === "favorites") return <FavoritesSection key={key} head={head} folded={folded} onNavigate={onNavigate} />;
          if (key === "recent") return <RecentSection key={key} head={head} folded={folded} onNavigate={onNavigate} />;
          const space = key as SpaceKey;
          return <SpaceSection key={key} space={space} full={full} head={head} folded={folded} canEdit={canEdit} onNavigate={onNavigate} onSearch={onSearch} />;
        })}
      </div>
      <CustomizeSidebar open={customize} onOpenChange={setCustomize} />
    </DragProvider>
  );
}

function SectionHead({ label, folded, onFold, onHide, onCustomize, extra }: { label: ReactNode; folded: boolean; onFold: () => void; onHide: () => void; onCustomize: () => void; extra?: ReactNode }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="group/head flex h-6 items-center gap-0.5 pl-2 pr-1">
      <button type="button" onClick={onFold} aria-expanded={!folded} className="label-caps flex min-w-0 flex-1 items-center gap-1 text-left transition-colors hover:text-fg-2">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight className={cn("size-3 shrink-0 opacity-0 transition-[transform,opacity] duration-150 group-hover/head:opacity-100", !folded && "rotate-90")} />
      </button>
      <span className="flex items-center gap-px opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100 [@media(hover:none)]:opacity-100">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label={t("sidebar.sectionMenu")} className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-active hover:text-fg">
              <MoreHorizontal className="size-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={<EyeOff />} onSelect={onHide}>
              {t("sidebar.hide")}
            </MenuItem>
            <MenuItem icon={<Settings2 />} onSelect={onCustomize}>
              {t("sidebar.customize")}
            </MenuItem>
          </MenuContent>
        </Menu>
        {extra}
      </span>
    </div>
  );
}

function SpaceSection({
  space,
  full,
  head,
  folded,
  canEdit,
  onNavigate,
  onSearch,
}: {
  space: SpaceKey;
  full: Tree;
  head: (label: ReactNode, extra?: ReactNode) => ReactNode;
  folded: boolean;
  canEdit: boolean;
  onNavigate?: () => void;
  onSearch: () => void;
}) {
  const { t } = useTranslation("wiki");
  const create = useCreatePage();
  const view = useSpaceView(space);
  const empty = childrenOf(view, null).length === 0;
  const label = space === "workspace" ? t("sidebar.workspace") : space === "private" ? t("sidebar.private") : t("sidebar.teamspace");
  const add = canEdit ? (
    <Tooltip content={t("sidebar.addIn", { section: label })}>
      <button
        type="button"
        aria-label={t("sidebar.addIn", { section: label })}
        onClick={() => create.mutate(spaceBody(space))}
        className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-active hover:text-fg"
      >
        <Plus className="size-3.5" />
      </button>
    </Tooltip>
  ) : undefined;
  return (
    <section>
      {head(sectionLabel(space, t), add)}
      {!folded &&
        (empty ? (
          <EmptyRow space={space} canEdit={canEdit} onAdd={() => create.mutate(spaceBody(space))} />
        ) : (
          <TreeView view={view} full={full} space={space} canEdit={canEdit} onNavigate={onNavigate} onSearch={onSearch} />
        ))}
    </section>
  );
}

function sectionLabel(space: SpaceKey, t: ReturnType<typeof useTranslation<"wiki">>["t"]): ReactNode {
  if (space === "workspace") return t("sidebar.workspace");
  if (space === "private") return t("sidebar.private");
  return <TeamLabel id={space.slice(5)} />;
}

function TeamLabel({ id }: { id: string }) {
  const { data: teams = [] } = useQuery(q.teams());
  const team = teams.find((x) => x.id === id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TeamDot team={team} />
      <span className="truncate">{team?.name}</span>
      {team?.private && <Lock className="size-2.5 shrink-0" />}
    </span>
  );
}

function FlatRow({ node, onNavigate, actions }: { node: WikiNode; onNavigate?: () => void; actions?: ReactNode }) {
  const title = useTitle();
  const openId = useOpenPageId();
  return (
    <div className={cn("group relative flex h-7 items-center gap-1.5 rounded-md pl-[26px] pr-1 text-[12.5px]", node.id === openId ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}>
      <Link {...pageTo(node)} onClick={onNavigate} data-wiki-row className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none focus-visible:underline">
        <PageIcon icon={node.icon} />
        <span className={cn("truncate", !node.title.trim() && "text-fg-3")}>{title(node.title)}</span>
      </Link>
      {actions && <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">{actions}</span>}
    </div>
  );
}

function FavoritesSection({ head, folded, onNavigate }: { head: (label: ReactNode, extra?: ReactNode) => ReactNode; folded: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation("wiki");
  const fav = useFavorites();
  const area = useArea();
  const [dragging, setDragging] = useState<string | null>(null);
  // The column's own area's favorites; the main sidebar's Favorites has both.
  const list = fav.list.filter(inArea(area));
  if (!list.length) return null;
  return (
    <section>
      {head(t("favorites.title"))}
      {!folded &&
        list.map((n) => (
          <div
            key={n.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              setDragging(n.id);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => {
              if (!dragging || dragging === n.id) return;
              e.preventDefault();
              const ids = fav.list.map((x) => x.id).filter((x) => x !== dragging);
              ids.splice(ids.indexOf(n.id) + (e.nativeEvent.offsetY > 14 ? 1 : 0), 0, dragging);
              if (ids.join() !== fav.list.map((x) => x.id).join()) fav.reorder(ids);
            }}
            className={cn(dragging === n.id && "opacity-40")}
          >
            <FlatRow
              node={n}
              onNavigate={onNavigate}
              actions={
                <Tooltip content={t("favorites.remove")}>
                  <button type="button" aria-label={t("favorites.remove")} onClick={() => fav.toggle(n)} className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-active hover:text-fg">
                    <StarOff className="size-3.5" />
                  </button>
                </Tooltip>
              }
            />
          </div>
        ))}
    </section>
  );
}

function RecentSection({ head, folded, onNavigate }: { head: (label: ReactNode, extra?: ReactNode) => ReactNode; folded: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation("wiki");
  const { data = [] } = useQuery(q.wikiRecent(useArea()));
  if (!data.length) return null;
  return (
    <section>
      {head(
        <span className="flex items-center gap-1">
          <Clock className="size-2.5" />
          {t("sidebar.recent")}
        </span>,
      )}
      {!folded && data.slice(0, 6).map((n) => <FlatRow key={n.id} node={n} onNavigate={onNavigate} />)}
    </section>
  );
}

/** The wiki's places, at the foot of the sidebar. */
function Places({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation("wiki");
  const openToday = useOpenToday();
  const area = useArea();
  const canEdit = atLeast(useRole(), "agent");
  const item = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover [&_svg]:size-[14px] [&_svg]:text-fg-3";
  const active = { className: "bg-active text-fg" };
  return (
    <nav aria-label={t("sidebar.places")} className="shrink-0 border-t border-line px-1.5 py-1.5">
      {canEdit && (
        <button
          type="button"
          className={item}
          onClick={() => {
            onNavigate?.();
            void openToday();
          }}
        >
          <CalendarDays />
          {t("journal.today")}
        </button>
      )}
      <Link to={areaPath(area, "templates")} className={item} activeProps={active} onClick={onNavigate}>
        <LayoutTemplate />
        {t("templatesPage.title")}
      </Link>
      <div className="grid grid-cols-3 gap-0.5">
        <Link to={areaPath(area, "graph")} className={item} activeProps={active} onClick={onNavigate}>
          <Network />
          {t("graph.title")}
        </Link>
        <Link to={areaPath(area, "tags")} className={item} activeProps={active} onClick={onNavigate}>
          <Hash />
          {t("tags.title")}
        </Link>
        <Link to={areaPath(area, "trash")} className={item} activeProps={active} onClick={onNavigate}>
          <Trash2 />
          {t("trash.title")}
        </Link>
      </div>
    </nav>
  );
}

