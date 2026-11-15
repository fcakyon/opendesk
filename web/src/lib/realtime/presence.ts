// Phoenix Presence state, kept as a plain map so it is easy to test and render.

/** A ticket's states are viewing, replying and idle; a wiki page's viewing, editing and idle. */
export type PresenceStatus = "viewing" | "replying" | "editing" | "idle";
export type WikiPresenceStatus = Extract<PresenceStatus, "viewing" | "editing" | "idle">;

export type PresenceMeta = {
  user_id: string;
  name: string;
  avatar?: string;
  state: PresenceStatus;
  online_at?: string;
  phx_ref?: string;
};
export type PresenceState = Record<string, { metas: PresenceMeta[] }>;
export type PresenceDiff = { joins: PresenceState; leaves: PresenceState };

export function syncState(_prev: PresenceState, next: PresenceState): PresenceState {
  return structuredClone(next);
}

export function syncDiff(prev: PresenceState, diff: PresenceDiff): PresenceState {
  const state: PresenceState = structuredClone(prev);
  for (const [key, { metas }] of Object.entries(diff.joins ?? {})) {
    const cur = state[key]?.metas ?? [];
    const refs = new Set(metas.map((m) => m.phx_ref));
    state[key] = { metas: [...cur.filter((m) => !refs.has(m.phx_ref)), ...metas] };
  }
  for (const [key, { metas }] of Object.entries(diff.leaves ?? {})) {
    const cur = state[key];
    if (!cur) continue;
    const refs = new Set(metas.map((m) => m.phx_ref));
    const left = cur.metas.filter((m) => !refs.has(m.phx_ref));
    if (left.length) state[key] = { metas: left };
    else delete state[key];
  }
  return state;
}

export type Viewer = { user_id: string; name: string; avatar?: string; state: PresenceMeta["state"] };

/** Who is writing (a reply, a page) first, then who is looking, then who stepped away. */
const rank: Record<PresenceStatus, number> = { replying: 2, editing: 2, viewing: 1, idle: 0 };

/** One entry per user (most active state wins), excluding `self`; the most active first, then by name. */
export function viewers(state: PresenceState, self?: string): Viewer[] {
  const out: Viewer[] = [];
  for (const [key, { metas }] of Object.entries(state)) {
    if (!metas.length) continue;
    const best = metas.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
    const user_id = best.user_id ?? key;
    if (user_id === self) continue;
    out.push({ user_id, name: best.name, avatar: best.avatar, state: best.state });
  }
  return out.sort((a, b) => rank[b.state] - rank[a.state] || a.name.localeCompare(b.name));
}
