import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/endpoints", () => ({
  api: {
    // A token for w1 whose private teams are tp: the manager joins what its claims cover.
    realtimeToken: () => Promise.resolve({ token: `x.${btoa(JSON.stringify({ wid: "w1", teams: ["tp"] }))}.y`, url: "", expires_at: "" }),
    events: () => Promise.resolve({ data: [], latest_seq: 0, resync: false }),
    tickets: { typing: () => Promise.resolve() },
  },
}));
vi.mock(import("../api/client"), async (importOriginal) => ({ ...(await importOriginal()), getWorkspaceId: () => "w1" }));

import { RealtimeManager } from "./manager";
import { useRealtime, wikiPresenceKey } from "./store";
import { setSocketFactory, type RtChannel, type RtSocket } from "./transport";

type FakeChannel = {
  topic: string;
  params: () => Record<string, unknown>;
  joined: Record<string, unknown>[];
  left: boolean;
  pushes: { event: string; payload: object }[];
  handlers: Map<string, (p: unknown) => void>;
};

let channels: FakeChannel[] = [];
const wikiChannels = () => channels.filter((c) => c.topic.startsWith("wiki_page:"));
const open = () => wikiChannels().filter((c) => c.joined.length && !c.left);

function fakeSocket(): RtSocket {
  const reply = { receive: () => reply };
  return {
    connect: () => undefined,
    disconnect: () => undefined,
    onOpen: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
    isConnected: () => true,
    channel: (topic: string, params?: object | (() => object)): RtChannel => {
      const c: FakeChannel = {
        topic,
        params: () => ({ ...(typeof params === "function" ? params() : (params ?? {})) }) as Record<string, unknown>,
        joined: [],
        left: false,
        pushes: [],
        handlers: new Map(),
      };
      channels.push(c);
      return {
        // Phoenix reads a params function at every (re)join.
        join: () => {
          c.joined.push(c.params());
          return reply;
        },
        leave: () => {
          c.left = true;
          return reply;
        },
        on: (event, cb) => {
          c.handlers.set(event, cb);
          return 0;
        },
        off: () => undefined,
        push: (event, payload) => {
          c.pushes.push({ event, payload });
          return reply;
        },
        onError: () => undefined,
        onClose: () => undefined,
      };
    },
  };
}

const meta = (user_id: string, state: string, phx_ref: string) => ({ user_id, name: user_id.toUpperCase(), state, phx_ref });

describe("RealtimeManager wiki page presence", () => {
  let m: RealtimeManager;

  beforeEach(async () => {
    channels = [];
    useRealtime.setState({ presence: {} });
    setSocketFactory(() => fakeSocket());
    m = new RealtimeManager({ qc: new QueryClient(), workspaceId: "w1", userId: "me" });
    await m.start();
  });
  afterEach(() => m.stop());

  it("joins the open page with its state, and a private team's page with its team", () => {
    m.setActiveWikiPage("p1", { state: "editing" });
    expect(open().map((c) => [c.topic, c.joined[0]])).toEqual([["wiki_page:w1:p1", { state: "editing" }]]);

    m.setActiveWikiPage("p2", { teamId: "tp" });
    expect(open().map((c) => [c.topic, c.joined[0]])).toEqual([["wiki_page:w1:p2", { state: "viewing", team_id: "tp" }]]);
    expect(wikiChannels()[0].left).toBe(true);
  });

  it("joins a teamspace page of a team that is not one of the token's private teams without team_id", () => {
    m.setActiveWikiPage("p1", { teamId: "public-team" });
    expect(open()[0].joined[0]).toEqual({ state: "viewing" });
  });

  it("pushes state changes on the open page, once each, and rejoins with the current state", () => {
    m.setActiveWikiPage("p1");
    m.setWikiPresenceState("editing");
    m.setWikiPresenceState("editing");
    m.setActiveWikiPage("p1", { state: "idle" });
    const [ch] = open();
    expect(ch.pushes).toEqual([
      { event: "presence", payload: { state: "editing" } },
      { event: "presence", payload: { state: "idle" } },
    ]);
    // The same page is not rejoined for a state change; a reconnect's rejoin says the latest.
    expect(wikiChannels()).toHaveLength(1);
    expect(ch.params()).toEqual({ state: "idle" });
  });

  it("keeps the page's presence in the store under its key, and clears it on leaving", () => {
    m.setActiveWikiPage("p1");
    const [ch] = open();
    ch.handlers.get("presence_state")!({ ana: { metas: [meta("ana", "viewing", "a1")] } });
    ch.handlers.get("presence_diff")!({ joins: { ben: { metas: [meta("ben", "editing", "b1")] } }, leaves: {} });
    expect(Object.keys(useRealtime.getState().presence[wikiPresenceKey("p1")]).sort()).toEqual(["ana", "ben"]);
    // A ticket with the same id is a different key.
    expect(useRealtime.getState().presence.p1).toBeUndefined();

    m.setActiveWikiPage(null);
    expect(ch.left).toBe(true);
    expect(useRealtime.getState().presence[wikiPresenceKey("p1")]).toBeUndefined();
    // A late push from the old channel is ignored.
    ch.handlers.get("presence_diff")!({ joins: { cy: { metas: [meta("cy", "viewing", "c1")] } }, leaves: {} });
    expect(useRealtime.getState().presence[wikiPresenceKey("p1")]).toBeUndefined();
  });

  it("leaves the page when the focus moves to another workspace", () => {
    m.setActiveWikiPage("p1");
    m.setFocus("w2");
    expect(open()).toEqual([]);
    m.setWikiPresenceState("editing");
    expect(wikiChannels()[0].pushes).toEqual([]);
  });
});
