// The filter bar on Settings → Members: a name or email search, then role, team and
// status pickers with how many members each option holds. What is set lives in the
// URL (lib/memberFilters.ts); the search reaches it a moment after typing stops.

import { useNavigate, useSearch } from "@tanstack/react-router";
import { Activity, ShieldCheck, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AvailabilityDot } from "@/components/presence/availability";
import { useDebounced } from "@/components/contacts/hooks";
import { Button, FilterButton } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { roleText, roleTone } from "@/components/settings2/bits";
import { TeamDot } from "@/components/settings2/teams";
import type { Availability, Role, Team } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import {
  filtersFromSearch,
  hasMemberFilters,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  NO_TEAM,
  noMemberFilters,
  searchFromFilters,
  type MemberCounts,
  type MemberFilters,
  type MemberSearch,
} from "@/lib/memberFilters";
import { tone as tones } from "@/lib/tones";

/**
 * The filters from the URL, with the search as typed (it reaches the URL after a
 * short pause). `set` adds a history entry, so Back undoes a filter.
 */
export function useMemberFilters() {
  const search = useSearch({ strict: false }) as MemberSearch;
  const navigate = useNavigate();
  const fromUrl = useMemo(() => filtersFromSearch(search), [search]);
  const [term, setTerm] = useState(fromUrl.q);
  const debounced = useDebounced(term, 250);

  const go = useCallback(
    (patch: Partial<MemberFilters>, replace?: boolean) =>
      void navigate({
        to: ".",
        search: (s: Record<string, unknown>) => ({ ...s, ...searchFromFilters({ ...filtersFromSearch(s as MemberSearch), ...patch }) }),
        replace,
      }),
    [navigate],
  );

  // The URL's search as last seen: it follows typing once it settles, and a change made
  // elsewhere (Back, a link, Clear filters) replaces what was typed.
  const urlQ = useRef(search.q);
  useEffect(() => {
    if (search.q === urlQ.current) return;
    urlQ.current = search.q;
    setTerm(search.q ?? "");
  }, [search.q]);
  useEffect(() => {
    const q = debounced.trim() || undefined;
    if (q === urlQ.current) return;
    urlQ.current = q;
    go({ q }, true);
  }, [debounced, go]);

  const filters = useMemo(() => ({ ...fromUrl, q: term }), [fromUrl, term]);
  return {
    filters,
    active: hasMemberFilters(filters),
    setTerm,
    set: (patch: Omit<Partial<MemberFilters>, "q">) => go(patch),
    clear: () => {
      setTerm("");
      go(noMemberFilters);
    },
  };
}

const noTeamMark = <span aria-hidden className="size-2 shrink-0 rounded-full border border-dashed border-line-strong" />;

function RoleDot({ role }: { role: Role }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tones[roleTone[role]].solid)} />;
}

const count = (n: number) => <span className="mono tabular-nums">{n}</span>;

export function MemberFilterBar({
  state,
  counts,
  teams,
  shown,
  total,
}: {
  state: ReturnType<typeof useMemberFilters>;
  counts: MemberCounts;
  teams: readonly Team[];
  shown: number;
  total: number;
}) {
  const { t } = useTranslation("settings");
  const { t: ui } = useTranslation("ui");
  const { t: setup } = useTranslation("setup");
  const { filters, active, setTerm, set, clear } = state;
  const roleName = (r: Role) => ui(roleText[r]);
  const statusName = (s: Availability) => setup(`availability.${s}`);

  const roleItems: PickerItem[] = MEMBER_ROLES.map((r) => ({ value: r, label: roleName(r), icon: <RoleDot role={r} />, hint: count(counts.roles[r]) }));
  const statusItems: PickerItem[] = MEMBER_STATUSES.map((s) => ({ value: s, label: statusName(s), icon: <AvailabilityDot value={s} />, hint: count(counts.statuses[s]) }));
  const teamItems: PickerItem[] = [
    { value: NO_TEAM, label: t("members.filter.noTeam"), icon: noTeamMark, hint: count(counts.teams[NO_TEAM] ?? 0) },
    ...teams.map((x) => ({ value: x.id, label: x.name, icon: <TeamDot team={x} />, hint: count(counts.teams[x.id] ?? 0) })),
  ];

  const roleLabel = filters.roles.length ? filters.roles.map(roleName).join(", ") : t("members.filter.allRoles");
  const statusLabel = filters.statuses.length ? filters.statuses.map(statusName).join(", ") : t("members.filter.anyStatus");
  const team = filters.team && filters.team !== NO_TEAM ? teams.find((x) => x.id === filters.team) : undefined;
  // A team id the list does not have (deleted, or a stale link) still reads as a filter.
  const teamLabel = filters.team === NO_TEAM ? t("members.filter.noTeam") : filters.team ? (team?.name ?? t("members.filter.unknownTeam")) : t("members.filter.allTeams");

  return (
    <div role="group" aria-label={t("members.filter.label")} className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2">
      <SearchInput value={filters.q} onChange={setTerm} placeholder={t("members.search")} className="w-full sm:w-[220px]" />
      <Picker
        multi
        items={roleItems}
        values={filters.roles}
        onChange={(v) => set({ roles: v as Role[] })}
        placeholder={t("members.filter.searchRoles")}
        width={220}
        trigger={
          <FilterButton
            aria-label={t("members.filter.roleLabel", { value: roleLabel })}
            active={filters.roles.length > 0}
            icon={filters.roles.length === 1 ? <RoleDot role={filters.roles[0]} /> : <ShieldCheck className="size-3.5 text-fg-3" />}
            label={roleLabel}
          />
        }
      />
      {(teams.length > 0 || filters.team) && (
        <Picker
          items={[{ value: "", label: t("members.filter.allTeams"), icon: <Users className="text-fg-3" /> }, ...teamItems]}
          value={filters.team ?? ""}
          onSelect={(v) => set({ team: v || null })}
          placeholder={t("members.filter.searchTeams")}
          trigger={
            <FilterButton
              aria-label={t("members.filter.teamLabel", { value: teamLabel })}
              active={!!filters.team}
              icon={team ? <TeamDot team={team} /> : filters.team === NO_TEAM ? noTeamMark : <Users className="size-3.5 text-fg-3" />}
              label={teamLabel}
            />
          }
        />
      )}
      <Picker
        multi
        items={statusItems}
        values={filters.statuses}
        onChange={(v) => set({ statuses: v as Availability[] })}
        placeholder={t("members.filter.searchStatuses")}
        width={220}
        trigger={
          <FilterButton
            aria-label={t("members.filter.statusLabel", { value: statusLabel })}
            active={filters.statuses.length > 0}
            icon={filters.statuses.length === 1 ? <AvailabilityDot value={filters.statuses[0]} /> : <Activity className="size-3.5 text-fg-3" />}
            label={statusLabel}
          />
        }
      />
      {active && (
        <div className="ml-auto flex items-center gap-2">
          <span className="mono text-[11px] tabular-nums text-fg-4" aria-live="polite">
            {t("members.filter.shown", { shown, total })}
          </span>
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={clear}>
            {t("members.filter.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}
