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

/** Naming a row or section in the member's sidebar: its key in `names`, and its own name. */
export type RenamingRow = { key: string; fallback: string };

/** Adding rows to a section of a Space, from the sidebar's edit mode. */
export type SpaceAdding = { spaceId: string; sectionId: string };

export const useOwnSectionsUi = create<{ naming: Naming | null; adding: string | null; addingToSpace: SpaceAdding | null; addingFavorites: boolean; renamingRow: RenamingRow | null }>(() => ({
  naming: null,
  adding: null,
  addingToSpace: null,
  addingFavorites: false,
  renamingRow: null,
}));

export const ownSectionsUi = {
  name: (n: Naming) => useOwnSectionsUi.setState({ naming: n }),
  /** Opens the rows picker for a section. */
  add: (sectionId: string) => useOwnSectionsUi.setState({ adding: sectionId }),
  /** Opens the rows picker for a section of a Space. */
  addToSpace: (spaceId: string, sectionId: string) => useOwnSectionsUi.setState({ addingToSpace: { spaceId, sectionId } }),
  /** Opens the picker of favorites: anything that can be pinned, and pages to star. */
  addFavorites: () => useOwnSectionsUi.setState({ addingFavorites: true }),
  /** Opens the popup that names a row in the member's sidebar. */
  renameRow: (r: RenamingRow) => useOwnSectionsUi.setState({ renamingRow: r }),
  close: () => useOwnSectionsUi.setState({ naming: null, adding: null, addingToSpace: null, addingFavorites: false, renamingRow: null }),
};
