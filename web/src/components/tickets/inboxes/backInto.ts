import { useTranslation } from "react-i18next";
import { useCollab, useSidebarPrefs } from "@/lib/collab/hooks";
import type { InboxScope } from "@/lib/collab/inboxSections";
import { nameOf, sectionKey } from "@/lib/collab/sidebarPrefs";

/** "Back into Tickets" or "Back into Teams", naming the section as the member named it. */
export function useBackIntoLabel(kind: InboxScope["kind"]): string {
  const { t } = useTranslation("inbox");
  const { t: tShell } = useTranslation("shell");
  const prefs = useSidebarPrefs();
  const collab = useCollab();
  const home = kind === "mailbox" ? "inbox" : "teams";
  const fallback = kind === "mailbox" ? tShell(collab.enabled ? "nav.tickets" : "nav.inbox") : tShell("nav.teams");
  return t("inboxes.backInto", { name: nameOf(prefs, sectionKey(home), fallback) });
}
