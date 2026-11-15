// The sidebar's part of ticket inboxes: where the inbox sections go among the others, Tickets'
// "+" to add one, and a quiet offer, once, to give each inbox its own section.

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditHintShown } from "@/components/collab/SidebarMenu";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { inboxSections, parseInboxKey, setInboxSection } from "@/lib/collab/inboxSections";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { quickAdd } from "@/app/quickAdd";
import { InboxSection } from "./InboxSection";

const headerBtn =
  "flex size-5 items-center justify-center rounded text-fg-4 opacity-0 transition-opacity hover:bg-chrome-hover hover:text-fg group-hover/section:opacity-100 focus-visible:opacity-100";

/** The inbox section an order key names. */
export function InboxSectionAt({ id, first, rail }: { id: string; first: boolean; rail: boolean }) {
  const scope = parseInboxKey(id);
  if (!scope) return null;
  return <InboxSection scope={scope} first={first} rail={rail} />;
}

/** Tickets' "+": a new ticket inbox, in place. */
export function AddInboxButton() {
  const { t } = useTranslation("inbox");
  return (
    <Tooltip content={t("inboxes.add")}>
      <button type="button" aria-label={t("inboxes.add")} onClick={() => quickAdd.inbox({})} className={headerBtn}>
        <Plus className="size-3.5" />
      </button>
    </Tooltip>
  );
}

const offerKey = (uid: string, wid: string) => `od-inbox-offer:${uid}:${wid}`;

/**
 * Once a workspace takes tickets at two addresses or more, the member is asked once whether each
 * should have a section of its own. Either answer, or giving one inbox its own section, ends it.
 */
export function InboxOffer({ rail }: { rail: boolean }) {
  const { t } = useTranslation("inbox");
  const uid = useSession((s) => s.user?.id ?? "");
  const wid = useSession((s) => s.workspaceId) ?? "";
  const prefs = useSidebarPrefs();
  const save = useSaveSidebarPrefs();
  const { data: mailboxes } = useQuery(q.mailboxes());
  const [gone, setGone] = useState(() => {
    try {
      return localStorage.getItem(offerKey(uid, wid)) === "1";
    } catch {
      return true;
    }
  });
  // One prompt at a time: the sidebar's own hint goes first.
  const hint = useEditHintShown();
  const list = mailboxes ?? [];
  if (rail || gone || hint || list.length < 2 || inboxSections(prefs).some((s) => s.kind === "mailbox")) return null;
  const end = () => {
    try {
      localStorage.setItem(offerKey(uid, wid), "1");
    } catch {
      // Private mode: it shows again next time.
    }
    setGone(true);
  };
  const yes = () => {
    let next = prefs;
    for (const m of list) next = setInboxSection(next, { kind: "mailbox", id: m.id }, true);
    const before = prefs;
    save.mutate(next, { onError: (e) => toast.error(e, t("inboxes.saveFailed")) });
    toast.undo(t("inboxes.offer.done"), () => save.mutate(before), t("inboxes.undo"));
    end();
  };
  return (
    <div className="mx-2 mb-1.5 mt-0.5 animate-rise-in rounded-md border border-chrome-line bg-surface px-3 py-2.5 shadow-xs motion-reduce:animate-none">
      <p className="text-[12.5px] font-medium text-fg">{t("inboxes.offer.title")}</p>
      <p className="mt-0.5 text-xs leading-[1.45] text-fg-3">{t("inboxes.offer.body", { count: list.length })}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" variant="primary" onClick={yes}>
          {t("inboxes.offer.yes")}
        </Button>
        <Button size="sm" variant="ghost" onClick={end}>
          {t("inboxes.offer.no")}
        </Button>
      </div>
    </div>
  );
}
