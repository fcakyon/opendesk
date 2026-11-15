// Copies a Space's sections with rows of this workspace into the member's own sidebar
// sections ("Copy a Space"), within the limits of their sections.

import type { SidebarPrefs, Space } from "../api/types";
import { asSpace, newOwnSection, OWN_LIMITS, ownCount, withSpace } from "./ownSections";

export function copySpaceSections(p: SidebarPrefs, wid: string, sp: Space): { prefs: SidebarPrefs; made: number } {
  let next = p;
  let made = 0;
  for (const sec of sp.sections) {
    const rows = sec.items.filter((i) => i.workspace_id === wid && i.kind !== "section" && i.kind !== "everywhere");
    if (!rows.length || next.sections.length >= OWN_LIMITS.sections) continue;
    const room = Math.min(OWN_LIMITS.sectionItems, OWN_LIMITS.items - ownCount(next));
    if (room <= 0) break;
    const r = newOwnSection(next, wid, sec.title || sp.name);
    const own = asSpace(r.prefs, wid);
    const items = rows.slice(0, room).map((i) => ({ workspace_id: wid, kind: i.kind, id: i.id, ...(i.name ? { name: i.name } : {}), ...(i.badge ? { badge: i.badge } : {}), ...(i.icon ? { icon: i.icon } : {}) }));
    next = withSpace(r.prefs, { ...own, sections: own.sections.map((x) => (x.id === r.id ? { ...x, ...(sec.icon ? { icon: sec.icon } : {}), items } : x)) });
    made++;
  }
  return { prefs: next, made };
}
