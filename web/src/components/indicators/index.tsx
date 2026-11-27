// One family of indicators for status, priority, SLA, sentiment and channel.
// All glyphs are drawn on the same 16px grid with a 1.5 stroke, sized 14px by
// default, coloured from the tone palette (lib/tones.ts) with light and dark
// variants, and they snap in softly when their value changes.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Channel, Priority, Sentiment, Severity, TicketStatus } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { minutes } from "@/lib/format";
import { channelTone, isTone, priorityTone, sentimentTone, severityTone, statusTone, tone, toneVar, type Tone } from "@/lib/tones";
import { Tooltip } from "@/components/ui/tooltip";

export const statusLabel = (value: TicketStatus) => i18n.t(`indicators:status.${value}`);
export const statusOrder: TicketStatus[] = ["open", "pending", "on_hold", "solved", "closed"];
export const priorityLabel = (value: Priority) => i18n.t(`indicators:priority.${value}`);
export const priorityOrder: Priority[] = ["urgent", "high", "normal", "low"];
export const severityLabel = (value: Severity) => i18n.t(`indicators:severity.${value}`);
/** What each level means, for pickers and tooltips. */
export const severityHint = (value: Severity) => i18n.t(`indicators:severityHint.${value}`);
export const severityOrder: Severity[] = ["sev1", "sev2", "sev3", "sev4"];
export const channelLabel = (value: Channel) => i18n.t(`indicators:channel.${value}`);
export const sentimentLabel = (value: Sentiment) => i18n.t(`indicators:sentiment.${value}`);

const SW = 1.5;

// The WhatsApp mark (simple-icons), a filled glyph that reads at 12-14px where the
// outline family's speech bubble does not. It is scaled into the 16px grid.
const WHATSAPP_PATH = "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z";

export function WhatsAppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0", className)} fill="currentColor" aria-hidden>
      <path d={WHATSAPP_PATH} />
    </svg>
  );
}

/** The shared frame: a 16px grid, keyed by value so a change snaps in. */
function Glyph({ k, label, className, children }: { k: string; label: string; className?: string; children: ReactNode }) {
  return (
    <svg
      key={k}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      className={cn("size-3.5 shrink-0 animate-indicator-in motion-reduce:animate-none", className)}
      fill="none"
    >
      {children}
    </svg>
  );
}

// Status: rings that fill as the ticket moves along, in the status tone.

export function StatusIcon({ status, className }: { status: TicketStatus; className?: string }) {
  useTranslation("indicators");
  const c = toneVar(statusTone[status]);
  return (
    <Glyph k={status} label={statusLabel(status)} className={className}>
      {status === "open" && (
        <>
          <circle cx="8" cy="8" r="5.75" stroke={c} strokeWidth={SW} />
          <circle cx="8" cy="8" r="2.25" fill={c} />
        </>
      )}
      {status === "pending" && (
        <>
          <circle cx="8" cy="8" r="5.75" stroke={c} strokeWidth={SW} />
          <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill={c} />
        </>
      )}
      {status === "on_hold" && (
        <>
          <circle cx="8" cy="8" r="5.75" stroke={c} strokeWidth={SW} strokeDasharray="2.4 1.9" />
          <path d="M6.6 6v4M9.4 6v4" stroke={c} strokeWidth={SW} strokeLinecap="round" />
        </>
      )}
      {(status === "solved" || status === "closed") && (
        <>
          <circle cx="8" cy="8" r="6.5" fill={c} />
          <path d="M5.4 8.2l1.8 1.75 3.5-3.7" stroke="var(--surface)" strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </Glyph>
  );
}

/** Spam is a folder rather than a status; it gets a matching glyph. */
export function SpamIcon({ className }: { className?: string }) {
  useTranslation("indicators");
  const c = toneVar("red");
  return (
    <Glyph k="spam" label={i18n.t("indicators:spam")} className={className}>
      <circle cx="8" cy="8" r="5.75" stroke={c} strokeWidth={SW} />
      <path d="M4 12l8-8" stroke={c} strokeWidth={SW} strokeLinecap="round" />
    </Glyph>
  );
}

/** `label` and `hue` carry the workspace's display overrides (status_labels). */
export function StatusPill({ status, className, label, hue }: { status: TicketStatus; className?: string; label?: string; hue?: string | null }) {
  useTranslation("indicators");
  return (
    <span className={cn("inline-flex h-[19px] shrink-0 items-center gap-1 rounded-sm pl-1 pr-1.5 text-[10.5px] font-medium", tone[isTone(hue) ? hue : statusTone[status]].chip, className)}>
      <StatusIcon status={status} className="size-3" />
      {label || statusLabel(status)}
    </span>
  );
}

// Priority: three signal bars that rise and warm with priority; urgent is a
// filled square with an exclamation, the one mark that shouts.

export function PriorityIcon({ priority, className, muted }: { priority: Priority | null | undefined; className?: string; muted?: boolean }) {
  useTranslation("indicators");
  // No priority yet: a faint dashed outline holds the slot so columns align.
  if (!priority)
    return (
      <Glyph k="none" label={i18n.t("indicators:noPriority")} className={className}>
        <rect x="2" y="2" width="12" height="12" rx="3" stroke="var(--line-strong)" strokeWidth={SW} strokeDasharray="2.2 2" />
      </Glyph>
    );
  if (priority === "urgent")
    return (
      <Glyph k={priority} label={priorityLabel("urgent")} className={className}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={toneVar("red")} />
        <path d="M8 4.6v4.1" stroke="white" strokeWidth="1.75" strokeLinecap="round" />
        <circle cx="8" cy="11.1" r="1" fill="white" />
      </Glyph>
    );
  const level = { low: 1, normal: 2, high: 3 }[priority];
  const on = muted ? "var(--fg-3)" : toneVar(priorityTone[priority]);
  return (
    <Glyph k={priority} label={priorityLabel(priority)} className={className}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2.25 + i * 4.25} y={10 - i * 3.5} width="3" height={4 + i * 3.5} rx="0.9" fill={i < level ? on : "var(--line-strong)"} />
      ))}
    </Glyph>
  );
}

