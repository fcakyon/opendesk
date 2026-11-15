// The schema a new database starts with, by the layout it was asked for from the "/" menu:
// a name, a status (a board groups by it), tags, and a date for calendars and timelines.

import type { TFunction } from "i18next";
import type { Database, DbViewType } from "@/lib/api/types";
import { defaultView } from "@/lib/wiki/db";

export function starterDatabase(type: DbViewType, t: TFunction<"wiki">): Database {
  const db: Database = {
    properties: [
      { id: "title", name: t("db.starter.name"), type: "title" },
      {
        id: "status",
        name: t("db.starter.status"),
        type: "status",
        options: [
          { id: "not_started", name: t("db.starter.notStarted"), color: "gray" },
          { id: "in_progress", name: t("db.starter.inProgress"), color: "blue" },
          { id: "done", name: t("db.starter.done"), color: "green" },
        ],
        groups: [
          { id: "todo", option_ids: ["not_started"] },
          { id: "doing", option_ids: ["in_progress"] },
          { id: "done", option_ids: ["done"] },
        ],
      },
      { id: "tags", name: t("db.starter.tags"), type: "multi_select", options: [] },
      ...(type === "calendar" || type === "timeline" ? [{ id: "date", name: t("db.starter.date"), type: "date" as const }] : []),
    ],
    views: [],
    next_id: 1,
  };
  return { ...db, views: [{ ...defaultView(type, db), id: type, name: t(`db.view.${type}`) }] };
}
