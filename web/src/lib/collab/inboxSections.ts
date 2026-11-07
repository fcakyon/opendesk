// A ticket inbox (a mailbox) or a team shown as a sidebar section of its own
// (contracts/collab.md "Inboxes as sections"): `order` holds "mailbox:<id>" or "team:<id>"
// where it shows. Its folders list that reply address's or team's tickets; Tickets and Teams
// keep everything. The section sits after the section it follows in the saved order.

import type { SidebarPrefs } from "../api/types";

export type InboxScope = { kind: "mailbox" | "team"; id: string };

const KINDS = ["mailbox", "team"] as const;

export const inboxKey = (s: InboxScope) => `${s.kind}:${s.id}`;

/** The scope an order entry names, or null for any other entry. */
export function parseInboxKey(key: string): InboxScope | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!(KINDS as readonly string[]).includes(kind) || !id) return null;
  return { kind: kind as InboxScope["kind"], id };
}

/** The inbox sections in the member's order, each once. */
export function inboxSections(p: SidebarPrefs): InboxScope[] {
  const out: InboxScope[] = [];
  for (const key of p.order) {
    const s = parseInboxKey(key);
    if (s && !out.some((x) => inboxKey(x) === key)) out.push(s);
  }
  return out;
}

export const isInboxSection = (p: SidebarPrefs, s: InboxScope) => p.order.includes(inboxKey(s));

/**
 * Shows a ticket inbox or team as a section of its own, or puts it back. A new one goes
 * after the last inbox section of its kind, else after Tickets (a mailbox) or Teams (a team),
 * else last.
 */
export function setInboxSection(p: SidebarPrefs, s: InboxScope, on: boolean): SidebarPrefs {
  const key = inboxKey(s);
  const rest = p.order.filter((k) => k !== key);
  if (!on) return rest.length === p.order.length ? p : { ...p, order: rest };
  if (rest.length !== p.order.length) return p;
  const anchor = s.kind === "mailbox" ? "inbox" : "teams";
  let at = -1;
  rest.forEach((k, i) => {
    if (parseInboxKey(k)?.kind === s.kind) at = i;
  });
  if (at < 0) at = rest.indexOf(anchor);
  const order = [...rest];
  if (at < 0) order.push(key);
  else order.splice(at + 1, 0, key);
  return { ...p, order };
}

/**
 * Puts the inbox sections among the sidebar's sections: each after the nearest entry before it
 * in the saved order that shows (a built-in, an own section or another inbox section); one
 * with nothing before it goes first. `entries` are the shown sections' keys, in order.
 */
export function placeInboxSections(order: string[], entries: string[], inboxes: string[]): string[] {
  const shown = new Set(entries);
  const wanted = new Set(inboxes);
  const after = new Map<string, string[]>();
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (!wanted.has(key)) continue;
    wanted.delete(key);
    let anchor = "";
    for (let j = i - 1; j >= 0; j--) {
      const k = order[j];
      if (shown.has(k) || (inboxes.includes(k) && k !== key)) {
        anchor = k;
        break;
      }
    }
    after.set(anchor, [...(after.get(anchor) ?? []), key]);
  }
  const out: string[] = [];
  const place = (k: string) => {
    out.push(k);
    for (const next of after.get(k) ?? []) place(next);
  };
  for (const k of after.get("") ?? []) place(k);
  for (const k of entries) place(k);
  return out;
}

/**
 * Moves an inbox section one place up (-1) or down (1) among the sections shown (`shown`,
 * their keys in order): right before the section above it, or right after the one below.
 */
export function moveInboxSection(p: SidebarPrefs, key: string, dir: -1 | 1, shown: string[]): SidebarPrefs {
  const i = shown.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return p;
  const order = p.order.filter((k) => k !== key);
  let at = order.indexOf(shown[j]);
  if (at < 0) return p;
  if (dir === 1) at += 1;
  order.splice(at, 0, key);
  return { ...p, order };
}