/** `label` and `hue` carry the workspace's display overrides (priority_labels). */
export function PriorityPill({ priority, className, label, hue: override }: { priority: Priority; className?: string; label?: string; hue?: string | null }) {
  useTranslation("indicators");
  const hue: Tone = isTone(override) ? override : priorityTone[priority];
  return (
    <span className={cn("inline-flex h-[19px] shrink-0 items-center gap-1 rounded-sm pl-1 pr-1.5 text-[10.5px] font-medium", tone[hue].chip, className)}>
      <PriorityIcon priority={priority} className="size-3" />
      {label || priorityLabel(priority)}
    </span>
  );
}

// Severity: a compact mono chip, "S1" to "S4", in the level's tone. It sits
// beside the priority glyph and stays out of the way when a ticket has none.

export function SeverityChip({ severity, className, title }: { severity: Severity | null | undefined; className?: string; title?: string }) {
  useTranslation("indicators");
  if (!severity) return null;
  const hue: Tone = severityTone[severity];
  return (
    <span
      key={severity}
      role="img"
      aria-label={title ?? severityLabel(severity)}
      className={cn(
        "mono inline-flex h-[16px] min-w-[22px] shrink-0 items-center justify-center rounded-[4px] px-1 text-[10px] font-semibold leading-none tabular-nums animate-indicator-in motion-reduce:animate-none",
        tone[hue].chip,
        className,
      )}
    >
      S{severity.slice(3)}
    </span>
  );
}

/** The chip with its name, for pickers and the ticket header. */
export function SeverityPill({ severity, className }: { severity: Severity; className?: string }) {
  useTranslation("indicators");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[12px]", className)}>
      <SeverityChip severity={severity} />
      {severityLabel(severity)}
    </span>
  );
}

// SLA: on track, due soon or breached, with the time left.

export type SlaInput = {
  sla: { first_response_due_at: string | null; resolution_due_at: string | null; breached: boolean } | null;
  first_responded_at?: string | null;
  status: TicketStatus;
};

export type SlaState = { due: string; left: number; kind: string; state: "on_track" | "due_soon" | "breached"; tone: "danger" | "warn" | "muted" };

/** Which SLA clock matters now, and how long is left in minutes (negative = overdue). */
export function slaState(t: SlaInput, now = Date.now()): SlaState | null {
  if (!t.sla || t.status === "solved" || t.status === "closed") return null;
  const firstPending = !t.first_responded_at && t.sla.first_response_due_at;
  const due = firstPending ? t.sla.first_response_due_at : t.sla.resolution_due_at;
  if (!due) return null;
  const left = Math.round((Date.parse(due) - now) / 60000);
  const kind = firstPending ? "First response" : "Resolution";
  const state = t.sla.breached || left < 0 ? "breached" : left < 60 ? "due_soon" : "on_track";
  return { due, left, kind, state, tone: state === "breached" ? "danger" : state === "due_soon" ? "warn" : "muted" };
}

const slaLook = {
  on_track: { chip: "text-fg-3", dot: tone.green.solid },
  due_soon: { chip: tone.amber.chip, dot: tone.amber.solid },
  breached: { chip: tone.red.chip, dot: tone.red.solid },
} as const;

