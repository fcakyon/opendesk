// One wiki page (/wiki/$pageId): its icon and title edited in place, the body in the
// knowledge base's editor, saved as people type (lib/wiki/saver.ts). Breadcrumbs follow
// the live tree; "Last edited" ticks in its own small component. When someone else saves
// first, the page keeps what was typed and asks whose version stays. A version loaded
// from the server (theirs, a restored one) is shown silently: loading is not an edit, and
// only someone who may edit ever saves. With `?beside=` a second page opens beside it (split
// view, components/wiki/split.tsx): a full page of its own, its editor and saver apart.

import { sidebarDragProps } from "@/lib/collab/sidebarDrag";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import { AlertTriangle, ArrowLeftRight, Check, CloudOff, Columns2, FileUp, FolderInput, History, Link2, Maximize2, MoreHorizontal, Plus, SmilePlus, Tag, Type, ImageIcon, PanelRight, Link2 as BacklinkIcon, Star, Copy, LayoutTemplate, BookOpenCheck, Printer, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@/app/RootLayout";
import { usePageCrumb, usePageTrail } from "@/app/useBreadcrumbs";
import { Toolbar, type RichEditorHandle } from "@/components/editor/RichEditor";
import { WikiEditor } from "@/components/wiki/editor/WikiEditor";
import type { WikiEditorEnv } from "@/components/wiki/editor/context";
import { usePanelPref, useToolbarPref } from "@/components/wiki/editor/prefs";
import { PagePanel } from "@/components/wiki/PagePanel";
import { Morph } from "@/components/motion";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-button";
import { Drawer } from "@/components/ui/dialog";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { EmptyState } from "@/components/ui/empty";
import { Menu, MenuCheckItem, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { HistoryDrawer } from "@/components/wiki/HistoryDrawer";
import { IconPicker } from "@/components/wiki/IconPicker";
import { FollowItem, MoveDialog, TrashItem } from "@/components/wiki/PageMenu";
import { useWikiPresence, WikiViewers } from "@/components/wiki/presence";
import { CommentsPanel } from "@/components/wiki/comments/CommentsPanel";
import { CommentCount, FollowButton, usePageComments } from "@/components/wiki/comments/PageComments";
import { DayNav, TemplateBanner, TrashBanner, Verification } from "@/components/wiki/PageBanners";
import { AddToSpace } from "@/components/wiki/AddToSpace";
import { PublishDialog } from "@/components/wiki/PublishDialog";
import { ExportPageItems } from "@/components/wiki/Export";
import { openImport, quickAdd } from "@/app/quickAdd";
import { usePageShortcuts } from "@/components/wiki/pageShortcuts";
import { AliasChips } from "@/components/wiki/Aliases";
import { printWikiPage } from "@/components/wiki/editor/print";
import { BESIDE_ATTR, OpenBesideDialog, useSplit, useWideScreen } from "@/components/wiki/split";

const CanvasView = lazy(() => import("@/components/wiki/canvas/CanvasView"));
import { DatabaseView } from "@/components/wiki/database/DatabaseView";
import { RowProperties } from "@/components/wiki/database/RowProperties";
import { UnsentBanner } from "@/components/wiki/Unsent";
import { PageIcon, pageUrl } from "@/components/wiki/PageTree";
import { PageCrumbs } from "@/components/wiki/PageCrumbs";
import { freshPages, nodeOf, patchTree, useCreatePage, useDeleteRule, useFavorites, useMovePage, useTitle, useUseTemplate, useWikiTree } from "@/components/wiki/hooks";
import { useProducts } from "@/lib/products";
import { areaHome, areaOf, pageTo, useArea } from "@/lib/wiki/area";
import type { PageSearch } from "@/lib/wiki/split";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import type { WikiArea, WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { fullDate, relLong } from "@/lib/format";
import { clampWidth, setLiveWidth, usePaneWidth } from "@/lib/panes";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";
import { useNow } from "@/lib/useNow";
import { forgetSaver, openSaver, saverFor, type PageSaver } from "@/lib/wiki/saver";
import { ancestorsOf, childrenOf, MAX_TITLE } from "@/lib/wiki/tree";
import { PagesButton } from "./WikiLayout";
import { CoverPicker, PageCover } from "@/components/wiki/PageCover";
import { PageStyleItems, useLook, LockedBar } from "@/components/wiki/PageStyle";


export default function WikiPageView(): ReactNode {
  const { t } = useTranslation("wiki");
  // A page of the wiki or of Pages: the same view under /wiki/<id> and /pages/<id>.
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  const { comment, beside: besideParam } = useSearch({ strict: false }) as PageSearch;
  const area = useArea();
  const beside = besideParam && besideParam !== pageId ? besideParam : undefined;
  const navigate = useNavigate();
  const page = useQuery(q.wikiPage(pageId));
  if (page.isLoading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-12 shrink-0 border-b border-line" />
        <div className="mx-auto w-full max-w-[760px] px-6 pt-16">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="mt-4 h-7 w-2/3" />
          <Skeleton className="mt-3 h-3 w-40" />
          <Skeleton className="mt-10 h-3 w-full" />
          <Skeleton className="mt-3 h-3 w-5/6" />
          <Skeleton className="mt-3 h-3 w-4/6" />
        </div>
      </div>
    );
  if (!page.data)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-line px-4">
          <PagesButton />
        </header>
        {isApiError(page.error, "not_found") && <Orphan id={pageId} />}
        <EmptyState
          art="wiki"
          title={isApiError(page.error, "not_found") ? t("page.notFound") : t("page.loadFailed")}
          description={isApiError(page.error, "not_found") ? t("page.notFoundHint") : errorMessage(page.error)}
          action={
            <Button asChild>
              <Link to={areaHome(area)}>{t("page.backHome")}</Link>
            </Button>
          }
        />
      </div>
    );
  const main = (
    <PageScreen
      key={pageId}
      page={page.data}
      openThread={comment}
      beside={beside}
      // The link has done its work: the address goes back to the page's own (and its side page).
      onThreadOpened={() => void navigate({ ...pageTo({ id: pageId, area }), search: { beside }, replace: true })}
    />
  );
  return beside ? <Split main={main} beside={beside} /> : main;
}

/**
 * The open page and the one beside it, the edge between them dragged to resize the side page
 * (kept per person in this browser). On a narrow screen the side page is a peek over the page.
 */
function Split({ main, beside }: { main: ReactNode; beside: string }) {
  const { t } = useTranslation("wiki");
  const wide = useWideScreen();
  const split = useSplit();
  const [width, setWidth] = usePaneWidth("beside");
  const rowRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setRoom(el.clientWidth));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  if (!wide)
    return (
      <>
        {main}
        <Drawer open onOpenChange={(o) => !o && split.close()} title={t("split.label")} width={820} header={<BesideBar id={beside} inDrawer />}>
          <BesidePane id={beside} />
        </Drawer>
      </>
    );
  return (
    <div ref={rowRef} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
      <ResizeHandle
        pane="beside"
        side="after"
        label={t("split.resize")}
        target={paneRef}
        room={() => rowRef.current?.clientWidth}
        width={width}
        onLive={(px) => setLiveWidth(paneRef.current, "beside", px === null ? null : `${px}px`)}
        onWidth={setWidth}
      />
      <section
        ref={paneRef}
        aria-label={t("split.label")}
        className="flex min-h-0 w-[var(--pane-beside-live,var(--pane-beside,50%))] shrink-0 flex-col border-l border-line animate-slide-in-right motion-reduce:animate-none"
        style={width === null ? undefined : ({ "--pane-beside": `${clampWidth("beside", width, room)}px` } as CSSProperties)}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
          <BesideBar id={beside} />
        </header>
        <BesidePane id={beside} />
      </section>
    </div>
  );
}

/** The side page's own bar: its title, and swap, open as the main page, close (a drawer has its own). */
function BesideBar({ id, inDrawer }: { id: string; inDrawer?: boolean }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const split = useSplit();
  const { data } = useQuery(q.wikiPage(id));
  const { tree } = useWikiTree();
  const node = tree.byId.get(id);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[12.5px] font-medium text-fg">
        <PageIcon icon={node?.icon ?? data?.icon ?? ""} kind={node?.kind} />
        <span className="truncate">{title(node?.title ?? data?.title)}</span>
      </span>
      <Tooltip content={t("split.swap")}>
        <Button square variant="ghost" size="sm" aria-label={t("split.swap")} onClick={split.swap} disabled={!data}>
          <ArrowLeftRight className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content={t("split.openMain")}>
        <Button square variant="ghost" size="sm" aria-label={t("split.openMain")} onClick={split.promote} disabled={!data}>
          <Maximize2 className="size-3.5" />
        </Button>
      </Tooltip>
      {!inDrawer && (
        <Tooltip content={t("split.close")}>
          <Button square variant="ghost" size="sm" aria-label={t("split.close")} onClick={split.close}>
            <X className="size-4" />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

/** The side page: a full page with its own editor and saves, without the main page's chrome. */
function BesidePane({ id }: { id: string }) {
  const { t } = useTranslation("wiki");
  const page = useQuery(q.wikiPage(id));
  if (page.isLoading)
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 pt-10">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="mt-4 h-3 w-full" />
        <Skeleton className="mt-3 h-3 w-5/6" />
      </div>
    );
  if (!page.data) return <EmptyState art="wiki" title={t("split.gone")} description={isApiError(page.error, "not_found") ? t("page.notFoundHint") : errorMessage(page.error)} />;
  return (
    <div {...{ [BESIDE_ATTR]: "" }} className="flex min-h-0 flex-1 flex-col">
      <PageScreen key={id} page={page.data} peek />
    </div>
  );
}

/** Typing left on a page that is gone: it can still be copied. */
function Orphan({ id }: { id: string }) {
  const saver = openSaver(id);
  if (!saver?.pending) return null;
  return <OrphanBanner saver={saver} />;
}

function OrphanBanner({ saver }: { saver: PageSaver }) {
  useSaver(saver);
  if (!saver.pending) return null;
  return <UnsentBanner reason="deleted" draft={saver.draft} onDiscard={() => forgetSaver(saver.id)} />;
}

function useSaver(saver: PageSaver) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = saver.subscribe(bump);
    return () => {
      off();
    };
  }, [saver]);
}

