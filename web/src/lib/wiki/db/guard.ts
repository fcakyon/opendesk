// Formulas and rollups may read each other, across databases too, so a cell can end up
// asking for itself. Evaluation is synchronous: one set of the cells being worked out
// right now is enough to see that.

const active = new Set<string>();

export function guarded<T>(key: string, run: () => T, onCycle: () => T): T {
  if (active.has(key)) return onCycle();
  active.add(key);
  try {
    return run();
  } finally {
    active.delete(key);
  }
}
