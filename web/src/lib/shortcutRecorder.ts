// Recording new keys for a shortcut (Settings › Shortcuts): presses become a binding as
// lib/shortcuts.ts writes them. A press without mod may be followed, within a moment, by a
// second one ("g" then "p"); a chord with mod is a binding at once.

import { keyName } from "./hotkeys";
import { isBinding } from "./shortcuts";

/** Modifier keys alone are part of a chord, never a press of their own. */
const MODIFIERS = new Set(["control", "meta", "alt", "shift", "os", "altgraph", "capslock"]);

/** The step a key event makes, or null when it is a modifier alone or not a step. */
export function stepOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIERS.has(e.key.toLowerCase())) return null;
  const name = keyName(e as KeyboardEvent);
  return isBinding(name) ? name : null;
}

export type Recorder = {
  /** Feeds a press; answers the binding once it is complete, or null while it waits for more. */
  press: (step: string) => string | null;
  /** The binding so far when the wait runs out. */
  flush: () => string | null;
};

export function recorder(): Recorder {
  let first: string | null = null;
  return {
    press(step) {
      if (first) {
        const both = `${first} ${step}`;
        first = null;
        return isBinding(both) ? both : step;
      }
      if (step.startsWith("mod+")) return step;
      first = step;
      return null;
    },
    flush() {
      const out = first;
      first = null;
      return out;
    },
  };
}