export function PageScreen({
  page,
  peek,
  beside,
  openThread,
  onThreadOpened,
}: {
  page: WikiPage;
  /** Shown inside another view (a database row's peek, the side page of a split): no header, panel, comments or presence of its own. */
  peek?: boolean;
  /** The page open beside this one, if any. */
  beside?: string;
  openThread?: string;
  onThreadOpened?: () => void;
}) {
  const { t } = useTranslation("wiki");
  const { t: ui } = useTranslation("ui");
  const qc = useQueryClient();
  const title = useTitle();
  const role = useRole();
  const me = useSession((s) => s.user?.id ?? null);
  const canEdit = atLeast(role, "agent");
  const create = useCreatePage();
  const moveTree = useMovePage();
  const pagesOn = useProducts().pages;
  const navigate = useNavigate();
  const { tree } = useWikiTree();

  const saver = useMemo(
    () =>
      saverFor(page, {
        onSaved: (p) => {
          qc.setQueryData<WikiPage>(qk.wikiPage(p.id), (old) => ({ ...(old ?? p), ...p }));
          patchTree(qc, (nodes) => nodes.map((n) => (n.id === p.id ? nodeOf(p) : n)));
        },
      }),
    // One saver per page: later loads of the page reach it through rebase below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.id],
  );
  useSaver(saver);
  const draft = saver.draft;
  const { data: live = page } = useQuery(q.wikiPage(page.id));
  const look = useLook(live);
  // A locked page reads like a viewer's until someone unlocks it (contracts/wiki.md "Page settings").
  const canWrite = canEdit && !live.locked && !live.deleted_at;
  // A row of a database shows its values under its title.
  const isRow = !!live.parent_id && tree.byId.get(live.parent_id)?.kind === "database";
  // A database's page is its views: full width, with a short description over them.
  const isDb = live.kind === "database";
  // A canvas's page is its board: full width too, the description over it.
  const isCanvas = live.kind === "canvas";
  const wide = isDb || isCanvas;
  const fav = useFavorites();
  const startFromTemplate = useUseTemplate();
  const [usingTemplate, setUsingTemplate] = useState(false);
  const deleteRule = useDeleteRule()(page.id);
  const shown = title(draft.title);
  // In a peek the page beneath keeps the window's title and the breadcrumb.
  useDocumentTitle(peek ? null : shown);
  usePageCrumb(peek ? null : shown);

  const editorRef = useRef<RichEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on("transaction", rerender);
    return () => {
      editor.off("transaction", rerender);
    };
  }, [editor]);
  const [showToolbar, setShowToolbar] = useToolbarPref();
  const [panel, setPanel] = usePanelPref();
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Mod+Shift+; opens and closes the page panel (the main page's: a peek has none).
  useEffect(() => {
    if (peek) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Semicolon") {
        e.preventDefault();
        setPanel(panel ? null : "outline");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, setPanel, peek]);
  // Comments (contracts/wiki.md "Comments"): agents write them on a page that isn't in the
  // trash; a thread on selected text also needs the right to edit the text it marks.
  const canComment = canEdit && !live.deleted_at;
  const openComments = useCallback(() => setPanel("comments"), [setPanel]);
  // Who else has the page open (contracts/realtime.md): editing while the text has focus.
  // A side peek leaves the page behind it joined.
  const [editorFocused, setEditorFocused] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const on = () => setEditorFocused(true);
    const off = () => setEditorFocused(false);
    editor.on("focus", on);
    editor.on("blur", off);
    return () => {
      editor.off("focus", on);
      editor.off("blur", off);
    };
  }, [editor]);
  useWikiPresence(peek ? undefined : live, canWrite && editorFocused);
  const comments = usePageComments({ pageId: page.id, editor, panelOpen: panel === "comments" && !peek, openPanel: openComments, openThread, onThreadOpened });
  const env = useMemo<WikiEditorEnv>(
    () => ({ pageId: page.id, canEdit: canWrite, upload: (f) => api.attachments.upload(f), unfurl: (url) => api.wiki.unfurl(url) }),
    [page.id, canWrite],
  );
  const createSubpage = useCallback(
    async (title?: string) => {
      try {
        const p = await create.mutateAsync({ parent_id: page.id, title, navigate: false });
        return p.id;
      } catch {
        return null;
      }
    },
    [create, page.id],
  );
  const openSubpage = useCallback(
    (id: string) => {
      // The block that leads to it is saved before this page closes.
      const html = editorRef.current?.editor?.getHTML();
      if (html && html !== saver.draft.body_html) saver.edit({ body_html: html });
      void saver.flush();
      freshPages.add(id);
      void navigate(pageTo({ id, area: live.area }));
    },
    [saver, navigate, live.area],
  );
  const copyBlockLink = useCallback(
    (blockId: string) => {
      // The block's id must be stored before anyone opens the link: save now.
      const html = editorRef.current?.editor?.getHTML();
      if (html && html !== saver.draft.body_html) saver.edit({ body_html: html });
      void saver.flush();
      void copyText(`${pageUrl(page.id)}#${blockId}`);
      toast.success(t("editor.blockLinkCopied"));
    },
    [page.id, saver, t],
  );

  // A page made a moment ago starts with its title focused.
  useEffect(() => {
    if (canEdit && freshPages.delete(page.id)) titleRef.current?.focus();
  }, [canEdit, page.id]);

  // What is typed goes out when the page closes (navigation keeps the saver alive).
  useEffect(() => () => void saver.flush(), [saver]);

  // A newer version from someone else (realtime refetches the page): taken in place when
  // nothing here is unsaved; with unsaved typing, the banner asks whose version stays.
  const latest = live;
  const take = useCallback(
    (p: WikiPage) => {
      saver.rebase(p);
      editorRef.current?.setHtml(p.body_html, { silent: true });
    },
    [saver],
  );
  const newer = saver.isNewer(latest);
  useEffect(() => {
    if (!newer || saver.busy || saver.status === "conflict") return;
    take(latest);
  }, [newer, latest, saver, saver.status, take]);
  const theirs = saver.status === "conflict" || (newer && saver.status === "dirty");

  // Cmd/Ctrl+S saves now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saver.flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saver]);

  const loadTheirs = async () => {
    try {
      const fresh = await api.wiki.get(page.id);
      qc.setQueryData(qk.wikiPage(page.id), fresh);
      take(fresh);
    } catch (e) {
      toast.error(e);
    }
  };
  const keepMine = async () => {
    try {
      const fresh = await api.wiki.get(page.id);
      qc.setQueryData(qk.wikiPage(page.id), fresh);
      saver.overwrite(fresh.version);
    } catch (e) {
      toast.error(e);
    }
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const a = await api.attachments.upload(file);
      const src = a.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const alt = file.name.replace(/\.[^.]+$/, "").replace(/[<>"]/g, "");
      editorRef.current?.insertHtml(`<img src="${src}" alt="${alt}">`);
    } catch (e) {
      toast.error(e, t("page.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const [iconOpen, setIconOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [moving, setMoving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [aliasing, setAliasing] = useState(false);
  const [pickBeside, setPickBeside] = useState(false);
  const split = useSplit();
  // A help center article is made from a plain page: not a template, a journal or a database.
  const canPublish = !live.template && !live.journal && !live.daily_date && !wide;
  const crumbs = tree.byId.has(page.id) ? ancestorsOf(tree, page.id) : page.breadcrumbs;
  // The header's breadcrumbs carry the same path, each parent a link.
  usePageTrail(peek ? null : crumbs.map((c) => ({ label: title(c.title), ...pageTo({ id: c.id, area: live.area }) })));
  const kids = tree.byId.has(page.id) ? childrenOf(tree, page.id) : page.children;
  const current = latest;
  const node = tree.byId.get(page.id) ?? nodeOf(current);

  const duplicatePage = async (asTemplate: boolean) => {
    try {
      const copy = await api.wiki.duplicate(page.id, asTemplate ? { template: true, title: title(live.title) } : { parent_id: live.parent_id, title: t("duplicate.title", { title: title(live.title) }), position: live.position + 1 });
      qc.setQueryData(qk.wikiPage(copy.id), copy);
      void qc.invalidateQueries({ queryKey: asTemplate ? qk.wikiTemplates : qk.wikiTree });
      if (asTemplate) toast.success(t("templatesPage.saved", { title: title(live.title) }));
      void navigate(pageTo(copy));
    } catch (e) {
      toast.error(e, t("duplicate.failed"));
    }
  };
  // Pages and the wiki are trees of their own (contracts/pages.md): the page moves with its
  // subpages to the top of the other one, and opens there.
  const moveArea = (to: WikiArea) =>
    moveTree.mutate(
      { id: page.id, drop: { parent: null, position: Number.MAX_SAFE_INTEGER, area: to } },
      {
        onSuccess: (moved) => {
          toast.success(to === "pages" ? t("pages.movedToPages", { title: title(live.title) }) : t("pages.movedToWiki", { title: title(live.title) }));
          void navigate({ ...pageTo(moved), replace: true });
        },
      },
    );
  const verify = async (verified: boolean, days?: number) => {
    try {
      const saved = await api.wiki.update(page.id, verified ? { verified: true, ...(days ? { verified_days: days } : {}) } : { verified: false });
      qc.setQueryData<WikiPage>(qk.wikiPage(page.id), (old) => (old ? { ...old, verification: saved.verification } : old));
      patchTree(qc, (nodes) => nodes.map((n) => (n.id === page.id ? { ...n, verified: !!saved.verification && !saved.verification.expired } : n)));
    } catch (e) {
      toast.error(e, t("verify.failed"));
    }
  };

  const copyLink = () => {
    void copyText(pageUrl(page.id));
    toast.success(t("toast.linkCopied"));
  };
  usePageShortcuts(
    live.deleted_at
      ? {}
      : {
          newPage: canEdit ? () => quickAdd.page(undefined, areaOf(live)) : undefined,
          newSubpage: canEdit ? () => create.mutate({ parent_id: page.id }) : undefined,
          parent: crumbs.length ? () => void navigate(pageTo({ id: crumbs[crumbs.length - 1]!.id, area: live.area })) : undefined,
          favorite: live.template ? undefined : () => fav.toggle(node),
          duplicate: canEdit && !live.journal ? () => void duplicatePage(false) : undefined,
          move: canEdit && !live.journal ? () => setMoving(true) : undefined,
          copyLink,
          beside: () => setPickBeside(true),
          history: () => setHistory(true),
          publish: canEdit && canPublish ? () => setPublishing(true) : undefined,
          exportMenu: () => document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(t("page.more"))}"]`)?.click(),
          lock: canEdit ? () => look.set({ locked: !live.locked }) : undefined,
        },
    !peek,
  );

  const iconTrigger = (
    <button
      type="button"
      disabled={!canWrite}
      aria-label={draft.icon ? t("icon.change") : t("icon.add")}
      className={cn(
        "flex items-center justify-center rounded-lg outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:pointer-events-none",
        draft.icon ? "size-14 text-[40px] leading-none hover:bg-hover" : "h-7 gap-1.5 px-2 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg",
      )}
    >
      {draft.icon ? (
        <span aria-hidden>{draft.icon}</span>
      ) : (
        <>
          <SmilePlus className="size-3.5" />
          {t("icon.add")}
        </>
      )}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!peek && (
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-3 sm:px-4">
          <PagesButton />
          <nav aria-label={t("page.breadcrumbs")} className="flex min-w-0 flex-1 items-center gap-1 text-[12.5px]">
            <PageCrumbs area={areaOf(live)} isPrivate={!!live.private} parents={crumbs} />
            <span className="hidden text-fg-4 sm:inline">/</span>
            <span
              className="flex min-w-0 items-center gap-1 px-1.5 font-medium text-fg"
              aria-current="page"
              // Dragged into the sidebar, the page lands in Favorites or a section of the member's own.
              {...(live.deleted_at || live.template ? {} : sidebarDragProps({ kind: "wiki_page", id: page.id, label: shown }))}
            >
              <PageIcon icon={draft.icon} />
              <span className="truncate">{shown}</span>
            </span>
            {canEdit && <SaveState saver={saver} />}
          </nav>
          <div className="flex shrink-0 items-center gap-0.5">
            {!live.deleted_at && !live.template && (
              <Tooltip content={fav.has(page.id) ? t("favorites.remove") : t("favorites.add")} shortcut="page.favorite">
                <Button square variant="ghost" size="sm" aria-label={fav.has(page.id) ? t("favorites.remove") : t("favorites.add")} aria-pressed={fav.has(page.id)} onClick={() => fav.toggle(node)}>
                  <Star className={cn("size-4", fav.has(page.id) && "fill-tone-amber-solid text-tone-amber-solid")} />
                </Button>
              </Tooltip>
            )}
            <WikiViewers pageId={page.id} />
            {!live.deleted_at && <FollowButton pageId={page.id} />}
            <Tooltip content={t("page.copyLink")} shortcut="page.copyLink">
              <Button square variant="ghost" size="sm" aria-label={t("page.copyLink")} onClick={copyLink}>
                <Link2 className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("panel.open")} shortcut="page.panel">
              <Button square variant="ghost" size="sm" aria-label={t("panel.open")} aria-pressed={!!panel} onClick={() => setPanel(panel ? null : "outline")} className={cn("hidden", beside ? "2xl:inline-flex" : "lg:inline-flex", panel && "bg-hover text-fg")}>
                <PanelRight className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("history.open")} shortcut="page.history">
              <Button square variant="ghost" size="sm" aria-label={t("history.open")} onClick={() => setHistory(true)}>
                <History className="size-4" />
              </Button>
            </Tooltip>
            {!live.deleted_at && (
              <Menu>
                <MenuTrigger asChild>
                  <Button square variant="ghost" size="sm" aria-label={t("page.more")}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {canEdit && (
                    <MenuItem icon={<Plus />} shortcut="page.newSubpage" onSelect={() => create.mutate({ parent_id: page.id })}>
                      {t("tree.addSubpage")}
                    </MenuItem>
                  )}
                  {canEdit && !live.journal && (
                    <MenuItem icon={<FolderInput />} shortcut="page.move" onSelect={() => setMoving(true)}>
                      {t("tree.moveTo")}
                    </MenuItem>
                  )}
                  {canEdit && !live.journal && !live.template && (pagesOn || areaOf(live) === "pages") && (
                    <MenuItem icon={<ArrowLeftRight />} onSelect={() => moveArea(areaOf(live) === "pages" ? "wiki" : "pages")}>
                      {areaOf(live) === "pages" ? t("pages.moveToWiki") : t("pages.moveToPages")}
                    </MenuItem>
                  )}
                  {canEdit && !live.journal && (
                    <MenuItem icon={<Copy />} shortcut="page.duplicate" onSelect={() => void duplicatePage(false)}>
                      {t("duplicate.action")}
                    </MenuItem>
                  )}
                  {canEdit && !live.template && !live.journal && (
                    <MenuItem icon={<LayoutTemplate />} onSelect={() => void duplicatePage(true)}>
                      {t("templatesPage.saveAs")}
                    </MenuItem>
                  )}
                  <MenuItem icon={<Link2 />} shortcut="page.copyLink" onSelect={copyLink}>
                    {t("page.copyLink")}
                  </MenuItem>
                  <MenuItem icon={<Columns2 />} shortcut="page.beside" onSelect={() => setPickBeside(true)}>
                    {t("split.openPageBeside")}
                  </MenuItem>
                  {beside && (
                    <MenuItem icon={<X />} onSelect={split.close}>
                      {t("split.close")}
                    </MenuItem>
                  )}
                  {canEdit && !live.template && <AddToSpace pageId={page.id} />}
                  {canEdit && canPublish && (
                    <MenuItem icon={<BookOpenCheck />} shortcut="page.publish" onSelect={() => setPublishing(true)}>
                      {t("publish.action")}
                    </MenuItem>
                  )}
                  <FollowItem pageId={page.id} />
                  <MenuItem icon={<History />} shortcut="page.history" onSelect={() => setHistory(true)}>
                    {t("history.open")}
                  </MenuItem>
                  <MenuSeparator />
                  <ExportPageItems page={live} hasSubpages={kids.length > 0} />
                  <MenuItem icon={<Printer />} shortcut="page.print" onSelect={() => printWikiPage(scrollEl)}>
                    {t("editor.print.menu")}
                  </MenuItem>
                  {canEdit && !live.template && live.kind !== "database" && (
                    <MenuItem icon={<FileUp />} onSelect={() => openImport(page.id)}>
                      {t("import.here")}
                    </MenuItem>
                  )}
                  {canEdit && (
                    <>
                      <MenuSeparator />
                      <PageStyleItems page={live} onChange={look.set} />
                      <MenuCheckItem icon={<Type />} checked={showToolbar} onSelect={() => setShowToolbar(!showToolbar)}>
                        {t("page.formattingBar")}
                      </MenuCheckItem>
                      <MenuSeparator />
                      <TrashItem node={node} />
                    </>
                  )}
                </MenuContent>
              </Menu>
            )}
          </div>
        </header>
      )}

      <TrashBanner page={live} canEdit={canEdit} canDelete={deleteRule === "yes"} />
      <TemplateBanner
        page={live}
        busy={usingTemplate}
        onUse={
          canEdit
            ? async () => {
                setUsingTemplate(true);
                await startFromTemplate(nodeOf(live));
                setUsingTemplate(false);
              }
            : undefined
        }
      />
      {canEdit && live.locked && !live.deleted_at && <LockedBar onUnlock={() => look.set({ locked: false })} />}

      {saver.final && saver.pending && (
        <UnsentBanner
          reason={saver.status === "forbidden" ? "forbidden" : "deleted"}
          draft={draft}
          onDiscard={() => {
            if (saver.status === "forbidden") return take(latest);
            forgetSaver(page.id);
            void navigate({ to: areaHome(areaOf(live)) });
          }}
        />
      )}

      {theirs && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--tone-amber-solid)_35%,var(--line))] bg-tone-amber-soft px-4 py-2.5 text-[12.5px] text-fg animate-rise-in motion-reduce:animate-none">
          <AlertTriangle className="size-4 shrink-0 text-tone-amber" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{latest.updated_by ? t("conflict.titleBy", { name: latest.updated_by.name }) : t("conflict.title")}</span>{" "}
            <span className="text-fg-2">{t("conflict.body")}</span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button size="sm" onClick={() => void loadTheirs()}>
              {t("conflict.loadTheirs")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void keepMine()}>
              {t("conflict.keepMine")}
            </Button>
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={setScrollEl} data-wiki-print className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", live.font !== "default" && `wiki-font-${live.font}`, live.small_text && "wiki-small")}>
          <PageCover cover={live.cover} coverY={live.cover_y} canEdit={canWrite} onChange={look.set} />
          <article className={cn("mx-auto w-full px-6 pb-32 md:px-10", wide ? "max-w-none md:px-16" : live.full_width ? "max-w-none md:px-24" : "max-w-[760px]", live.cover ? "pt-6" : "pt-10 md:pt-14")}>
            {live.daily_date && (
              <div data-print="hide">
                <DayNav page={live} />
              </div>
            )}
          <div className="group/head">
              {draft.icon && (
                <div className={cn("relative -ml-2 mb-2", live.cover && "-mt-[60px]")}>
                  {canWrite ? (
                    <IconPicker value={draft.icon} onChange={(icon) => saver.edit({ icon })} trigger={iconTrigger} open={iconOpen} onOpenChange={setIconOpen} />
                  ) : (
                    <span className="flex size-14 items-center justify-center text-[40px] leading-none" aria-hidden>
                      {draft.icon}
                    </span>
                  )}
                </div>
              )}
              {canWrite && (!draft.icon || !live.cover || !(live.aliases ?? []).length) && (
                <div
                  data-print="hide"
                  className={cn(
                    "-ml-2 mb-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100 [@media(hover:none)]:opacity-100",
                    (coverOpen || iconOpen) && "opacity-100",
                  )}
                >
                  {!draft.icon && <IconPicker value="" onChange={(icon) => saver.edit({ icon })} trigger={iconTrigger} open={iconOpen} onOpenChange={setIconOpen} />}
                  {!(live.aliases ?? []).length && !aliasing && (
                    <button
                      type="button"
                      onClick={() => setAliasing(true)}
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                    >
                      <Tag className="size-3.5" />
                      {t("aliases.add")}
                    </button>
                  )}
                  {!live.cover && (
                    <CoverPicker
                      value=""
                      onChange={(c) => look.set({ cover: c, cover_y: 50 })}
                      open={coverOpen}
                      onOpenChange={setCoverOpen}
                      trigger={
                        <button type="button" className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]">
                          <ImageIcon className="size-3.5" />
                          {t("cover.add")}
                        </button>
                      }
                    />
                  )}
                </div>
              )}
              <textarea
                ref={titleRef}
                value={draft.title}
                onChange={(e) => saver.edit({ title: e.target.value.replace(/\n/g, " ") })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === e.currentTarget.value.length)) {
                    e.preventDefault();
                    editorRef.current?.editor?.commands.focus("start");
                  }
                }}
                readOnly={!canWrite}
                rows={1}
                maxLength={MAX_TITLE}
                placeholder={t("untitled")}
                aria-label={ui("title")}
                className="wiki-title field-sizing-content w-full resize-none bg-transparent text-[30px] font-semibold leading-[36px] tracking-[-0.03em] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-none"
              />
              <AliasChips page={live} canEdit={canWrite} adding={aliasing} onAdding={setAliasing} variant="title" />
              <div data-print="hide" className="flex flex-wrap items-center gap-x-3">
                <EditedLine page={current} />
                <BacklinkCount pageId={page.id} onOpen={() => setPanel("links")} />
                {!peek && <CommentCount count={comments.count} canComment={canComment} onOpen={canComment ? comments.addComment : openComments} />}
              {!live.template && !live.journal && !live.daily_date && <Verification page={live} canEdit={canEdit && !live.deleted_at} onChange={verify} />}
              </div>
            </div>

            {isRow && <RowProperties page={live} canEdit={canWrite} />}
          {canWrite && editor && showToolbar && !wide && (
              <div data-print="hide" className="sticky top-3 z-10 -mx-3 mt-6 rounded-lg border border-line bg-surface/95 pt-1.5 shadow-xs backdrop-blur">
                <Toolbar editor={editor} full onImage={() => fileRef.current?.click()} end={uploading ? <span className="pr-2 text-xs text-fg-4">{t("page.uploading")}</span> : undefined} />
              </div>
            )}
            <WikiEditor
              ref={editorRef}
              value={draft.body_html}
              onChange={canWrite ? (html) => saver.edit({ body_html: html }) : undefined}
              editable={canWrite}
              placeholder={wide ? (canWrite ? t("db.description") : "") : canWrite ? t("editor.placeholder.empty") : t("page.bodyEmpty")}
              ariaLabel={t("page.body")}
              env={env}
              createSubpage={createSubpage}
              openSubpage={openSubpage}
              onCopyBlockLink={copyBlockLink}
              className={wide ? "mt-2 text-fg-2" : "mt-5"}
              contentClassName={wide ? "min-h-0" : "prose-lg"}
              onReady={setEditor}
              onOpenComment={peek ? undefined : comments.open}
              onStartComment={canWrite && !peek ? comments.start : undefined}
              pageTitle={draft.title}
            />
            {live.kind === "database" && (
              <div className="mt-6">
                <DatabaseView databaseId={live.id} />
              </div>
            )}
            {isCanvas && (
              <div className="mt-5 flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-line">
                <Suspense fallback={null}>
                  <CanvasView page={live} canEdit={canWrite} />
                </Suspense>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />

            {!wide && (kids.length > 0 || canEdit) && (
              <section data-print="hide" className="mt-14 border-t border-line-soft pt-6" aria-labelledby="wiki-subpages">
                <h2 id="wiki-subpages" className="label-caps mb-2">
                  {t("page.subpages")}
                </h2>
                <div className="flex flex-col gap-px">
                  {kids.map((k) => (
                    <Link
                      key={k.id}
                      {...pageTo({ id: k.id, area: live.area })}
                      className="-mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover"
                    >
                      <PageIcon icon={k.icon} />
                      <span className={cn("truncate", !k.title.trim() && "text-fg-3")}>{title(k.title)}</span>
                    </Link>
                  ))}
                  {canEdit && (
                    <button
                      type="button"
                      disabled={create.isPending}
                      onClick={(e) =>
                        // Ctrl or Cmd: the new page opens beside this one.
                        (e.metaKey || e.ctrlKey) && split.available
                          ? create.mutate({ parent_id: page.id, navigate: false }, { onSuccess: (p) => split.open(p.id) })
                          : create.mutate({ parent_id: page.id })
                      }
                      title={split.available ? t("page.addSubpageBesideHint") : undefined}
                      className="-mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:opacity-60"
                    >
                      <Plus className="size-[14px]" />
                      {t("page.addSubpage")}
                    </button>
                  )}
                </div>
              </section>
            )}
          </article>
        </div>
        {panel && !peek && (
          // Comments also open on a narrow screen, over the page.
          // With a page beside, the panel sits beside the text only on the widest screens; comments then open over it.
          <div
            className={
              panel === "comments"
                ? cn("fixed inset-y-0 right-0 z-40 flex max-w-full shadow-float", beside ? "2xl:static 2xl:z-auto 2xl:shadow-none" : "lg:static lg:z-auto lg:shadow-none")
                : beside
                  ? "hidden 2xl:flex"
                  : "hidden lg:flex"
            }
          >
            <PagePanel
              page={live}
              editor={editor}
              scrollEl={scrollEl}
              tab={panel}
              onTab={setPanel}
              onClose={() => setPanel(null)}
              canEdit={canWrite}
              commentCount={comments.count}
              className="max-w-full"
              comments={
                <CommentsPanel
                  pageId={page.id}
                  editor={editor}
                  access={{ me, admin: atLeast(role, "admin"), canComment }}
                  active={comments.active}
                  onActive={comments.setActive}
                  pending={comments.pending}
                  onCancelPending={comments.cancel}
                  onSendPending={comments.sendPending}
                  focusNew={comments.focusNew}
                />
              }
            />
          </div>
        )}
      </div>

      <HistoryDrawer
        page={current}
        open={history}
        onOpenChange={setHistory}
        canRestore={canEdit}
        onRestored={take}
      />
      <MoveDialog node={node} open={moving} onOpenChange={setMoving} />
      {!peek && <OpenBesideDialog open={pickBeside} onOpenChange={setPickBeside} exclude={[page.id, ...(beside ? [beside] : [])]} />}
      {canPublish && <PublishDialog pageId={page.id} pageTitle={draft.title} open={publishing} onOpenChange={setPublishing} beforePublish={() => saver.flush()} />}
    </div>
  );
}

