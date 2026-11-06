// What the wiki's views share: the tree query, creating, moving and deleting pages with
// the cache patched at once (the server's answer or event settles it), and which pages
// are open in the tree.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { WikiNode, WikiPage, WikiSpace } from "@/lib/api/types";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";
import { forgetSaver } from "@/lib/wiki/saver";
import { applyMove, buildTree, descendantsOf, ownership, removeSubtree, spaceBody, upsertNode, type Drop, type Ownership } from "@/lib/wiki/tree";

export function useWikiTree() {
  const query = useQuery(q.wikiTree());
  const tree = useMemo(() => buildTree(query.data ?? []), [query.data]);
  return { ...query, tree };
}

export const nodeOf = (p: WikiPage): WikiNode => ({
  id: p.id,
  parent_id: p.parent_id,
  title: p.title,
  icon: p.icon,
  position: p.position,
  version: p.version,
  updated_at: p.updated_at,
  created_by_id: p.created_by?.id ?? null,
  tags: p.tags ?? [],
});

/** A page's title for display: "Untitled" until it has one. */
export function useTitle() {
  const { t } = useTranslation("wiki");
  return (title: string | undefined | null) => title?.trim() || t("untitled");
}

/** The open page's id, from the URL. */
export function useOpenPageId(): string | undefined {
  return useRouterState({ select: (s) => s.location.pathname.match(/^\/wiki\/([0-9a-f-]{36})/i)?.[1] });
}

// ─── Open pages in the tree ─────────────────────────────────────────────────

const listeners = new Set<() => void>();
const cache = new Map<string, Set<string>>();
const storeKey = (wid: string) => `od:wiki:open:${wid}`;

function openSet(wid: string): Set<string> {
  let s = cache.get(wid);
  if (!s) {
    try {
      s = new Set(JSON.parse(localStorage.getItem(storeKey(wid)) ?? "[]") as string[]);
    } catch {
      s = new Set();
    }
    cache.set(wid, s);
  }
  return s;
}

function setOpen(wid: string, ids: string[], open: boolean) {
  const next = new Set(openSet(wid));
  for (const id of ids) {
    if (open) next.add(id);
    else next.delete(id);
  }
  cache.set(wid, next);
  try {
    localStorage.setItem(storeKey(wid), JSON.stringify([...next].slice(-500)));
  } catch {
    // Private mode: it holds for this visit.
  }
  listeners.forEach((l) => l());
}

/** The pages showing their subpages, kept per workspace on this device. */
export function useExpanded() {
  const wid = useSession((s) => s.workspaceId) ?? "";
  const set = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => openSet(wid),
  );
  return {
    expanded: set,
    toggle: (id: string, open = !set.has(id)) => setOpen(wid, [id], open),
    open: (ids: string[]) => ids.some((id) => !set.has(id)) && setOpen(wid, ids, true),
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export function patchTree(qc: QueryClient, fn: (nodes: WikiNode[]) => WikiNode[]) {
  qc.setQueryData<WikiNode[]>(qk.wikiTree, (old) => (old ? fn(old) : old));
}

/** Pages just made here: their title takes the focus when they open. */
export const freshPages = new Set<string>();

export type NewPage = { parent_id?: string | null; space?: WikiSpace; team_id?: string; template?: boolean; title?: string; icon?: string; body_html?: string; position?: number };

export function useCreatePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { open } = useExpanded();
  const { t } = useTranslation("wiki");
  return useMutation({
    // `navigate: false` stays on the page: a subpage made from the editor ("/page", "[[new").
    mutationFn: ({ navigate: _stay, ...b }: NewPage & { navigate?: boolean }) => api.wiki.create(b),
    onSuccess: (page, vars) => {
      qc.setQueryData(qk.wikiPage(page.id), page);
      patchTree(qc, (nodes) => upsertNode(nodes, nodeOf(page)));
      if (page.parent_id) open([page.parent_id]);
      if (vars.navigate === false) return;
      freshPages.add(page.id);
      void navigate({ to: "/wiki/$pageId", params: { pageId: page.id } });
    },
    onError: (e) => toast.error(e, t("toast.createFailed")),
  });
}

export function useMovePage() {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  return useMutation({
    mutationFn: ({ id, drop }: { id: string; drop: Drop }) => api.wiki.move(id, { parent_id: drop.parent, position: drop.position, ...(drop.space ? spaceBody(drop.space) : {}) }),
    onMutate: ({ id, drop }) => {
      const before = qc.getQueryData<WikiNode[]>(qk.wikiTree);
      patchTree(qc, (nodes) => applyMove(nodes, id, drop));
      return { before };
    },
    onSuccess: (page) => {
      qc.setQueryData<WikiPage>(qk.wikiPage(page.id), (old) => (old ? { ...old, parent_id: page.parent_id, position: page.position, breadcrumbs: page.breadcrumbs } : old));
      // Breadcrumbs of the pages under it moved too.
      void qc.invalidateQueries({ queryKey: qk.of("wiki", "page"), refetchType: "none" });
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(qk.wikiTree, ctx.before);
      toast.error(e, t("toast.moveFailed"));
    },
  });
}

