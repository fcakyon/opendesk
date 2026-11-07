// Starting points for a member's sidebar: a few layouts of the built-in sections, previewed
// before they apply. A layout sets which built-in sections show and in what order; the
// member's own sections keep their place after the section they followed, and the rows
// hidden inside sections stay as they were.

import type { SidebarPrefs, SidebarSectionId } from "../api/types";
import { entryKey, reorderEntries, sidebarEntries } from "./ownSections";
import { hid, isHidden, SECTION_IDS, sectionOrder, setHidden } from "./sidebarPrefs";

export type LayoutId = "support" | "mail" | "docs" | "minimal";

export type Layout = { id: LayoutId; order: readonly SidebarSectionId[]; hidden: readonly SidebarSectionId[] };

export const LAYOUTS: readonly Layout[] = [
  { id: "support", order: ["favorites", "inbox", "teams", "views", "mail", "pages", "workspace"], hidden: ["mail", "pages"] },
  { id: "mail", order: ["favorites", "mail", "inbox", "teams", "views", "pages", "workspace"], hidden: [] },
  { id: "docs", order: ["favorites", "pages", "inbox", "mail", "teams", "views", "workspace"], hidden: [] },
  { id: "minimal", order: ["favorites", "inbox", "mail", "pages", "teams", "views", "workspace"], hidden: ["teams", "views", "workspace"] },
];

/** The prefs with a layout applied: its order and shown sections, the member's own sections where they were. */
export function applyLayout(p: SidebarPrefs, layout: Layout): SidebarPrefs {
  const entries = sidebarEntries(p);
  // Each own section follows the built-in section it followed (or leads, before any).
  const after = new Map<string, string[]>();
  let last = "";
  for (const e of entries) {
    if (e.kind === "builtin") last = e.id;
    else after.set(last, [...(after.get(last) ?? []), entryKey(e)]);
  }
  const order = [...layout.order, ...SECTION_IDS.filter((id) => !layout.order.includes(id))];
  const keys = [...(after.get("") ?? []), ...order.flatMap((id) => [id, ...(after.get(id) ?? [])])];
  let next = reorderEntries(p, keys);
  for (const id of SECTION_IDS) next = setHidden(next, hid.section(id), layout.hidden.includes(id));
  return next;
}

/** Whether the prefs already have this layout's order and shown sections. */
export function hasLayout(p: SidebarPrefs, layout: Layout): boolean {
  const order = sectionOrder(p);
  const want = [...layout.order, ...SECTION_IDS.filter((id) => !layout.order.includes(id))];
  return order.every((id, i) => id === want[i]) && SECTION_IDS.every((id) => isHidden(p, hid.section(id)) === layout.hidden.includes(id));
}

/** The built-in sections a layout shows, in order (for its preview). */
export function layoutSections(layout: Layout, offered: readonly SidebarSectionId[]): SidebarSectionId[] {
  return layout.order.filter((id) => offered.includes(id) && !layout.hidden.includes(id));
}

/** Back to how the sidebar starts: every section in the default order, nothing hidden, no row order. The member's own sections and favorites stay. */
export function resetPrefs(p: SidebarPrefs): SidebarPrefs {
  const keys = [...SECTION_IDS, ...p.sections.map((s) => `custom:${s.id}`)];
  return { ...reorderEntries({ ...p, hidden: [], row_order: {} }, keys), hidden: [], row_order: {}, show_waiting_chats: false };
}
