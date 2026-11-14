// The widget's appearance from /v1/widget/config. Every appearance key has a
// default (contracts/api.md "Widget"), so an older server, or a stored setting
// without the key, reads the same as the default.

import { OLLIE_LOOK, readLook, type BotLook } from "../../src/lib/botlook";
import { contrastText, isHex } from "./html";
import type { BotIdentity, BotRef, WidgetConfig, WidgetRadius } from "./types";

export const BOT_NAME = "Ollie";

const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : d;
  return Math.min(hi, Math.max(lo, v));
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null);

/** What a message or a live event says of its bot. `look` is null when it sent none (an older server). */
export type BotSeen = { id: string | null; name: string; avatar_url: string; look: BotLook | null };

/**
 * A bot from the server, read for display. The look always goes through
 * readLook (unknown values take Ollie's), so only allow-listed values reach the
 * renderer. An older server sent `{name, avatar_url}`: its picture becomes an
 * image look.
 */
export function readBotRef(v: unknown): BotSeen | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const avatar = url(o.avatar_url) ?? "";
  const look = o.look && typeof o.look === "object" ? readLook(o.look) : avatar ? { ...OLLIE_LOOK, kind: "image" as const } : null;
  return { id: typeof o.id === "string" && o.id ? o.id : null, name: str(o.name, 40), avatar_url: avatar, look };
}

/** WidgetConfig.bot with every key filled in: Ollie when the server sent none. */
export function readBot(v: unknown): BotIdentity {
  const b = readBotRef(v);
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    id: b?.id ?? null,
    name: b?.name || BOT_NAME,
    role: str(o.role, 60),
    avatar_url: b?.avatar_url ?? "",
    look: b?.look ?? OLLIE_LOOK,
    // Newlines are kept; only the ends are trimmed.
    greeting: typeof o.greeting === "string" ? o.greeting.trim().slice(0, 300) : "",
  };
}

/** The bot to show for a message or live reply: the one it names, else the widget's. */
export function botShown(seen: BotSeen | null | undefined, bot: BotRef): BotRef {
  if (!seen) return bot;
  return {
    id: seen.id ?? bot.id,
    name: seen.name || bot.name,
    ...(seen.look ? { look: seen.look, avatar_url: seen.avatar_url } : { look: bot.look, avatar_url: bot.avatar_url }),
  };
}

/** Fill in every key with its default and keep values in their documented ranges. */
export function resolveConfig(raw: Partial<WidgetConfig> | null | undefined): WidgetConfig {
  const r = raw ?? {};
  const suggestions = Array.isArray(r.suggestions)
    ? r.suggestions
        .map((s) => str(s, 60))
        .filter((s) => s.length >= 2)
        .slice(0, 4)
    : [];
  const team = Array.isArray(r.team)
    ? r.team
        .filter((m) => m && typeof m.name === "string")
        .slice(0, 3)
        .map((m) => ({ name: m.name.trim().slice(0, 40), avatar_url: url(m.avatar_url) }))
    : [];
  const seen = new Set<string>();
  const topics = Array.isArray(r.topics)
    ? r.topics
        .filter((x) => x && typeof x.id === "string" && x.id && !seen.has(x.id) && seen.add(x.id))
        .map((x) => ({ id: x.id, label: str(x.label, 40) }))
        .filter((x) => x.label.length >= 2)
        .slice(0, 8)
    : [];
  const brandColor = isHex(r.brand?.color) ? r.brand.color.trim() : null;
  const brand = { name: str(r.brand?.name, 80) || str(r.workspace_name, 80), color: brandColor };
  return {
    workspace_name: str(r.workspace_name, 80) || brand.name,
    brand_color: isHex(r.brand_color) ? r.brand_color.trim() : brandColor,
    greeting: typeof r.greeting === "string" ? r.greeting : "",
    help_center_url: url(r.help_center_url),
    require_email: r.require_email === true,
    locale: r.locale ?? null,
    avatar_url: url(r.avatar_url),
    launcher_icon_url: url(r.launcher_icon_url),
    theme: oneOf(r.theme, ["auto", "light", "dark"] as const, "auto"),
    position: oneOf(r.position, ["right", "left"] as const, "right"),
    offset_x: clamp(r.offset_x, 0, 200, 20),
    offset_y: clamp(r.offset_y, 0, 200, 20),
    z_index: clamp(r.z_index, 0, MAX_Z_INDEX, 0),
    launcher: oneOf(r.launcher, ["icon", "label"] as const, "icon"),
    launcher_label: str(r.launcher_label, 24),
    radius: oneOf(r.radius, ["square", "soft", "round"] as const, "soft"),
    title: str(r.title, 40),
    subtitle: str(r.subtitle, 80),
    suggestions,
    sound: r.sound === true,
    attachments: r.attachments !== false,
    attachment_extensions: Array.isArray(r.attachment_extensions)
      ? r.attachment_extensions
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase())
          .filter((x) => /^\.[a-z0-9]{1,10}$/.test(x))
          .slice(0, 60)
      : null,
    voice_messages: r.voice_messages === true,
    voice_max_seconds: clamp(r.voice_max_seconds, 5, 300, 60),
    team,
    ai_answers: r.ai_answers === true,
    bot: readBot(r.bot),
    topics,
    // Older servers have no hours here: open.
    open: r.open !== false,
    offline_message: typeof r.offline_message === "string" ? r.offline_message.trim().slice(0, 300) : "",
    intro: typeof r.intro === "string" ? r.intro.trim().slice(0, 200) : "",
    // Older servers have no switch: the welcome shows.
    chat_welcome: r.chat_welcome !== false,
    language: typeof r.language === "string" ? r.language.trim() : "",
    brand,
  };
}

