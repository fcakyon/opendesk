// A ticket inbox or a team as a sidebar section of its own (contracts/collab.md "Inboxes as
// sections"): its folders (a mailbox: Unassigned to Spam of that reply address) or its inbox's
// tabs (a team), each a row as the rest of the sidebar draws them. Tickets and Teams keep
// everything; this is where the member chose to see one inbox apart.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, CornerUpLeft, Ellipsis, Inbox, Layers, Plus, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/app/sidebarParts";
import { RowMenu } from "@/components/collab/RowMenu";
import { NavItemRow, ticketFolderIcons, type RowModel } from "@/components/spaces/rows";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { ticketRowNumbers } from "@/lib/collab/badges";
import { inboxKey, moveInboxSection, setInboxSection, type InboxScope } from "@/lib/collab/inboxSections";
import { folders, type TeamTab } from "@/lib/folders";
import { q } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";
import { teamsOf } from "@/lib/ticketCache";
import { quickAdd } from "@/app/quickAdd";

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

export function InboxSection({ scope, first, rail, shown }: { scope: InboxScope; first: boolean; rail: boolean; shown: string[] }) {
  const { t } = useTranslation("inbox");
  const { t: tNav } = useTranslation("navigation");
  const navigate = useNavigate();
  const role = useRole();
  const me = useSession((s) => s.user?.id ?? "");
  const prefs = useSidebarPrefs();
  const save = useSaveSidebarPrefs();
  const { data: counts } = useQuery(q.counts());
  const { data: mailboxes } = useQuery(q.mailboxes());
  const { data: teams } = useQuery(q.teams());
  const key = inboxKey(scope);
  const at = shown.indexOf(key);
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

  const action = (
    <div className="flex items-center gap-0.5">
      {scope.kind === "mailbox" && (
        <Tooltip content={t("inboxes.add")}>
          <button type="button" aria-label={t("inboxes.add")} onClick={() => quickAdd.inbox({})} className={headerBtn}>
            <Plus className="size-3.5" />
          </button>
        </Tooltip>
      )}
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label={t("inboxes.menu", { name: title })} className={headerBtn}>
            <Ellipsis className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-[220px]">
          <MenuItem icon={<CornerUpLeft />} onSelect={back}>
            {scope.kind === "mailbox" ? t("inboxes.backIntoTickets") : t("inboxes.backIntoTeams")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ArrowUp />} disabled={at <= 0} onSelect={() => change(moveInboxSection(prefs, key, -1, shown))}>
            {t("inboxes.moveUp")}
          </MenuItem>
          <MenuItem icon={<ArrowDown />} disabled={at < 0 || at >= shown.length - 1} onSelect={() => change(moveInboxSection(prefs, key, 1, shown))}>
            {t("inboxes.moveDown")}
          </MenuItem>
          {atLeast(role, "admin") && (mailbox || team) && (
            <>
              <MenuSeparator />
              {mailbox ? (
                <>
                  <MenuItem icon={<Inbox />} onSelect={() => quickAdd.inbox({})}>
                    {t("inboxes.add")}
                  </MenuItem>
                  <MenuItem icon={<Settings />} onSelect={() => void navigate({ to: "/settings/mailboxes/$mailboxId", params: { mailboxId: mailbox.id } })}>
                    {t("inboxes.settings")}
                  </MenuItem>
                </>
              ) : (
                <MenuItem icon={<Settings />} onSelect={() => void navigate({ to: "/settings/teams" })}>
                  {t("inboxes.teamSettings")}
                </MenuItem>
              )}
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  );

  return (
    <Section id={`inbox-${key}`} label={title} icon={prefs.icons[`section:${key}`]} rail={rail} first={first} action={rail ? undefined : action}>
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
                items={[{ label: scope.kind === "mailbox" ? t("inboxes.backIntoTickets") : t("inboxes.backIntoTeams"), icon: <CornerUpLeft />, onSelect: back }]}
              >
                {row}
              </RowMenu>
            )}
          />
        ))}
    </Section>
  );
}
