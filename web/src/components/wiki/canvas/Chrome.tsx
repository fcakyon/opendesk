// The canvas's controls: the floating toolbar (add cards, colour, arrows, delete, undo),
// the zoom controls, the minimap and the formatting bar over a text card being edited.

import type { Editor } from "@tiptap/react";
import {
  ArrowLeftRight,
  ArrowRight,
  Bold,
  Copy,
  FileText,
  Group,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Map as MapIcon,
  Maximize,
  Minus,
  Plus,
  Redo2,
  StickyNote,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { Menu, MenuChoice, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { Popover } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { CanvasEdge, CanvasNode, WikiNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useTitle } from "../hooks";
import { PageIcon } from "../PageTree";
import { solidOf } from "./look";
import { PRESETS, cleanUrl, fromEnd, toEnd, toWorld, type Rect, type Size, type View } from "./model";

const panel = "rounded-xl border border-line bg-raised/95 shadow-float backdrop-blur-sm";

function Tool({ label, shortcut, onClick, children, active, disabled }: { label: string; shortcut?: string; onClick?: () => void; children: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <Button variant="ghost" size="sm" square aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={cn(active && "bg-hover text-fg")}>
        {children}
      </Button>
    </Tooltip>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-line" aria-hidden />;

export type ArrowMode = "none" | "end" | "both";
export const arrowMode = (e: CanvasEdge): ArrowMode => (toEnd(e) === "arrow" ? (fromEnd(e) === "arrow" ? "both" : "end") : fromEnd(e) === "arrow" ? "both" : "none");

export type ToolbarProps = {
  canEdit: boolean;
  selectedNodes: CanvasNode[];
  selectedEdges: CanvasEdge[];
  pages: WikiNode[];
  selfId: string;
  canUndo: boolean;
  canRedo: boolean;
  onAddText: () => void;
  onAddPage: (id: string) => void;
  onAddLink: (url: string) => void;
  onAddGroup: () => void;
  onAddFiles: (files: File[]) => void;
  onColor: (color: string | undefined) => void;
  onArrows: (mode: ArrowMode) => void;
  onEditLabel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

export function Toolbar(p: ToolbarProps) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const file = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pageOpen, setPageOpen] = useState(false);
  const items = useMemo<PickerItem[]>(
    () => p.pages.filter((n) => n.id !== p.selfId).map((n) => ({ value: n.id, label: title(n.title), icon: <PageIcon icon={n.icon} kind={n.kind === "database" ? "database" : "page"} /> })),
    [p.pages, p.selfId, title],
  );
  if (!p.canEdit) return null;
  const any = p.selectedNodes.length + p.selectedEdges.length > 0;
  const colors = [...p.selectedNodes.map((n) => n.color), ...p.selectedEdges.map((e) => e.color)];
  const color = colors.length && colors.every((c) => c === colors[0]) ? colors[0] : null;
  const edge = p.selectedEdges.length === 1 && !p.selectedNodes.length ? p.selectedEdges[0]! : null;
  return (
    <div className={cn(panel, "absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 p-1")} role="toolbar" aria-label={t("canvas.label")} onPointerDown={(e) => e.stopPropagation()}>
      <Tool label={t("canvas.add.text")} shortcut="dblclick" onClick={p.onAddText}>
        <StickyNote />
      </Tool>
      <Picker
        open={pageOpen}
        onOpenChange={setPageOpen}
        side="top"
        align="center"
        width={280}
        placeholder={t("canvas.pagePlaceholder")}
        items={items}
        value={null}
        onSelect={(id) => {
          setPageOpen(false);
          p.onAddPage(id);
        }}
        trigger={
          <Tooltip content={t("canvas.add.page")}>
            <Button variant="ghost" size="sm" square aria-label={t("canvas.add.page")}>
              <FileText />
            </Button>
          </Tooltip>
        }
      />
      <Popover
        open={linkOpen}
        onOpenChange={setLinkOpen}
        side="top"
        align="center"
        className="w-[300px] p-2"
        trigger={
          <Tooltip content={t("canvas.add.link")}>
            <Button variant="ghost" size="sm" square aria-label={t("canvas.add.link")}>
              <Link2 />
            </Button>
          </Tooltip>
        }
      >
        <LinkForm
          placeholder={t("canvas.linkPlaceholder")}
          submit={t("canvas.linkAdd")}
          invalid={t("canvas.linkInvalid")}
          onSubmit={(url) => {
            setLinkOpen(false);
            p.onAddLink(url);
          }}
        />
      </Popover>
      <Tool label={p.selectedNodes.length ? t("canvas.add.groupAround") : t("canvas.add.group")} shortcut={p.selectedNodes.length ? "mod g" : undefined} onClick={p.onAddGroup}>
        <Group />
      </Tool>
      <Tool label={t("canvas.add.file")} onClick={() => file.current?.click()}>
        <ImagePlus />
      </Tool>
      <input
        ref={file}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (list.length) p.onAddFiles(list);
        }}
      />
      {any && (
        <>
          <Divider />
          <ColorButton value={color ?? undefined} mixed={color === null} onChange={p.onColor} />
          {edge && (
            <>
              <Menu>
                <Tooltip content={t("canvas.arrows.label")}>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="sm" square aria-label={t("canvas.arrows.label")}>
                      {arrowMode(edge) === "both" ? <ArrowLeftRight /> : arrowMode(edge) === "end" ? <ArrowRight /> : <Minus />}
                    </Button>
                  </MenuTrigger>
                </Tooltip>
                <MenuContent side="top" align="center">
                  {(["none", "end", "both"] as const).map((m) => (
                    <MenuChoice key={m} checked={arrowMode(edge) === m} onSelect={() => p.onArrows(m)}>
                      {t(`canvas.arrows.${m}`)}
                    </MenuChoice>
                  ))}
                </MenuContent>
              </Menu>
              <Tool label={t("canvas.edgeLabel")} onClick={p.onEditLabel}>
                <Tag />
              </Tool>
            </>
          )}
          {p.selectedNodes.length > 0 && (
            <Tool label={t("canvas.duplicate")} shortcut="mod d" onClick={p.onDuplicate}>
              <Copy />
            </Tool>
          )}
          <Tool label={t("canvas.delete")} shortcut="Del" onClick={p.onDelete}>
            <Trash2 />
          </Tool>
        </>
      )}
      <Divider />
      <Tool label={t("canvas.undo")} shortcut="mod z" onClick={p.onUndo} disabled={!p.canUndo}>
        <Undo2 />
      </Tool>
      <Tool label={t("canvas.redo")} shortcut="mod shift z" onClick={p.onRedo} disabled={!p.canRedo}>
        <Redo2 />
      </Tool>
    </div>
  );
}

/** An https link field: what a link card or a text link points at. */
export function LinkForm({ placeholder, submit, invalid, initial = "", onSubmit }: { placeholder: string; submit: string; invalid: string; initial?: string; onSubmit: (url: string) => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(false);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const url = cleanUrl(value);
        if (!url) return setError(true);
        onSubmit(url);
      }}
    >
      <div className="flex items-center gap-1.5">
        <TextInput
          autoFocus
          value={value}
          invalid={error}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          placeholder={placeholder}
          className="h-7 flex-1 text-[12.5px]"
        />
        <Button type="submit" variant="primary" size="sm">
          {submit}
        </Button>
      </div>
      {error && <p className="px-0.5 text-[11.5px] text-danger-fg">{invalid}</p>}
    </form>
  );
}