/** Saving…, Saved, or what went wrong, beside the breadcrumbs. */
function SaveState({ saver }: { saver: PageSaver }) {
  const { t } = useTranslation("wiki");
  const s = saver.status;
  let body: ReactNode = null;
  if (s === "saving" || s === "dirty")
    body = (
      <>
        <Spinner className="size-3" />
        {t("save.saving")}
      </>
    );
  else if (s === "error")
    body = (
      <>
        <CloudOff className="size-3 text-tone-amber" />
        {t("save.retrying")}
      </>
    );
  else if (s === "conflict" || s === "forbidden" || s === "deleted")
    body = (
      <>
        <AlertTriangle className="size-3 text-tone-amber" />
        {t("save.notSaved")}
      </>
    );
  else if (saver.lastSavedAt)
    body = (
      <>
        <Check className="size-3 text-tone-green" strokeWidth={2.5} />
        {t("save.saved")}
      </>
    );
  return (
    <span className="ml-1 hidden shrink-0 items-center text-xs text-fg-4 sm:inline-flex" aria-live="polite">
      <Morph k={s === "dirty" ? "saving" : s === "saved" && !saver.lastSavedAt ? "idle" : s} className="items-center gap-1.5">
        {body}
      </Morph>
    </span>
  );
}

/** "Last edited by Maya, 3 min ago": its own clock, so only this line redraws. */
function EditedLine({ page }: { page: WikiPage }) {
  const { t } = useTranslation("wiki");
  const now = useNow();
  const who = page.updated_by;
  const when = relLong(page.updated_at, now);
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-3" title={fullDate(page.updated_at)}>
      {who && <Avatar name={who.name} src={who.avatar_url} size="xs" />}
      {who ? t("page.editedBy", { name: who.name, when }) : t("page.edited", { when })}
    </p>
  );
}

/** "3 backlinks" under the title, as Notion shows them: opens the panel's links. */
function BacklinkCount({ pageId, onOpen }: { pageId: string; onOpen: () => void }) {
  const { t } = useTranslation("wiki");
  const { data } = useQuery(q.wikiBacklinks(pageId));
  if (!data?.length) return null;
  return (
    <button type="button" onClick={onOpen} className="mt-2 flex items-center gap-1 rounded-md px-1 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">
      <BacklinkIcon className="size-3.5" />
      {t("panel.backlinkCount", { count: data.length })}
    </button>
  );
}
