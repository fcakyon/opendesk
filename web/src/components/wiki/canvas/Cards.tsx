// A canvas's cards: text (wiki HTML, edited in place), pages (live title, icon and how the
// page starts), links (a bookmark), files and images, and groups. Cards are memoized and
// keep their handlers on the canvas (data attributes say what was hit), so moving one card
// redraws that card alone.

import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { ExternalLink, FileText, Globe, LayoutDashboard, Lock, Paperclip } from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { RichEditor, type RichEditorHandle } from "@/components/editor/RichEditor";
import { Skeleton } from "@/components/ui/skeleton";
import type { CanvasFileNode, CanvasLinkNode, CanvasNode, CanvasPageNode, CanvasTextNode, WikiNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { useTitle } from "../hooks";
import { excerpt } from "../PagePreview";
import { PageIcon } from "../PageTree";
import { cardTint, solidOf } from "./look";
import { SIDES, WIKI_SRC, isImageName, type Handle } from "./model";

/** What cards read from the canvas around them. */
export type CardEnv = {
  /** The tree's pages by id: a page card's title and icon, live. */
  pages: Map<string, WikiNode> | null;
  /** Calls back when an element comes into view of the canvas (or leaves it). */
  observe: (el: Element, cb: (visible: boolean) => void) => () => void;
};
export const CardEnvContext = createContext<CardEnv>({ pages: null, observe: () => () => {} });

export type CardActions = {
  textChange: (id: string, html: string) => void;
  exitEdit: () => void;
  labelChange: (id: string, label: string) => void;
};

type CardProps = {
  node: CanvasNode;
  selected: boolean;
  /** Its text (or a group's label) is being edited. */
  editing: boolean;
  canEdit: boolean;
  /** Resize handles: one card selected. */
  handles: boolean;
  actions: CardActions;
  editorRef?: Ref<RichEditorHandle>;
};

const RESIZE: Handle[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
const RESIZE_POS: Record<Handle, string> = {
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  s: "left-1/2 top-full -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  e: "left-full top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  ne: "left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  sw: "left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  se: "left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
};
const CONNECT_POS = {
  top: "left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(50%+14px/var(--z))]",
  right: "left-full top-1/2 -translate-y-1/2 translate-x-[calc(-50%+14px/var(--z))]",
  bottom: "left-1/2 top-full -translate-x-1/2 translate-y-[calc(-50%+14px/var(--z))]",
  left: "left-0 top-1/2 -translate-y-1/2 -translate-x-[calc(50%+14px/var(--z))]",
} as const;

export const Card = memo(function Card({ node, selected, editing, canEdit, handles, actions, editorRef }: CardProps) {
  const { t } = useTranslation("wiki");
  const label = useCardLabel(node);
  const isGroup = node.type === "group";
  return (
    <div
      data-node-id={node.id}
      data-type={node.type}
      tabIndex={0}
      role="group"
      aria-roledescription={t(`canvas.types.${node.type}`)}
      aria-label={label || t("canvas.emptyCard")}
      aria-selected={selected}
      className={cn(
        "canvas-card group/card absolute outline-none",
        isGroup ? "rounded-[14px] border border-line" : "rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgb(10_10_10/0.05),0_6px_18px_-10px_rgb(10_10_10/0.18)]",
        isGroup && "bg-[color-mix(in_oklab,var(--fg)_2.5%,transparent)]",
        selected && "canvas-selected",
        editing && !isGroup && "z-10",
      )}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height, ...(isGroup ? groupTint(node.color) : cardTint(node.color)) }}
    >
      {node.type === "text" && <TextBody node={node} editing={editing} actions={actions} editorRef={editorRef} />}
      {node.type === "page" && <PageBody node={node} />}
      {node.type === "link" && <LinkBody node={node} />}
      {node.type === "file" && <FileBody node={node} />}
      {node.type === "group" && <GroupLabel id={node.id} label={node.label ?? ""} color={node.color} editing={editing} actions={actions} />}
      {canEdit && !editing && (
        <>
          {SIDES.map((side) => (
            <span
              key={side}
              data-connect={side}
              aria-hidden
              className={cn(
                "canvas-connect absolute z-20 rounded-full border-line-strong bg-surface opacity-0 shadow-xs transition-opacity duration-150 group-hover/card:opacity-100 hover:!bg-[var(--tone-blue-solid)] motion-reduce:transition-none",
                CONNECT_POS[side],
                selected && "opacity-100",
              )}
            />
          ))}
          {handles &&
            RESIZE.map((h) => <span key={h} data-handle={h} aria-hidden className={cn("canvas-handle absolute z-20 rounded-[3px] border bg-surface", RESIZE_POS[h])} />)}
        </>
      )}
    </div>
  );
});

