// The home screen's list of the visitor's conversations. Open ones come first,
// then finished ones, each newest first. A finished conversation whose last
// message is more than FINISHED_DAYS old stays off the home screen, which shows
// HOME_MAX at most; the rest are one tap away, from the list the API already
// sends (GET /v1/widget/conversations, up to 100).

import type { Conversation } from "./types";

type Conv = Pick<Conversation, "status" | "last_message_at">;

export const HOME_MAX = 6;
export const FINISHED_DAYS = 30;

export function isFinished(c: Pick<Conversation, "status">): boolean {
  return c.status === "solved" || c.status === "closed";
}

/** The last message's time; an unreadable date counts as very old. */
function lastAt(c: Conv): number {
  const t = Date.parse(c.last_message_at);
  return Number.isFinite(t) ? t : 0;
}

/** Open conversations first, then finished ones; each group newest first. */
export function sortConversations<T extends Conv>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(isFinished(a)) - Number(isFinished(b)) || lastAt(b) - lastAt(a));
}

/** What the home screen shows, and how many conversations only the full list has. */
export function homeConversations<T extends Conv>(list: readonly T[], now = Date.now()): { shown: T[]; hidden: number } {
  const sorted = sortConversations(list);
  const cutoff = now - FINISHED_DAYS * 24 * 60 * 60 * 1000;
  const shown = sorted.filter((c) => !isFinished(c) || lastAt(c) >= cutoff).slice(0, HOME_MAX);
  return { shown, hidden: sorted.length - shown.length };
}
