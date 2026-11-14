// What the sidebar and the header add in place: a page, database or canvas, an import, a team,
// a view, a mail account. Each opens a dialog over the open page rather than leaving it for
// Settings, which keeps its full pages. QuickAddRoot draws them.

import { create } from "zustand";
import type { WikiArea } from "@/lib/api/types";
import type { SpaceKey } from "@/lib/wiki/tree";

/** A view's editor: a new one, one to change, or a copy of one. */
export type ViewEdit = { kind: "new" } | { kind: "edit"; id: string } | { kind: "duplicate"; id: string };

/**
 * Where an import starts: under a page or at the top of a space of an area (Pages', unless
 * the workspace has Pages off or it says; contracts/pages.md), with files dropped elsewhere.
 */
export type ImportStart = { parentId: string | null; files: File[]; space?: SpaceKey; area?: WikiArea };

type QuickAdd = {
  /** The new page popup, with the space and area it adds to (Pages' when it says none). */
  newPage: { space?: SpaceKey; area?: WikiArea } | null;
  importing: ImportStart | null;
  /** Each opening of the import dialog starts afresh. */
  importNonce: number;
  team: boolean;
  view: ViewEdit | null;
  mail: boolean;
  /** A new ticket inbox: a new address, or one of the caller's Collab accounts handed over. */
  inbox: InboxStart | null;
};

/** Where adding a ticket inbox starts: from nothing, or from a Collab mail account (contracts/collab.md "Using an account for tickets"). */
export type InboxStart = { accountId?: string };

export const useQuickAdd = create<QuickAdd>(() => ({ newPage: null, importing: null, importNonce: 0, team: false, view: null, mail: false, inbox: null }));

/** Whether anything is open, so the dialogs load only once one is asked for. */
export const quickAddOpen = (s: QuickAdd) => !!(s.newPage || s.importing || s.team || s.view || s.mail || s.inbox);

export const quickAdd = {
  page: (space?: SpaceKey, area?: WikiArea) => useQuickAdd.setState({ newPage: { space, area } }),
  closePage: () => useQuickAdd.setState({ newPage: null }),
  team: (open = true) => useQuickAdd.setState({ team: open }),
  view: (edit: ViewEdit | null) => useQuickAdd.setState({ view: edit }),
  mail: (open = true) => useQuickAdd.setState({ mail: open }),
  inbox: (start: InboxStart | null) => useQuickAdd.setState({ inbox: start }),
  closeImport: () => useQuickAdd.setState({ importing: null }),
};

/**
 * Opens the import dialog, offering to put the pages under parentId (the page the person is on),
 * or at the top of a space; files dropped somewhere else (the sidebar's Pages) come along.
 */
export function openImport(parentId: string | null = null, from: { files?: File[]; space?: SpaceKey; area?: WikiArea } = {}) {
  useQuickAdd.setState((s) => ({ newPage: null, importing: { parentId, files: from.files ?? [], space: from.space, area: from.area }, importNonce: s.importNonce + 1 }));
}
