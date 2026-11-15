// The filters on Settings → Members: role, team, status and a name or email search.
// They live in the URL (`?role=admin,agent&team=…&status=online&q=…`) so a filtered
// list can be shared and survives a reload. The list is loaded whole, so filtering is local.

import type { Availability, Member, Role, Team } from "@/lib/api/types";

export const MEMBER_ROLES = ["owner", "admin", "agent", "viewer"] as const satisfies readonly Role[];
export const MEMBER_STATUSES = ["online", "away", "offline"] as const satisfies readonly Availability[];
/** The team filter's value for members on no team. */
export const NO_TEAM = "none";

/** The filters as the URL carries them: lists are comma separated, empty is left out. */
export type MemberSearch = { q?: string; role?: string; team?: string; status?: string };

export type MemberFilters = {
  q: string;
  roles: Role[];
  /** A team id, NO_TEAM, or null for every member. */
  team: string | null;
  statuses: Availability[];
};

export const noMemberFilters: MemberFilters = { q: "", roles: [], team: null, statuses: [] };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** Known values only, each once, in their usual order. */
function listOf<T extends string>(raw: unknown, known: readonly T[]): T[] {
  const parts = typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : [];
  return known.filter((k) => parts.includes(k));
}

/** The route's `validateSearch`: unknown roles and statuses are dropped. */
export function parseMemberSearch(raw: Record<string, unknown>): MemberSearch {
  const role = listOf(raw.role, MEMBER_ROLES);
  const status = listOf(raw.status, MEMBER_STATUSES);
  return {
    q: str(raw.q),
    role: role.length ? role.join(",") : undefined,
    team: str(raw.team),
    status: status.length ? status.join(",") : undefined,
  };
}

export function filtersFromSearch(s: MemberSearch): MemberFilters {
  return {
    q: s.q ?? "",
    roles: listOf(s.role, MEMBER_ROLES),
    team: s.team || null,
    statuses: listOf(s.status, MEMBER_STATUSES),
  };
}

export function searchFromFilters(f: MemberFilters): MemberSearch {
  const roles = MEMBER_ROLES.filter((r) => f.roles.includes(r));
  const statuses = MEMBER_STATUSES.filter((s) => f.statuses.includes(s));
  return {
    q: f.q.trim() || undefined,
    role: roles.length ? roles.join(",") : undefined,
    team: f.team || undefined,
    status: statuses.length ? statuses.join(",") : undefined,
  };
}

export function hasMemberFilters(f: MemberFilters) {
  return !!f.q.trim() || f.roles.length > 0 || !!f.team || f.statuses.length > 0;
}

/** The ids of the teams each member is on, as a member or an observer. */
export function teamsByMember(teams: readonly Team[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of teams) {
    for (const m of t.members) {
      const set = out.get(m.user_id) ?? new Set<string>();
      set.add(t.id);
      out.set(m.user_id, set);
    }
  }
  return out;
}

/**
 * The members that pass every filter. A team that no longer exists matches nobody,
 * so a stale link shows an empty list rather than everyone.
 */
export function filterMembers(members: readonly Member[], f: MemberFilters, teams: readonly Team[]): Member[] {
  const term = f.q.trim().toLowerCase();
  const onTeams = teamsByMember(teams);
  return members.filter((m) => {
    if (term && !m.user.name.toLowerCase().includes(term) && !m.user.email.toLowerCase().includes(term)) return false;
    if (f.roles.length && !f.roles.includes(m.role)) return false;
    if (f.statuses.length && !f.statuses.includes(m.presence)) return false;
    if (f.team) {
      const mine = onTeams.get(m.user.id);
      if (f.team === NO_TEAM ? mine && mine.size > 0 : !mine?.has(f.team)) return false;
    }
    return true;
  });
}

export type MemberCounts = {
  roles: Record<Role, number>;
  statuses: Record<Availability, number>;
  /** By team id, plus NO_TEAM. */
  teams: Record<string, number>;
};

/** How many members each filter option holds, over the whole list. */
export function memberCounts(members: readonly Member[], teams: readonly Team[]): MemberCounts {
  const roles: Record<Role, number> = { owner: 0, admin: 0, agent: 0, viewer: 0 };
  const statuses: Record<Availability, number> = { online: 0, away: 0, offline: 0 };
  const byTeam: Record<string, number> = { [NO_TEAM]: 0 };
  const onTeams = teamsByMember(teams);
  for (const t of teams) byTeam[t.id] = 0;
  for (const m of members) {
    roles[m.role] += 1;
    statuses[m.presence] += 1;
    const mine = onTeams.get(m.user.id);
    if (!mine?.size) byTeam[NO_TEAM] += 1;
    else for (const id of mine) byTeam[id] += 1;
  }
  return { roles, statuses, teams: byTeam };
}
