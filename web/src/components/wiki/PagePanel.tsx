// The panel beside a wiki page, as Obsidian's right sidebar: the page's outline, its links
// (pages linking here, pages naming it without a link, pages it links to, tickets it
// mentions), its local graph,
// its comments (comments/CommentsPanel.tsx) and what it holds (words, reading time, tags,
// aliases, its views over the last weeks, who made it). Kept open per browser.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { ArrowUpRight, Hash, Link2, ListTree, MessageSquare, Network, X, Info, CornerDownRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { WikiMention, WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { fullDate, number, relLong } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { linkFirstMention } from "@/lib/wiki/linkMention";
import { useNow } from "@/lib/useNow";
import { scrollToBlock } from "./editor/views";
import { TicketLine } from "./editor/desk";
import type { PanelTab } from "./editor/prefs";
import { AliasChips } from "./Aliases";
import { WikiGraph } from "./Graph";
import { PageAnalytics } from "./PageAnalytics";
import { useTitle, useWikiTree } from "./hooks";
import { PageIcon } from "./PageTree";

type Heading = { level: number; text: string; id: string };

function useHeadings(editor: Editor | null): Heading[] {
  const [heads, setHeads] = useState<Heading[]>([]);
  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const out: Heading[] = [];
      editor.state.doc.descendants((n) => {
        if (n.type.name === "heading") out.push({ level: n.attrs.level as number, text: n.textContent, id: (n.attrs["block-id"] as string) ?? "" });
        return n.type.name !== "heading";
      });
      setHeads(out);
    };
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return heads;
}

/** The heading the reader is at: the last one above the top of the scrolling page. */
function useCurrentHeading(heads: Heading[], scrollEl: HTMLElement | null): string {
  const [current, setCurrent] = useState("");
  useEffect(() => {
    if (!scrollEl || !heads.length) return;
    let frame = 0;
    const measure = () => {
      const top = scrollEl.getBoundingClientRect().top + 96;
      let at = heads[0]?.id ?? "";
      for (const h of heads) {
        const el = h.id ? scrollEl.querySelector(`[data-block-id="${CSS.escape(h.id)}"]`) : null;
        if (el && el.getBoundingClientRect().top <= top) at = h.id;
      }
      setCurrent(at);
    };
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    scrollEl.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollEl.removeEventListener("scroll", on);
    };
  }, [heads, scrollEl]);
  return current;
}

export function PagePanel({
  page,
  editor,
  scrollEl,
  tab,
  onTab,
  onClose,
  canEdit,
  comments,
  commentCount,
  className,
}: {
  page: WikiPage;
  editor: Editor | null;
  scrollEl: HTMLElement | null;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  canEdit: boolean;
  /** The Comments tab's content. */
  comments: ReactNode;
  commentCount: number;
  className?: string;
}) {
  const { t } = useTranslation("wiki");
  const backlinks = useQuery(q.wikiBacklinks(page.id));
  return (
    <aside aria-label={t("panel.label")} className={cn("flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-surface animate-slide-in-right motion-reduce:animate-none", className)}>
      <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-line pr-1.5">
          <TabsList className="h-full min-w-0 flex-1 gap-0 border-b-0 px-1">
            <TabsTrigger value="outline" icon={<ListTree />}>
              {t("panel.outline")}
            </TabsTrigger>
            <TabsTrigger value="links" icon={<Link2 />} count={backlinks.data?.length || undefined}>
              {t("panel.links")}
            </TabsTrigger>
            <TabsTrigger value="graph" icon={<Network />}>
              <span className="sr-only">{t("panel.graph")}</span>
            </TabsTrigger>
            <TabsTrigger value="comments" icon={<MessageSquare />} count={commentCount || undefined}>
              <span className="sr-only">{t("comments.tab")}</span>
            </TabsTrigger>
            <TabsTrigger value="info" icon={<Info />}>
              <span className="sr-only">{t("panel.info")}</span>
            </TabsTrigger>
          </TabsList>
          <Tooltip content={t("panel.close")}>
            <Button square variant="ghost" size="sm" aria-label={t("panel.close")} onClick={onClose}>
              <X className="size-4" />
            </Button>
          </Tooltip>
        </div>
        <TabsContent value="outline" className="min-h-0 flex-1 overflow-y-auto p-2">
          <Outline editor={editor} scrollEl={scrollEl} />
        </TabsContent>
        <TabsContent value="links" className="min-h-0 flex-1 overflow-y-auto p-2">
          <Links page={page} editor={editor} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="graph" className="flex min-h-0 flex-1 flex-col">
          <LocalGraph page={page} />
        </TabsContent>
        <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col">
          {comments}
        </TabsContent>
        <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto p-3">
          <PageInfo page={page} editor={editor} canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-[12.5px] leading-5 text-fg-3 [&>svg]:size-5 [&>svg]:text-fg-4">
      {icon}
      {children}
    </div>
  );
}

