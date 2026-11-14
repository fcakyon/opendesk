// Reports by team and brand (contracts/teams.md, contracts/api.md "reports"): the
// filters next to the date range and the breakdown tables. Team UI shows once the
// workspace has a team, brand UI once it has a second brand. Private teams the
// signed-in person is not on are left out: their tickets still count in the totals.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Layers, Users } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FilterButton } from "@/components/ui/button";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { BrandMark } from "@/components/settings2/teams";
import { TeamChip, TeamDot, sortTeams } from "@/components/tickets/teams";
import type { Brand, ReportsGroup, ReportsOverview, Team } from "@/lib/api/types";
import { minutes } from "@/lib/format";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { teamsOf } from "@/lib/ticketCache";
import { SERIES } from "@/lib/tones";
import { Bar } from "./Bars";

const none: never[] = [];
const ALL = "__all";
export const NO_TEAM = "none";

/** The workspace's teams and brands for reports, with the teams the caller may see. */
export function useReportScope() {
  const me = useSession((s) => s.user?.id ?? "");
  const teamsQ = useQuery(q.teams());
  const teams = teamsQ.data ?? none;
  const brands = useQuery({ ...q.brands(), retry: false }).data ?? none;
  const teamsLoaded = teamsQ.isSuccess;
  return useMemo(() => {
    const mine = new Set(teamsOf(teams, me));
    const visible = sortTeams(
      teams.filter((t) => !t.private || mine.has(t.id)),
      mine,
    );
    return {
      teams: visible,
      brands: [...brands].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
      hasTeams: teams.length > 0,
      multiBrand: brands.length > 1,
      /** The team list is in, so a team missing from it is one the caller may not see. */
      teamsLoaded,
      team: (id: string | null | undefined) => (id ? visible.find((t) => t.id === id) : undefined),
      brand: (id: string | null | undefined) => (id ? brands.find((b) => b.id === id) : undefined),
    };
  }, [teams, brands, me, teamsLoaded]);
}

export type ReportScope = ReturnType<typeof useReportScope>;

const noTeamMark = <span aria-hidden className="size-2 shrink-0 rounded-full border border-dashed border-line-strong" />;

