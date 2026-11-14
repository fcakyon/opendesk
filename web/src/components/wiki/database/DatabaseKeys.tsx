// A database page's keys (lib/shortcuts.ts, scope "database"): a new row, the next and
// previous view, filter, sort and search. Only the database's own page: an inline one
// leaves the keys to the page around it.

import { useTranslation } from "react-i18next";
import { useShortcuts } from "@/lib/shortcuts";

export function DatabaseKeys({
  onNewRow,
  onView,
  onFilter,
  onSearch,
}: {
  onNewRow?: () => void;
  onView: (by: 1 | -1) => void;
  onFilter?: () => void;
  onSearch?: () => void;
}) {
  const { t } = useTranslation("wiki");
  useShortcuts({
    "database.newRow": onNewRow,
    "database.nextView": () => onView(1),
    "database.previousView": () => onView(-1),
    "database.filter": onFilter,
    // The sort menu opens from its own button.
    "database.sort": () => document.querySelector<HTMLButtonElement>(`.wiki-db button[aria-label="${CSS.escape(t("db.sort"))}"]`)?.click(),
    "database.search": onSearch,
  });
  return null;
}
