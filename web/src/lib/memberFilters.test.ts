import { describe, expect, it } from "vitest";
import type { Availability, Member, Role, Team } from "@/lib/api/types";
import { filterMembers, filtersFromSearch, hasMemberFilters, memberCounts, NO_TEAM, noMemberFilters, parseMemberSearch, searchFromFilters, type MemberFilters } from "./memberFilters";

function member(id: string, name: string, role: Role, presence: Availability = "offline"): Member {
  return {
    user: { id, name, email: `${name.toLowerCase()}@example.test`, avatar_url: null, avatar_source: null },
    role,
    availability: presence,
    presence,
    max_open_tickets: null,
    open_tickets: 0,
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function team(id: string, members: { user_id: string; role: "member" | "observer" }[]): Team {
  return {
    id,
    name: id,
    description: "",
    color: "blue",
    private: false,
    members,
    member_ids: members.map((m) => m.user_id),
    signature_html: "",
    business_hours: null,
    assign_mode: null,
    mailbox_ids: [],
    open_count: 0,
    unassigned_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const maya = member("u1", "Maya", "owner", "online");
const jonas = member("u2", "Jonas", "admin", "away");
const priya = member("u3", "Priya", "agent", "online");
const omar = member("u4", "Omar", "agent", "offline");
const lea = member("u5", "Lea", "viewer", "offline");
const members = [maya, jonas, priya, omar, lea];
const teams = [team("support", [{ user_id: "u3", role: "member" }, { user_id: "u5", role: "observer" }]), team("billing", [{ user_id: "u2", role: "member" }, { user_id: "u3", role: "member" }])];

const ids = (list: Member[]) => list.map((m) => m.user.id);
const f = (over: Partial<MemberFilters>): MemberFilters => ({ ...noMemberFilters, ...over });

describe("filterMembers", () => {
  it("keeps everyone without filters", () => {
    expect(ids(filterMembers(members, noMemberFilters, teams))).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("matches the search on name or email, ignoring case and spaces around it", () => {
    expect(ids(filterMembers(members, f({ q: "  PRI " }), teams))).toEqual(["u3"]);
    expect(ids(filterMembers(members, f({ q: "omar@example" }), teams))).toEqual(["u4"]);
  });

  it("keeps any of the roles picked", () => {
    expect(ids(filterMembers(members, f({ roles: ["owner", "admin"] }), teams))).toEqual(["u1", "u2"]);
    expect(ids(filterMembers(members, f({ roles: ["agent"] }), teams))).toEqual(["u3", "u4"]);
  });

  it("keeps a team's members and observers, or the members on no team", () => {
    expect(ids(filterMembers(members, f({ team: "support" }), teams))).toEqual(["u3", "u5"]);
    expect(ids(filterMembers(members, f({ team: NO_TEAM }), teams))).toEqual(["u1", "u4"]);
  });

  it("matches nobody for a team that does not exist", () => {
    expect(filterMembers(members, f({ team: "gone" }), teams)).toEqual([]);
  });

  it("filters on presence, so auto-away counts as away", () => {
    const autoAway = { ...omar, availability: "online" as const, presence: "away" as const };
    expect(ids(filterMembers([...members.filter((m) => m !== omar), autoAway], f({ statuses: ["away"] }), teams))).toEqual(["u2", "u4"]);
  });

  it("combines every filter", () => {
    expect(ids(filterMembers(members, f({ roles: ["agent", "admin"], team: "billing", statuses: ["online"] }), teams))).toEqual(["u3"]);
    expect(ids(filterMembers(members, f({ roles: ["agent"], team: "billing", q: "omar" }), teams))).toEqual([]);
  });
});

describe("memberCounts", () => {
  it("counts each option over the whole list", () => {
    const c = memberCounts(members, teams);
    expect(c.roles).toEqual({ owner: 1, admin: 1, agent: 2, viewer: 1 });
    expect(c.statuses).toEqual({ online: 2, away: 1, offline: 2 });
    expect(c.teams).toEqual({ support: 2, billing: 2, [NO_TEAM]: 2 });
  });

  it("gives a team with nobody on it zero", () => {
    expect(memberCounts(members, [...teams, team("empty", [])]).teams.empty).toBe(0);
  });
});

describe("the filters in the URL", () => {
  it("reads lists, drops unknown values and keeps the usual order", () => {
    expect(parseMemberSearch({ role: "viewer,boss,admin,admin", status: "away,online,asleep", team: "support", q: "maya" })).toEqual({
      role: "admin,viewer",
      status: "online,away",
      team: "support",
      q: "maya",
    });
  });

  it("leaves out what is empty or not a string", () => {
    expect(parseMemberSearch({ role: "boss", status: "", team: "  ", q: 3 })).toEqual({ role: undefined, status: undefined, team: undefined, q: undefined });
    expect(parseMemberSearch({})).toEqual({ role: undefined, status: undefined, team: undefined, q: undefined });
  });

  it("round-trips filters through the URL", () => {
    const filters = f({ q: "pri", roles: ["agent", "owner"], team: NO_TEAM, statuses: ["offline", "online"] });
    const search = searchFromFilters(filters);
    expect(search).toEqual({ q: "pri", role: "owner,agent", team: NO_TEAM, status: "online,offline" });
    expect(filtersFromSearch(parseMemberSearch(search))).toEqual({ q: "pri", roles: ["owner", "agent"], team: NO_TEAM, statuses: ["online", "offline"] });
  });

  it("writes no parameter for cleared filters", () => {
    expect(searchFromFilters(noMemberFilters)).toEqual({ q: undefined, role: undefined, team: undefined, status: undefined });
    expect(searchFromFilters(f({ q: "   " })).q).toBeUndefined();
  });

  it("tells whether anything filters", () => {
    expect(hasMemberFilters(noMemberFilters)).toBe(false);
    expect(hasMemberFilters(f({ q: " " }))).toBe(false);
    expect(hasMemberFilters(f({ q: "a" }))).toBe(true);
    expect(hasMemberFilters(f({ roles: ["viewer"] }))).toBe(true);
    expect(hasMemberFilters(f({ team: NO_TEAM }))).toBe(true);
    expect(hasMemberFilters(f({ statuses: ["away"] }))).toBe(true);
  });
});