/** "All teams", "No team" or one team the caller may see. */
export function TeamFilter({ scope, value, onChange }: { scope: ReportScope; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const { t } = useTranslation("reports");
  const items: PickerItem[] = [
    { value: ALL, label: t("filter.allTeams"), icon: <Users className="text-fg-3" /> },
    { value: NO_TEAM, label: t("filter.noTeam"), icon: noTeamMark },
    ...scope.teams.map((x) => ({ value: x.id, label: x.name, icon: <TeamDot team={x} />, hint: x.private ? t("filter.private") : undefined })),
  ];
  const cur = value === NO_TEAM ? undefined : scope.team(value);
  const label = cur?.name ?? (value === NO_TEAM ? t("filter.noTeam") : t("filter.allTeams"));
  return (
    <Picker
      items={items}
      value={value ?? ALL}
      onSelect={(v) => onChange(v === ALL ? undefined : v)}
      placeholder={t("filter.searchTeams")}
      trigger={
        <FilterButton
          aria-label={t("filter.teamLabel", { value: label })}
          active={!!value}
          icon={cur ? <TeamDot team={cur} /> : value === NO_TEAM ? noTeamMark : <Users className="size-3.5 text-fg-3" />}
          label={label}
        />
      }
    />
  );
}

/** "All brands" or one brand. */
export function BrandFilter({ scope, value, onChange }: { scope: ReportScope; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const { t } = useTranslation("reports");
  const items: PickerItem[] = [
    { value: ALL, label: t("filter.allBrands"), icon: <Layers className="text-fg-3" /> },
    ...scope.brands.map((b) => ({ value: b.id, label: b.name, icon: <BrandMark brand={b} size="xs" /> })),
  ];
  const cur = scope.brand(value);
  return (
    <Picker
      items={items}
      value={value ?? ALL}
      onSelect={(v) => onChange(v === ALL ? undefined : v)}
      placeholder={t("filter.searchBrands")}
      trigger={
        <FilterButton
          aria-label={t("filter.brandLabel", { value: cur?.name ?? t("filter.allBrands") })}
          active={!!value}
          icon={cur ? <BrandMark brand={cur} size="xs" /> : <Layers className="size-3.5 text-fg-3" />}
          label={cur?.name ?? t("filter.allBrands")}
        />
      }
    />
  );
}

export type GroupRow = ReportsGroup & { id: string; name: ReactNode; search: { team?: string; brand?: string } };

/** Created, solved, open now and first response per group, busiest first. Each name narrows the report to it. */
function GroupTable({ rows, caption, head }: { rows: GroupRow[]; caption: string; head: string }) {
  const { t } = useTranslation("reports");
  const max = Math.max(1, ...rows.map((r) => r.created));
  return (
    <table className="w-full text-[13px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="whitespace-nowrap border-b border-line text-left">
          <th className="label-caps w-[30%] py-2 pl-4 font-normal">{head}</th>
          <th className="label-caps w-[22%] py-2 font-normal">{t("kpi.created")}</th>
          <th className="label-caps py-2 pl-3 text-right font-normal">{t("kpi.solved")}</th>
          <th className="label-caps py-2 pl-3 text-right font-normal">{t("kpi.openNow")}</th>
          <th className="label-caps py-2 pl-3 pr-4 text-right font-normal">{t("kpi.firstResponse")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line-soft transition-colors last:border-0 hover:bg-sunken">
            <td className="max-w-0 py-2.5 pl-4 pr-3">
              <Link
                to="/reports"
                search={(s) => ({ ...s, ...r.search })}
                title={t("groups.narrow")}
                className="inline-flex min-w-0 max-w-full items-center rounded-sm outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
              >
                {r.name}
              </Link>
            </td>
            <td className="py-2.5 pr-6">
              <span className="flex items-center gap-3">
                <span className="mono w-8 shrink-0 text-right text-xs tabular-nums">{r.created.toLocaleString()}</span>
                <Bar pct={(r.created / max) * 100} tone={SERIES[0]} />
              </span>
            </td>
            <td className="mono py-2.5 text-right text-xs tabular-nums text-fg-2">{r.solved.toLocaleString()}</td>
            <td className="mono py-2.5 text-right text-xs tabular-nums text-fg-2">{r.open_now.toLocaleString()}</td>
            <td className="mono py-2.5 pr-4 text-right text-xs tabular-nums text-fg-2">{minutes(r.first_response_p50_minutes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const byWork = (a: ReportsGroup, b: ReportsGroup) => b.created - a.created || b.open_now - a.open_now || b.solved - a.solved;

/**
 * The by-team rows the caller may see: tickets without a team as "No team", and
 * private teams they are not on left out (`hidden` says whether any were).
 */
export function teamRows(d: ReportsOverview, scope: ReportScope, noTeam: string): { rows: GroupRow[]; hidden: boolean } {
  let hidden = false;
  const rows: GroupRow[] = [];
  for (const g of d.by_team ?? []) {
    if (!g.team_id) {
      rows.push({ ...g, id: NO_TEAM, search: { team: NO_TEAM }, name: <span className="inline-flex min-w-0 items-center gap-2 text-fg-2">{noTeamMark}<span className="truncate">{noTeam}</span></span> });
      continue;
    }
    const team: Team | undefined = scope.team(g.team_id);
    if (!team) {
      hidden = true;
      continue;
    }
    rows.push({ ...g, id: team.id, search: { team: team.id }, name: <TeamChip team={team} className="max-w-full" /> });
  }
  return { rows: rows.sort(byWork), hidden };
}

export function brandRows(d: ReportsOverview, scope: ReportScope): GroupRow[] {
  return (d.by_brand ?? [])
    .map((g) => {
      const b: Brand | undefined = scope.brand(g.brand_id);
      return {
        ...g,
        id: g.brand_id,
        search: { brand: g.brand_id },
        name: (
          <span className="inline-flex min-w-0 items-center gap-2">
            {b && <BrandMark brand={b} size="xs" />}
            <span className="truncate font-medium">{b?.name ?? "–"}</span>
          </span>
        ),
      };
    })
    .sort(byWork);
}

export { GroupTable };
