// The product palette: a few soft hues used for meaning (status, priority,
// SLA, channels, sentiment, AI), for things people label (tags), and to tell
// people and workspaces apart (avatars, tiles, chart series). Each tone has a
// soft fill, a hairline, an ink for text and icons, and a solid for dots and
// bars. Ink stays the primary action colour; tones never replace it.
//
// The class strings are spelled out so Tailwind can see them.

// The names match the API's LabelColor, so a label colour is a tone.
export const TONES = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "purple", "pink", "rose"] as const;
export type Tone = (typeof TONES)[number];

type ToneClasses = {
  /** Soft fill with ink text: badges, chips, pills. */
  chip: string;
  /** Soft fill only. */
  soft: string;
  /** Ink text or icon colour. */
  text: string;
  /** Solid fill: dots, bars, tiles. */
  solid: string;
  /** Hairline border in the hue. */
  line: string;
  /** SVG fill / stroke in the solid hue. */
  fill: string;
  stroke: string;
};

export const tone: Record<Tone, ToneClasses> = {
  blue: { chip: "bg-tone-blue-soft text-tone-blue shadow-[inset_0_0_0_1px_var(--tone-blue-line)]", soft: "bg-tone-blue-soft", text: "text-tone-blue", solid: "bg-tone-blue-solid", line: "border-tone-blue-line", fill: "fill-tone-blue-solid", stroke: "stroke-tone-blue-solid" },
  indigo: { chip: "bg-tone-indigo-soft text-tone-indigo shadow-[inset_0_0_0_1px_var(--tone-indigo-line)]", soft: "bg-tone-indigo-soft", text: "text-tone-indigo", solid: "bg-tone-indigo-solid", line: "border-tone-indigo-line", fill: "fill-tone-indigo-solid", stroke: "stroke-tone-indigo-solid" },
  violet: { chip: "bg-tone-violet-soft text-tone-violet shadow-[inset_0_0_0_1px_var(--tone-violet-line)]", soft: "bg-tone-violet-soft", text: "text-tone-violet", solid: "bg-tone-violet-solid", line: "border-tone-violet-line", fill: "fill-tone-violet-solid", stroke: "stroke-tone-violet-solid" },
  pink: { chip: "bg-tone-pink-soft text-tone-pink shadow-[inset_0_0_0_1px_var(--tone-pink-line)]", soft: "bg-tone-pink-soft", text: "text-tone-pink", solid: "bg-tone-pink-solid", line: "border-tone-pink-line", fill: "fill-tone-pink-solid", stroke: "stroke-tone-pink-solid" },
  red: { chip: "bg-tone-red-soft text-tone-red shadow-[inset_0_0_0_1px_var(--tone-red-line)]", soft: "bg-tone-red-soft", text: "text-tone-red", solid: "bg-tone-red-solid", line: "border-tone-red-line", fill: "fill-tone-red-solid", stroke: "stroke-tone-red-solid" },
  orange: { chip: "bg-tone-orange-soft text-tone-orange shadow-[inset_0_0_0_1px_var(--tone-orange-line)]", soft: "bg-tone-orange-soft", text: "text-tone-orange", solid: "bg-tone-orange-solid", line: "border-tone-orange-line", fill: "fill-tone-orange-solid", stroke: "stroke-tone-orange-solid" },
  amber: { chip: "bg-tone-amber-soft text-tone-amber shadow-[inset_0_0_0_1px_var(--tone-amber-line)]", soft: "bg-tone-amber-soft", text: "text-tone-amber", solid: "bg-tone-amber-solid", line: "border-tone-amber-line", fill: "fill-tone-amber-solid", stroke: "stroke-tone-amber-solid" },
  lime: { chip: "bg-tone-lime-soft text-tone-lime shadow-[inset_0_0_0_1px_var(--tone-lime-line)]", soft: "bg-tone-lime-soft", text: "text-tone-lime", solid: "bg-tone-lime-solid", line: "border-tone-lime-line", fill: "fill-tone-lime-solid", stroke: "stroke-tone-lime-solid" },
  green: { chip: "bg-tone-green-soft text-tone-green shadow-[inset_0_0_0_1px_var(--tone-green-line)]", soft: "bg-tone-green-soft", text: "text-tone-green", solid: "bg-tone-green-solid", line: "border-tone-green-line", fill: "fill-tone-green-solid", stroke: "stroke-tone-green-solid" },
  teal: { chip: "bg-tone-teal-soft text-tone-teal shadow-[inset_0_0_0_1px_var(--tone-teal-line)]", soft: "bg-tone-teal-soft", text: "text-tone-teal", solid: "bg-tone-teal-solid", line: "border-tone-teal-line", fill: "fill-tone-teal-solid", stroke: "stroke-tone-teal-solid" },
  cyan: { chip: "bg-tone-cyan-soft text-tone-cyan shadow-[inset_0_0_0_1px_var(--tone-cyan-line)]", soft: "bg-tone-cyan-soft", text: "text-tone-cyan", solid: "bg-tone-cyan-solid", line: "border-tone-cyan-line", fill: "fill-tone-cyan-solid", stroke: "stroke-tone-cyan-solid" },
  yellow: { chip: "bg-tone-yellow-soft text-tone-yellow shadow-[inset_0_0_0_1px_var(--tone-yellow-line)]", soft: "bg-tone-yellow-soft", text: "text-tone-yellow", solid: "bg-tone-yellow-solid", line: "border-tone-yellow-line", fill: "fill-tone-yellow-solid", stroke: "stroke-tone-yellow-solid" },
  purple: { chip: "bg-tone-purple-soft text-tone-purple shadow-[inset_0_0_0_1px_var(--tone-purple-line)]", soft: "bg-tone-purple-soft", text: "text-tone-purple", solid: "bg-tone-purple-solid", line: "border-tone-purple-line", fill: "fill-tone-purple-solid", stroke: "stroke-tone-purple-solid" },
  rose: { chip: "bg-tone-rose-soft text-tone-rose shadow-[inset_0_0_0_1px_var(--tone-rose-line)]", soft: "bg-tone-rose-soft", text: "text-tone-rose", solid: "bg-tone-rose-solid", line: "border-tone-rose-line", fill: "fill-tone-rose-solid", stroke: "stroke-tone-rose-solid" },
  gray: { chip: "bg-tone-gray-soft text-tone-gray shadow-[inset_0_0_0_1px_var(--tone-gray-line)]", soft: "bg-tone-gray-soft", text: "text-tone-gray", solid: "bg-tone-gray-solid", line: "border-tone-gray-line", fill: "fill-tone-gray-solid", stroke: "stroke-tone-gray-solid" },
};

