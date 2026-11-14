// The rows ticked on a People or Companies list. A selection belongs to one list: it is dropped
// when the list's search or filters change, so an action never reaches rows that are no longer shown.

import { useCallback, useEffect, useState } from "react";

export type Selection = {
  ids: string[];
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Ticks every given row, or none when they are all ticked already. */
  togglePage: (pageIds: string[]) => void;
  /** Everyone the filters match, beyond the rows loaded. */
  allMatching: boolean;
  selectAllMatching: () => void;
  clear: () => void;
};

export function useSelection(listKey: string): Selection {
  const [ids, setIds] = useState<string[]>([]);
  const [allMatching, setAllMatching] = useState(false);
  const clear = useCallback(() => {
    setIds([]);
    setAllMatching(false);
  }, []);
  useEffect(clear, [listKey, clear]);
  return {
    ids,
    has: (id) => ids.includes(id),
    toggle: (id) => {
      setAllMatching(false);
      setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    },
    togglePage: (pageIds) => {
      setAllMatching(false);
      setIds((cur) => (pageIds.length > 0 && pageIds.every((id) => cur.includes(id)) ? cur.filter((id) => !pageIds.includes(id)) : [...new Set([...cur, ...pageIds])]));
    },
    allMatching,
    selectAllMatching: () => setAllMatching(true),
    clear,
  };
}