function Outline({ editor, scrollEl }: { editor: Editor | null; scrollEl: HTMLElement | null }) {
  const { t } = useTranslation("wiki");
  const heads = useHeadings(editor);
  const current = useCurrentHeading(heads, scrollEl);
  if (!heads.length) return <Empty icon={<ListTree />}>{t("panel.outlineEmpty")}</Empty>;
  const min = Math.min(...heads.map((h) => h.level));
  return (
    <nav aria-label={t("panel.outline")} className="relative">
      {heads.map((h, i) => (
        <button
          key={`${h.id}-${i}`}
          type="button"
          onClick={() => scrollToBlock(h.id)}
          aria-current={current === h.id ? "location" : undefined}
          className={cn(
            "relative block w-full truncate rounded-md py-1 pr-2 text-left text-[12.5px] transition-colors hover:bg-hover hover:text-fg",
            current === h.id ? "font-medium text-fg" : "text-fg-3",
            h.level === min && "text-fg-2",
          )}
          style={{ paddingLeft: 10 + (h.level - min) * 14 }}
        >
          {current === h.id && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-fg" />}
          {h.text || t("editor.untitledHeading")}
        </button>
      ))}
    </nav>
  );
}

function MentionRow({ m, action }: { m: WikiMention; action?: ReactNode }) {
  const title = useTitle();
  return (
    <div className="group/m rounded-lg px-2 py-1.5 transition-colors hover:bg-hover">
      <div className="flex items-center gap-1.5">
        <Link to="/wiki/$pageId" params={{ pageId: m.id }} className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] font-medium text-fg hover:underline">
          <PageIcon icon={m.icon} />
          <span className="truncate">{title(m.title)}</span>
        </Link>
        {action}
      </div>
      {m.snippet && <p className="mt-0.5 line-clamp-2 pl-[22px] text-[11.5px] leading-[16px] text-fg-3">{m.snippet}</p>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="label-caps flex items-center gap-1.5 px-2 pb-1 pt-1.5">
        {title}
        {count ? <span className="mono text-fg-4">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Links({ page, editor, canEdit }: { page: WikiPage; editor: Editor | null; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const qc = useQueryClient();
  const title = useTitle();
  const { tree } = useWikiTree();
  const backlinks = useQuery(q.wikiBacklinks(page.id));
  const mentions = useQuery(q.wikiMentions(page.id));
  const [linking, setLinking] = useState<string | null>(null);

  // Pages this one links to and tickets it mentions, read from the text as it is now.
  const [outgoing, setOutgoing] = useState<string[]>([]);
  const [tickets, setTickets] = useState<string[]>([]);
  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const ids: string[] = [];
      const ticketIds: string[] = [];
      editor.state.doc.descendants((n) => {
        const id = n.type.name === "pageLink" || n.type.name === "subpage" ? (n.attrs.id as string) : "";
        if (id && !ids.includes(id) && id !== page.id) ids.push(id);
        const tid = n.type.name === "ticketMention" ? (n.attrs.id as string) : "";
        if (tid && !ticketIds.includes(tid)) ticketIds.push(tid);
      });
      setOutgoing((old) => (old.join() === ids.join() ? old : ids));
      setTickets((old) => (old.join() === ticketIds.join() ? old : ticketIds));
    };
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor, page.id]);

  const link = async (m: WikiMention) => {
    setLinking(m.id);
    try {
      const other = await api.wiki.get(m.id);
      // It may name this page by its title or by one of its aliases.
      let html: string | null = null;
      for (const name of [page.title, ...(page.aliases ?? [])]) if ((html = linkFirstMention(other.body_html, name, page.id))) break;
      if (!html) throw new Error(t("panel.mentionGone"));
      const saved = await api.wiki.update(m.id, { body_html: html, version: other.version });
      qc.setQueryData(qk.wikiPage(m.id), saved);
      await Promise.all([qc.invalidateQueries({ queryKey: qk.wikiBacklinks(page.id) }), qc.invalidateQueries({ queryKey: qk.wikiMentions(page.id) })]);
      toast.success(t("panel.linked", { title: title(m.title) }));
    } catch (e) {
      toast.error(e, t("panel.linkFailed"));
    } finally {
      setLinking(null);
    }
  };

  const loading = backlinks.isLoading || mentions.isLoading;
  if (loading)
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-4" />
      </div>
    );
  const back = backlinks.data ?? [];
  const unlinked = mentions.data ?? [];
  const out = outgoing.map((id) => tree.byId.get(id)).filter((n) => !!n);
  if (!back.length && !unlinked.length && !out.length && !tickets.length) return <Empty icon={<Link2 />}>{t("panel.linksEmpty")}</Empty>;
  return (
    <>
      <Section title={t("panel.backlinks")} count={back.length}>
        {back.length ? back.map((m) => <MentionRow key={m.id} m={m} />) : <p className="px-2 py-1 text-[12px] text-fg-4">{t("panel.backlinksEmpty")}</p>}
      </Section>
      {unlinked.length > 0 && (
        <Section title={t("panel.unlinked")} count={unlinked.length}>
          {unlinked.map((m) => (
            <MentionRow
              key={m.id}
              m={m}
              action={
                canEdit && (
                  <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-[11.5px] opacity-0 group-hover/m:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" disabled={linking === m.id} onClick={() => void link(m)}>
                    {linking === m.id ? <Spinner className="size-3" /> : <Link2 className="size-3" />}
                    {t("panel.link")}
                  </Button>
                )
              }
            />
          ))}
        </Section>
      )}
      {out.length > 0 && (
        <Section title={t("panel.outgoing")} count={out.length}>
          {out.map((n) => (
            <Link key={n.id} to="/wiki/$pageId" params={{ pageId: n.id }} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg">
              <CornerDownRight className="size-3.5 text-fg-4" />
              <PageIcon icon={n.icon} />
              <span className="truncate">{title(n.title)}</span>
            </Link>
          ))}
        </Section>
      )}
      {tickets.length > 0 && (
        <Section title={t("desk.panelTickets")} count={tickets.length}>
          {tickets.map((id) => (
            <TicketLine key={id} id={id} />
          ))}
        </Section>
      )}
    </>
  );
}

function LocalGraph({ page }: { page: WikiPage }) {
  const { t } = useTranslation("wiki");
  const navigate = useNavigate();
  const { data: nodes = [] } = useQuery(q.wikiTree());
  const { data: links = [] } = useQuery(q.wikiGraph());
  const [depth, setDepth] = useState<1 | 2>(1);
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5">
        {([1, 2] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDepth(d)}
            aria-pressed={depth === d}
            className={cn("h-6 rounded-md px-2 text-[11.5px] transition-colors", depth === d ? "bg-active font-medium text-fg" : "text-fg-3 hover:bg-hover hover:text-fg")}
          >
            {t("panel.depth", { count: d })}
          </button>
        ))}
        <Link to="/wiki/graph" search={{ focus: page.id }} className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          {t("panel.openGraph")}
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <WikiGraph nodes={nodes} links={links} focus={page.id} depth={depth} subpageLinks compact orphans height="100%" onOpen={(id) => void navigate({ to: "/wiki/$pageId", params: { pageId: id } })} />
      </div>
    </>
  );
}

