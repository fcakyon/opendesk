import { motion, useReducedMotion } from "motion/react";
import { AlarmClock, Check, Lock, UserPlus } from "lucide-react";
import { forwardRef, memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Ticket, TicketLastNote } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { relLong, relShort, fullDate } from "@/lib/format";
import { ease } from "@/lib/motion";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { ChannelIcon, channelLabel, PriorityIcon, SeverityChip, severityLabel, SlaPill, slaState, StatusIcon } from "./bits";
import { useDisplay } from "./fields";
import { SetByOllie, useOllieNote } from "./ollie";
import { aiDecisions } from "@/lib/decisions";
import { useAssigneeDisplay, useShowLastNote } from "@/lib/listDisplay";
import { tone } from "@/lib/tones";
import { AssigneeMark, Viewers } from "./people";
import { rowMotion } from "./motion";
import { Labels } from "@/components/contacts/bits";
import { LiveChatBadge, NewCount, UrgentEdge, WaitPill, urgentWash, useChatWait, useHandoffBot } from "./waiting";
import { TicketTeamChips, useTeamsCtx } from "./teams";
import { requesterLabel } from "./requester";
import { browserClick } from "@/lib/links";

export type QuickAction = "assign" | "snooze" | "solve";

export type RowProps = {
  ticket: Ticket;
  active: boolean;
  focused: boolean;
  selected: boolean;
  selecting: boolean;
  compact: boolean;
  /** Hide the assignee (a folder where everyone is the same person). */
  hideAssignee?: boolean;
  /** Arrived live after the list was shown: tint it briefly. */
  fresh?: boolean;
  /** The ticket in this list, as a link: a right click, a Ctrl/Cmd or middle click open it in a new tab. */
  href: string;
  onOpen: (t: Ticket) => void;
  onToggle: (t: Ticket, shift: boolean) => void;
  onHover?: (t: Ticket) => void;
  /** Hover actions; left out for viewers. */
  onQuick?: (t: Ticket, a: QuickAction) => void;
};

/** The customer wrote last and nobody has answered yet. */
export function awaitingReply(t: Ticket) {
  return (
    (t.status === "open" || t.status === "pending") &&
    !!t.last_customer_message_at &&
    Date.parse(t.last_customer_message_at) >= Date.parse(t.last_message_at) - 1000
  );
}

/** SLA only when it matters: due soon or breached. On track says nothing. */
function SlaIfAtRisk({ ticket }: { ticket: Ticket }) {
  const s = slaState(ticket);
  if (!s || s.state === "on_track") return null;
  return <SlaPill ticket={ticket} />;
}

/** Who wrote a note, as a row names them: a member by first name, an API key by its name. */
function noteAuthor(n: TicketLastNote) {
  return (n.author.type === "user" && n.author.name.split(" ")[0]) || n.author.name;
}

/** The whole note, with who wrote it and when: the tooltip of the row's note. */
function NoteTip({ note }: { note: TicketLastNote }) {
  const { t: tr } = useTranslation("inbox");
  return (
    <span className="block max-w-[320px] py-0.5 font-normal">
      <span className="block font-medium">{tr("row.noteFrom", { name: note.author.name, when: relLong(note.created_at) })}</span>
      <span className="mt-0.5 block whitespace-normal break-words opacity-80" data-ph-mask>
        {note.preview}
      </span>
    </span>
  );
}

/** The ticket's latest internal note as a line under the preview, tinted like notes in the timeline. */
function NoteLine({ note }: { note: TicketLastNote }) {
  const { t: tr } = useTranslation("inbox");
  return (
    <Tooltip content={<NoteTip note={note} />} align="start">
      <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-sm bg-note px-1.5 py-px text-xs">
        <Lock aria-hidden className={cn("size-3 shrink-0", tone.amber.text)} />
        <span className="min-w-0 truncate text-fg-3" data-ph-mask>
          <span className="sr-only">{tr("row.note")}: </span>
          <span className="font-medium text-fg-2">{tr("row.noteBy", { name: noteAuthor(note) })} </span>
          {note.preview}
        </span>
      </div>
    </Tooltip>
  );
}

