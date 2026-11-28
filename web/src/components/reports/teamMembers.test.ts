import { describe, expect, it } from "vitest";
import { openWorkTeam } from "./teamMembers";
import { NO_TEAM } from "./TeamBrand";

describe("openWorkTeam", () => {
  it("lists a team's tickets, and its people's when the workspace counts a team by its people", () => {
    expect(openWorkTeam(undefined, true)).toEqual({});
    expect(openWorkTeam("t1", false)).toEqual({ team_id: "t1" });
    expect(openWorkTeam("t1", true)).toEqual({ team_id: "t1", team_members: true });
  });
  it("keeps No team as the tickets without one", () => {
    expect(openWorkTeam(NO_TEAM, true)).toEqual({ team_id: NO_TEAM });
  });
});
