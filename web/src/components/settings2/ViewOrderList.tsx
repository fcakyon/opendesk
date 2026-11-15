// Settings → Views in sidebar order, each row moved by its grip: a view within its list, into
// another section or out of its section to the top level, and a section with its views among
// the top-level entries. The row lifts and follows the pointer; a line shows where it lands, and
// a section it would join is outlined. Alt+ArrowUp/Down on a grip moves it one place within its
// list, as SortableList does. Where it lands is lib/viewMoves.ts.

import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { View } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { dur, springs } from "@/lib/motion";
import { dropSpot, entryId, placeViews, sameLayout, stepSpot, type Dragged, type DropRow, type ViewSpot } from "@/lib/viewMoves";
import { groupViews, type ViewEntry } from "@/lib/viewSections";
import { DragHandle } from "./Sortable";

type SectionEntry = Extract<ViewEntry, { kind: "section" }>;

const keyOf = (d: Dragged) => ("view" in d ? d.view : `section:${d.section}`);

export function ViewOrderList({
  views,
  canMoveView,
  canMoveSection,
  onMove,
  renderView,
  renderHeader,
  viewLabel,
  sectionLabel,
  groupLabel,
}: {
  views: View[];
  /** Whether the person may move this view (write it). */
  canMoveView: (v: View) => boolean;
  canMoveSection: (s: SectionEntry) => boolean;
  /** Called once a drag or a keyboard move ends somewhere new. */
  onMove: (dragged: Dragged, spot: ViewSpot) => void;
  /** A view's row; put `handle` at its start. */
  renderView: (v: View, handle: ReactNode) => ReactNode;
  /** A section's header; put `handle` at its start. */
  renderHeader: (s: SectionEntry, handle: ReactNode) => ReactNode;
  viewLabel: (v: View) => string;
  sectionLabel: (s: SectionEntry) => string;
  groupLabel: (s: SectionEntry) => string;
}) {
  const entries = useMemo(() => groupViews(views), [views]);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dragged: Dragged; el: HTMLElement | null; cancelled: boolean } | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [over, setOver] = useState<ViewSpot | null>(null);
  const overRef = useRef<ViewSpot | null>(null);
  const show = (spot: ViewSpot | null) => {
    const cur = overRef.current;
    if (cur?.section === spot?.section && cur?.before === spot?.before) return;
    overRef.current = spot;
    setOver(spot);
  };

  // Escape lets go: the row glides back and nothing moves.
  useEffect(() => {
    if (!lifted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      drag.current.cancelled = true;
      overRef.current = null;
      setOver(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lifted]);

  const start = (dragged: Dragged, el: HTMLElement | null) => {
    drag.current = { dragged, el, cancelled: false };
    setLifted(keyOf(dragged));
    show(null);
  };
  /** Where a drop at `y` would land, from the rows on screen; `offset` is how far the dragged rows moved. */
  const track = (y: number, offset: number) => {
    const d = drag.current;
    if (!d || d.cancelled || !root.current) return;
    const rows: DropRow[] = [];
    for (const n of root.current.querySelectorAll<HTMLElement>("[data-drop-row]")) {
      if (d.el?.contains(n)) continue;
      const r = n.getBoundingClientRect();
      rows.push({ kind: n.dataset.dropRow === "header" ? "header" : "view", id: n.dataset.id ?? "", section: n.dataset.section || null, top: r.top, bottom: r.bottom });
    }
    const box = d.el?.getBoundingClientRect();
    const spot = dropSpot(rows, d.dragged, y, box && { top: box.top - offset, bottom: box.bottom - offset });
    // Only somewhere that changes the list: over its own place, nothing shows.
    show(spot && !sameLayout(views, placeViews(views, d.dragged, spot)) ? spot : null);
  };
  const end = () => {
    const d = drag.current;
    const spot = overRef.current;
    drag.current = null;
    setLifted(null);
    show(null);
    if (d && !d.cancelled && spot) onMove(d.dragged, spot);
  };
  const step = (dragged: Dragged, dir: -1 | 1) => {
    const spot = stepSpot(views, dragged, dir);
    if (spot) onMove(dragged, spot);
  };
  const top = (id: string) => over?.section === null && over.before === id;

  return (
    <div ref={root}>
      <AnimatePresence initial={false}>
        {entries.map((e, i) => {
          const id = entryId(e);
          const line = top(id) ? "top" : i === entries.length - 1 && over?.section === null && over.before === null ? "bottom" : null;
          if (e.kind === "view") {
            const v = e.view;
            const dragged = { view: v.id };
            return (
              <DragItem
                key={id}
                row={{ "data-drop-row": "view", "data-id": v.id, "data-section": "" }}
                label={viewLabel(v)}
                disabled={!canMoveView(v)}
                lifted={lifted === id}
                line={line}
                onStart={(el) => start(dragged, el)}
                onDrag={track}
                onEnd={end}
                onStep={(dir) => step(dragged, dir)}
              >
                {(handle) => renderView(v, handle)}
              </DragItem>
            );
          }
          const dragged = { section: e.key };
          const into = over?.section === e.key;
          return (
            <DragItem
              key={id}
              label={sectionLabel(e)}
              disabled={!canMoveSection(e)}
              lifted={lifted === id}
              line={line}
              onStart={(el) => start(dragged, el)}
              onDrag={track}
              onEnd={end}
              onStep={(dir) => step(dragged, dir)}
            >
              {(handle) => (
                <div role="group" aria-label={groupLabel(e)} className="relative">
                  <div data-drop-row="header" data-id={e.key}>
                    {renderHeader(e, handle)}
                  </div>
                  <AnimatePresence initial={false}>
                    {e.views.map((v, j) => {
                      const inner = { view: v.id };
                      const at = into && over.before === v.id ? "top" : into && over.before === null && j === e.views.length - 1 ? "bottom" : null;
                      return (
                        <DragItem
                          key={v.id}
                          row={{ "data-drop-row": "view", "data-id": v.id, "data-section": e.key }}
                          label={viewLabel(v)}
                          disabled={!canMoveView(v)}
                          lifted={lifted === v.id}
                          line={at}
                          nested
                          onStart={(el) => start(inner, el)}
                          onDrag={track}
                          onEnd={end}
                          onStep={(dir) => step(inner, dir)}
                        >
                          {(h) => renderView(v, h)}
                        </DragItem>
                      );
                    })}
                  </AnimatePresence>
                  {into && <span aria-hidden data-drop-into={e.key} className="pointer-events-none absolute inset-0 z-[2] rounded-md bg-tone-blue-solid/5 shadow-[inset_0_0_0_1.5px_var(--tone-blue-solid)]" />}
                </div>
              )}
            </DragItem>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function DragItem({
  row,
  label,
  disabled,
  lifted,
  line,
  nested,
  onStart,
  onDrag,
  onEnd,
  onStep,
  children,
}: {
  row?: Record<string, string>;
  label: string;
  disabled: boolean;
  lifted: boolean;
  /** The drop line at the row's top or bottom edge. */
  line: "top" | "bottom" | null;
  /** A view inside a section: its line starts past the section's indent. */
  nested?: boolean;
  onStart: (el: HTMLElement | null) => void;
  onDrag: (y: number, offset: number) => void;
  onEnd: () => void;
  onStep: (dir: -1 | 1) => void;
  children: (handle: ReactNode) => ReactNode;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const handle = disabled ? null : (
    <DragHandle
      label={label}
      dragging={lifted}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        controls.start(e);
      }}
      onMove={onStep}
    />
  );
  return (
    <motion.div
      ref={ref}
      {...row}
      drag="y"
      dragListener={false}
      dragControls={controls}
      dragSnapToOrigin
      dragMomentum={false}
      onDragStart={() => onStart(ref.current)}
      onDrag={(e, info) => onDrag("clientY" in e ? e.clientY : info.point.y - window.scrollY, info.offset.y)}
      onDragEnd={onEnd}
      layout="position"
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.99, transition: { duration: dur.fast } }}
      transition={reduce ? { duration: 0 } : springs.row}
      whileDrag={reduce ? { zIndex: 3 } : { scale: 1.015, boxShadow: "var(--shadow-float)", zIndex: 3 }}
      className={cn("relative border-b border-line-soft bg-surface last:border-0 [&>*]:border-b-0", lifted && "cursor-grabbing rounded-md")}
    >
      {children(handle)}
      {line && (
        <span
          aria-hidden
          data-drop-line={line}
          className={cn("pointer-events-none absolute right-2 z-[4] h-0.5 rounded-full bg-tone-blue-solid", nested ? "left-10" : "left-2", line === "top" ? "-top-px" : "-bottom-px")}
        />
      )}
    </motion.div>
  );
}
