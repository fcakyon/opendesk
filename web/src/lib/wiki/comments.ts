// What the wiki's comments (contracts/wiki.md "Comments") work out without the network:
// the order threads read in, the cache after a write, and comments typed and not sent yet.

import type { WikiComments, WikiThread } from "../api/types";

/**
 * Threads as the page reads: inline ones by where their text is in the page (those whose
 * text is gone, in the order they were made), then the page's own discussion, oldest first.
 */
export function orderThreads(threads: WikiThread[], positions: ReadonlyMap<string, number>): WikiThread[] {
  const made = (a: WikiThread, b: WikiThread) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const placed = threads.filter((t) => t.inline && positions.has(t.id)).sort((a, b) => positions.get(a.id)! - positions.get(b.id)! || made(a, b));
  const lost = threads.filter((t) => t.inline && !positions.has(t.id)).sort(made);
  const page = threads.filter((t) => !t.inline).sort(made);
  return [...placed, ...lost, ...page];
}

/** The cache with a thread as the API answered it: replaced in place, or added last. */
export function withThread(cur: WikiComments | undefined, t: WikiThread): WikiComments | undefined {
  if (!cur) return cur;
  const i = cur.data.findIndex((x) => x.id === t.id);
  return { ...cur, data: i < 0 ? [...cur.data, t] : cur.data.map((x, j) => (j === i ? t : x)) };
}

/** The cache without a comment; the first comment of a thread takes the thread with it. */
export function withoutComment(cur: WikiComments | undefined, commentId: string): WikiComments | undefined {
  if (!cur) return cur;
  return {
    ...cur,
    data: cur.data.filter((t) => t.id !== commentId).map((t) => (t.comments.some((c) => c.id === commentId) ? { ...t, comments: t.comments.filter((c) => c.id !== commentId) } : t)),
  };
}

/** Comments in open threads: what "Comments (n)" counts under the title. */
export const openCount = (threads: WikiThread[]) => threads.reduce((n, t) => (t.resolved_at ? n : n + t.comments.length), 0);

/** The page's link that opens one thread, as notifications link to it. */
export const threadUrl = (origin: string, pageId: string, threadId: string) => `${origin}/wiki/${pageId}?comment=${encodeURIComponent(threadId)}`;

// ─── Drafts ───────────────────────────────────────────────────────────────

/**
 * Comments typed and not sent, by page and thread ("new" for a page comment, "inline" for
 * one on selected text), for as long as the tab is open: leaving a thread or the page
 * keeps what was written there.
 */
const drafts = new Map<string, string>();

export const draftKey = (pageId: string, thread: string) => `${pageId}:${thread}`;

export function readDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/** Keeps html for key; a blank one is forgotten. */
export function keepDraft(key: string, html: string, blank: boolean) {
  if (blank) drafts.delete(key);
  else drafts.set(key, html);
}

export function forgetDraft(key: string) {
  drafts.delete(key);
}
