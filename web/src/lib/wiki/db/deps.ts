// Dependencies (contracts/wiki.md "Databases"): which rows wait on which. Each edge runs
// from the blocking row to the row it blocks; one is late when the blocked row starts
// before its blocker ends.

import type { Database, DbRow, DbValue } from "../../api/types";

export type DepEdge = { from: string; to: string };
export type Span = { start: Date; end: Date };

const ids = (v: DbValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The edges between rows, read from both sides (they agree once kept in step), each once. */
export function dependencyEdges(db: Database, rows: readonly DbRow[]): DepEdge[] {
  const d = db.dependencies;
  if (!d) return [];
  const known = new Set(rows.map((r) => r.id));
  const seen = new Set<string>();
  const out: DepEdge[] = [];
  const add = (from: string, to: string) => {
    const key = `${from}>${to}`;
    if (from === to || !known.has(from) || !known.has(to) || seen.has(key)) return;
    seen.add(key);
    out.push({ from, to });
  };
  for (const r of rows) {
    for (const b of ids(r.props[d.blocked_by])) add(b, r.id);
    for (const b of ids(r.props[d.blocking])) add(r.id, b);
  }
  return out;
}

/** Whether an edge is late: its blocked row starts before the blocking row ends. */
export function isLate(edge: DepEdge, spanOf: (id: string) => Span | null | undefined): boolean {
  const from = spanOf(edge.from);
  const to = spanOf(edge.to);
  return !!from && !!to && from.end.getTime() > to.start.getTime();
}

/** The rows blocking a row that end after it starts. */
export function lateBlockers(rowId: string, edges: readonly DepEdge[], spanOf: (id: string) => Span | null | undefined): string[] {
  return edges.filter((e) => e.to === rowId && isLate(e, spanOf)).map((e) => e.from);
}
