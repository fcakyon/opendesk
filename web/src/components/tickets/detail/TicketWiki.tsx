// The wiki pages that mention a ticket (GET /v1/tickets/{id}/wiki), under the ticket's
// other links. Nothing shows until a page mentions it. A page's change elsewhere reaches
// the list through its wiki_page event (lib/wiki/events.ts).

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fullDate, relShort } from "@/lib/format";
import { q } from "@/lib/queries";
import { useNow } from "@/lib/useNow";

function Edited({ iso }: { iso: string }) {
  const now = useNow();
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-fg-4" title={fullDate(iso)}>
      {relShort(iso, now)}
    </span>
  );
}

export function TicketWiki({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation("inbox");
  const { data: pages } = useQuery({ ...q.ticketWiki(ticketId), retry: false });
  if (!pages?.length) return null;
  return (
    <section className="border-b border-line-soft px-4 py-3.5" aria-label={t("wiki.title")}>
      <h3 className="label-caps mb-2">{t("wiki.title")}</h3>
      <ul className="flex flex-col gap-0.5">
        {pages.map((p) => (
          <li key={p.id}>
            <Link
              to="/wiki/$pageId"
              params={{ pageId: p.id }}
              className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] text-fg-2 transition-colors hover:bg-sunken hover:text-fg"
            >
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-[13px] leading-none text-fg-4">
                {p.icon || <FileText className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{p.title.trim() || t("wiki.untitled")}</span>
              <Edited iso={p.updated_at} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