function groupTint(color: string | undefined) {
  const solid = solidOf(color);
  return solid ? { borderColor: `color-mix(in oklab, ${solid} 45%, var(--line))`, background: `color-mix(in oklab, ${solid} 5%, transparent)` } : undefined;
}

/** A card's words, for its accessible name and the list screen readers get. */
export function useCardLabel(node: CanvasNode): string {
  const { pages } = useContext(CardEnvContext);
  return useMemo(() => cardLabel(node, pages), [node, pages]);
}

export function cardLabel(node: CanvasNode, pages: Map<string, WikiNode> | null): string {
  switch (node.type) {
    case "text":
      return plain(node.html).slice(0, 200);
    case "page":
      return pages?.get(node.page_id)?.title ?? "";
    case "link":
      return node.title || node.url;
    case "file":
      return node.name || node.src;
    case "group":
      return node.label ?? "";
  }
}

const plainCache = new Map<string, string>();

/** A card's text without markup; kept, as moving a card makes a new node with the same text. */
function plain(html: string): string {
  if (!html) return "";
  const hit = plainCache.get(html);
  if (hit !== undefined) return hit;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("p, h1, h2, h3, li").forEach((el) => el.append(" "));
  const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  if (plainCache.size > 4000) plainCache.clear();
  plainCache.set(html, text);
  return text;
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** Stored text is sanitized by the API; what this tab typed is the editor's own. Both pass here once more. */
const clean = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "iframe", "form"], FORBID_ATTR: ["style"] });

function TextBody({ node, editing, actions, editorRef }: { node: CanvasTextNode; editing: boolean; actions: CardActions; editorRef?: Ref<RichEditorHandle> }) {
  const { t } = useTranslation("wiki");
  const html = useMemo(() => clean(node.html), [node.html]);
  if (editing)
    return (
      <div data-editing className="h-full cursor-text overflow-hidden rounded-[inherit]">
        <RichEditor
          ref={editorRef}
          value={node.html}
          onChange={(v) => actions.textChange(node.id, v)}
          toolbar="none"
          autofocus
          placeholder={t("canvas.typing")}
          ariaLabel={t("canvas.types.text")}
          className="h-full"
          contentClassName="canvas-prose min-h-full px-3.5 py-3"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return false;
            actions.exitEdit();
            return true;
          }}
        />
      </div>
    );
  if (!html) return <p className="px-3.5 py-3 text-[13px] text-fg-4">{t("canvas.emptyCard")}</p>;
  return (
    <div
      className="tiptap prose-od canvas-prose h-full overflow-hidden px-3.5 py-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-20px),transparent)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/** True once the element has come into the canvas's view, so cards far away fetch nothing. */
function useSeen<T extends Element>(): [Ref<T>, boolean] {
  const { observe } = useContext(CardEnvContext);
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el || seen) return;
    return observe(el, (v) => v && setSeen(true));
  }, [el, seen, observe]);
  return [setEl, seen];
}

function PageBody({ node }: { node: CanvasPageNode }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { pages } = useContext(CardEnvContext);
  const ref = pages?.get(node.page_id);
  const [anchor, seen] = useSeen<HTMLDivElement>();
  const page = useQuery({ ...q.wikiPage(node.page_id), enabled: seen && !!ref, staleTime: 60_000, retry: false });
  const text = useMemo(() => {
    const p = page.data;
    if (!p) return "";
    if (p.kind === "canvas") return excerpt((p.canvas?.nodes ?? []).map((n) => (n.type === "text" ? n.html : "")).join(" "), 260);
    return excerpt(p.body_html, 260);
  }, [page.data]);
  if (!pages)
    return (
      <div className="p-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-3 w-full" />
      </div>
    );
  if (!ref)
    return (
      <div className="flex h-full flex-col justify-center gap-1.5 px-4 text-fg-3">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          <Lock className="size-3.5" aria-hidden />
          {t("canvas.pageHidden")}
        </span>
        <span className="text-[12px] text-fg-4">{t("canvas.pageHiddenHint")}</span>
      </div>
    );
  return (
    <div ref={anchor} className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
        {!ref.icon && ref.kind === "canvas" ? (
          <LayoutDashboard className="size-[14px] shrink-0 text-fg-4" aria-hidden />
        ) : (
          <PageIcon icon={ref.icon} kind={ref.kind === "database" ? "database" : "page"} />
        )}
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{title(ref.title)}</span>
        <ExternalLink className="size-3.5 shrink-0 text-fg-4 opacity-0 transition-opacity group-hover/card:opacity-100" aria-hidden />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-18px),transparent)]">
        {page.isLoading && seen ? (
          <>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
          </>
        ) : (
          text || <span className="text-fg-4">{t("canvas.emptyPage")}</span>
        )}
      </div>
    </div>
  );
}

