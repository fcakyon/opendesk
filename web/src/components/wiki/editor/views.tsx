// The React views of the wiki editor's blocks (blocks.ts). Each one reads well for viewers
// and turns into its own small editor for people who may edit: an empty file asks for one,
// an empty embed for a link, an image shows its width handles and caption.

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Link } from "@tanstack/react-router";
import { AlignCenter, AlignLeft, AlignRight, ArrowUpRight, BellRing, Clock, Download, X, FileText, Film, Globe, Link2, ListTree, Music, Paperclip } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Calendar, parseDay, formatDay, TimeField } from "@/components/ui/date-picker";
import { Switch } from "@/components/ui/switch";
import { TextInput } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { bytes, longDate, timeOfDay } from "@/lib/format";
import { newReminderId } from "@/lib/wiki/reminder";
import { embedFor, EMBED_NAMES } from "@/lib/wiki/embeds";
import { IconPicker } from "../IconPicker";
import { PageIcon } from "../PageTree";
import { useTitle, useWikiTree } from "../hooks";
import { useWikiEditorEnv } from "./context";
import { PagePreview } from "../PagePreview";
import { type Tone } from "./tones";

const blockCard = "group/card relative my-1 flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors";

/** The empty state of a block that waits for its file or link. */
function Placeholder({ icon, children, onClick, selected }: { icon: ReactNode; children: ReactNode; onClick?: () => void; selected: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      contentEditable={false}
      className={cn(
        "my-1 flex h-11 w-full items-center gap-2.5 rounded-lg bg-hover px-3 text-left text-[13px] text-fg-3 transition-colors hover:bg-active hover:text-fg-2 [&_svg]:size-4",
        selected && "shadow-[0_0_0_2px_var(--focus)]",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Callout ────────────────────────────────────────────────────────────────

export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const tone = (node.attrs.tone as Tone) ?? "gray";
  const icon = (node.attrs.icon as string) || "";
  const editable = editor.isEditable;
  return (
    <NodeViewWrapper as="div" data-type="callout" data-tone={tone} className="wiki-callout">
      <div contentEditable={false} className="wiki-callout-icon">
        {editable ? (
          <IconPicker
            value={icon}
            open={open}
            onOpenChange={setOpen}
            onChange={(v) => updateAttributes({ icon: v })}
            trigger={
              <button type="button" aria-label={t("editor.calloutIcon")} className="flex size-6 items-center justify-center rounded-md text-[17px] leading-none transition-colors hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]">
                {icon || <span className="size-1.5 rounded-full bg-fg-4" />}
              </button>
            }
          />
        ) : (
          icon && <span className="flex size-6 items-center justify-center text-[17px] leading-none">{icon}</span>
        )}
      </div>
      <NodeViewContent className="wiki-callout-body" />
    </NodeViewWrapper>
  );
}


// ─── Image ──────────────────────────────────────────────────────────────────

export function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const { src, alt, width, align, caption } = node.attrs as { src: string; alt: string; width: number | null; align: "left" | "center" | "right"; caption: string };
  const editable = editor.isEditable;
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? width ?? 100;

  const startResize = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const parent = box.current?.parentElement;
    if (!parent) return;
    const full = parent.getBoundingClientRect().width;
    const startX = e.clientX;
    const startW = ((width ?? 100) / 100) * full;
    let latest = width ?? 100;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === "right" ? 1 : -1) * (align === "center" ? 2 : 1);
      latest = Math.round(Math.min(100, Math.max(15, ((startW + dx) / full) * 100)));
      setDrag(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      updateAttributes({ width: latest >= 100 ? null : latest });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <NodeViewWrapper as="figure" className={cn("wiki-figure", `wiki-figure-${align}`)} data-drag-handle="">
      <div ref={box} className="relative inline-block max-w-full" style={{ width: `${shown}%` }}>
        <img src={src} alt={alt ?? ""} draggable={false} className={cn("block w-full rounded-lg", selected && editable && "shadow-[0_0_0_2px_var(--focus)]")} />
        {editable && (
          <>
            {(["left", "right"] as const).map((side) => (
              <span
                key={side}
                contentEditable={false}
                onPointerDown={startResize(side)}
                className={cn(
                  "absolute top-1/2 h-12 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-full border border-white/70 bg-black/45 opacity-0 transition-opacity group-hover/fig:opacity-100 [figure:hover_&]:opacity-100",
                  side === "left" ? "left-2" : "right-2",
                  drag !== null && "opacity-100",
                )}
              />
            ))}
            <div contentEditable={false} className="absolute right-2 top-2 flex gap-0.5 rounded-md border border-line bg-raised/95 p-0.5 opacity-0 shadow-xs backdrop-blur transition-opacity [figure:hover_&]:opacity-100">
              {([
                ["left", AlignLeft, t("editor.alignLeft")],
                ["center", AlignCenter, t("editor.alignCenter")],
                ["right", AlignRight, t("editor.alignRight")],
              ] as const).map(([a, Icon, label]) => (
                <Tooltip key={a} content={label}>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={align === a}
                    onClick={() => updateAttributes({ align: a })}
                    className={cn("flex size-6 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-fg [&_svg]:size-3.5", align === a && "bg-hover text-fg")}
                  >
                    <Icon />
                  </button>
                </Tooltip>
              ))}
            </div>
          </>
        )}
      </div>
      {(caption || (editable && selected)) && (
        <figcaption contentEditable={false}>
          {editable ? (
            <input
              value={caption}
              onChange={(e) => updateAttributes({ caption: e.target.value.slice(0, 500) })}
              placeholder={t("editor.captionPlaceholder")}
              aria-label={t("editor.caption")}
              className="w-full bg-transparent text-center outline-none placeholder:text-fg-4"
            />
          ) : (
            caption
          )}
        </figcaption>
      )}
    </NodeViewWrapper>
  );
}

// ─── Files and media ────────────────────────────────────────────────────────

function useUploadInto(update: (a: Record<string, unknown>) => void, accept: "file" | "video" | "audio") {
  const { t } = useTranslation("wiki");
  const { upload } = useWikiEditorEnv();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = () => input.current?.click();
  const el = (
    <input
      ref={input}
      type="file"
      hidden
      accept={accept === "video" ? "video/*" : accept === "audio" ? "audio/*" : undefined}
      onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        setBusy(true);
        try {
          const a = await upload(f);
          update({ src: a.url, name: a.filename, size: a.size_bytes, mime: a.content_type });
        } catch (err) {
          toast.error(err, t("page.uploadFailed"));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
  return { pick, busy, el };
}

export function FileView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const { src, name, size } = node.attrs as { src: string; name: string; size: number | null };
  const up = useUploadInto(updateAttributes, "file");
  if (!src)
    return (
      <NodeViewWrapper>
        {up.el}
        <Placeholder selected={selected} onClick={editor.isEditable ? up.pick : undefined} icon={up.busy ? <Spinner className="size-4" /> : <Paperclip />}>
          {up.busy ? t("page.uploading") : t("editor.fileEmpty")}
        </Placeholder>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper>
      <a href={src} download={name} target="_blank" rel="noopener noreferrer" contentEditable={false} className={cn(blockCard, "hover:bg-hover", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-fg-3">
          <FileText className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{name || t("editor.file")}</span>
          {size ? <span className="block text-[11.5px] text-fg-4">{bytes(size)}</span> : null}
        </span>
        <Download className="size-4 shrink-0 text-fg-4 transition-colors group-hover/card:text-fg-2" />
      </a>
    </NodeViewWrapper>
  );
}

export function MediaView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const video = node.type.name === "video";
  const { src, name } = node.attrs as { src: string; name: string };
  const up = useUploadInto(updateAttributes, video ? "video" : "audio");
  if (!src)
    return (
      <NodeViewWrapper>
        {up.el}
        <Placeholder selected={selected} onClick={editor.isEditable ? up.pick : undefined} icon={up.busy ? <Spinner className="size-4" /> : video ? <Film /> : <Music />}>
          {up.busy ? t("page.uploading") : video ? t("editor.videoEmpty") : t("editor.audioEmpty")}
        </Placeholder>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper className={cn("my-1 rounded-lg", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
      <div contentEditable={false}>
        {video ? (
          <video src={src} controls preload="metadata" className="w-full rounded-lg border border-line bg-black" aria-label={name} />
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
            <Music className="size-4 shrink-0 text-fg-3" />
            <span className="min-w-0 max-w-[30%] truncate text-[12.5px] text-fg-2">{name}</span>
            <audio src={src} controls preload="metadata" className="h-9 min-w-0 flex-1" aria-label={name} />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ─── Bookmarks and embeds ───────────────────────────────────────────────────

function UrlForm({ placeholder, hint, onSubmit, busy }: { placeholder: string; hint?: string; onSubmit: (url: string) => void; busy?: boolean }) {
  const { t } = useTranslation("wiki");
  const [v, setV] = useState("");
  return (
    <form
      contentEditable={false}
      className="my-1 rounded-lg border border-line bg-sunken p-2"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = /^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`;
        if (v.trim()) onSubmit(url.replace(/^http:/i, "https:"));
      }}
    >
      <div className="flex gap-1.5">
        <TextInput autoFocus inputSize="sm" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={placeholder} onKeyDown={(e) => e.stopPropagation()} />
        <Button type="submit" size="sm" variant="primary" disabled={busy || !v.trim()}>
          {busy ? <Spinner className="size-3.5" /> : t("editor.add")}
        </Button>
      </div>
      {hint && <p className="mt-1.5 px-0.5 text-[11.5px] text-fg-4">{hint}</p>}
    </form>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export function BookmarkView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const { unfurl } = useWikiEditorEnv();
  const { url, title, description, image } = node.attrs as { url: string; title: string; description: string; image: string };
  const [busy, setBusy] = useState(false);
  if (!url)
    return (
      <NodeViewWrapper>
        {editor.isEditable ? (
          <UrlForm
            busy={busy}
            placeholder={t("editor.bookmarkPlaceholder")}
            onSubmit={async (u) => {
              setBusy(true);
              try {
                const card = await unfurl(u);
                updateAttributes({ url: u, title: card.title, description: card.description, image: card.image });
              } catch {
                updateAttributes({ url: u });
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : null}
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper>
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" contentEditable={false} className={cn(blockCard, "items-stretch overflow-hidden p-0 hover:bg-hover", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3.5 py-3">
          <span className="truncate text-[13.5px] font-medium text-fg">{title || hostOf(url)}</span>
          {description && <span className="line-clamp-2 text-[12px] leading-[17px] text-fg-3">{description}</span>}
          <span className="mt-1 flex items-center gap-1.5 truncate text-[11.5px] text-fg-4">
            <Globe className="size-3 shrink-0" />
            {url.replace(/^https?:\/\//, "")}
          </span>
        </span>
        {image && <img src={image} alt="" className="hidden h-auto w-[30%] max-w-[220px] shrink-0 border-l border-line object-cover sm:block" loading="lazy" referrerPolicy="no-referrer" />}
      </a>
    </NodeViewWrapper>
  );
}

export function EmbedView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const url = node.attrs.url as string;
  const provider = useMemo(() => (url ? embedFor(url) : null), [url]);
  if (!url)
    return (
      <NodeViewWrapper>
        {editor.isEditable ? (
          <UrlForm placeholder={t("editor.embedPlaceholder")} hint={t("editor.embedHint", { list: EMBED_NAMES.slice(0, 8).join(", ") })} onSubmit={(u) => updateAttributes({ url: u })} />
        ) : null}
      </NodeViewWrapper>
    );
  if (!provider)
    return (
      <NodeViewWrapper>
        <a href={url} target="_blank" rel="noopener noreferrer nofollow" contentEditable={false} className={cn(blockCard, "hover:bg-hover", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
          <Link2 className="size-4 shrink-0 text-fg-4" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{url}</span>
          <ArrowUpRight className="size-4 shrink-0 text-fg-4" />
        </a>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper className={cn("wiki-embed my-1 overflow-hidden rounded-lg border border-line bg-sunken", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
      <div contentEditable={false}>
        <iframe
          src={provider.src}
          title={provider.name}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms"
          allow="fullscreen; picture-in-picture; encrypted-media; clipboard-write"
          referrerPolicy="strict-origin-when-cross-origin"
          className="block w-full border-0"
          style={provider.ratio ? { aspectRatio: String(provider.ratio) } : { height: (node.attrs.height as number | null) ?? provider.height }}
        />
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-[11.5px] text-fg-4">
          <span className="font-medium text-fg-3">{provider.name}</span>
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="ml-auto flex items-center gap-1 hover:text-fg">
            {t("editor.openOriginal")}
            <ArrowUpRight className="size-3" />
          </a>
        </div>
      </div>
    </NodeViewWrapper>
  );
}

// ─── Table of contents ──────────────────────────────────────────────────────

type Heading = { level: number; text: string; id: string };

export function headingsOf(editor: NodeViewProps["editor"]): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "heading") out.push({ level: n.attrs.level as number, text: n.textContent, id: (n.attrs["block-id"] as string) ?? "" });
    // A toggle heading is a heading too; what it folds may hold more.
    else if (n.type.name === "details" && n.attrs.heading) out.push({ level: n.attrs.heading as number, text: n.firstChild?.textContent ?? "", id: (n.attrs["block-id"] as string) ?? "" });
    return n.type.name !== "heading";
  });
  return out;
}

export function scrollToBlock(id: string) {
  if (!id) return;
  const el = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el.classList.remove("wiki-flash");
  void el.offsetWidth;
  el.classList.add("wiki-flash");
}

export function TocView({ editor, selected }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [heads, setHeads] = useState(() => headingsOf(editor));
  useEffect(() => {
    const on = () => setHeads(headingsOf(editor));
    editor.on("update", on);
    return () => {
      editor.off("update", on);
    };
  }, [editor]);
  const min = Math.min(...heads.map((h) => h.level), 3);
  return (
    <NodeViewWrapper className={cn("my-1 rounded-lg py-1", selected && "shadow-[0_0_0_2px_var(--focus)]")}>
      <nav contentEditable={false} aria-label={t("editor.toc")}>
        {heads.length === 0 ? (
          <p className="flex items-center gap-2 px-2 py-1 text-[13px] text-fg-4">
            <ListTree className="size-4" />
            {t("editor.tocEmpty")}
          </p>
        ) : (
          heads.map((h, i) => (
            <button
              key={`${h.id}-${i}`}
              type="button"
              onClick={() => scrollToBlock(h.id)}
              className="block w-full truncate rounded-md py-[3px] pr-2 text-left text-[13.5px] text-fg-2 underline decoration-line-strong underline-offset-[3px] transition-colors hover:bg-hover hover:text-fg"
              style={{ paddingLeft: 8 + (h.level - min) * 18 }}
            >
              {h.text || t("editor.untitledHeading")}
            </button>
          ))
        )}
      </nav>
    </NodeViewWrapper>
  );
}

// ─── Links to pages ─────────────────────────────────────────────────────────

export function PageLinkView({ node }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree, isLoading } = useWikiTree();
  const id = node.attrs.id as string;
  const live = tree.byId.get(id);
  const gone = !isLoading && !live;
  return (
    <NodeViewWrapper as="span" className="wiki-pagelink-wrap">
      <PagePreview id={id}>
        <Link
          to="/wiki/$pageId"
          params={{ pageId: id }}
          hash={(node.attrs.block as string) || undefined}
          contentEditable={false}
          draggable={false}
          className={cn("wiki-pagelink", gone && "wiki-pagelink-gone")}
          title={gone ? t("editor.pageGone") : undefined}
        >
          <PageIcon icon={live?.icon ?? ""} className="wiki-pagelink-icon" />
          <span>{live ? title(live.title) : (node.attrs.label as string) || t("untitled")}</span>
        </Link>
      </PagePreview>
    </NodeViewWrapper>
  );
}

export function SubpageView({ node, selected }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree, isLoading } = useWikiTree();
  const id = node.attrs.id as string;
  const live = tree.byId.get(id);
  if (!live && !isLoading)
    return (
      <NodeViewWrapper>
        <p contentEditable={false} className="my-1 flex h-8 items-center gap-2 px-1 text-[13px] text-fg-4">
          <FileText className="size-4" />
          {t("editor.pageGone")}
        </p>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper>
      <Link
        to="/wiki/$pageId"
        params={{ pageId: id }}
        contentEditable={false}
        draggable={false}
        className={cn("-mx-1 my-px flex h-8 items-center gap-2 rounded-md px-1 text-[15px] font-medium text-fg underline decoration-line-strong underline-offset-[5px] transition-colors hover:bg-hover", selected && "bg-hover")}
      >
        <PageIcon icon={live?.icon ?? ""} className="size-5 text-[16px]" />
        <span className="truncate">{title(live?.title)}</span>
      </Link>
    </NodeViewWrapper>
  );
}

// ─── Dates ──────────────────────────────────────────────────────────────────

export function DateView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const date = node.attrs.date as string;
  const time = node.attrs.time as string;
  const reminder = node.attrs.reminder as string | null;
  const d = parseDay(date);
  const label = d ? relativeDay(d, t) + (time ? ` ${timeOfDay(time)}` : "") : t("editor.pickDate");
  const title = d ? longDate(d.toISOString()) + (reminder ? ` · ${t("reminder.set")}` : "") : undefined;
  const face = (
    <>
      <span aria-hidden>@</span>
      {label}
      {reminder && <BellRing aria-label={t("reminder.set")} className="wiki-date-bell" />}
    </>
  );
  const chip = (
    <button type="button" contentEditable={false} className={cn("wiki-date", reminder && "has-reminder")} disabled={!editor.isEditable} title={title}>
      {face}
    </button>
  );
  return (
    <NodeViewWrapper as="span">
      {editor.isEditable ? (
        <Popover open={open} onOpenChange={setOpen} trigger={chip} className="w-[240px] p-2">
          <Calendar
            value={d}
            onChange={(v) => {
              updateAttributes({ date: formatDay(v) });
              if (!reminder) setOpen(false);
            }}
          />
          <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
            <div className="flex h-8 items-center gap-2 px-1 text-[12.5px]">
              <Clock className="size-3.5 text-fg-4" />
              <span className="flex-1 text-fg-2">{t("reminder.time")}</span>
              <TimeField size="sm" value={time} onChange={(v) => updateAttributes({ time: v })} aria-label={t("reminder.time")} />
              {time && (
                <Tooltip content={t("reminder.clearTime")}>
                  <button type="button" aria-label={t("reminder.clearTime")} onClick={() => updateAttributes({ time: "" })} className="grid size-6 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg">
                    <X className="size-3" />
                  </button>
                </Tooltip>
              )}
            </div>
            <label className="flex h-8 cursor-pointer items-center gap-2 px-1 text-[12.5px]">
              <BellRing className="size-3.5 text-fg-4" />
              <span className="flex-1 text-fg-2">{t("reminder.remindMe")}</span>
              <Switch checked={!!reminder} onCheckedChange={(on) => updateAttributes({ reminder: on ? newReminderId() : null })} aria-label={t("reminder.remindMe")} />
            </label>
            {reminder && <p className="px-1 pb-0.5 text-[11.5px] leading-4 text-fg-4">{t("reminder.hintAt", { time: timeOfDay(time || "09:00") })}</p>}
          </div>
        </Popover>
      ) : (
        <span className={cn("wiki-date", reminder && "has-reminder")} title={title}>
          {face}
        </span>
      )}
    </NodeViewWrapper>
  );
}

function relativeDay(d: Date, t: TFunction<"wiki">): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return t("editor.today");
  if (diff === 1) return t("editor.tomorrow");
  if (diff === -1) return t("editor.yesterday");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