/** A one-line row's mark for the latest internal note; the note itself is in its tooltip. */
function NoteMark({ note }: { note: TicketLastNote }) {
  const { t: tr } = useTranslation("inbox");
  return (
    <Tooltip content={<NoteTip note={note} />}>
      <span
        role="img"
        aria-label={`${tr("row.noteFrom", { name: note.author.name, when: relLong(note.created_at) })}: ${note.preview}`}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-note-line bg-note"
      >
        <Lock aria-hidden className={cn("size-3", tone.amber.text)} />
      </span>
    </Tooltip>
  );
}

function QuickButton({ label, shortcut, onClick, children }: { label: string; shortcut: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          // Inside the row's link: the click neither opens the ticket nor follows the link.
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        className="flex size-6 items-center justify-center rounded-sm text-fg-3 outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-line-strong active:scale-95"
      >
        {children}
      </button>
    </Tooltip>
  );
}

const Row = forwardRef<HTMLAnchorElement, RowProps>(function TicketRow(
  { ticket: t, active, focused, selected, selecting, compact, hideAssignee, fresh, href, onOpen, onToggle, onHover, onQuick },
  ref,
) {
  const { t: tr } = useTranslation("inbox");
  useTranslation("indicators");
  const reduced = useReducedMotion();
  const display = useDisplay();
  const note = useOllieNote();
  const teams = useTeamsCtx();
  const wait = useChatWait(t);
  // A visitor waiting in live chat with nobody on it: the row washes red.
  const urgent = wait?.state === "urgent" && !t.assignee;
  const unread = awaitingReply(t) || !!wait;
  // A waiting visitor's row says what it is about and how much they wrote; other rows
  // show the count once it is more than one message.
  const newCount = wait ? t.unanswered_count : t.unanswered_count > 1 ? t.unanswered_count : 0;
  // The bot's hand-off line is the last message of a chat it gave to the team.
  const botLast = !!wait?.handedOff && !awaitingReply(t);
  const bot = useHandoffBot(t);
  const contactName = requesterLabel(t.contact) || tr("row.unknown");
  const subject = t.subject || tr("row.noSubject");
  const showCheck = selecting || selected;
  const done = t.status === "solved" || t.status === "closed";
  const decisions = aiDecisions(t);
  const aiSet = decisions ? !!decisions.fields.priority?.applied : !!t.custom?.ai_triaged_at;
  const aiSeverity = !!decisions?.fields.severity?.applied && decisions.fields.severity.value === t.severity;
  // Who it is assigned to sits at the row's end, as this browser chose; who is on it
  // right now shows live in green (./people), so the two never read alike.
  const assigneeMode = useAssigneeDisplay();
  const lastNote = useShowLastNote() ? t.last_note : null;
  const named = !hideAssignee && assigneeMode === "name";
  const assignee = !hideAssignee && assigneeMode !== "none" && t.assignee;
  // A handled chat's wait pill already says who is on it: the live mark keeps to its avatars.
  const handledLive = wait?.handler?.how === "viewing" || wait?.handler?.how === "replying";
  const motionProps = rowMotion(reduced);
  const initial = fresh && !reduced ? { ...motionProps.initial, backgroundColor: "var(--tone-blue-soft)" } : motionProps.initial;
  const animate = fresh && !reduced ? { ...motionProps.animate, backgroundColor: "rgba(0,0,0,0)" } : motionProps.animate;

  const check = (
    // Inside the row's link: a click on the checkbox selects the row, it neither opens the
    // ticket nor follows the link (prevented here, once the checkbox has toggled).
    <span
      className="flex"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <Checkbox
        checked={selected}
        aria-label={tr("row.select", { number: t.number })}
        onClick={(e) => {
          if (e.shiftKey) {
            e.preventDefault();
            onToggle(t, true);
          }
        }}
        onCheckedChange={() => onToggle(t, false)}
      />
    </span>
  );

  // Status, swapped for a checkbox on hover or while selecting.
  const statusSlot = (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <Tooltip content={display.status(t.status)}>
        <span className={cn("flex transition-opacity duration-100", showCheck ? "opacity-0" : "md:group-hover:opacity-0")}>
          <StatusIcon status={t.status} />
        </span>
      </Tooltip>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity duration-100",
          showCheck ? "opacity-100" : "pointer-events-none opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100",
        )}
      >
        {check}
      </span>
    </span>
  );

  // Every row shows its priority in the same slot, so the column lines up.
  const prioritySlot = (
    <Tooltip content={aiSet ? `${tr("row.priority", { priority: display.priority(t.priority) })} · ${note(t, "priority")}` : tr("row.priority", { priority: display.priority(t.priority) })}>
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <PriorityIcon priority={t.priority} />
        {aiSet && <SetByOllie size={10} className="absolute -right-1.5 -top-1.5 ring-1 ring-surface" />}
      </span>
    </Tooltip>
  );

  // Severity is optional: a compact chip before the subject, only when set and the workspace uses it.
  const severity = display.severity && t.severity && (
    <Tooltip content={aiSeverity ? `${severityLabel(t.severity)} · ${note(t, "severity")}` : severityLabel(t.severity)}>
      <span className="flex shrink-0">
        <SeverityChip severity={t.severity} />
      </span>
    </Tooltip>
  );

  // Which address an email came in on, once there is more than one to write to.
  const received = teams.multiAddress && t.channel === "email" && t.received_at ? (
    <span className="mono min-w-0 shrink truncate text-[10.5px] text-fg-4" title={tr("row.receivedAt", { address: t.received_at })} data-ph-mask>
      {t.received_at}
    </span>
  ) : null;
  const chips = <TicketTeamChips t={t} ctx={teams} />;

  const channel = t.channel === "chat" ? (
    <LiveChatBadge urgent={urgent} handedOff={wait?.handedOff} bot={bot} />
  ) : t.channel !== "email" && (
    <Tooltip content={channelLabel(t.channel)}>
      <span className="flex shrink-0">
        <ChannelIcon channel={t.channel} plain className="size-3" />
      </span>
    </Tooltip>
  );

  // Time and avatar, replaced in place by quick actions on hover or focus.
  const end = (
    <span className={cn("relative flex shrink-0 items-center justify-end", compact ? (named ? "h-4 min-w-[60px]" : "h-4 w-[60px]") : named ? "h-6 w-[148px]" : "h-6 w-[84px]")}>
      <span className={cn("flex items-center gap-2 transition-opacity duration-100", onQuick && "md:group-hover:opacity-0 md:group-focus-within:opacity-0")}>
        {assignee && <AssigneeMark assignee={assignee} mode={assigneeMode} compact={compact} />}
        <span className={cn("mono text-right tabular-nums", compact ? "whitespace-nowrap text-[10.5px] text-fg-4" : "min-w-9 whitespace-nowrap text-[11px] text-fg-3")} title={fullDate(t.last_message_at)}>
          {relShort(t.last_message_at)}
        </span>
      </span>
      {onQuick && (
        <span
          className={cn(
            "absolute inset-y-0 right-0 hidden items-center gap-0.5 opacity-0 transition-opacity duration-100 md:flex",
            "pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            compact && "-my-1",
          )}
        >
          {!t.assignee && (
            <QuickButton label={tr("quick.assign", { number: t.number })} shortcut="tickets.assign" onClick={() => onQuick(t, "assign")}>
              <UserPlus className="size-3.5" />
            </QuickButton>
          )}
          <QuickButton label={tr("quick.snooze", { number: t.number })} shortcut="tickets.snooze" onClick={() => onQuick(t, "snooze")}>
            <AlarmClock className="size-3.5" />
          </QuickButton>
          {!done && (
            <QuickButton label={display.finishWords.quick(t.number)} shortcut="tickets.solve" onClick={() => onQuick(t, "solve")}>
              <Check className="size-3.5" />
            </QuickButton>
          )}
        </span>
      )}
    </span>
  );

  return (
    // A real link, so the browser opens the ticket in a new tab on a right, Ctrl/Cmd or middle
    // click; a plain click opens it here. The option keeps the listbox's own keyboard focus.
    <motion.a
      ref={ref}
      href={href}
      role="option"
      aria-selected={active}
      data-ticket-id={t.id}
      data-focused={focused || undefined}
      tabIndex={-1}
      onClick={(e) => {
        if (browserClick(e)) return;
        e.preventDefault();
        onOpen(t);
      }}
      onMouseEnter={() => onHover?.(t)}
      {...motionProps}
      initial={initial}
      animate={animate}
      transition={fresh ? { ...motionProps.transition, backgroundColor: { duration: 1.4, ease: ease.out } } : motionProps.transition}
      className="relative z-[1] block shrink-0 overflow-hidden outline-none"
    >
      {compact ? (
        <div
          className={cn(
            "group relative flex cursor-pointer gap-2.5 border-b border-line-soft py-2.5 pl-3.5 pr-3 transition-colors duration-100",
            urgent ? cn(urgentWash, active && "shadow-[inset_0_0_0_1px_var(--tone-red-line)]") : active ? "bg-active" : selected ? "bg-hover" : "hover:bg-sunken/70",
          )}
        >
          {urgent && <UrgentEdge />}
          <div className="flex w-4 shrink-0 flex-col items-center gap-[7px] pt-px">
            {statusSlot}
            {prioritySlot}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={cn("min-w-[72px] shrink-[0.25] truncate text-[12.5px]", unread ? "font-medium text-fg" : "text-fg-2")} data-ph-mask>
                {contactName}
              </span>
              {channel}
              <TicketTeamChips t={t} ctx={teams} plain className="ml-0.5 shrink" />
              <Viewers ticketId={t.id} bare />
              <span className="flex-1" />
              {end}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {severity}
              <span className={cn("min-w-0 truncate text-[12.5px]", unread ? "font-medium text-fg" : "text-fg")} data-ph-mask>
                {subject}
              </span>
              {wait && <Labels labels={t.tags} className="ml-auto pl-1" />}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate text-xs", urgent ? "text-fg-2" : "text-fg-3")} data-ph-mask>
                {botLast && <span className="font-medium text-tone-violet">{tr("waiting.botSaid", { name: bot })} </span>}
                {t.last_message_preview}
              </span>
              {received}
              <NewCount count={newCount} urgent={urgent} />
              {wait ? <WaitPill wait={wait} compact /> : <SlaIfAtRisk ticket={t} />}
            </div>
            {lastNote && <NoteLine note={lastNote} />}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "group relative flex h-11 cursor-pointer items-center gap-3 border-b border-line-soft pl-3.5 pr-4 transition-colors duration-100",
            urgent ? cn(urgentWash, active && "shadow-[inset_0_0_0_1px_var(--tone-red-line)]") : active ? "bg-active" : selected ? "bg-hover" : "hover:bg-sunken/70",
          )}
        >
          {urgent && <UrgentEdge />}
          {statusSlot}
          {prioritySlot}
          <span className="flex w-[180px] shrink-0 items-center gap-1.5">
            <span className={cn("min-w-0 truncate text-[13px]", unread ? "font-medium text-fg" : "text-fg-2")} data-ph-mask>
              {contactName}
            </span>
            {channel}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {severity}
            <span className={cn("max-w-[60%] shrink-0 truncate text-[13px]", unread ? "font-medium text-fg" : "text-fg-2")} data-ph-mask>
              {subject}
            </span>
            {wait && <Labels labels={t.tags} className="shrink-0" />}
            {chips}
            <Viewers ticketId={t.id} bare={handledLive} />
            <NewCount count={newCount} urgent={urgent} />
            {wait ? <WaitPill wait={wait} /> : <SlaIfAtRisk ticket={t} />}
            {lastNote && <NoteMark note={lastNote} />}
            <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", urgent ? "text-fg-3" : "text-fg-4")} data-ph-mask>
              {botLast && <span className="font-medium text-tone-violet">{tr("waiting.botSaid", { name: bot })} </span>}
              {t.last_message_preview}
            </span>
            {received && <span className="flex max-w-[180px] shrink-0">{received}</span>}
          </span>
          {end}
        </div>
      )}
    </motion.a>
  );
});

export const TicketRow = memo(Row);
