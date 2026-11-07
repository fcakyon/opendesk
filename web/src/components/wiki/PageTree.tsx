// A space's page tree, shared by the wiki's own column and the Pages section of the main
// sidebar (contracts/wiki.md "In the main sidebar"): rows nest, expand and collapse, "+" adds a
// subpage, the menu favorites, duplicates, moves or trashes, and pages drag onto, above or below
// each other, also into another space. Keyboard: arrows move through the rows (Right opens,
// Left closes or goes up), Enter opens a page, Alt+arrows move the focused page.

import { useSidebarPrefs } from "@/lib/collab/hooks";
import { RowEmoji } from "@/components/spaces/rows";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Columns2, Copy, EyeOff, FileText, FolderInput, LayoutDashboard, Link2, MoreHorizontal, PencilRuler, Plus, Star, StarOff, Table2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SIDEBAR_DRAG } from "@/lib/collab/sidebarDrag";
import { sidebarEdit } from "@/lib/collab/sidebarEdit";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/components/ui/copy-button";
import { toast } from "@/components/ui/toast";
import { ActivePill } from "@/app/sidebarParts";
import { api } from "@/lib/api/endpoints";
import type { WikiKind, WikiNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { ancestorsOf, childrenOf, dropIn, keyMove, spaceOf, spaceTree, visibleRows, type Drop, type SpaceKey, type Tree, type Zone } from "@/lib/wiki/tree";
import { pageTo, useArea } from "@/lib/wiki/area";
import { markOpener, openHere, useAreaTree, useCreatePage, useExpanded, useFavorites, useMovePage, useOpenPageId, useOpener, useTitle } from "./hooks";
import { MoveDialog, TrashItem } from "./PageMenu";
import { useSplit } from "./split";
import { AddToSpace } from "./AddToSpace";

/** Where a tree is drawn: the wiki's own column, or the main sidebar's Pages section. */
export type TreeVariant = "wiki" | "nav";

export function pageUrl(id: string) {
  return `${location.origin}/wiki/${id}`;
}

/** Whether a sidebar row opening page id (a favorite, a row of a section) is in sight in from's sidebar. */
function rowInSight(from: HTMLElement, id: string): boolean {
  const nav = from.closest("nav");
  if (!nav) return false;
  const box = (from.closest(".overflow-y-auto") ?? nav).getBoundingClientRect();
  return [...nav.querySelectorAll<HTMLAnchorElement>(`a[href$="/${CSS.escape(id)}"]`)].some((a) => {
    const r = a.getBoundingClientRect();
    return r.height > 0 && r.top >= box.top && r.bottom <= box.bottom;
  });
}

export function PageIcon({ icon, className, kind }: { icon: string; className?: string; kind?: WikiKind }) {
  if (icon)
    return (
      <span className={cn("flex size-4 shrink-0 items-center justify-center text-[13px] leading-none", className)} aria-hidden>
        {icon}
      </span>
    );
  const Glyph = kind === "database" ? Table2 : kind === "canvas" ? LayoutDashboard : FileText;
  return <Glyph className={cn("size-[14px] shrink-0 text-fg-4", className)} aria-hidden />;
}

export const DragCtx = createContext<{ drag: string | null; setDrag: (id: string | null) => void }>({ drag: null, setDrag: () => {} });
/** One drag at a time across every tree inside it, so a page drags from one space into another. */
export function DragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<string | null>(null);
  return <DragCtx.Provider value={{ drag, setDrag }}>{children}</DragCtx.Provider>;
}

/** A space's pages; a database's rows are its own, shown in its views, so trees leave them out. */
export function useSpaceView(space: SpaceKey): Tree {
  const { data = [] } = useAreaTree();
  return useMemo(() => {
    const databases = new Set(data.filter((n) => n.kind === "database").map((n) => n.id));
    return spaceTree(
      data.filter((n) => !n.parent_id || !databases.has(n.parent_id)),
      space,
    );
  }, [data, space]);
}

/** An empty space: a hint, and a drop target to bring a page in. */
export function EmptyRow({ space, canEdit, onAdd, variant = "wiki" }: { space: SpaceKey; canEdit: boolean; onAdd: () => void; variant?: TreeVariant }) {
  const { t } = useTranslation("wiki");
  const { drag, setDrag } = useContext(DragCtx);
  const move = useMovePage();
  const area = useArea();
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
        if (drag) move.mutate({ id: drag, drop: { parent: null, position: 0, space, area } });
        setDrag(null);
        setOver(false);
      }}
      className={cn("rounded-md px-2 py-1.5 text-[12px] leading-[17px] text-fg-4", variant === "nav" ? "mx-2.5 pl-[33px]" : "mx-1", over && "bg-tone-blue-soft shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]")}
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

