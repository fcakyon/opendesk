import { describe, expect, it } from "vitest";
import type { Member } from "@/lib/api/types";
import { reportsQuery } from "@/router";
import { reportPeople } from "./PersonFilter";

const member = (id: string, name: string, role: Member["role"]) =>
  ({ user: { id, name, email: `${id}@example.com`, avatar_url: null, avatar_source: null }, role }) as Member;

const members = [member("c", "Carl", "agent"), member("a", "Anna", "admin"), member("v", "Vic", "viewer"), member("b", "Bea", "owner")];

describe("reportPeople", () => {
  it("offers admins every member but viewers, by name", () => {
    expect(reportPeople(members, "a", true).map((m) => m.user.name)).toEqual(["Anna", "Bea", "Carl"]);
  });
  it("offers another member themselves alone", () => {
    expect(reportPeople(members, "c", false).map((m) => m.user.id)).toEqual(["c"]);
    expect(reportPeople(members, "v", false)).toEqual([]);
  });
});

describe("reportsQuery", () => {
  it("sends the person as assignee_id", () => {
    expect(reportsQuery({ from: "2026-11-01", to: "2026-11-05", person: "a" })).toMatchObject({ assignee_id: "a" });
    expect(reportsQuery({ from: "2026-11-01", to: "2026-11-05" }).assignee_id).toBeUndefined();
  });
});
