import { create } from "zustand";
import type { PresenceState } from "./presence";

export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

type Typing = { user_id: string; name: string; at: number };

/** The widget agent's reply as it is written (contracts/realtime.md "Live events"). Never stored. */
export type LiveReply = {
  reply_id: string;
  ticket_id: string;
  bot: string;
  /** The bot's look and picture (contracts/bots.md); absent from older servers. */
  botLook?: unknown;
  botAvatar?: string;
  /** Raw markdown so far, citation markers included. */
  text: string;
  tools: { tool: string; status: "running" | "done" | "error" }[];
  /** Set by ai.reply.ended: the posted message replaces the preview once it is in the thread. */
  message_id?: string;
  handoff?: boolean;
  ended: boolean;
  at: number;
};

type RealtimeState = {
  status: ConnectionStatus;
  /** Presence by key: a ticket's id, or `wikiPresenceKey(page id)`. */
  presence: Record<string, PresenceState>;
  typing: Record<string, Typing[]>;
  customerTyping: Record<string, number>;
  /** One live reply per ticket at most. */
  live: Record<string, LiveReply>;
  /** The ticket this person has open, if any. */
  active: string | null;
  /** Tickets that moved out of this person's view (a private team they are not on), by id. */
  hidden: Record<string, number>;
};

export const useRealtime = create<RealtimeState>(() => ({
  status: "idle",
  presence: {},
  typing: {},
  customerTyping: {},
  live: {},
  active: null,
  hidden: {},
}));

/** A ticket left this person's view: an open detail closes and says why. */
export function markHidden(ticketId: string) {
  useRealtime.setState((s) => ({ hidden: { ...s.hidden, [ticketId]: Date.now() } }));
}

/** Visible again (moved out of the private team, or the person joined it). */
export function unmarkHidden(ticketId: string) {
  if (!useRealtime.getState().hidden[ticketId]) return;
  useRealtime.setState((s) => {
    const hidden = { ...s.hidden };
    delete hidden[ticketId];
    return { hidden };
  });
}

/** The presence key of a wiki page; a ticket's is its id. */
export const wikiPresenceKey = (pageId: string) => `wiki_page:${pageId}`;

export function setPresence(key: string, state: PresenceState) {
  useRealtime.setState((s) => ({ presence: { ...s.presence, [key]: state } }));
}

export function clearPresence(key: string) {
  useRealtime.setState((s) => {
    const next = { ...s.presence };
    delete next[key];
    return { presence: next };
  });
}

const TYPING_MS = 5000;

export function noteTyping(ticketId: string, t: { user_id: string; name: string }) {
  useRealtime.setState((s) => {
    const cur = (s.typing[ticketId] ?? []).filter((x) => x.user_id !== t.user_id && Date.now() - x.at < TYPING_MS);
    return { typing: { ...s.typing, [ticketId]: [...cur, { ...t, at: Date.now() }] } };
  });
  setTimeout(() => {
    useRealtime.setState((s) => ({
      typing: { ...s.typing, [ticketId]: (s.typing[ticketId] ?? []).filter((x) => Date.now() - x.at < TYPING_MS) },
    }));
  }, TYPING_MS + 50);
}

export function noteCustomerTyping(ticketId: string) {
  useRealtime.setState((s) => ({ customerTyping: { ...s.customerTyping, [ticketId]: Date.now() } }));
  setTimeout(() => useRealtime.setState((s) => ({ customerTyping: { ...s.customerTyping } })), TYPING_MS + 50);
}

export function isCustomerTyping(at: number | undefined) {
  return !!at && Date.now() - at < TYPING_MS;
}

/** A preview whose posted message never shows up is dropped after this long. */
const LIVE_STALE_MS = 45_000;

function setLive(ticketId: string, next: LiveReply | null) {
  useRealtime.setState((s) => {
    const live = { ...s.live };
    if (next) live[ticketId] = next;
    else delete live[ticketId];
    return { live };
  });
}

export function clearLive(ticketId: string, replyId?: string) {
  const cur = useRealtime.getState().live[ticketId];
  if (cur && (!replyId || cur.reply_id === replyId)) setLive(ticketId, null);
}

/** Applies one "live" push. Events of one reply arrive in order; a new reply replaces an old one. */
export function applyLive(ticketId: string, type: string, data: Record<string, unknown>) {
  const replyId = typeof data.reply_id === "string" ? data.reply_id : "";
  if (!replyId) return;
  const cur = useRealtime.getState().live[ticketId];
  const base: LiveReply =
    cur && cur.reply_id === replyId
      ? cur
      : { reply_id: replyId, ticket_id: ticketId, bot: "", text: "", tools: [], ended: false, at: Date.now() };
  switch (type) {
    case "ai.reply.started": {
      const b = (data.bot ?? {}) as { name?: string; look?: unknown; avatar_url?: string };
      setLive(ticketId, { ...base, bot: b.name ?? "", botLook: b.look, botAvatar: b.avatar_url, at: Date.now() });
      break;
    }
    case "ai.reply.delta":
      setLive(ticketId, { ...base, text: base.text + (typeof data.text === "string" ? data.text : ""), at: Date.now() });
      break;
    case "ai.reply.tool": {
      const tool = typeof data.tool === "string" ? data.tool : "";
      const status: LiveReply["tools"][number]["status"] = data.status === "done" || data.status === "error" ? data.status : "running";
      const i = base.tools.findIndex((x) => x.tool === tool && x.status === "running");
      const tools: LiveReply["tools"] = i >= 0 ? base.tools.map((x, j) => (j === i ? { tool, status } : x)) : [...base.tools, { tool, status }];
      setLive(ticketId, { ...base, tools, at: Date.now() });
      break;
    }
    case "ai.reply.ended": {
      const messageId = typeof data.message_id === "string" ? data.message_id : null;
      if (!messageId) {
        setLive(ticketId, null);
        return;
      }
      setLive(ticketId, { ...base, ended: true, message_id: messageId, handoff: data.handoff === true, at: Date.now() });
      break;
    }
    default:
      return;
  }
  setTimeout(() => {
    const now = useRealtime.getState().live[ticketId];
    if (now && now.reply_id === replyId && Date.now() - now.at >= LIVE_STALE_MS) setLive(ticketId, null);
  }, LIVE_STALE_MS + 50);
}
