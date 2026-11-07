// Dragging in the sidebar's edit mode: sections and rows move by their handle with the mouse,
// a finger or a pen (pointer events, so touch works without the HTML drag API). While a drag
// runs, a small copy of the row follows the pointer, the target shows a line where it would
// land, and the sidebar scrolls when the pointer nears its top or bottom edge.
//
// The editor marks what can be dropped on: a section's block `data-edit-section="<key>"` with
// its header `data-edit-head`, each of its rows `data-edit-row="<key>"`. Which drops are
// allowed, and what a drop does, are the editor's (`accepts`, `onDrop`).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type Drag<S> = { source: S; label: string; x: number; y: number };

/** Where a drag would land: between sections, or among a section's rows (before a row, or at the end). */
export type Target = { kind: "section"; before: string | null } | { kind: "row"; section: string; before: string | null };

const START_AT = 4; // px the pointer moves before a press becomes a drag
const EDGE = 36; // px from the scroller's edge where it starts to scroll
const STEP = 12; // px scrolled per frame at the edge

const sameTarget = (a: Target | null, b: Target | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.before === b.before && (a.kind === "section" || (b.kind === "row" && a.section === b.section)));

/** Which drop a point names: for a section drag, the gap between headers; for a row drag, the gap between the rows of the section under it. */
function targetAt(root: HTMLElement, x: number, y: number, kind: "section" | "row"): Target | null {
  if (kind === "section") {
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-edit-section]")];
    for (const b of blocks) {
      const head = b.querySelector<HTMLElement>("[data-edit-head]") ?? b;
      const r = head.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { kind: "section", before: b.dataset.editSection ?? null };
    }
    return { kind: "section", before: null };
  }
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-edit-section]");
  if (!el || !root.contains(el)) return null;
  const section = el.dataset.editSection ?? "";
  for (const row of el.querySelectorAll<HTMLElement>("[data-edit-row]")) {
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { kind: "row", section, before: row.dataset.editRow ?? null };
  }
  return { kind: "row", section, before: null };
}

export function useEditDrag<S extends { kind: "section" | "row" }>({
  root,
  accepts,
  onDrop,
}: {
  /** The editor's element, inside the sidebar's scroller. */
  root: React.RefObject<HTMLElement | null>;
  /** Whether a source may land on a target. */
  accepts: (source: S, target: Target) => boolean;
  onDrop: (source: S, target: Target) => void;
}) {
  const [drag, setDrag] = useState<Drag<S> | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const live = useRef<{ source: S; label: string; x0: number; y0: number; started: boolean; target: Target | null; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const handlers = useRef({ accepts, onDrop });
  handlers.current = { accepts, onDrop };

  const scroller = useCallback(() => root.current?.closest<HTMLElement>(".overflow-y-auto") ?? null, [root]);

  const retarget = useCallback(
    (x: number, y: number) => {
      const d = live.current;
      const el = root.current;
      if (!d || !el) return;
      const t = targetAt(el, x, y, d.source.kind);
      const ok = t && handlers.current.accepts(d.source, t) ? t : null;
      if (!sameTarget(ok, d.target)) {
        d.target = ok;
        setTarget(ok);
      }
    },
    [root],
  );

  // Near the scroller's edge, it scrolls on each frame and the target follows.
  const tick = useCallback(() => {
    frame.current = null;
    const d = live.current;
    const sc = scroller();
    if (!d?.started || !sc) return;
    const r = sc.getBoundingClientRect();
    const dy = d.y < r.top + EDGE ? -STEP : d.y > r.bottom - EDGE ? STEP : 0;
    if (!dy) return;
    sc.scrollTop += dy;
    frame.current = requestAnimationFrame(tick);
  }, [scroller]);

  const end = useCallback(
    (commit: boolean) => {
      const d = live.current;
      live.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setDrag(null);
      setTarget(null);
      if (commit && d?.started && d.target) handlers.current.onDrop(d.source, d.target);
    },
    [],
  );

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag, end]);

  /** The props of a handle that drags `source`. */
  const handle = (source: S, label: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer the browser no longer tracks: the drag still follows it on this element */
      }
      live.current = { source, label, x0: e.clientX, y0: e.clientY, started: false, target: null, y: e.clientY };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = live.current;
      if (!d) return;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < START_AT) return;
        d.started = true;
      }
      d.y = e.clientY;
      setDrag({ source: d.source, label: d.label, x: e.clientX, y: e.clientY });
      retarget(e.clientX, e.clientY);
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => {
      if (live.current) end(true);
    },
    style: { touchAction: "none" as const },
  });

  return { drag, target, handle };
}
