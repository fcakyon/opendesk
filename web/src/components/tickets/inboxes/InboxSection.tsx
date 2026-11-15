// A ticket inbox or a team as a sidebar section of its own (contracts/collab.md "Inboxes as
// sections"): its folders (a mailbox: Unassigned to Spam of that reply address) or its inbox's
// tabs (a team), each a row as the rest of the sidebar draws them. Tickets and Teams keep
// everything; this is where the member chose to see one inbox apart.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CornerUpLeft, Inbox, Layers, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Section, type SectionEdit } from "@/app/sidebarParts";
import { SectionMenu } from "@/components/collab/SectionMenu";
import { RowMenu } from "@/components/collab/RowMenu";
import { NavItemRow, ticketFolderIcons, type RowModel } from "@/components/spaces/rows";
import { MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { ticketRowNumbers } from "@/lib/collab/badges";
import { inboxKey, setInboxSection, type InboxScope } from "@/lib/collab/inboxSections";
import { setHidden, setIcon, setName } from "@/lib/collab/sidebarPrefs";
import { folders, type TeamTab } from "@/lib/folders";
import { q } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";
import { teamsOf } from "@/lib/ticketCache";
import { quickAdd } from "@/app/quickAdd";
import { useBackIntoLabel } from "./backInto";

const headerBtn =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 transition-opacity hover:bg-chrome-hover hover:text-fg group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

const TEAM_TABS: { tab: TeamTab; folder: "unassigned" | "open" | "pending" | null }[] = [
  { tab: "unassigned", folder: "unassigned" },
  { tab: "open", folder: "open" },
  { tab: "pending", folder: "pending" },
  { tab: "all", folder: null },
];

/** The rows' hidden ids: mailbox:<id>:<folder>, team:<id>:<tab>. */
export const inboxRowKey = (s: InboxScope, part: string) => `${inboxKey(s)}:${part}`;

/** A section's rows as the lists that arrange the sidebar show them: a mailbox's folders, a team's tabs. */
export function useInboxParts(): (scope: InboxScope) => { key: string; label: string; icon: ReactNode }[] {
  const { t } = useTranslation("inbox");
  const { t: tNav } = useTranslation("navigation");
  return (scope) =>
    scope.kind === "mailbox"
      ? folders.map((f) => ({ key: inboxRowKey(scope, f.id), label: tNav(f.labelKey), icon: ticketFolderIcons[f.id] }))
      : TEAM_TABS.map(({ tab, folder }) => ({ key: inboxRowKey(scope, tab), label: t(`teams.tab.${tab}`), icon: folder ? ticketFolderIcons[folder] : <Layers /> }));
}

export function InboxSection({ scope, first, rail }: { scope: InboxScope; first: boolean; rail: boolean }) {
  const { t } = useTranslation("inbox");
  const { t: tc } = useTranslation("collab");
  const { t: tNav } = useTranslation("navigation");
  const navigate = useNavigate();
  const role = useRole();
  const me = useSession((s) => s.user?.id ?? "");
  const prefs = useSidebarPrefs();
  const save = useSaveSidebarPrefs();
  const backInto = useBackIntoLabel(scope.kind);
  const { data: counts } = useQuery(q.counts());
  const { data: mailboxes } = useQuery(q.mailboxes());
  const { data: teams } = useQuery(q.teams());
  const key = inboxKey(scope);
  const change = (next: typeof prefs) => save.mutate(next, { onError: (e) => toast.error(e, t("inboxes.saveFailed")) });

  const mailbox = scope.kind === "mailbox" ? mailboxes?.find((m) => m.id === scope.id) : undefined;
  const team = scope.kind === "team" && scope.id !== "mine" ? teams?.find((x) => x.id === scope.id) : undefined;
  const mine = scope.kind === "team" && scope.id === "mine";
  // Gone, or a private team the member is not on: kept in the order and skipped.
  if (scope.kind === "mailbox" && !mailbox) return null;
  if (scope.kind === "team" && !mine && (!team || (team.private && !teamsOf(teams ?? [], me).includes(team.id)))) return null;

  const ownName = mailbox ? mailbox.name || mailbox.email : mine ? t("teams.myTeams") : (team?.name ?? "");
  const title = prefs.names[`section:${key}`] || ownName;
  const back = () => {
    const before = prefs;
    change(setInboxSection(prefs, scope, false));
    toast.undo(scope.kind === "mailbox" ? t("inboxes.backDone", { name: title }) : t("inboxes.backTeamDone", { name: title }), () => change(before), t("inboxes.undo"));
  };

  const rows: { model: RowModel; hideId: string }[] =
    scope.kind === "mailbox"
      ? folders.map((f) => {
          const rowKey = inboxRowKey(scope, f.id);
          const counted = f.id !== "solved" && f.id !== "spam";
          return {
            hideId: rowKey,
            model: {
              key: rowKey,
              label: tNav(f.labelKey),
              icon: ticketFolderIcons[f.id],
              badge: counted ? { kind: "ticket", sections: ["inbox"], nums: ticketRowNumbers(counts, rowKey) } : undefined,
              link: { kind: "inbox", folder: f.id, mailbox: scope.id },
              railDot: f.id === "unassigned" ? "count" : undefined,
            } satisfies RowModel,
          };
        })
      : TEAM_TABS.map(({ tab, folder }) => {
          const rowKey = inboxRowKey(scope, tab);
          const c = mine ? counts?.my_teams : counts?.teams?.[scope.id];
          return {
            hideId: rowKey,
            model: {
              key: rowKey,
              label: t(`teams.tab.${tab}`),
              icon: folder ? ticketFolderIcons[folder] : <Layers />,
              // A team counts its unassigned tickets; its other tabs show none.
              badge: tab === "unassigned" ? { kind: "ticket", sections: ["teams"], nums: { count: c?.unassigned } } : undefined,
              link: { kind: "team", teamId: scope.id, tab: tab === "unassigned" ? undefined : tab },
              railDot: tab === "unassigned" ? "count" : undefined,
            } satisfies RowModel,
          };
        });

  const action =
    scope.kind === "mailbox" ? (
      <Tooltip content={t("inboxes.add")}>
        <button type="button" aria-label={t("inboxes.add")} onClick={() => quickAdd.inbox({})} className={headerBtn}>
          <Plus className="size-3.5" />
        </button>
      </Tooltip>
    ) : undefined;

  // Its name and emoji of the member's own, its moves among the sections and hiding, as every
  // section has them (components/collab/SectionMenu.tsx), with its own Back into and settings first.
  const sk = `section:${key}`;
  const edit: SectionEdit = {
    key: sk,
    placeholder: ownName,
    renameLabel: tc("edit.rename", { name: title }),
    onName: (v) => change(setName(prefs, sk, v === ownName ? "" : v)),
    menu: (
      <SectionMenu
        id={sk}
        name={title}
        dragKey={key}
        emoji={prefs.icons[sk]}
        onIcon={(v) => change(setIcon(prefs, sk, v))}
        onReset={prefs.names[sk] || prefs.icons[sk] ? () => change(setIcon(setName(prefs, sk, ""), sk, "")) : undefined}
        onHide={() => {
          const before = prefs;
          change(setHidden(prefs, sk, true));
          toast.undo(tc("edit.hidden", { name: title }), () => change(before), tc("edit.undo"));
        }}
        top={
          <>
            <MenuItem icon={<CornerUpLeft />} onSelect={back}>
              {backInto}
            </MenuItem>
            {atLeast(role, "admin") && mailbox && (
              <MenuItem icon={<Inbox />} onSelect={() => quickAdd.inbox({})}>
                {t("inboxes.add")}
              </MenuItem>
            )}
            {atLeast(role, "admin") && mailbox && (
              <MenuItem icon={<Settings />} onSelect={() => void navigate({ to: "/settings/mailboxes/$mailboxId", params: { mailboxId: mailbox.id } })}>
                {t("inboxes.settings")}
              </MenuItem>
            )}
            {atLeast(role, "admin") && team && (
              <MenuItem icon={<Settings />} onSelect={() => void navigate({ to: "/settings/teams" })}>
                {t("inboxes.teamSettings")}
              </MenuItem>
            )}
          </>
        }
      />
    ),
  };

  return (
    <Section id={`inbox-${key}`} label={title} icon={prefs.icons[sk]} rail={rail} first={first} action={rail ? undefined : action} edit={rail ? undefined : edit} dragKey={key}>
      {rows
        .filter((r) => !prefs.hidden.includes(r.hideId))
        .map(({ model, hideId }) => (
          <NavItemRow
            key={model.key}
            model={model}
            rail={rail}
            prefs={prefs}
            place={`section:${key}`}
            menu={(row) => (
              <RowMenu
                enabled
                prefs={prefs}
                badge={model.badge ? { key: model.key, kind: "ticket", sections: model.badge.sections, numbers: model.badge.nums } : undefined}
                hideId={hideId}
                rail={rail}
                label={prefs.names[model.key] || model.label}
                ownName={model.label}
                items={[{ label: backInto, icon: <CornerUpLeft />, onSelect: back }]}
              >
                {row}
              </RowMenu>
            )}
          />
        ))}
    </Section>
  );
}
