import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Mail, Pencil, Phone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { CompanyGlyph } from "./bits";
import { PhoneNumber } from "./PhoneNumber";
import { VerificationBadge } from "./VerificationBadge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusIcon, TicketNumber } from "@/components/tickets/bits";
import type { Ticket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { relShort } from "@/lib/format";
import { q } from "@/lib/queries";

/**
 * A contact at a glance: identity, company, notes and recent tickets. Used in
 * the ticket side panel and anywhere a contact needs summarising.
 */
export function ContactCard({ contactId, compact, excludeTicketId }: { contactId: string; compact?: boolean; excludeTicketId?: string }) {
  const { t: ui } = useTranslation("ui");
  const { t } = useTranslation("inbox");
  const { data: c, isLoading } = useQuery(q.contact(contactId));
  // In a ticket, the customer's tickets from every address they wrote from; elsewhere, or when
  // that answer fails, the contact's own.
  const customer = useQuery({ ...q.customerTickets(excludeTicketId ?? ""), enabled: !!excludeTicketId });
  const byCustomer = !!excludeTicketId && !customer.isError;
  const tickets = useQuery({ ...q.contactTickets(contactId), enabled: !byCustomer });

  if (isLoading || !c)
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-2 w-2/3" />
          </div>
        </div>
        <Skeleton className="h-2 w-3/4" />
      </div>
    );

  // A ticket filed under another contact (the same customer's other address) names that address.
  const past: (Pick<Ticket, "id" | "number" | "subject" | "status" | "last_message_at"> & { via: string })[] = (
    byCustomer
      ? (customer.data?.data ?? []).map((t) => ({ ...t, via: t.contact.id === c.id ? "" : t.contact.email.trim() || t.contact.name }))
      : (tickets.data ?? []).filter((t) => t.id !== excludeTicketId).map((t) => ({ ...t, via: "" }))
  ).slice(0, compact ? 4 : 8);
  const pastLoading = byCustomer ? customer.isLoading : tickets.isLoading;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <Avatar name={c.name || c.email || "?"} src={c.avatar_url} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium" data-ph-mask>
              {c.name || c.email || t("contact.unnamed")}
            </span>
            {c.blocked && <Badge tone="danger">{t("contact.blocked")}</Badge>}
            <VerificationBadge v={c.verification} />
          </div>
          {c.company && (
            <Link
              to="/companies/{-$companyId}"
              params={{ companyId: c.company.id }}
              search={{ q: undefined }}
              className="mt-0.5 flex items-center gap-1 truncate text-xs text-fg-3 hover:text-fg"
            >
              <CompanyGlyph name={c.company.name} src={c.company.avatar_url} size="xs" />
              {c.company.name}
            </Link>
          )}
        </div>
        <Tooltip content={t("contact.open")}>
          <Link
            to="/contacts/{-$contactId}"
            params={{ contactId: c.id }}
            search={{ q: undefined, company: undefined }}
            aria-label={ui("editContact")}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          >
            <Pencil className="size-3.5" />
          </Link>
        </Tooltip>
      </div>

      <dl className="flex flex-col gap-1 text-[12.5px]">
        {c.email && (
          <div className="group flex items-center gap-2 text-fg-2">
            <Mail className="size-3.5 shrink-0 text-fg-4" />
            <span className="mono min-w-0 flex-1 truncate text-xs" data-ph-mask>
              {c.email}
            </span>
            <CopyButton value={c.email} label={t("contact.copyEmail")} className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </div>
        )}
        {c.phone && (
          <div className="flex items-center gap-2 text-fg-2">
            <Phone className="size-3.5 shrink-0 text-fg-4" />
            <PhoneNumber phone={c.phone} className="mono truncate text-xs" />
          </div>
        )}
      </dl>

      {c.notes && (
        <p className={cn("rounded-md bg-sunken px-2.5 py-2 text-xs leading-[18px] text-fg-2", compact && "line-clamp-3")} data-ph-mask>
          {c.notes}
        </p>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="label-caps">{t("contact.pastTickets")}</span>
          <span className="mono text-[11px] text-fg-4 tabular-nums">{byCustomer ? (customer.data?.total ?? "") : c.ticket_count}</span>
        </div>
        {pastLoading ? (
          <div className="flex flex-col gap-2 py-1">
            <Skeleton className="h-2.5 w-4/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
        ) : past.length === 0 ? (
          <p className="py-1 text-xs text-fg-4">{t("contact.noOther")}</p>
        ) : (
          <ul className="-mx-1.5 flex flex-col">
            {past.map((t) => (
              <li key={t.id}>
                <Link
                  to="/inbox/$folder/{-$ticketId}"
                  params={{ folder: "open", ticketId: t.id }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 text-[12.5px] outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)]",
                    t.via ? "min-h-7 py-0.5" : "h-7",
                  )}
                >
                  <StatusIcon status={t.status} />
                  <span className="min-w-0 flex-1" data-ph-mask>
                    <span className="block truncate text-fg-2">{t.subject}</span>
                    {t.via && (
                      <span className="mono block truncate text-[10.5px] leading-4 text-fg-4" title={t.via}>
                        {t.via}
                      </span>
                    )}
                  </span>
                  {!compact && <TicketNumber n={t.number} />}
                  <span className="mono shrink-0 text-[10.5px] text-fg-4">{relShort(t.last_message_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
