// Who else is on a wiki page right now: the page joins wiki_page:<wid>:<id> (contracts/realtime.md),
// and its header shows the others as a small avatar stack.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AvatarStack } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { realtime } from "@/lib/realtime/manager";
import { viewers, type Viewer, type WikiPresenceStatus } from "@/lib/realtime/presence";
import { useRealtime, wikiPresenceKey } from "@/lib/realtime/store";
import { useSession } from "@/lib/session";

const none: Viewer[] = [];

function useTabHidden() {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.hidden,
    () => false,
  );
}

/**
 * Puts this person on the open page: viewing, editing while `editing`, idle while the tab is
 * hidden. A private page is never joined (contracts/realtime.md). Call it once, in the page view.
 */
export function useWikiPresence(page: { id: string; private?: boolean; team_id?: string | null } | undefined, editing: boolean) {
  const id = page && !page.private ? page.id : null;
  const teamId = page?.team_id ?? null;
  const hidden = useTabHidden();
  const state: WikiPresenceStatus = hidden ? "idle" : editing ? "editing" : "viewing";
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!id) return;
    realtime()?.setActiveWikiPage(id, { teamId, state: stateRef.current });
    return () => realtime()?.setActiveWikiPage(null);
  }, [id, teamId]);
  useEffect(() => {
    if (id) realtime()?.setWikiPresenceState(state);
  }, [id, state]);
}

/** The others on a wiki page right now (never yourself), one per person, editing first. */
export function useWikiViewers(pageId: string | undefined): Viewer[] {
  const state = useRealtime((s) => (pageId ? s.presence[wikiPresenceKey(pageId)] : undefined));
  const me = useSession((s) => s.user?.id);
  return useMemo(() => (state ? viewers(state, me) : none), [state, me]);
}

/** The others on the page as ringed avatars; the tooltip says who is editing and who is viewing. */
export function WikiViewers({ pageId, max = 3 }: { pageId: string; max?: number }) {
  const { t } = useTranslation(["shell", "inbox"]);
  const list = useWikiViewers(pageId);
  if (!list.length) return null;
  const lines = list.map((v) => ({
    id: v.user_id,
    text: v.state === "editing" ? t("wikiPresence.editing", { name: v.name }) : t("inbox:presence.viewing", { name: v.name }),
  }));
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          {lines.map((l) => (
            <span key={l.id}>{l.text}</span>
          ))}
        </span>
      }
    >
      <span className="flex shrink-0 animate-pop-in px-0.5 motion-reduce:animate-none" data-wiki-presence>
        <AvatarStack size="xs" max={max} live people={list.map((v) => ({ id: v.user_id, name: v.name, avatar: v.avatar, state: v.state }))} />
        <span className="sr-only">{lines.map((l) => l.text).join(", ")}</span>
      </span>
    </Tooltip>
  );
}
