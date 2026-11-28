/** @jsxImportSource preact */
// 16px line icons (currentColor) and bot faces, all inline SVG.

import type { JSX } from "preact";
import { readLook, renderBotSvg } from "../../src/lib/botlook";

const svg = (d: JSX.Element, s = 16, w = 1.75) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={w} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {d}
  </svg>
);

export const X = (s = 16) => svg(<path d="M18 6 6 18M6 6l12 12" />, s);
export const Back = () => svg(<path d="m15 18-6-6 6-6" />);
export const Clip = () => svg(<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />);
export const Up = () => svg(<path d="M12 19V5M5 12l7-7 7 7" />, 16, 2);
export const Down = () => svg(<path d="M12 5v14M19 12l-7 7-7-7" />, 14, 2);
export const Ext = () => svg(<path d="M7 17 17 7M8 7h9v9" />, 14);
export const Arrow = () => svg(<path d="M5 12h14M13 6l6 6-6 6" />, 15);
export const Mic = () => svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>);
export const StopIc = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
  </svg>
);
export const Play = (s = 14) => (
  <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" />
  </svg>
);
export const Pause = (s = 14) => (
  <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" />
    <rect x="14" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" />
  </svg>
);
export const Trash = () => svg(<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" />, 15);
export const FileIc = () => svg(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />, 14);
export const LinkIc = () => svg(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />, 12, 2);
export const Person = (s = 14) => svg(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>, s);
export const Check = (s = 14) => svg(<path d="M20 6 9 17l-5-5" />, s, 2.25);
export const Cross = (s = 12) => svg(<path d="M17 7 7 17M7 7l10 10" />, s, 2.25);
export const MailIc = (s = 14) => svg(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>, s, 2);
export const Clock = (s = 12) => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>, s, 2);
export const Bolt = (s = 12) => svg(<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />, s, 2);
export const ThumbUp = () =>
  svg(<path d="M7 10v10M7 10l4-7a2 2 0 0 1 3 2l-1 4h5.5a2 2 0 0 1 2 2.4l-1.3 6.4a2 2 0 0 1-2 1.6H7m0-9.4H4.5a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1H7" />, 14);
export const ThumbDown = () =>
  svg(<path d="M17 14V4m0 10-4 7a2 2 0 0 1-3-2l1-4H5.5a2 2 0 0 1-2-2.4l1.3-6.4a2 2 0 0 1 2-1.6H17m0 9.4h2.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H17" />, 14);

/** The launcher's chat bubble. */
export const ChatIc = (s = 24) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 3.5c-4.9 0-8.75 3.43-8.75 7.75 0 2.3 1.1 4.36 2.86 5.78-.13 1.12-.6 2.2-1.37 3.08a.5.5 0 0 0 .44.83c1.9-.2 3.47-.86 4.62-1.67.7.15 1.45.23 2.2.23 4.9 0 8.75-3.43 8.75-7.75S16.9 3.5 12 3.5Z"
    />
  </svg>
);

/** Spinner: a quarter arc that turns (still under reduced motion). */
export const Spinner = () => (
  <svg class="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".22" stroke-width="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
);

/** The opendesk mark (footer). */
export const OdMark = ({ s = 10 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 64 64" aria-hidden="true">
    <path
      fill="currentColor"
      d="M11 4h12a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7h-12a7 7 0 0 1-7-7v-12a7 7 0 0 1 7-7Z M47 4a13 13 0 1 1 0 26a13 13 0 1 1 0-26Z M11 34h12a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7h-12a7 7 0 0 1-7-7v-12a7 7 0 0 1 7-7Z M41 34h12a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7h-12a7 7 0 0 1-7-7v-12a7 7 0 0 1 7-7Z"
    />
  </svg>
);

/** A look as SVG markup, cached by look (rows re-render often; the markup is a pure function of it). */
const faces = new Map<string, string>();
function faceSvg(look: unknown): string {
  const l = readLook(look);
  const k = JSON.stringify(l);
  let svg = faces.get(k);
  if (svg === undefined) {
    svg = renderBotSvg(l);
    if (faces.size >= 32) faces.clear();
    faces.set(k, svg);
  }
  return svg;
}

/**
 * A bot's face, drawn by the shared look renderer (contracts/bots.md "The
 * look"). The markup holds only the renderer's constants and validated values
 * (readLook allow-lists every key, colours are #rrggbb, the emoji is escaped).
 * `anim` adds the idle blink; a data-bot-state ancestor bobs or hops it.
 */
export const BotFace = ({ look, anim }: { look: unknown; anim?: boolean }) => (
  <span class={`face${anim ? " odb-anim" : ""}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: faceSvg(look) }} />
);
