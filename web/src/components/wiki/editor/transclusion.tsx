// Synced blocks (Notion's) and embeds of a note (Obsidian's ![[Note]] and ![[Note#Heading]]):
// another page, or one block or heading's section of it, shown live and read-only where it
// sits (contracts/wiki.md "Blocks"). The source is read as its reader may read it: a page
// they can't see shows a stub without its title, and an embed that would show itself, or go
// round through other embeds, shows another.

import { NodeViewWrapper, EditorContent, useEditor, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown, EyeOff, FileText, Hash, Repeat2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { TextInput } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import type { WikiNode } from "@/lib/api/types";
import { PageIcon } from "../PageTree";
import { useTitle, useWikiTree } from "../hooks";
import { useWikiEditorEnv } from "./context";
import { readerExtensions } from "./extensions";
import { rank } from "./menu";
import { embedStop, outlineOf, sectionOf, type OutlineEntry } from "./transclude";

/** The pages shown around this point: the page being read first, then each embed's page inside it. */
const EmbedChain = createContext<string[]>([]);

const frame = "wiki-synced my-1 rounded-lg border border-line bg-surface";

export function TransclusionView({ node, editor, selected, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const env = useWikiEditorEnv();
  const outer = useContext(EmbedChain);
  const chain = outer.length ? outer : [env.pageId];
  const id = node.attrs.id as string;
  const block = node.attrs.block as string;
  const ring = selected && "shadow-[0_0_0_2px_var(--focus)]";

  if (!id)
    return (
      <NodeViewWrapper>
        {editor.isEditable ? <EmbedPicker exclude={chain[0]} onPick={(page, section) => updateAttributes({ id: page, block: section })} /> : null}
      </NodeViewWrapper>
    );
  const stop = embedStop(chain, id);
  if (stop)
    return (
      <NodeViewWrapper>
        <Stub icon={<Repeat2 />} className={cn(ring)}>
          {t(stop === "deep" ? "editor.synced.tooDeep" : "editor.synced.loop")}
        </Stub>
      </NodeViewWrapper>
    );
  return (
    <NodeViewWrapper>
      <Synced id={id} block={block} chain={chain} editable={editor.isEditable} ring={!!selected} onSection={(b) => updateAttributes({ block: b })} />
    </NodeViewWrapper>
  );
}

function Stub({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div contentEditable={false} className={cn("my-1 flex min-h-10 items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-fg-3 [&_svg]:size-4 [&_svg]:shrink-0", className)}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

function Synced({ id, block, chain, editable, ring, onSection }: { id: string; block: string; chain: string[]; editable: boolean; ring: boolean; onSection: (block: string) => void }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { data: page, isLoading, isError } = useQuery({ ...q.wikiPage(id), retry: false });
  const html = useMemo(() => (!page ? null : block ? sectionOf(page.body_html, block) : page.body_html), [page, block]);
  const outline = useMemo(() => (page ? outlineOf(page.body_html) : []), [page]);
  const heading = block ? outline.find((o) => o.id === block) : undefined;
  const [choosing, setChoosing] = useState(false);

  if (isLoading)
    return (
      <div contentEditable={false} className={cn(frame, "p-3")}>
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-4/5" />
      </div>
    );
  // Out of sight or gone: nothing about the page, not even its title.
  if (isError || !page || page.deleted_at)
    return (
      <Stub icon={<EyeOff />} className={cn(ring && "shadow-[0_0_0_2px_var(--focus)]")}>
        {t("editor.synced.hidden")}
      </Stub>
    );
  return (
    <div contentEditable={false} className={cn(frame, "group/synced overflow-hidden transition-[border-color,box-shadow] hover:border-line-strong", ring && "shadow-[0_0_0_2px_var(--focus)]")} data-drag-handle="">
      <div className="flex h-8 items-center gap-1.5 border-b border-line-soft bg-sunken px-2.5 text-[12px] text-fg-3">
        <Repeat2 className="size-3.5 shrink-0 text-fg-4" aria-label={t("editor.synced.label")} />
        <PageIcon icon={page.icon} className="size-4 text-[12px]" />
        <span className="min-w-0 truncate font-medium text-fg-2">{title(page.title)}</span>
        {block && (
          <span className="flex min-w-0 items-center gap-1 truncate text-fg-4">
            <Hash className="size-3 shrink-0" />
            <span className="truncate">{heading?.text || t("editor.synced.block")}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5" data-print="hide">
          {editable && (outline.length > 0 || block) && (
            <Popover
              open={choosing}
              onOpenChange={setChoosing}
              align="end"
              className="w-[260px] p-1"
              trigger={
                <button type="button" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-3 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/synced:opacity-100 [@media(hover:none)]:opacity-100">
                  {t("editor.synced.section")}
                  <ChevronDown className="size-3" />
                </button>
              }
            >
              <OutlineList
                outline={outline}
                current={block}
                onPick={(b) => {
                  onSection(b);
                  setChoosing(false);
                }}
              />
            </Popover>
          )}
          <Link to="/wiki/$pageId" params={{ pageId: id }} hash={block || undefined} className="flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg">
            {t("editor.synced.edit")}
            <ArrowUpRight className="size-3" />
          </Link>
        </span>
      </div>
      {html === null ? (
        <p className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-fg-4">
          <FileText className="size-4" />
          {t("editor.synced.blockGone")}
        </p>
      ) : html.trim() === "" ? (
        <p className="px-3 py-2.5 text-[13px] text-fg-4">{t("editor.synced.empty")}</p>
      ) : (
        <EmbedChain.Provider value={[...chain, id]}>
          <EmbedBody html={html} />
        </EmbedChain.Provider>
      )}
    </div>
  );
}

/** The source's text, read-only, with every block drawn as on its own page. */
function EmbedBody({ html }: { html: string }) {
  const { t } = useTranslation("wiki");
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  // Made once per embed; the tag link reads the router through the ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const extensions = useMemo(() => readerExtensions({ t, onOpenTag: (tag) => void nav.current({ to: "/wiki/tags", search: { tag } }) }), []);
  const editor = useEditor({
    extensions,
    content: html,
    editable: false,
    immediatelyRender: true,
    editorProps: { attributes: { class: "tiptap prose-od wiki-prose wiki-synced-body px-3 py-2", "data-ph-mask": "true" } },
  });
  useEffect(() => {
    if (editor && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, html]);
  return <EditorContent editor={editor} />;
}

function OutlineList({ outline, current, onPick, autoFocus }: { outline: OutlineEntry[]; current: string; onPick: (block: string) => void; autoFocus?: boolean }) {
  const { t } = useTranslation("wiki");
  const min = Math.min(3, ...outline.map((o) => o.level));
  const row = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover";
  return (
    <div
      role="listbox"
      aria-label={t("editor.synced.section")}
      className="max-h-[280px] overflow-y-auto"
      onKeyDown={(e) => {
        // Arrows move between the entries; Enter picks one (a button's own).
        e.stopPropagation();
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }}
    >
      <button type="button" role="option" autoFocus={autoFocus} aria-selected={!current} className={cn(row, !current && "font-medium text-fg")} onClick={() => onPick("")}>
        <FileText className="size-3.5 shrink-0 text-fg-4" />
        {t("editor.synced.wholePage")}
      </button>
      {outline.map((o) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={current === o.id}
          className={cn(row, current === o.id && "font-medium text-fg")}
          style={{ paddingLeft: 8 + (o.level - min) * 14 }}
          onClick={() => onPick(o.id)}
        >
          <Hash className="size-3.5 shrink-0 text-fg-4" />
          <span className="truncate">{o.text || t("editor.untitledHeading")}</span>
        </button>
      ))}
    </div>
  );
}

/** An empty synced block asks which page to show, then which part of it. */
function EmbedPicker({ exclude, onPick }: { exclude: string; onPick: (page: string, block: string) => void }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree } = useWikiTree();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<WikiNode | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pages = useMemo(() => {
    const all = [...tree.byId.values()].filter((n) => n.id !== exclude && n.kind !== "database");
    const sorted = query.trim() ? all : all.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return rank(query, sorted, (n) => [title(n.title)]).slice(0, 8);
  }, [tree, exclude, query, title]);
  const source = useQuery({ ...q.wikiPage(page?.id ?? ""), enabled: !!page, retry: false });
  const outline = useMemo(() => (source.data ? outlineOf(source.data.body_html) : []), [source.data]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, pages.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && pages[index]) {
      e.preventDefault();
      setPage(pages[index]);
    }
  };

  if (page)
    return (
      <div contentEditable={false} className="my-1 rounded-lg border border-line bg-sunken p-1.5">
        <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-fg-3">
          <PageIcon icon={page.icon} />
          <span className="truncate font-medium text-fg-2">{title(page.title)}</span>
          <span className="text-fg-4">{t("editor.synced.pickSection")}</span>
        </div>
        {source.isLoading ? (
          <div className="p-2">
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : (
          <OutlineList autoFocus outline={outline} current="__none" onPick={(b) => onPick(page.id, b)} />
        )}
      </div>
    );
  return (
    <div contentEditable={false} className="my-1 rounded-lg border border-line bg-sunken p-1.5">
      <TextInput
        autoFocus
        inputSize="sm"
        value={query}
        onChange={(e) => (setQuery(e.target.value), setIndex(0))}
        onKeyDown={onKey}
        placeholder={t("editor.synced.search")}
        aria-label={t("editor.synced.search")}
      />
      <div ref={list} role="listbox" aria-label={t("editor.menu.pages")} className="mt-1 max-h-[260px] overflow-y-auto">
        {pages.length === 0 ? (
          <p className="px-2 py-2 text-[12.5px] text-fg-4">{t("editor.menu.noPages")}</p>
        ) : (
          pages.map((n, i) => (
            <button
              key={n.id}
              type="button"
              role="option"
              data-i={i}
              aria-selected={i === index}
              onMouseMove={() => i !== index && setIndex(i)}
              onClick={() => setPage(n)}
              className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-2", i === index && "bg-hover text-fg")}
            >
              <PageIcon icon={n.icon} />
              <span className="truncate">{title(n.title)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