/** CSS variable for the solid hue, for inline styles (charts, SVG). */
export const toneVar = (t: Tone) => `var(--tone-${t}-solid)`;

export const isTone = (v: unknown): v is Tone => typeof v === "string" && (TONES as readonly string[]).includes(v);

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Hues that tell people and things apart without reading as a warning.
const identityTones: Tone[] = ["blue", "indigo", "violet", "pink", "orange", "amber", "lime", "green", "teal", "cyan"];

/** A stable tone for a name: avatar fallbacks, workspace tiles, untinted tags. */
export function toneFor(name: string): Tone {
  return identityTones[hash(name || "?") % identityTones.length];
}

/** Tones offered when someone picks a tag colour. */
export const TAG_TONES: Tone[] = [...TONES];

/** Chart series, in order. */
export const SERIES: Tone[] = ["blue", "violet", "teal", "amber", "pink", "green"];

// Meaning.
export const statusTone = { open: "blue", pending: "amber", on_hold: "violet", solved: "green", closed: "gray" } as const satisfies Record<string, Tone>;
export const priorityTone = { urgent: "red", high: "orange", normal: "blue", low: "gray" } as const satisfies Record<string, Tone>;
export const severityTone = { sev1: "red", sev2: "orange", sev3: "amber", sev4: "gray" } as const satisfies Record<string, Tone>;
export const channelTone = { email: "blue", chat: "teal", api: "violet", portal: "indigo", phone: "green", whatsapp: "lime" } as const satisfies Record<string, Tone>;
export const sentimentTone = { positive: "green", neutral: "gray", negative: "red", mixed: "amber" } as const satisfies Record<string, Tone>;
/** AI surfaces carry one accent so they read as one family. */
export const AI_TONE: Tone = "violet";