// ─── Tree ──────────────────────────────────────────────────────────────────

type Over = { id: string; zone: Zone } | { id: "__end"; zone: "after" };

export function TreeView({
  view,
  full,
  space,
  canEdit,
  onNavigate,
  onSearch,
  onHide,
  hidden,
  depth: base = 0,
  variant = "wiki",
}: {
  view: Tree;
  full: Tree;
  space: SpaceKey;
  canEdit: boolean;
  onNavigate?: () => void;
  /** Up from the first row: the wiki column's search. */
  onSearch?: () => void;
  /** Hides a top-level page from the main sidebar (its row menu's Hide). */
  onHide?: (id: string) => void;
  /** Top-level pages hidden from the main sidebar: left out with their subpages. */
  hidden?: ReadonlySet<string>;
  /** Rows start this deep: a teamspace's pages sit under its row in the main sidebar. */
  depth?: number;
  variant?: TreeVariant;
}) {
  const { t } = useTranslation("wiki");
  const { expanded, toggle, open } = useExpanded();
  const openId = useOpenPageId();
  const who = useOpener();
  const navigate = useNavigate();
  const move = useMovePage();
  const area = useArea();
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
  // The page that opened last is shown once its row is there: its parents may still be
  // opening, or a page made a moment ago join the tree a render later.
  const reveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    reveal.current = openId;
  }, [openId]);
  useEffect(() => {
    const id = reveal.current;
    if (!id || !root.current) return;
    const row = root.current.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    reveal.current = undefined;
    // In the main sidebar a page can also be a row of Favorites or of a section: when one
    // of its rows is already in sight (the one just clicked), the sidebar stays where it is.
    if (variant === "nav" && rowInSight(root.current, id)) return;
    // After the router has restored the scroll of a navigation, which would undo this.
    requestAnimationFrame(() => requestAnimationFrame(() => row.isConnected && row.scrollIntoView({ block: "nearest" })));
  });

  const rows = useMemo(() => {
    const all = visibleRows(view, expanded);
    if (!hidden?.size) return all;
    let skip = false;
    return all.filter(({ node, depth }) => {
      if (depth === 0) skip = hidden.has(node.id);
      return !skip;
    });
  }, [view, expanded, hidden]);
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
        if (at <= 0) onSearch?.();
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
        if (variant === "nav") markOpener(id, "tree");
        void navigate(pageTo({ id, area: n.area }));
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
  const dropOn = (target: string, zone: Zone) => (drag ? dropIn(view, full, drag, target, zone, space, area) : null);

  const dnd = (n: WikiNode) =>
    canEdit
      ? {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            e.dataTransfer.effectAllowed = variant === "nav" ? "copyMove" : "move";
            e.dataTransfer.setData("text/plain", pageUrl(n.id));
            // In the main sidebar the page also drops on Favorites (starred) or a section of the member's own.
            if (variant === "nav") e.dataTransfer.setData(SIDEBAR_DRAG, JSON.stringify({ kind: "wiki_page", id: n.id, label: n.title.trim() || t("untitled") }));
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
            depth={depth + base}
            variant={variant}
            onHide={onHide && depth === 0 ? () => onHide(n.id) : undefined}
            hasKids={childrenOf(view, n.id).length > 0}
            open={expanded.has(n.id)}
            active={variant === "nav" ? openHere(who, openId, n.id, "tree") : n.id === openId}
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
            className={cn("relative h-5 rounded-md", variant === "nav" && "mx-2.5", over?.id === "__end" && "before:absolute before:inset-x-2 before:top-1 before:h-0.5 before:rounded-full before:bg-tone-blue-solid")}
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
  onHide,
  dnd,
  variant,
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
  onHide?: () => void;
  dnd: Record<string, unknown>;
  variant: TreeVariant;
}) {
  const { t } = useTranslation("wiki");
  const { t: tc } = useTranslation("collab");
  const title = useTitle();
  const create = useCreatePage();
  const fav = useFavorites();
  const navigate = useNavigate();
  const split = useSplit();
  const [menu, setMenu] = useState(false);
  const nav = variant === "nav";
  // In the main sidebar the row wears the member's own name and emoji for it, if any (contracts/collab.md "Names and icons").
  const sidebar = useSidebarPrefs();
  const label = (nav && sidebar.names[`wiki_page:${n.id}`]) || title(n.title);
  const glyph = nav ? sidebar.icons[`wiki_page:${n.id}`] : undefined;
  const indent = nav ? 8 + depth * 12 : 6 + depth * 14;
  // The buttons' hover, on the sidebar's grey or the wiki column's white.
  const tool = cn("flex size-5 items-center justify-center rounded-sm text-fg-3 hover:text-fg", nav ? "hover:bg-chrome-active" : "hover:bg-active");
  const line = (where: "top" | "bottom"): ReactNode => (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-tone-blue-solid", where === "top" ? "-top-px" : "-bottom-px")}
      style={{ left: indent + (nav ? 25 : 18) }}
    />
  );
  const duplicate = async () => {
    try {
      const copy = await api.wiki.duplicate(n.id, { parent_id: n.parent_id, title: t("duplicate.title", { title: title(n.title) }), position: n.position + 1 });
      void navigate(pageTo(copy));
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
        "group relative flex h-7 shrink-0 select-none items-center rounded-md pr-1 text-[12.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)]",
        nav ? "isolate mx-2.5 w-[calc(100%-1.25rem)] gap-2.5" : "gap-1",
        nav
          ? active
            ? "font-medium text-fg"
            : "text-fg-2 hover:bg-chrome-hover hover:text-fg"
          : active
            ? "bg-active font-medium text-fg"
            : "text-fg-2 hover:bg-hover hover:text-fg",
        dragging && "opacity-40",
        over === "inside" && "bg-tone-blue-soft shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]",
      )}
      style={{ paddingLeft: indent }}
    >
      {nav && active && <ActivePill />}
      {over === "before" && line("top")}
      {over === "after" && line("bottom")}
      {nav ? (
        // The page's icon, which turns into its fold on hover when it has subpages, as in Notion.
        hasKids ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? t("tree.collapse") : t("tree.expand")}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="group/fold relative flex size-[15px] shrink-0 items-center justify-center rounded-sm text-fg-3 hover:text-fg"
          >
            {glyph ? <span className="transition-opacity group-hover:opacity-0"><RowEmoji emoji={glyph} /></span> : <PageIcon icon={n.icon} kind={n.kind} className="transition-opacity group-hover:opacity-0" />}
            <ChevronRight className={cn("absolute size-3.5 opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 motion-reduce:transition-none", open && "rotate-90")} />
          </button>
        ) : (
          <span className="flex size-[15px] shrink-0 items-center justify-center">
            {glyph ? <RowEmoji emoji={glyph} /> : <PageIcon icon={n.icon} kind={n.kind} />}
          </span>
        )
      ) : (
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
      )}
      <Link
        {...pageTo(n)}
        tabIndex={-1}
        draggable={false}
        onClick={() => {
          if (nav) markOpener(n.id, "tree");
          onNavigate?.();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none">
        {!nav && <PageIcon icon={n.icon} kind={n.kind} />}
        <span className={cn("truncate", !n.title.trim() && !sidebar.names[`wiki_page:${n.id}`] && "text-fg-3")}>{label}</span>
        {n.verified && <VerifiedMark />}
      </Link>
      {/* In the main sidebar the tools take no room until wanted, so titles keep the row's width. */}
      <span
        className={cn(
          "shrink-0 items-center gap-px transition-opacity",
          nav
            ? menu
              ? "flex"
              : "hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex"
            : cn("flex", menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"),
        )}
      >
        <Menu open={menu} onOpenChange={setMenu}>
          <MenuTrigger asChild>
            <button type="button" tabIndex={-1} aria-label={t("tree.actions", { title: title(n.title) })} className={tool}>
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
            {split.available && !active && (
              <MenuItem
                icon={<Columns2 />}
                onSelect={() => {
                  split.open(n.id);
                  onNavigate?.();
                }}
              >
                {t("split.openBeside")}
              </MenuItem>
            )}
            <AddToSpace pageId={n.id} />
            {onHide && (
              <MenuItem icon={<EyeOff />} onSelect={onHide}>
                {t("sidebar.hidePage")}
              </MenuItem>
            )}
            {nav && (
              <MenuItem icon={<PencilRuler />} onSelect={() => sidebarEdit.start()}>
                {tc("edit.title")}
              </MenuItem>
            )}
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
                // Ctrl or Cmd: the new page opens beside the one open, which stays.
                if ((e.metaKey || e.ctrlKey) && split.available) create.mutate({ parent_id: n.id, navigate: false }, { onSuccess: (p) => split.open(p.id) });
                else create.mutate({ parent_id: n.id });
              }}
              className={tool}
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