/** Asks first, naming the subpages that go with it, then deletes for good. */
export function useDeletePage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const openId = useOpenPageId();
  const { t } = useTranslation("wiki");
  const title = useTitle();
  return (node: WikiNode) => {
    const tree = buildTree(qc.getQueryData<WikiNode[]>(qk.wikiTree) ?? [node]);
    const under = descendantsOf(tree, node.id);
    const gone = [node.id, ...under.map((n) => n.id)];
    confirm.show(
      under.length ? t("delete.withSubpages", { count: under.length }) : t("delete.body"),
      async () => {
        await api.wiki.remove(node.id);
        patchTree(qc, (nodes) => removeSubtree(nodes, gone));
        for (const id of gone) {
          forgetSaver(id);
          qc.removeQueries({ queryKey: qk.wikiPage(id) });
        }
        if (openId && gone.includes(openId))
          void navigate(node.parent_id ? { to: "/wiki/$pageId", params: { pageId: node.parent_id } } : { to: "/wiki" });
        toast.success(t("toast.deleted", { title: title(node.title) }));
      },
      { title: t("delete.title", { title: title(node.title) }), confirmLabel: under.length ? t("delete.confirmAll", { count: under.length + 1 }) : t("delete.confirm"), danger: true },
    );
  };
}

/**
 * Whether the person may delete a page (contracts/wiki.md "Access"): yes; no (viewers);
 * or "page" / "subpages" when someone else created the page or one under it, so only an
 * admin can. A page not in the tree yet shows the action and lets the API decide.
 */
export type DeleteRule = "no" | Ownership;

export function useDeleteRule() {
  const role = useRole();
  const me = useSession((s) => s.user?.id);
  const { tree } = useWikiTree();
  return (id: string): DeleteRule => {
    if (!atLeast(role, "agent")) return "no";
    if (atLeast(role, "admin")) return "yes";
    return ownership(tree, id, me);
  };
}

// ─── Trash ──────────────────────────────────────────────────────────────────

/** Moves a page and its subpages to the trash at once, with Undo (contracts/wiki.md "Trash"). */
export function useTrashPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const openId = useOpenPageId();
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const restore = useRestorePage();
  return async (node: WikiNode) => {
    const before = qc.getQueryData<WikiNode[]>(qk.wikiTree);
    const tree = buildTree(before ?? [node]);
    const gone = [node.id, ...descendantsOf(tree, node.id).map((n) => n.id)];
    patchTree(qc, (nodes) => removeSubtree(nodes, gone));
    if (openId && gone.includes(openId)) void navigate(node.parent_id ? { to: "/wiki/$pageId", params: { pageId: node.parent_id } } : { to: "/wiki" });
    try {
      const page = await api.wiki.trash(node.id);
      qc.setQueryData(qk.wikiPage(node.id), page);
      for (const id of gone.slice(1)) qc.removeQueries({ queryKey: qk.wikiPage(id) });
      void qc.invalidateQueries({ queryKey: qk.wikiTrash });
      void qc.invalidateQueries({ queryKey: qk.wikiFavorites });
      void qc.invalidateQueries({ queryKey: qk.wikiRecent });
      toast.undo(t("trash.moved", { title: title(node.title) }), () => void restore(node.id), t("trash.undo"));
    } catch (e) {
      if (before) qc.setQueryData(qk.wikiTree, before);
      toast.error(e, t("trash.moveFailed"));
    }
  };
}

/** Puts a page back from the trash where it was. */
export function useRestorePage() {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  const title = useTitle();
  return async (id: string) => {
    try {
      const page = await api.wiki.untrash(id);
      qc.setQueryData(qk.wikiPage(id), page);
      await Promise.all([qc.invalidateQueries({ queryKey: qk.wikiTree }), qc.invalidateQueries({ queryKey: qk.wikiTrash }), qc.invalidateQueries({ queryKey: qk.wikiRecent })]);
      toast.success(t("trash.restored", { title: title(page.title) }));
      return page;
    } catch (e) {
      toast.error(e, t("trash.restoreFailed"));
      return null;
    }
  };
}

// ─── Favorites ──────────────────────────────────────────────────────────────

/** The person's favorite pages, in their order, changed at once and saved behind. */
export function useFavorites() {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  const query = useQuery({ ...q.wikiFavorites(), enabled: useSession((s) => !!s.user) });
  const list = query.data ?? [];
  const save = async (next: WikiNode[]) => {
    const before = qc.getQueryData<WikiNode[]>(qk.wikiFavorites);
    qc.setQueryData(qk.wikiFavorites, next);
    try {
      const saved = await api.wiki.setFavorites(next.map((n) => n.id));
      qc.setQueryData(qk.wikiFavorites, saved.data);
    } catch (e) {
      if (before) qc.setQueryData(qk.wikiFavorites, before);
      toast.error(e, t("favorites.failed"));
    }
  };
  return {
    list,
    has: (id: string) => list.some((n) => n.id === id),
    toggle: (node: WikiNode) => void save(list.some((n) => n.id === node.id) ? list.filter((n) => n.id !== node.id) : [...list, node]),
    reorder: (ids: string[]) => void save(ids.map((id) => list.find((n) => n.id === id)).filter((n): n is WikiNode => !!n)),
  };
}
