import { useQuery } from "@tanstack/react-query";
import { q } from "@/lib/queries";
import { NO_TEAM } from "./TeamBrand";

/** settings.reports_team_members: on the reports, a team is its people. */
export function useTeamByPeople(): boolean {
  return useQuery(q.workspace()).data?.settings.reports_team_members ?? false;
}

/**
 * The open-work cards' team filter: the tickets of the team picked, and with byPeople also those
 * assigned to its leads and members, as the report counts them. "No team" stays the tickets
 * without one.
 */
export function openWorkTeam(team: string | undefined, byPeople: boolean): { team_id?: string; team_members?: true } {
  if (!team) return {};
  return byPeople && team !== NO_TEAM ? { team_id: team, team_members: true } : { team_id: team };
}
