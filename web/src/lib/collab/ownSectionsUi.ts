// The popups of a member's own sidebar sections (lib/collab/ownSections.ts): naming a new
// section or renaming one, and adding rows to one. Opened from any row's "Add to sidebar",
// a section's header menu and the sidebar's "Add section", never from Settings.

import { create } from "zustand";
import type { SidebarItem } from "../api/types";

export type OwnRow = Pick<SidebarItem, "kind" | "id">;

export type Naming =
  /** A new section, with the row that asked for it in it; after `at` (a section's key) or last. */
  | { mode: "new"; item?: OwnRow; at?: string }
  | { mode: "rename"; id: string };

export const useOwnSectionsUi = create<{ naming: Naming | null; adding: string | null }>(() => ({ naming: null, adding: null }));

export const ownSectionsUi = {
  name: (n: Naming) => useOwnSectionsUi.setState({ naming: n }),
  /** Opens the rows picker for a section. */
  add: (sectionId: string) => useOwnSectionsUi.setState({ adding: sectionId }),
  close: () => useOwnSectionsUi.setState({ naming: null, adding: null }),
};
