// Settings > Teams: who owns which work (contracts/teams.md). The list shows
// each team's colour, privacy, people, open work and addresses; a team opens
// on its own page.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Inbox, Lock, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Section, SettingsPage } from "@/components/layout";
import { ListSkeleton } from "@/components/settings2/bits";
import { MotionList, MotionRow } from "@/components/settings2/motion";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { NewTeamDialog } from "@/components/settings2/NewTeamDialog";
import { PrivatePill, TeamDot } from "@/components/settings2/teams";
import { AvatarStack } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { Member, Team } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { atLeast, useRole, useUser } from "@/lib/session";
import { tone } from "@/lib/tones";

export default function Teams() {
  const { t } = useTranslation("settingsTeams");
  const admin = atLeast(useRole(), "admin");
  const { data: teams, isLoading } = useQuery(q.teams());
  const { data: members } = useQuery(q.members());
  const { data: mailboxes } = useQuery({ ...q.mailboxes(), enabled: admin });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const byId = new Map((members ?? []).map((m) => [m.user.id, m]));

  const newButton = (variant: "primary" | "secondary" = "primary") =>
    admin && (
      <Button variant={variant} icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
        {t("list.new")}
      </Button>
    );

  return (
    <SettingsPage title={t("list.title")} description={t("list.description")} actions={teams?.length ? newButton() : undefined}>
      {isLoading ? (
        <Section flush>
          <ListSkeleton rows={4} />
        </Section>
      ) : !teams?.length ? (
        <Section flush>
          <SettingsEmpty
            art="contacts"
            ghost="people"
            title={t("list.emptyTitle")}
            description={t("list.emptyHint")}
            action={newButton()}
            tips={[
              { label: t("list.tips.address"), icon: <Inbox /> },
              { label: t("list.tips.private"), icon: <Lock /> },
            ]}
          />
        </Section>
      ) : (
        <Section flush title={t("list.count", { count: teams.length })}>
          <div className="hidden h-8 items-center gap-3 border-b border-line-soft bg-sunken/50 px-4 text-[11px] font-medium text-fg-4 md:flex">
            <span className="flex-1">{t("list.colTeam")}</span>
            <span className="w-[120px]">{t("list.colPeople")}</span>
            <span className="w-[64px] text-right">{t("list.colOpen")}</span>
            <span className="w-[84px] text-right">{t("list.colUnassigned")}</span>
            <span className="w-4" />
          </div>
          <MotionList>
            {teams.map((team) => (
              <MotionRow key={team.id}>
                <TeamRow team={team} byId={byId} addresses={(mailboxes ?? []).filter((m) => m.team_id === team.id).map((m) => m.email)} />
              </MotionRow>
            ))}
          </MotionList>
        </Section>
      )}
      {creating && <NewTeamDialog onClose={() => setCreating(false)} onCreated={(team) => void navigate({ to: "/settings/teams/$teamId", params: { teamId: team.id } })} />}
    </SettingsPage>
  );
}

function TeamRow({ team, byId, addresses }: { team: Team; byId: Map<string, Member>; addresses: string[] }) {
  const { t } = useTranslation("settingsTeams");
  const me = useUser();
  const people = team.members.map((m) => byId.get(m.user_id)).filter((m): m is Member => !!m);
  const mine = team.members.some((m) => m.user_id === me.id);
  const hidden = team.private && !team.members.length && !mine;
  const shown = addresses.slice(0, 2);
  return (
    <Link
      to="/settings/teams/$teamId"
      params={{ teamId: team.id }}
      className="group flex min-h-14 items-center gap-3 border-b border-line-soft px-4 py-2.5 outline-none transition-colors last:border-0 hover:bg-sunken focus-visible:bg-sunken"
    >
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", tone[team.color]?.soft ?? tone.gray.soft)}>
        <TeamDot team={team} className="size-2.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{team.name}</span>
          {team.private && <PrivatePill />}
          {mine && <span className="text-[11px] text-fg-4">{t("list.youreOn")}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">
          {shown.length ? (
            <>
              <Inbox className="size-3 shrink-0 text-fg-4" aria-hidden />
              <span className="mono truncate text-[11.5px]">
                {shown.join(", ")}
                {addresses.length > shown.length && <span className="text-fg-4"> {t("list.more", { count: addresses.length - shown.length })}</span>}
              </span>
            </>
          ) : (
            <span className="truncate">{team.description || t("list.noAddress")}</span>
          )}
        </div>
      </div>
      <div className="hidden w-[120px] items-center md:flex">
        {hidden ? (
          <Tooltip content={t("list.hiddenMembers")}>
            <span className="inline-flex items-center gap-1 text-[12px] text-fg-4">
              <Lock className="size-3" aria-hidden />
              {t("list.membersCount", { count: team.member_ids.length })}
            </span>
          </Tooltip>
        ) : people.length ? (
          <AvatarStack people={people.map((m) => ({ id: m.user.id, name: m.user.name, avatar: m.user.avatar_url }))} max={4} size="md" />
        ) : (
          <span className="text-[12px] text-fg-4">{t("list.noMembers")}</span>
        )}
      </div>
      <span className={cn("hidden w-[64px] text-right text-[13px] tabular-nums md:block", team.open_count ? "text-fg" : "text-fg-4")}>{team.open_count}</span>
      <span className={cn("hidden w-[84px] text-right text-[13px] tabular-nums md:block", team.unassigned_count ? tone.amber.text : "text-fg-4")}>{team.unassigned_count}</span>
      <ChevronRight className="size-4 shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
    </Link>
  );
}
