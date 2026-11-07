// wiki_page.* events (contracts/wiki.md "Events") on the TanStack Query cache. They carry
// the page without its body: the tree is patched in place, and an open page someone else
// changed elsewhere is refetched (the page view then takes it, or asks when typing is
// unsaved). Elsewhere includes the same person in another tab or through Ollie: what
// tells this tab's own saves apart is the version its saver already holds.

import type { QueryClient } from "@tanstack/react-query";
import type { WikiNode, WikiPage, WikiPageSettings } from "../api/types";
import { qk } from "../queries";
import { openSaver } from "./saver";
import { removeSubtree, upsertNode } from "./tree";

export function applyWikiEvent(qc: QueryClient, verb: string, d: Record<string, unknown>) {
  void qc.invalidateQueries({ queryKey: qk.of("wiki", "search") });
  // A ticket's "Wiki" section: which pages mention it can change with any page.
  void qc.invalidateQueries({ queryKey: qk.of("tickets", "wiki") });
  const patch = (fn: (nodes: WikiNode[]) => WikiNode[]) => qc.setQueryData<WikiNode[]>(qk.wikiTree, (old) => (old ? fn(old) : old));
  if (verb === "deleted") {
    const ids = (d.wiki_page_ids as string[] | undefined) ?? [d.wiki_page_id as string];
    patch((nodes) => removeSubtree(nodes, ids));
    // A page moved to the trash still opens (with its banner); one deleted or moved out of sight does not.
    if (d.trashed) for (const id of ids) void qc.invalidateQueries({ queryKey: qk.wikiPage(id) });
    else if (!d.moved) for (const id of ids) qc.removeQueries({ queryKey: qk.wikiPage(id) });
    void qc.invalidateQueries({ queryKey: qk.wikiTrash });
    void qc.invalidateQueries({ queryKey: qk.wikiFavorites });
    void qc.invalidateQueries({ queryKey: qk.wikiTemplates });
    void qc.invalidateQueries({ queryKey: qk.wikiRecent });
    return;
  }
  const node = d.wiki_page as WikiNode | undefined;
  if (!node) return;
  // A page restored from the trash or copied with its subpages brings a whole branch back.
  if (verb === "restored" || (verb === "created" && ((d.wiki_page_ids as string[] | undefined)?.length ?? 0) > 1)) {
    void qc.invalidateQueries({ queryKey: qk.wikiTree });
    void qc.invalidateQueries({ queryKey: qk.wikiTrash });
    void qc.invalidateQueries({ queryKey: qk.wikiPage(node.id) });
    return;
  }
  if (node.template) {
    void qc.invalidateQueries({ queryKey: qk.wikiTemplates });
    return;
  }
  if (verb === "moved") {
    // Positions of its old and new siblings moved too, and breadcrumbs below it.
    void qc.invalidateQueries({ queryKey: qk.wikiTree });
    void qc.invalidateQueries({ queryKey: qk.of("wiki", "page") });
    return;
  }
  patch((nodes) => upsertNode(nodes, node));
  // A new look (contracts/wiki.md "Page settings") or verification has no version: it is taken as it comes.
  const settings = d.settings as WikiPageSettings | undefined;
  if (settings) qc.setQueryData<WikiPage>(qk.wikiPage(node.id), (old) => (old ? { ...old, ...settings } : old));
  // Aliases have no version either (contracts/wiki.md "Aliases").
  if (Array.isArray(d.aliases)) qc.setQueryData<WikiPage>(qk.wikiPage(node.id), (old) => (old ? { ...old, aliases: d.aliases as string[] } : old));
  if ("verification" in d) qc.setQueryData<WikiPage>(qk.wikiPage(node.id), (old) => (old ? { ...old, verification: d.verification as WikiPage["verification"] } : old));
  // A canvas has no version either (contracts/wiki.md "Canvas"): the open canvas takes it when idle.
  if (d.canvas) qc.setQueryData<WikiPage>(qk.wikiPage(node.id), (old) => (old ? { ...old, canvas: d.canvas as WikiPage["canvas"] } : old));
  else if (d.canvas_changed) void qc.invalidateQueries({ queryKey: qk.wikiPage(node.id) });
  const page = qc.getQueryData<WikiPage>(qk.wikiPage(node.id));
  // This tab's own saves come back with their answer (the saver has the version already).
  const known = Math.max(page?.version ?? Infinity, openSaver(node.id)?.version ?? 0);
  if (known < node.version) void qc.invalidateQueries({ queryKey: qk.wikiPage(node.id) });
  void qc.invalidateQueries({ queryKey: qk.wikiRevisions(node.id), refetchType: "none" });
}

/** wiki_comment.changed (contracts/wiki.md "Comments"): the page's threads are read again. */
export function applyWikiCommentEvent(qc: QueryClient, d: Record<string, unknown>) {
  if (typeof d.page_id === "string") void qc.invalidateQueries({ queryKey: qk.wikiComments(d.page_id) });
}
