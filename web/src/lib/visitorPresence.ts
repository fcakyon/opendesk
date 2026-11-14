// Whether a chat's visitor is on the page, by the signal the chat follow-up uses to decide
// whether a reply is also emailed (GET /v1/tickets/{id}/visitor-presence, "customer_presence"
// on the ticket's channel; contracts/teams.md "Chat follow-up").
import type { QueryClient } from "@tanstack/react-query";
import { http } from "./api/client";
import { qk } from "./queries";

export type VisitorPresence = {
  chat: boolean;
  present: boolean;
  last_seen_at: string | null;
  away_after_seconds: number;
  email_follow_up: boolean;
};

export const visitorPresenceKey = (ticketId: string) => qk.of("tickets", "visitor-presence", ticketId);

export const visitorPresence = (ticketId: string) => http.get<VisitorPresence>(`/v1/tickets/${encodeURIComponent(ticketId)}/visitor-presence`);

/** "customer_presence": the visitor came back; the ticket's presence reloads. */
export function applyVisitorPresence(qc: QueryClient, ticketId: string) {
  void qc.invalidateQueries({ queryKey: visitorPresenceKey(ticketId) });
}

/** Minutes since the visitor's widget was last seen, or null when it never was. */
export function minutesAway(p: Pick<VisitorPresence, "last_seen_at">, now: number): number | null {
  if (!p.last_seen_at) return null;
  const t = Date.parse(p.last_seen_at);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : null;
}

/** When the presence should be reloaded to see the visitor go away: just after the follow-up's threshold. */
export function recheckIn(p: VisitorPresence, now: number): number | null {
  if (!p.present || !p.last_seen_at) return null;
  const t = Date.parse(p.last_seen_at);
  if (!Number.isFinite(t)) return null;
  return Math.max(1_000, t + p.away_after_seconds * 1000 + 1_000 - now);
}
