// The wiki's sidebar, beside every wiki page: search on top, then sections the member
// arranges (Favorites, Recent, a section per teamspace, the workspace's pages, their private
// pages), and the wiki's places at the bottom (today's note, templates, the graph, tags,
// the trash). In each space the pages nest: rows expand and collapse, "+" adds a subpage, the
// menu copies a link, favorites, duplicates, moves (Move to…, also on touch screens) or moves
// to the trash, and pages drag onto, above or below each other, also into another section.
// Keyboard: arrows move through the rows (Right opens, Left closes or goes up), Enter opens a
// page, and Alt+arrows move the focused page up, down, in under the one above, or out.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronRight,
  Clock,
  Copy,
  EyeOff,
  FileText,
  FolderInput,
  Hash,
  LayoutTemplate,
  Link2,
  Lock,
  MoreHorizontal,
  Network,
  Plus,
  Settings2,
  Star,
  StarOff,
  Table2,
  Trash2,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/components/ui/copy-button";
import { toast } from "@/components/ui/toast";
import { useDebounced } from "@/components/contacts/hooks";
import { TeamDot } from "@/components/tickets/teams";
import { api } from "@/lib/api/endpoints";
import type { Team, WikiNode, WikiSearchHit } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { ancestorsOf, buildTree, childrenOf, dropIn, keyMove, spaceBody, spaceOf, spaceTree, visibleRows, type Drop, type SpaceKey, type Tree, type Zone } from "@/lib/wiki/tree";
import { useCreatePage, useExpanded, useFavorites, useMovePage, useOpenPageId, useTitle, useWikiTree } from "./hooks";
import { MoveDialog, TrashItem } from "./PageMenu";
import { useOpenToday } from "./journal";
import { arrange, useSidebarLayout, type SectionKey } from "./sidebarLayout";
import { CustomizeSidebar } from "./CustomizeSidebar";
import { AddToSpace } from "./AddToSpace";
import { starterDatabase } from "./database/starter";

export function pageUrl(id: string) {
  return `${location.origin}/wiki/${id}`;
}

export function PageIcon({ icon, className, kind }: { icon: string; className?: string; kind?: "page" | "database" }) {
  if (icon)
    return (
      <span className={cn("flex size-4 shrink-0 items-center justify-center text-[13px] leading-none", className)} aria-hidden>
        {icon}
      </span>
    );
  const Glyph = kind === "database" ? Table2 : FileText;
  return <Glyph className={cn("size-[14px] shrink-0 text-fg-4", className)} aria-hidden />;
}

