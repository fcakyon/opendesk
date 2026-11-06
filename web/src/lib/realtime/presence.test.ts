import { describe, expect, it } from "vitest";
import { syncDiff, viewers, type PresenceState, type PresenceStatus } from "./presence";

const meta = (user_id: string, state: PresenceStatus, ref: string) => ({ user_id, name: user_id.toUpperCase(), state, phx_ref: ref });

describe("presence", () => {
  it("applies joins and leaves by phx_ref", () => {
    let s: PresenceState = {};
    s = syncDiff(s, { joins: { u1: { metas: [meta("u1", "viewing", "r1")] }, u2: { metas: [meta("u2", "viewing", "r2")] } }, leaves: {} });
    s = syncDiff(s, { joins: { u1: { metas: [meta("u1", "replying", "r3")] } }, leaves: {} });
    expect(s.u1.metas).toHaveLength(2);
    s = syncDiff(s, { joins: {}, leaves: { u2: { metas: [meta("u2", "viewing", "r2")] } } });
    expect(s.u2).toBeUndefined();
  });

  it("collapses tabs to the most active state and drops self", () => {
    const s: PresenceState = {
      u1: { metas: [meta("u1", "viewing", "a"), meta("u1", "replying", "b")] },
      me: { metas: [meta("me", "replying", "c")] },
      u3: { metas: [meta("u3", "idle", "d")] },
    };
    expect(viewers(s, "me")).toEqual([
      { user_id: "u1", name: "U1", avatar: undefined, state: "replying" },
      { user_id: "u3", name: "U3", avatar: undefined, state: "idle" },
    ]);
  });

  it("puts someone editing a page first, one entry per person across tabs", () => {
    const s: PresenceState = {
      ana: { metas: [meta("ana", "viewing", "a")] },
      ben: { metas: [meta("ben", "idle", "b"), meta("ben", "editing", "c")] },
      cy: { metas: [meta("cy", "idle", "d")] },
      me: { metas: [meta("me", "editing", "e")] },
    };
    expect(viewers(s, "me").map((v) => [v.user_id, v.state])).toEqual([
      ["ben", "editing"],
      ["ana", "viewing"],
      ["cy", "idle"],
    ]);
  });

  it("keeps a page's editors in step with joins and leaves", () => {
    let s: PresenceState = {};
    s = syncDiff(s, { joins: { ana: { metas: [meta("ana", "viewing", "a1")] } }, leaves: {} });
    // A state change is a join of the new meta and a leave of the old one.
    s = syncDiff(s, { joins: { ana: { metas: [meta("ana", "editing", "a2")] } }, leaves: { ana: { metas: [meta("ana", "viewing", "a1")] } } });
    expect(viewers(s)).toEqual([{ user_id: "ana", name: "ANA", avatar: undefined, state: "editing" }]);
    s = syncDiff(s, { joins: {}, leaves: { ana: { metas: [meta("ana", "editing", "a2")] } } });
    expect(viewers(s)).toEqual([]);
  });
});