/** The server's upload limit per file. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Whether the visitor may attach files at all. */
export function canAttach(c: WidgetConfig | null | undefined): boolean {
  return c?.attachments !== false && (c?.attachment_extensions == null || c.attachment_extensions.length > 0);
}

/**
 * Why a file can't be sent, checked before uploading: its extension is not one the widget
 * takes, or it is too large. The server checks the type again against the file's bytes.
 */
export function fileProblem(f: { name: string; size: number }, extensions: string[] | null | undefined): "type" | "size" | null {
  if (extensions) {
    const dot = f.name.lastIndexOf(".");
    if (dot < 1 || !extensions.includes(f.name.slice(dot).toLowerCase())) return "type";
  }
  return f.size > MAX_FILE_BYTES ? "size" : null;
}

/** Corner radii per preset: panel, bubbles, launcher, controls (buttons, chips), cards, the composer bar, avatars. */
export const RADII: Record<WidgetRadius, { panel: number; bubble: number; launcher: string; ctl: string; card: number; bar: number; av: string }> = {
  square: { panel: 6, bubble: 6, launcher: "10px", ctl: "4px", card: 4, bar: 4, av: "4px" },
  soft: { panel: 16, bubble: 14, launcher: "16px", ctl: "8px", card: 10, bar: 10, av: "6px" },
  round: { panel: 24, bubble: 20, launcher: "999px", ctl: "999px", card: 16, bar: 22, av: "999px" },
};

/** Above nearly any page; a workspace lowers it (z_index) so its own drawers and dialogs cover the widget. */
export const DEFAULT_Z_INDEX = 2147483000;
const MAX_Z_INDEX = 2147483647;

/**
 * CSS custom properties on the widget host for a resolved config. Each of the offsets, the
 * stacking order and the colour reads the host page's own variable first, so a site restyles
 * the widget without !important or media-query tricks (documented in the docs'
 * "Customize the widget"): --opendesk-offset-x, --opendesk-offset-y, --opendesk-z-index,
 * --opendesk-brand and --opendesk-brand-text.
 */
export function hostVars(c: WidgetConfig): Record<string, string> {
  const r = RADII[c.radius ?? "soft"];
  const vars: Record<string, string> = {
    "--r-panel": `${r.panel}px`,
    "--r-bubble": `${r.bubble}px`,
    "--r-launcher": r.launcher,
    "--r-ctl": r.ctl,
    "--r-card": `${r.card}px`,
    "--r-bar": `${r.bar}px`,
    "--r-av": r.av,
    "--ox": `var(--opendesk-offset-x, ${c.offset_x ?? 20}px)`,
    "--oy": `var(--opendesk-offset-y, ${c.offset_y ?? 20}px)`,
    "--oz": `var(--opendesk-z-index, ${c.z_index || DEFAULT_Z_INDEX})`,
  };
  if (isHex(c.brand_color)) {
    const hex = c.brand_color.startsWith("#") ? c.brand_color : `#${c.brand_color}`;
    vars["--brand"] = `var(--opendesk-brand, ${hex})`;
    vars["--brand-fg"] = `var(--opendesk-brand-text, ${contrastText(hex)})`;
  } else {
    vars["--brand"] = "var(--opendesk-brand)";
    vars["--brand-fg"] = "var(--opendesk-brand-text)";
  }
  return vars;
}

/** Write `hostVars` onto an element. */
export function applyHostVars(el: HTMLElement, c: WidgetConfig) {
  const vars = hostVars(c);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/** The visitor's current page for the agent: https only, no fragment or credentials, at most 500 characters. */
export function pageUrl(href: string | undefined = typeof location === "undefined" ? undefined : location.href): string | undefined {
  if (!href) return undefined;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  u.hash = "";
  u.username = "";
  u.password = "";
  let s = u.href;
  if (s.length > 500) s = (u.origin + u.pathname).slice(0, 500);
  return s;
}