export function SlaPill({ ticket, className }: { ticket: SlaInput; className?: string }) {
  useTranslation("indicators");
  const s = slaState(ticket);
  if (!s) return null;
  const look = slaLook[s.state];
  const label = s.left < 0 ? i18n.t("indicators:sla.over", { duration: minutes(-s.left) }) : minutes(s.left);
  return (
    <Tooltip content={i18n.t(`indicators:sla.${s.kind === "First response" ? "firstResponse" : "resolution"}.${s.state}`)}>
      <span
        key={s.state}
        className={cn(
          "mono inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10.5px] tabular-nums animate-indicator-in motion-reduce:animate-none",
          look.chip,
          className,
        )}
      >
        <span className={cn("size-1.5 rounded-full", look.dot, s.state === "breached" && "animate-pulse-soft")} />
        {label}
      </span>
    </Tooltip>
  );
}

// Sentiment: a small face, coloured by mood.

export function SentimentIcon({ sentiment, className }: { sentiment: Sentiment | string; className?: string }) {
  useTranslation("indicators");
  const s = (["positive", "neutral", "negative", "frustrated"].includes(sentiment) ? sentiment : "neutral") as Sentiment;
  const hue: Tone = s === "frustrated" ? "red" : s === "negative" ? "amber" : sentimentTone[s as "positive" | "neutral"];
  const c = toneVar(hue);
  const mouth = {
    positive: "M5.6 9.4c1.3 1.45 3.5 1.45 4.8 0",
    neutral: "M5.8 10h4.4",
    negative: "M5.6 10.8c1.3-1.45 3.5-1.45 4.8 0",
    frustrated: "M5.6 11c1.3-1.6 3.5-1.6 4.8 0",
  }[s];
  return (
    <Glyph k={s} label={sentimentLabel(s)} className={className}>
      <circle cx="8" cy="8" r="6.25" stroke={c} strokeWidth={SW} />
      {s === "frustrated" ? (
        <path d="M5.2 6l1.6.7M10.8 6l-1.6.7" stroke={c} strokeWidth={SW} strokeLinecap="round" />
      ) : (
        <>
          <circle cx="6" cy="6.6" r="0.95" fill={c} />
          <circle cx="10" cy="6.6" r="0.95" fill={c} />
        </>
      )}
      <path d={mouth} stroke={c} strokeWidth={SW} strokeLinecap="round" />
    </Glyph>
  );
}

// Channel: envelope, bubble, handset, braces, globe, WhatsApp bubble; drawn to match the family.

export function ChannelIcon({ channel, className, plain }: { channel: Channel; className?: string; plain?: boolean }) {
  useTranslation("indicators");
  const c = plain ? "var(--fg-3)" : toneVar(channelTone[channel]);
  return (
    <Glyph k={channel} label={channelLabel(channel)} className={className}>
      {channel === "email" && (
        <>
          <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" stroke={c} strokeWidth={SW} />
          <path d="M2.5 4.5L8 8.6l5.5-4.1" stroke={c} strokeWidth={SW} strokeLinejoin="round" />
        </>
      )}
      {channel === "chat" && (
        <path
          d="M3.75 2.75h8.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7.5L4.6 13.9a.5.5 0 0 1-.85-.36V11.7a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z"
          stroke={c}
          strokeWidth={SW}
          strokeLinejoin="round"
        />
      )}
      {channel === "api" && (
        <path d="M5.5 3.5C4 3.5 4 4.5 4 6s-1.5 2-1.5 2S4 8.5 4 10s0 2.5 1.5 2.5M10.5 3.5C12 3.5 12 4.5 12 6s1.5 2 1.5 2S12 8.5 12 10s0 2.5-1.5 2.5" stroke={c} strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {channel === "phone" && (
        <path
          d="M5.6 2.25H4a1.5 1.5 0 0 0-1.5 1.6C2.85 9.15 6.85 13.15 12.15 13.5a1.5 1.5 0 0 0 1.6-1.5v-1.6a1 1 0 0 0-.73-.96l-1.9-.55a1 1 0 0 0-1 .27l-.72.73a7.6 7.6 0 0 1-3.29-3.29l.73-.72a1 1 0 0 0 .27-1l-.55-1.9a1 1 0 0 0-.96-.73z"
          stroke={c}
          strokeWidth={SW}
          strokeLinejoin="round"
        />
      )}
      {channel === "portal" && (
        <>
          <circle cx="8" cy="8" r="6" stroke={c} strokeWidth={SW} />
          <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z" stroke={c} strokeWidth={SW} strokeLinejoin="round" />
        </>
      )}
      {channel === "whatsapp" && (
        <g transform="scale(0.6666667)">
          <path d={WHATSAPP_PATH} fill={c} />
        </g>
      )}
    </Glyph>
  );
}
