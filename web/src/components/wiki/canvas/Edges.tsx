// A canvas's connections: smooth curves between cards' sides, arrowheads drawn as their
// own shapes (so they take the line's colour in either theme), a wide invisible stroke to
// pick a line up by, and labels at the middle of the curve.

import { memo, useMemo } from "react";
import type { CanvasEdge, CanvasNode, CanvasSide } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { strokeOf } from "./look";
import { arrowHead, curve, edgeGeometry, fromEnd, tangentBack, toEnd, type EdgeGeometry, type Point } from "./model";

type EdgeProps = { edge: CanvasEdge; from: CanvasNode; to: CanvasNode; selected: boolean };

const Edge = memo(function Edge({ edge, from, to, selected }: EdgeProps) {
  const g = useMemo(() => edgeGeometry(edge, from, to), [edge, from, to]);
  return <EdgeShape id={edge.id} g={g} color={edge.color} start={fromEnd(edge) === "arrow"} end={toEnd(edge) === "arrow"} selected={selected} />;
});

function EdgeShape({ id, g, color, start, end, selected, draft }: { id?: string; g: EdgeGeometry; color?: string; start: boolean; end: boolean; selected?: boolean; draft?: boolean }) {
  const stroke = strokeOf(color);
  return (
    <g data-edge-id={id} className={cn(!draft && "canvas-edge cursor-pointer")} style={{ color: stroke }}>
      {!draft && <path d={g.d} fill="none" stroke="transparent" style={{ pointerEvents: "stroke", strokeWidth: "calc(14px / var(--z))" }} />}
      {selected && <path d={g.d} fill="none" stroke="var(--tone-blue-solid)" strokeOpacity={0.25} strokeLinecap="round" style={{ strokeWidth: "calc(8px / var(--z))" }} />}
      <path d={g.d} fill="none" stroke="currentColor" strokeLinecap="round" strokeDasharray={draft ? "6 6" : undefined} style={{ strokeWidth: "calc(2px / max(var(--z), 0.5))" }} />
      {end && <path d={arrowHead(g.to, tangentBack(g, "to"), 10)} fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth={1} />}
      {start && <path d={arrowHead(g.from, tangentBack(g, "from"), 10)} fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth={1} />}
    </g>
  );
}

/** Every connection whose cards are both there, and the one being drawn. */
export const EdgeLayer = memo(function EdgeLayer({ edges, byId, selected }: { edges: CanvasEdge[]; byId: Map<string, CanvasNode>; selected: ReadonlySet<string> }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
      {edges.map((e) => {
        const from = byId.get(e.fromNode);
        const to = byId.get(e.toNode);
        if (!from || !to) return null;
        return <Edge key={e.id} edge={e} from={from} to={to} selected={selected.has(e.id)} />;
      })}
    </svg>
  );
});

/** A connection being dragged out of a card's side, to the pointer or the card under it. */
export function DraftEdge({ from, side, to, toSide }: { from: Point; side: CanvasSide; to: Point; toSide: CanvasSide | null }) {
  const g = curve(from, side, to, toSide);
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
      <EdgeShape g={g} start={false} end draft color={undefined} />
    </svg>
  );
}

/** The labels, as text at the middle of each curve (HTML, so they read sharply at any zoom). */
export const EdgeLabels = memo(function EdgeLabels({ edges, byId, editing }: { edges: CanvasEdge[]; byId: Map<string, CanvasNode>; editing: string | null }) {
  return (
    <>
      {edges.map((e) => {
        if (!e.label || e.id === editing) return null;
        const from = byId.get(e.fromNode);
        const to = byId.get(e.toNode);
        if (!from || !to) return null;
        const mid = edgeGeometry(e, from, to).mid;
        return (
          <span
            key={e.id}
            data-edge-id={e.id}
            className="absolute max-w-[240px] -translate-x-1/2 -translate-y-1/2 cursor-pointer truncate rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px] text-fg-2 shadow-xs"
            style={{ left: mid.x, top: mid.y }}
          >
            {e.label}
          </span>
        );
      })}
    </>
  );
});

