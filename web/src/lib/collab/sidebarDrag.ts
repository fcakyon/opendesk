// Dragging something from the page into the sidebar to add it there: a page's title, an
// inbox folder's, team's or view's title. The drag carries the row it would be, under a type
// of its own, and the sidebar's Favorites, the member's own sections and "Add section" take it.

import type { DragEvent } from "react";
import type { OwnRow } from "./ownSectionsUi";

export const SIDEBAR_DRAG = "application/x-od-sidebar-row";

export type SidebarDragItem = OwnRow & { label: string };

/** The props that make an element drag `item` toward the sidebar. */
export function sidebarDragProps(item: SidebarDragItem) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(SIDEBAR_DRAG, JSON.stringify(item));
      e.dataTransfer.setData("text/plain", item.label);
      e.dataTransfer.effectAllowed = "copyLink";
    },
  };
}

/** Whether a drag carries a row for the sidebar (its data is readable only on drop). */
export const carriesSidebarRow = (e: DragEvent) => e.dataTransfer.types.includes(SIDEBAR_DRAG);

export function readSidebarDrag(e: DragEvent): SidebarDragItem | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(SIDEBAR_DRAG)) as SidebarDragItem;
    return typeof v?.kind === "string" && typeof v.id === "string" && typeof v.label === "string" ? v : null;
  } catch {
    return null;
  }
}