// ─── Links and files ─────────────────────────────────────────────────────────

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinkBody({ node }: { node: CanvasLinkNode }) {
  const image = node.image && WIKI_SRC.test(node.image) ? node.image : null;
  const host = hostOf(node.url);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
      {image && node.height >= 160 && <img src={image} alt="" draggable={false} loading="lazy" className="min-h-0 w-full flex-[1_1_45%] border-b border-line-soft object-cover" />}
      <div className="flex min-h-0 flex-1 flex-col gap-1 px-3.5 py-2.5">
        <span className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-fg">{node.title || host}</span>
        {node.description && <span className="line-clamp-3 text-[12.5px] leading-relaxed text-fg-3">{node.description}</span>}
        <span className="mt-auto flex min-w-0 items-center gap-1.5 pt-1 text-[11.5px] text-fg-4">
          <Globe className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{host}</span>
        </span>
      </div>
    </div>
  );
}

function FileBody({ node }: { node: CanvasFileNode }) {
  const { t } = useTranslation("wiki");
  const [broken, setBroken] = useState(false);
  if (isImageName(node.name || node.src) && !broken)
    return (
      <div className="relative h-full overflow-hidden rounded-[inherit] bg-sunken">
        <img src={node.src} alt={node.name} draggable={false} loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />
        {node.name && (
          <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/50 to-transparent px-3 pt-6 pb-2 text-[11.5px] text-white opacity-0 transition-opacity group-hover/card:opacity-100">
            {node.name}
          </span>
        )}
      </div>
    );
  return (
    <div className="flex h-full items-center gap-3 px-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-sunken text-fg-3">
        {broken ? <FileText className="size-4" aria-hidden /> : <Paperclip className="size-4" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium text-fg">{node.name || hostOf(node.src)}</span>
        <span className="text-[11.5px] text-fg-4">{t("canvas.openFile")}</span>
      </span>
    </div>
  );
}

// ─── Groups ──────────────────────────────────────────────────────────────────

function GroupLabel({ id, label, color, editing, actions }: { id: string; label: string; color?: string; editing: boolean; actions: CardActions }) {
  const { t } = useTranslation("wiki");
  const solid = solidOf(color);
  const style = { color: solid ? `color-mix(in oklab, ${solid} 75%, var(--fg))` : undefined, fontSize: "calc(13px / min(var(--z), 1))" };
  return (
    <div className="absolute bottom-full left-0 max-w-full pb-[calc(6px/min(var(--z),1))]">
      {editing ? (
        <LabelInput initial={label} placeholder={t("canvas.groupPlaceholder")} style={style} onDone={(v) => { actions.labelChange(id, v); actions.exitEdit(); }} onCancel={actions.exitEdit} />
      ) : (
        <span data-group-label className={cn("block cursor-text truncate px-1 font-semibold", !label && "text-fg-4")} style={style}>
          {label || t("canvas.groupUntitled")}
        </span>
      )}
    </div>
  );
}

/** A one-line field that saves on Enter or when it loses focus, and gives up on Escape. */
export function LabelInput({
  initial,
  placeholder,
  style,
  className,
  onDone,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  style?: CSSProperties;
  className?: string;
  onDone: (v: string) => void;
  onCancel: () => void;
}) {
    const [value, setValue] = useState(initial);
    const done = useRef(false);
    const finish = (save: boolean) => {
      if (done.current) return;
      done.current = true;
      if (save) onDone(value.trim().replace(/\s+/g, " ").slice(0, 200));
      else onCancel();
    };
    return (
      <input
        data-editing
        autoFocus
        value={value}
        maxLength={200}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
        style={style}
        className={cn("min-w-[8ch] rounded-md border border-line bg-raised px-1.5 py-0.5 font-semibold text-fg shadow-xs outline-none focus:shadow-[0_0_0_3px_var(--focus)]", className)}
      />
    );
}
