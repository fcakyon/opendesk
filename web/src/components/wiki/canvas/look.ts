// How a canvas colour looks: a preset (JSON Canvas's 1 to 6) is one of the app's tones,
// a hex colour is mixed the same way, so both sit softly on the light and dark themes.

import type { CSSProperties } from "react";
import { PRESET_TONES, isColor } from "./model";

/** The solid of a colour, as CSS: a tone's variable or the hex itself. */
export function solidOf(color: string | undefined): string | null {
  if (!isColor(color)) return null;
  return color in PRESET_TONES ? `var(--tone-${PRESET_TONES[color as keyof typeof PRESET_TONES]}-solid)` : color;
}

/** A card's border and fill in its colour; nothing for a card without one. */
export function cardTint(color: string | undefined, fill = 7): CSSProperties | undefined {
  const solid = solidOf(color);
  if (!solid) return undefined;
  return {
    borderColor: `color-mix(in oklab, ${solid} 55%, var(--line))`,
    background: `color-mix(in oklab, ${solid} ${fill}%, var(--surface))`,
  };
}

/** A connection's stroke. */
export const strokeOf = (color: string | undefined) => solidOf(color) ?? "var(--fg-4)";