function ColorButton({ value, mixed, onChange }: { value: string | undefined; mixed: boolean; onChange: (c: string | undefined) => void }) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const swatch = (c: string | undefined) => solidOf(c);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="center"
      className="p-1.5"
      trigger={
        <Tooltip content={t("canvas.color")}>
          <Button variant="ghost" size="sm" square aria-label={t("canvas.color")}>
            <span
              className="size-4 rounded-full border border-line-strong"
              style={{ background: mixed ? "conic-gradient(var(--tone-red-solid), var(--tone-yellow-solid), var(--tone-green-solid), var(--tone-cyan-solid), var(--tone-purple-solid), var(--tone-red-solid))" : (swatch(value) ?? "var(--surface)") }}
            />
          </Button>
        </Tooltip>
      }
    >
      <div className="flex items-center gap-1" role="radiogroup" aria-label={t("canvas.color")}>
        {[undefined, ...PRESETS].map((c) => {
          const name = c ? t(`canvas.colors.${c}`) : t("canvas.noColor");
          const on = !mixed && value === c;
          return (
            <Tooltip key={c ?? "none"} content={name}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className={cn(
                  "relative flex size-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)]",
                  on && "bg-hover",
                )}
              >
                <span className={cn("size-4 rounded-full border", c ? "border-transparent" : "border-line-strong bg-surface")} style={c ? { background: swatch(c) ?? undefined } : undefined}>
                  {!c && <span className="block h-px w-[18px] -translate-x-px translate-y-[7px] rotate-45 bg-fg-4" />}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </Popover>
  );
}

// ─── Zoom and minimap ────────────────────────────────────────────────────────

export function ZoomHud({ zoom, onZoomIn, onZoomOut, onReset, onFit, minimap, onMinimap }: { zoom: number; onZoomIn: () => void; onZoomOut: () => void; onReset: () => void; onFit: () => void; minimap: boolean; onMinimap: () => void }) {
  const { t } = useTranslation("wiki");
  return (
    <div className={cn(panel, "absolute bottom-4 right-4 z-30 flex items-center gap-0.5 p-1")} onPointerDown={(e) => e.stopPropagation()}>
      <Tool label={t("canvas.zoomOut")} shortcut="-" onClick={onZoomOut}>
        <Minus />
      </Tool>
      <Tooltip content={t("canvas.zoomReset")} shortcut="mod 0">
        <button type="button" onClick={onReset} className="h-7 min-w-[48px] rounded-md px-1 font-mono text-[11.5px] tabular-nums text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]">
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <Tool label={t("canvas.zoomIn")} shortcut="+" onClick={onZoomIn}>
        <Plus />
      </Tool>
      <Divider />
      <Tool label={t("canvas.fit")} shortcut="shift 1" onClick={onFit}>
        <Maximize />
      </Tool>
      <Tool label={t("canvas.minimap")} onClick={onMinimap} active={minimap}>
        <MapIcon />
      </Tool>
    </div>
  );
}

const MINI: Size = { width: 208, height: 144 };

/** The whole canvas small, with the part in view outlined; a click or drag moves the view there. */
export function Minimap({ nodes, bounds, view, viewport, onCenter }: { nodes: CanvasNode[]; bounds: Rect | null; view: View; viewport: Size; onCenter: (world: { x: number; y: number }) => void }) {
  const { t } = useTranslation("wiki");
  const tl = toWorld(view, { x: 0, y: 0 });
  const seen = { x: tl.x, y: tl.y, width: viewport.width / view.zoom, height: viewport.height / view.zoom };
  const all = bounds ? unionRect(bounds, seen) : seen;
  const pad = 40;
  const scale = Math.min((MINI.width - 8) / (all.width + pad * 2), (MINI.height - 8) / (all.height + pad * 2));
  const ox = (MINI.width - (all.width + pad * 2) * scale) / 2 - (all.x - pad) * scale;
  const oy = (MINI.height - (all.height + pad * 2) * scale) / 2 - (all.y - pad) * scale;
  const dragging = useRef(false);
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter({ x: (e.clientX - r.left - ox) / scale, y: (e.clientY - r.top - oy) / scale });
  };
  return (
    <div className={cn(panel, "absolute bottom-[60px] right-4 z-30 overflow-hidden p-0")} onPointerDown={(e) => e.stopPropagation()}>
      <svg
        width={MINI.width}
        height={MINI.height}
        role="img"
        aria-label={t("canvas.minimapAria")}
        className="block cursor-pointer touch-none"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => dragging.current && at(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        {nodes.map((n) => (
          <rect
            key={n.id}
            x={n.x * scale + ox}
            y={n.y * scale + oy}
            width={Math.max(1.5, n.width * scale)}
            height={Math.max(1.5, n.height * scale)}
            rx={n.type === "group" ? 2 : 1.5}
            fill={n.type === "group" ? "none" : (solidOf(n.color) ?? "var(--line-strong)")}
            fillOpacity={n.color ? 0.55 : 1}
            stroke={n.type === "group" ? (solidOf(n.color) ?? "var(--line-strong)") : "none"}
          />
        ))}
        <rect x={seen.x * scale + ox} y={seen.y * scale + oy} width={seen.width * scale} height={seen.height * scale} rx={3} fill="var(--tone-blue-solid)" fillOpacity={0.06} stroke="var(--tone-blue-solid)" strokeOpacity={0.6} />
      </svg>
    </div>
  );
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// ─── Formatting a text card ──────────────────────────────────────────────────

function B({ label, shortcut, active, onClick, children }: { label: string; shortcut?: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn("flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[15px]", active && "bg-hover text-fg")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Bold, italic, a heading, lists and links over the text card being edited. */
export function FormatBar({ editor, at }: { editor: Editor; at: { x: number; y: number } }) {
  const { t } = useTranslation("wiki");
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [linkOpen, setLinkOpen] = useState(false);
  useEffect(() => {
    editor.on("transaction", redraw);
    return () => {
      editor.off("transaction", redraw);
    };
  }, [editor]);
  const run = (fn: () => void) => () => fn();
  const chain = () => editor.chain().focus();
  return (
    <div
      className={cn(panel, "absolute z-40 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 p-1")}
      style={{ left: at.x, top: at.y - 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <B label={t("canvas.format.bold")} shortcut="mod b" active={editor.isActive("bold")} onClick={run(() => chain().toggleBold().run())}>
        <Bold />
      </B>
      <B label={t("canvas.format.italic")} shortcut="mod i" active={editor.isActive("italic")} onClick={run(() => chain().toggleItalic().run())}>
        <Italic />
      </B>
      <B label={t("canvas.format.heading")} active={editor.isActive("heading", { level: 2 })} onClick={run(() => chain().toggleHeading({ level: 2 }).run())}>
        <Heading2 />
      </B>
      <Divider />
      <B label={t("canvas.format.bullets")} active={editor.isActive("bulletList")} onClick={run(() => chain().toggleBulletList().run())}>
        <List />
      </B>
      <B label={t("canvas.format.numbers")} active={editor.isActive("orderedList")} onClick={run(() => chain().toggleOrderedList().run())}>
        <ListOrdered />
      </B>
      <Divider />
      <Popover
        open={linkOpen}
        onOpenChange={setLinkOpen}
        side="top"
        className="w-[280px] p-2"
        trigger={
          <button
            type="button"
            aria-label={t("canvas.format.link")}
            aria-pressed={editor.isActive("link")}
            onMouseDown={(e) => e.preventDefault()}
            className={cn("flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[15px]", editor.isActive("link") && "bg-hover text-fg")}
          >
            <Link2 />
          </button>
        }
      >
        <div data-editing>
          <LinkForm
            placeholder={t("canvas.format.linkPlaceholder")}
            submit={t("canvas.linkAdd")}
            invalid={t("canvas.linkInvalid")}
            initial={(editor.getAttributes("link").href as string | undefined) ?? ""}
            onSubmit={(href) => {
              setLinkOpen(false);
              chain().extendMarkRange("link").setLink({ href }).run();
            }}
          />
          {editor.isActive("link") && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1.5"
              onClick={() => {
                setLinkOpen(false);
                chain().extendMarkRange("link").unsetLink().run();
              }}
            >
              {t("canvas.format.unlink")}
            </Button>
          )}
        </div>
      </Popover>
    </div>
  );
}