/** The sections a member can have, in their default order: teamspaces first, as Notion does. */
export function useSections(): { key: SectionKey; team?: Team }[] {
  const { data } = useWikiTree();
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
  const { isLoading } = useWikiTree();
  const canEdit = atLeast(useRole(), "agent");
  const create = useCreatePage();
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
  const { data, isFetching, isError } = useQuery(q.wikiSearch(term));
  const title = useTitle();
  const openId = useOpenPageId();
  if (!data) return <p className="px-2.5 pt-2 text-[12.5px] text-fg-3">{isError ? t("tree.searchFailed") : t("tree.searching")}</p>;
  if (!data.length) return <p className="px-2.5 pt-2 text-[12.5px] text-fg-3">{t("tree.noMatches", { term })}</p>;
  return (
    <ul className={cn("flex flex-col gap-px transition-opacity", isFetching && "opacity-70")} aria-label={t("tree.results")}>
      {data.map((h) => (
        <li key={h.id}>
          <Link
            to="/wiki/$pageId"
            params={{ pageId: h.id }}
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
const DragCtx = createContext<{ drag: string | null; setDrag: (id: string | null) => void }>({ drag: null, setDrag: () => {} });

function Sections({ canEdit, onNavigate, onSearch }: { canEdit: boolean; onNavigate?: () => void; onSearch: () => void }) {
  const { data = [] } = useWikiTree();
  const full = useMemo(() => buildTree(data), [data]);
  const sections = useSections();
  const { layout, toggleFold, setHidden } = useSidebarLayout();
  const [drag, setDrag] = useState<string | null>(null);
  const [customize, setCustomize] = useState(false);
  const order = arrange(
    sections.map((s) => s.key),
    layout,
  ).filter((k) => !layout.hidden.includes(k));
  const byKey = new Map(sections.map((s) => [s.key, s]));

  return (
    <DragCtx.Provider value={{ drag, setDrag }}>
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
    </DragCtx.Provider>
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
  const { data = [] } = useWikiTree();
  const create = useCreatePage();
  // A database's rows are its own, shown in its views: the sidebar leaves them out.
  const view = useMemo(() => {
    const databases = new Set(data.filter((n) => n.kind === "database").map((n) => n.id));
    return spaceTree(
      data.filter((n) => !n.parent_id || !databases.has(n.parent_id)),
      space,
    );
  }, [data, space]);
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

/** An empty space: a hint, and a drop target to bring a page in. */
function EmptyRow({ space, canEdit, onAdd }: { space: SpaceKey; canEdit: boolean; onAdd: () => void }) {
  const { t } = useTranslation("wiki");
  const { drag, setDrag } = useContext(DragCtx);
  const move = useMovePage();
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        if (drag) move.mutate({ id: drag, drop: { parent: null, position: 0, space } });
        setDrag(null);
        setOver(false);
      }}
      className={cn("mx-1 rounded-md px-2 py-1.5 text-[12px] leading-[17px] text-fg-4", over && "bg-tone-blue-soft shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]")}
    >
      {space === "private" ? t("sidebar.privateEmpty") : t("sidebar.spaceEmpty")}
      {canEdit && !drag && (
        <button type="button" onClick={onAdd} className="ml-1 text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg">
          {t("sidebar.addFirst")}
        </button>
      )}
    </div>
  );
}

function FlatRow({ node, onNavigate, actions }: { node: WikiNode; onNavigate?: () => void; actions?: ReactNode }) {
  const title = useTitle();
  const openId = useOpenPageId();
  return (
    <div className={cn("group relative flex h-7 items-center gap-1.5 rounded-md pl-[26px] pr-1 text-[12.5px]", node.id === openId ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}>
      <Link to="/wiki/$pageId" params={{ pageId: node.id }} onClick={onNavigate} data-wiki-row className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none focus-visible:underline">
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
  const [dragging, setDragging] = useState<string | null>(null);
  if (!fav.list.length) return null;
  return (
    <section>
      {head(t("favorites.title"))}
      {!folded &&
        fav.list.map((n) => (
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
  const { data = [] } = useQuery(q.wikiRecent());
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
      <Link to="/wiki/templates" className={item} activeProps={active} onClick={onNavigate}>
        <LayoutTemplate />
        {t("templatesPage.title")}
      </Link>
      <div className="grid grid-cols-3 gap-0.5">
        <Link to="/wiki/graph" className={item} activeProps={active} onClick={onNavigate}>
          <Network />
          {t("graph.title")}
        </Link>
        <Link to="/wiki/tags" className={item} activeProps={active} onClick={onNavigate}>
          <Hash />
          {t("tags.title")}
        </Link>
        <Link to="/wiki/trash" className={item} activeProps={active} onClick={onNavigate}>
          <Trash2 />
          {t("trash.title")}
        </Link>
      </div>
    </nav>
  );
}

// ─── Tree ──────────────────────────────────────────────────────────────────

type Over = { id: string; zone: Zone } | { id: "__end"; zone: "after" };

function TreeView({ view, full, space, canEdit, onNavigate, onSearch }: { view: Tree; full: Tree; space: SpaceKey; canEdit: boolean; onNavigate?: () => void; onSearch: () => void }) {
  const { t } = useTranslation("wiki");
  const { expanded, toggle, open } = useExpanded();
  const openId = useOpenPageId();
  const navigate = useNavigate();
  const move = useMovePage();
  const { drag, setDrag } = useContext(DragCtx);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [over, setOver] = useState<Over | null>(null);
  const [moving, setMoving] = useState<WikiNode | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);

  // The open page's ancestors stay open, so it is always in view.
  const ancestorIds = useMemo(() => (openId && view.byId.has(openId) ? ancestorsOf(view, openId).map((a) => a.id) : []), [view, openId]);
  useEffect(() => {
    if (ancestorIds.length) open(ancestorIds);
  }, [ancestorIds, open]);
  useEffect(() => {
    if (!openId) return;
    root.current?.querySelector<HTMLElement>(`[data-id="${openId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  const rows = visibleRows(view, expanded);
  const current = focusId && rows.some((r) => r.node.id === focusId) ? focusId : openId && rows.some((r) => r.node.id === openId) ? openId : rows[0]?.node.id;

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    requestAnimationFrame(() => root.current?.closest("[data-wiki-sidebar]")?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus());
  };

  const doMove = (id: string, drop: Drop | null) => {
    if (!drop) return;
    if (drop.parent) open([drop.parent]);
    move.mutate({ id, drop });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
    if (!id || (e.target as HTMLElement).closest("button")) return;
    const i = rows.findIndex((r) => r.node.id === id);
    const n = view.byId.get(id);
    if (!n || i < 0) return;
    const hasKids = childrenOf(view, id).length > 0;
    if (e.altKey && canEdit && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowRight: "in", ArrowLeft: "out" } as const)[e.key as "ArrowUp"];
      doMove(id, keyMove(view, id, dir));
      focusRow(id);
      return;
    }
    // Up and down cross into the sections above and below.
    const all = [...(root.current?.closest("[data-wiki-sidebar]")?.querySelectorAll<HTMLElement>("[data-wiki-row]") ?? [])];
    const at = all.indexOf(e.target as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        all[at + 1]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (at <= 0) onSearch();
        else all[at - 1]?.focus();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (hasKids && !expanded.has(id)) toggle(id, true);
        else if (hasKids) focusRow(childrenOf(view, id)[0]?.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (hasKids && expanded.has(id)) toggle(id, false);
        else if (n.parent_id) focusRow(n.parent_id);
        break;
      case "Home":
        e.preventDefault();
        focusRow(rows[0]?.node.id);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows[rows.length - 1]?.node.id);
        break;
      case "Enter":
        e.preventDefault();
        void navigate({ to: "/wiki/$pageId", params: { pageId: id } });
        onNavigate?.();
        break;
    }
  };

  const zoneOf = (e: DragEvent<HTMLElement>, id: string): Zone => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (y < 0.28) return "before";
    if (y > 0.72) return childrenOf(view, id).length && expanded.has(id) ? "inside" : "after";
    return "inside";
  };
  const dropOn = (target: string, zone: Zone) => (drag ? dropIn(view, full, drag, target, zone, space) : null);

  const dnd = (n: WikiNode) =>
    canEdit
      ? {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", pageUrl(n.id));
            setDrag(n.id);
          },
          onDragEnd: () => {
            clearTimeout(hoverTimer.current);
            setDrag(null);
            setOver(null);
          },
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!drag) return;
            let zone = zoneOf(e, n.id);
            if (!dropOn(n.id, zone)) zone = zone === "inside" ? "after" : zone;
            if (!dropOn(n.id, zone)) return setOver(null);
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over?.id !== n.id || over.zone !== zone) {
              setOver({ id: n.id, zone });
              clearTimeout(hoverTimer.current);
              // Hovering in the middle of a closed page opens it, to drop deeper.
              if (zone === "inside" && childrenOf(view, n.id).length && !expanded.has(n.id)) hoverTimer.current = setTimeout(() => toggle(n.id, true), 650);
            }
          },
          onDragLeave: () => over?.id === n.id && setOver(null),
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            clearTimeout(hoverTimer.current);
            if (drag && over && over.id === n.id) doMove(drag, dropOn(n.id, over.zone));
            setDrag(null);
            setOver(null);
          },
        }
      : {};

  const top = childrenOf(view, null);
  return (
    <>
      <div ref={root} role="tree" aria-label={t("tree.label")} onKeyDown={onKeyDown} className="flex flex-col" data-wiki-panel>
        {rows.map(({ node: n, depth }) => (
          <TreeRow
            key={n.id}
            node={n}
            depth={depth}
            hasKids={childrenOf(view, n.id).length > 0}
            open={expanded.has(n.id)}
            active={n.id === openId}
            focusable={n.id === current}
            dragging={drag === n.id || (!!drag && ancestorsOf(view, n.id).some((a) => a.id === drag))}
            over={over && over.id === n.id ? over.zone : null}
            canEdit={canEdit}
            onToggle={() => toggle(n.id)}
            onFocus={() => setFocusId(n.id)}
            onNavigate={onNavigate}
            onMoveTo={() => setMoving(n)}
            dnd={dnd(n)}
          />
        ))}
        {canEdit && drag && (
          // Below the last page: the end of this space's top level.
          <div
            className={cn("relative h-5 rounded-md", over?.id === "__end" && "before:absolute before:inset-x-2 before:top-1 before:h-0.5 before:rounded-full before:bg-tone-blue-solid")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver({ id: "__end", zone: "after" });
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (drag) {
                const from = full.byId.get(drag);
                doMove(drag, { parent: null, position: top.filter((x) => x.id !== drag).length, ...(from && spaceOf(from) !== space ? { space } : {}) });
              }
              setDrag(null);
              setOver(null);
            }}
          />
        )}
      </div>
      <MoveDialog node={moving} open={!!moving} onOpenChange={(o) => !o && setMoving(null)} />
    </>
  );
}

function TreeRow({
  node: n,
  depth,
  hasKids,
  open,
  active,
  focusable,
  dragging,
  over,
  canEdit,
  onToggle,
  onFocus,
  onNavigate,
  onMoveTo,
  dnd,
}: {
  node: WikiNode;
  depth: number;
  hasKids: boolean;
  open: boolean;
  active: boolean;
  focusable: boolean;
  dragging: boolean;
  over: Zone | null;
  canEdit: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onNavigate?: () => void;
  onMoveTo: () => void;
  dnd: Record<string, unknown>;
}) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const create = useCreatePage();
  const fav = useFavorites();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const indent = 6 + depth * 14;
  const line = (where: "top" | "bottom"): ReactNode => (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-tone-blue-solid", where === "top" ? "-top-px" : "-bottom-px")}
      style={{ left: indent + 18 }}
    />
  );
  const duplicate = async () => {
    try {
      const copy = await api.wiki.duplicate(n.id, { parent_id: n.parent_id, title: t("duplicate.title", { title: title(n.title) }), position: n.position + 1 });
      void navigate({ to: "/wiki/$pageId", params: { pageId: copy.id } });
    } catch (e) {
      toast.error(e, t("duplicate.failed"));
    }
  };
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasKids ? open : undefined}
      aria-selected={active}
      aria-label={title(n.title)}
      data-id={n.id}
      data-wiki-row
      tabIndex={focusable ? 0 : -1}
      onFocus={onFocus}
      {...dnd}
      className={cn(
        "group relative flex h-7 shrink-0 select-none items-center gap-1 rounded-md pr-1 text-[12.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)]",
        active ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
        dragging && "opacity-40",
        over === "inside" && "bg-tone-blue-soft shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]",
      )}
      style={{ paddingLeft: indent }}
    >
      {over === "before" && line("top")}
      {over === "after" && line("bottom")}
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? t("tree.collapse") : t("tree.expand")}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-4 transition-colors hover:bg-active hover:text-fg-2", !hasKids && "invisible")}
      >
        <ChevronRight className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      <Link to="/wiki/$pageId" params={{ pageId: n.id }} tabIndex={-1} draggable={false} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none">
        <PageIcon icon={n.icon} kind={n.kind} />
        <span className={cn("truncate", !n.title.trim() && "text-fg-3")}>{title(n.title)}</span>
        {n.verified && <VerifiedMark />}
      </Link>
      <span className={cn("flex shrink-0 items-center gap-px transition-opacity", menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100")}>
        <Menu open={menu} onOpenChange={setMenu}>
          <MenuTrigger asChild>
            <button type="button" tabIndex={-1} aria-label={t("tree.actions", { title: title(n.title) })} className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-active hover:text-fg">
              <MoreHorizontal className="size-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={fav.has(n.id) ? <StarOff /> : <Star />} onSelect={() => fav.toggle(n)}>
              {fav.has(n.id) ? t("favorites.remove") : t("favorites.add")}
            </MenuItem>
            {canEdit && (
              <>
                <MenuItem icon={<Plus />} onSelect={() => create.mutate({ parent_id: n.id })}>
                  {t("tree.addSubpage")}
                </MenuItem>
                {!n.journal && (
                  <MenuItem icon={<Copy />} onSelect={() => void duplicate()}>
                    {t("duplicate.action")}
                  </MenuItem>
                )}
                {!n.journal && (
                  <MenuItem icon={<FolderInput />} onSelect={onMoveTo}>
                    {t("tree.moveTo")}
                  </MenuItem>
                )}
              </>
            )}
            <MenuItem
              icon={<Link2 />}
              onSelect={() => {
                void copyText(pageUrl(n.id));
                toast.success(t("toast.linkCopied"));
              }}
            >
              {t("page.copyLink")}
            </MenuItem>
            <AddToSpace pageId={n.id} />
            <MenuSeparator />
            <TrashItem node={n} />
          </MenuContent>
        </Menu>
        {canEdit && (
          <Tooltip content={t("tree.addSubpage")}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("tree.addSubpageTo", { title: title(n.title) })}
              onClick={(e) => {
                e.stopPropagation();
                create.mutate({ parent_id: n.id });
              }}
              className="flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-active hover:text-fg"
            >
              <Plus className="size-3.5" />
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  );
}

/** A small check beside a verified page's title. */
export function VerifiedMark({ className }: { className?: string }) {
  const { t } = useTranslation("wiki");
  return (
    <span title={t("verify.verified")} className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-full bg-tone-blue-solid text-white", className)}>
      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
        <path d="M3 6.2 5 8.2 9 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">{t("verify.verified")}</span>
    </span>
  );
}

