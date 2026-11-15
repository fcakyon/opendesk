// A live chat assigned to the member pops up on whatever page they are on, with the live chat
// alarm: who is waiting, their first words, and Open. It stays until they open the chat or
// close it, and while it shows in a background tab, the tab's title blinks. The desktop
// notification still goes out as before; this shows in the app even when the browser does not
// allow notifications.

import { MessageCircle, X } from "lucide-react";
import { useEffect, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { toast as sonner } from "sonner";
import { api } from "@/lib/api/endpoints";
import { inWorkspace } from "@/lib/api/client";
import { isDesktop } from "@/lib/desktop";
import { openInNewTab } from "@/lib/links";
import type { Notification, Ticket } from "@/lib/api/types";
import { playAlertOnce } from "@/lib/alertSound";
import { useRealtime } from "@/lib/realtime/store";
import { withWorkspaceParam } from "@/lib/workspaceParam";
import { notificationPath } from "@/app/Notifications";

/** A chat assigned to the member: the assigned notification of a chat ticket. */
export function isChatAssignment(n: Notification): boolean {
  return n.type === "assigned" && n.data.channel === "chat" && !!n.ticket;
}

/** The visitor's first words, cut at a word near `max` characters. */
export function firstWords(text: string, max = 90): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

const popped = new Set<string>();

const CARD_SLOT: CSSProperties = {
  width: 440,
  maxWidth: "calc(100vw - 2rem)",
  right: 0,
  padding: 0,
  border: 0,
  background: "transparent",
  boxShadow: "none",
  overflow: "visible",
};

/**
 * Pops a chat assigned to the member up and reports true, so the caller skips its usual toast;
 * false for any other notification. Once per chat: a second notification of the same chat does
 * nothing. Open opens the chat in a new tab, so the page the member is on stays; in the desktop
 * app, whose windows open only web addresses, it goes there in place with `navigate`. The card
 * shows once the visitor's name and first words are read (or reading them failed), so it keeps
 * the height the toast stack measures when it appears.
 */
export function showChatPopup(n: Notification, workspaceId: string | undefined, navigate: (path: string) => void): boolean {
  if (!isChatAssignment(n)) return false;
  const tid = n.ticket!.id;
  if (popped.has(tid)) return true;
  popped.add(tid);
  playAlertOnce("waiting", `chat:${tid}`);
  const at = notificationPath(n);
  const path = at ? withWorkspaceParam(at, workspaceId) : null;
  const onOpen = () => path && (isDesktop ? navigate(path) : openInNewTab(path));
  const show = (ticket: Ticket | null) =>
    sonner.custom((id) => <ChatPopup toastId={id} n={n} ticket={ticket} onOpen={onOpen} />, {
      id: `chat:${tid}`,
      duration: Infinity,
      // Wider than the usual toast, to be seen on a large screen: the card draws its own frame,
      // and it grows to the left from the stack's right edge.
      style: CARD_SLOT,
    });
  inWorkspace(workspaceId, () => api.tickets.get(tid)).then(show, () => show(null));
  return true;
}

/** Forgets the chats already popped up (tests). */
export function resetChatPopups() {
  popped.clear();
}

export function ChatPopup({ toastId, n, ticket, onOpen }: { toastId: string | number; n: Notification; ticket: Ticket | null; onOpen: () => void }) {
  const { t } = useTranslation("shell");
  const tid = n.ticket!.id;
  const looking = useRealtime((s) => s.active === tid);
  // Opened (here or from the list): its job is done.
  useEffect(() => {
    if (looking) sonner.dismiss(toastId);
  }, [looking, toastId]);
  // While it waits in a background tab, the tab's title blinks.
  const blink = t("chatPopup.title");
  useEffect(() => blinkTitle(`● ${blink}`), [blink]);
  const who = ticket?.contact?.name || ticket?.contact?.email || "";
  const words = firstWords(ticket?.last_message_preview || n.ticket!.subject || "");
  const title = [t("chatPopup.title"), who].filter(Boolean).join(" · ");
  return (
    <div
      role="alertdialog"
      aria-label={title}
      data-chat-popup={tid}
      className="flex w-full items-start gap-3 rounded-xl border border-line bg-raised px-4 py-3.5 text-[14px] text-fg shadow-float ring-[3px] ring-tone-red-solid/70"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-tone-red-solid text-white [&_svg]:size-4.5">
        <MessageCircle />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">{title}</p>
        {words && <p className="mt-1 line-clamp-3 text-[13px] text-fg-2">{words}</p>}
        <button
          type="button"
          onClick={() => {
            onOpen();
            sonner.dismiss(toastId);
          }}
          className="mt-2.5 h-8 rounded-md bg-inverse px-3.5 text-[13px] font-medium text-inverse-fg"
        >
          {t("chatPopup.open")}
        </button>
      </div>
      <button
        type="button"
        aria-label={t("chatPopup.close")}
        onClick={() => sonner.dismiss(toastId)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover [&_svg]:size-4"
      >
        <X />
      </button>
    </div>
  );
}

// The blinking title, shared by every pop-up showing: while the tab is in the background it
// alternates with the page's own title (taken afresh each time, so a title the page set
// meanwhile is kept), and the page's title comes back when the tab is in view again or the last
// pop-up goes.
let blinking = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let saved = "";
let shown = "";
export function blinkTitle(text: string): () => void {
  if (typeof document === "undefined") return () => undefined;
  blinking += 1;
  shown = text;
  if (!timer) {
    timer = setInterval(() => {
      if (document.title !== shown) saved = document.title;
      document.title = document.hidden && document.title !== shown ? shown : saved;
    }, 1000);
  }
  return () => {
    blinking -= 1;
    if (blinking > 0) return;
    if (timer) clearInterval(timer);
    timer = null;
    if (document.title === shown) document.title = saved;
  };
}