/** Words as the reader's language counts them. */
function countWords(text: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ isWordLike?: boolean }> } }).Segmenter;
  if (!Seg) return text.split(/\s+/).filter(Boolean).length;
  let n = 0;
  for (const s of new Seg(undefined, { granularity: "word" }).segment(text)) if (s.isWordLike) n++;
  return n;
}

function PageInfo({ page, editor, canEdit }: { page: WikiPage; editor: Editor | null; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const [adding, setAdding] = useState(false);
  const now = useNow();
  const [text, setText] = useState(() => editor?.getText() ?? "");
  useEffect(() => {
    if (!editor) return;
    const read = () => setText(editor.getText());
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  const stats = useMemo(() => {
    const words = countWords(text);
    return { words, chars: text.replace(/\s/g, "").length, minutes: Math.max(1, Math.round(words / 230)) };
  }, [text]);
  const { tree } = useWikiTree();
  const tags = tree.byId.get(page.id)?.tags ?? page.tags ?? [];
  const row = (label: string, value: ReactNode, title?: string) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]" title={title}>
      <span className="text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-right text-fg">{value}</span>
    </div>
  );
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          [number(stats.words), t("panel.words", { count: stats.words })],
          [number(stats.chars), t("panel.characters", { count: stats.chars })],
          [t("panel.minutes", { count: stats.minutes }), t("panel.reading")],
        ].map(([value, label]) => (
          <div key={label} className="rounded-lg border border-line px-2.5 py-2">
            <div className="text-[15px] font-semibold tabular-nums leading-5 text-fg">{value}</div>
            <div className="mt-0.5 truncate text-[11px] text-fg-3">{label}</div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <h3 className="label-caps pb-1">{t("panel.tags")}</h3>
        {tags.length ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Link key={tag} to="/wiki/tags" search={{ tag }} className="inline-flex h-6 items-center gap-0.5 rounded-md bg-tone-violet-soft px-1.5 text-[12px] text-tone-violet transition-colors hover:brightness-95">
                <Hash className="size-3" />
                {tag}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-fg-4">{t("panel.tagsEmpty")}</p>
        )}
      </div>
      <div className="mt-4">
        <h3 className="label-caps pb-1">{t("aliases.label")}</h3>
        <AliasChips page={page} canEdit={canEdit} adding={adding} onAdding={setAdding} variant="panel" />
        <p className="mt-1 text-[11.5px] leading-4 text-fg-4">{t("aliases.hint")}</p>
      </div>
      <PageAnalytics pageId={page.id} />
      <Readers pageId={page.id} />
      <div className="mt-4 divide-y divide-line-soft">
        {row(t("panel.created"), page.created_by ? t("panel.by", { name: page.created_by.name, when: relLong(page.created_at, now) }) : relLong(page.created_at, now), fullDate(page.created_at))}
        {row(t("panel.edited"), page.updated_by ? t("panel.by", { name: page.updated_by.name, when: relLong(page.updated_at, now) }) : relLong(page.updated_at, now), fullDate(page.updated_at))}
        {row(t("panel.subpages"), number(page.children.length))}
        {row(t("panel.version"), number(page.version))}
      </div>
    </>
  );
}

/** Who read the page lately (the counts are PageAnalytics's): the latest readers. */
function Readers({ pageId }: { pageId: string }) {
  const { t } = useTranslation("wiki");
  const now = useNow();
  const { data } = useQuery(q.wikiViews(pageId));
  if (!data?.readers.length) return null;
  return (
    <div className="mt-4">
      <h3 className="label-caps pb-1">{t("panel.readers")}</h3>
      {data.readers.length > 0 && (
        <ul className="mt-1.5 flex flex-col">
          {data.readers.slice(0, 6).map((r) => (
            <li key={r.user.id} className="flex h-7 items-center gap-2 text-[12.5px]">
              <Avatar name={r.user.name} src={r.user.avatar_url} size="xs" />
              <span className="min-w-0 flex-1 truncate text-fg">{r.user.name}</span>
              <span className="shrink-0 text-[11.5px] text-fg-4" title={fullDate(r.last_at)}>
                {relLong(r.last_at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
