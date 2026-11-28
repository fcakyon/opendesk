import { useEffect, useState } from "preact/hooks";
import type { LiveState } from "./live";
import type { AIActionStatus, Conversation, Message, Rating, UiMessage, WidgetConfig, WidgetSession } from "./types";

export type View = "home" | "thread";

/** Local state of an action card while the visitor's decision is on its way. */
export type ActionUi = { busy?: "confirm" | "decline"; status?: AIActionStatus; error?: boolean };

export type State = {
  open: boolean;
  view: View;
  /** Resolved config (every appearance key filled in). */
  config: WidgetConfig | null;
  session: WidgetSession | null;
  conversations: Conversation[] | null;
  /** Open conversation id, or null for a new one. */
  active: string | null;
  /** The topic picked for the new conversation (config.topics), sent as topic_id. */
  topic: string | null;
  /** A suggestion tapped before a topic was picked: sent once the visitor picks one. */
  queued: string | null;
  messages: Record<string, UiMessage[]>;
  /** ticket_id -> agent name, while they are typing. */
  typing: Record<string, string>;
  unread: number;
  /** The team's latest unread reply, previewed above the launcher while the widget is closed. */
  teaser: Message | null;
  error: string | null;
  booting: boolean;
  /** Active language; changing it re-renders every string. */
  lang: string;
  /** conversation id -> "Talk to a person" request state. */
  handoff: Record<string, "pending" | "done" | "failed">;
  /** conversation id -> when the visitor's last message was delivered, until a reply arrives. */
  awaiting: Record<string, number>;
  /** The agent's replies as they stream in (contracts/realtime.md "Live events"). */
  live: LiveState;
  /** Messages that took the place of a live preview: shown without an entrance. */
  swapped: Record<string, true>;
  /** Ratings sent but not yet confirmed by `message.updated`, by message id (null clears). */
  ratings: Record<string, Rating | null>;
  /** Action cards by action id. */
  actions: Record<string, ActionUi>;
  /** Rendered as the dashboard preview: contained in its host, no focus moves. */
  preview: boolean;
  /** Forced dark (true) or light (false) for config.theme "auto"; null follows the system. */
  dark: boolean | null;
  /** The verification notice: a send on its way, the last send's outcome, verified while shown, closed. */
  verify: VerifyUi;
};

/**
 * "resent": another link went out; "wait": too soon for another; "failed": it could not be sent.
 * merged: the address the visitor verified, when their chat went to the contact that has it.
 */
export type VerifyUi = { busy: boolean; note: "resent" | "wait" | "failed" | null; verifiedNow: boolean; closed: boolean; merged: string | null };

export const initialState = (): State => ({
  open: false,
  view: "home",
  config: null,
  session: null,
  conversations: null,
  active: null,
  topic: null,
  queued: null,
  messages: {},
  typing: {},
  unread: 0,
  teaser: null,
  error: null,
  booting: true,
  lang: "en",
  handoff: {},
  awaiting: {},
  live: { replies: {}, closed: [] },
  swapped: {},
  ratings: {},
  actions: {},
  preview: false,
  dark: null,
  verify: { busy: false, note: null, verifiedNow: false, closed: false, merged: null },
});

export type Patch = Partial<State> | ((s: State) => Partial<State>);

/** One widget's state. Each widget (the page's, or a dashboard preview) owns its own. */
export class Store {
  private state: State;
  private subs = new Set<() => void>();

  constructor(init: Partial<State> = {}) {
    this.state = { ...initialState(), ...init };
  }

  get(): State {
    return this.state;
  }

  set(patch: Patch) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    if (!next || Object.keys(next).length === 0) return;
    this.state = { ...this.state, ...next };
    this.subs.forEach((f) => f());
  }

  subscribe(f: () => void) {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  }
}

export function useStore(store: Store): State {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get();
}
