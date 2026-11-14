import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSidebarPrefs } from "@/lib/collab/hooks";
import { inboxKey, type InboxScope } from "@/lib/collab/inboxSections";
import { nameOf } from "@/lib/collab/sidebarPrefs";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { teamsOf } from "@/lib/ticketCache";

/** An inbox section's names: its own (the mailbox's or team's) and the one it shows. */
export type InboxNames = { own: string; title: string };

/**
 * The names of the ticket inboxes and teams shown as sections, for the lists that arrange the
 * sidebar (edit mode, Customize, layouts). Null for one that is gone or a private team the
 * member is not on: the sidebar skips it too.
 */
export function useInboxNames(): (scope: InboxScope) => InboxNames | null {
  const { t } = useTranslation("inbox");
  const prefs = useSidebarPrefs();
  const me = useSession((s) => s.user?.id ?? "");
  const { data: mailboxes } = useQuery(q.mailboxes());
  const { data: teams } = useQuery(q.teams());
  return (scope) => {
    let own: string | null = null;
    if (scope.kind === "mailbox") {
      const m = mailboxes?.find((x) => x.id === scope.id);
      if (m) own = m.name || m.email;
    } else if (scope.id === "mine") own = t("teams.myTeams");
    else {
      const team = teams?.find((x) => x.id === scope.id);
      if (team && (!team.private || teamsOf(teams ?? [], me).includes(team.id))) own = team.name;
    }
    return own === null ? null : { own, title: nameOf(prefs, `section:${inboxKey(scope)}`, own) };
  };
}
