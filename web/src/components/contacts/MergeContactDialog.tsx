// Merges a contact into another one (contracts/api.md "Merging contacts"): pick who stays. The
// contact chosen here is removed, and its tickets, messages, calls, labels and addresses
// become the other's. Admins only; it cannot be undone.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Contact } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/queries";
import { dropContact, patchContact } from "./cache";

export function MergeContactDialog({ contact, open, onOpenChange, onMerged }: { contact: Contact; open: boolean; onOpenChange: (o: boolean) => void; onMerged: () => void }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const [term, setTerm] = useState("");
  const deferred = useDeferredValue(term.trim());
  const [target, setTarget] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = contact.name || contact.email || t("thisContact");

  const results = useQuery({
    queryKey: qk.of("merge-contact-search", contact.id, deferred),
    queryFn: () => api.contacts.search({ q: deferred || undefined, limit: 10 }),
    enabled: open,
  });
  const list = (results.data?.data ?? []).filter((c) => c.id !== contact.id);

  const merge = useMutation({
    mutationFn: (into: Contact) => api.contacts.merge(contact.id, into.id),
    onSuccess: (kept) => {
      dropContact(qc, contact.id);
      qc.removeQueries({ queryKey: qk.contact(contact.id) });
      patchContact(qc, kept);
      // Their tickets now show the other contact.
      void qc.invalidateQueries({ queryKey: qk.ticketLists });
      toast.success(t("merge.done", { name: kept.name || kept.email || t("thisContact") }));
      onOpenChange(false);
      onMerged();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setTarget(null);
          setTerm("");
          setError(null);
        }
      }}
      title={t("merge.title", { name })}
      description={t("merge.description", { name })}
      footer={
        <>
          {error && (
            <p role="alert" className="mr-auto text-xs text-danger-fg">
              {error}
            </p>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant="primary" icon={<GitMerge className="size-3.5" />} disabled={!target} loading={merge.isPending} onClick={() => target && merge.mutate(target)}>
            {target ? t("merge.into", { name: target.name || target.email }) : t("merge.merge")}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-fg-3">{t("merge.warning", { name })}</p>
      <SearchInput value={term} onChange={setTerm} placeholder={t("merge.search")} inputSize="md" autoFocus />
      <div className="mt-3 flex min-h-[220px] flex-col gap-0.5">
        {results.isPending ? (
          <div className="flex flex-col gap-0.5" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex h-10 items-center gap-2.5 px-2.5" style={{ opacity: 1 - i * 0.2 }}>
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="h-2.5 w-28" />
                <Skeleton className="h-2.5 flex-1" />
              </div>
            ))}
          </div>
        ) : !list.length ? (
          <EmptyState compact lit={2} title={t("merge.none")} description={t("merge.noneHint")} />
        ) : (
          list.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setTarget(c)}
              aria-pressed={target?.id === c.id}
              className={cn(
                "flex h-10 items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] active:scale-[0.995]",
                target?.id === c.id && "bg-active shadow-[inset_0_0_0_1px_var(--line-strong)]",
              )}
            >
              <Avatar name={c.name || c.email || "?"} src={c.avatar_url} size="xs" />
              <span className="min-w-0 truncate font-medium" data-ph-mask>
                {c.name || c.email}
              </span>
              <span className="mono min-w-0 flex-1 truncate text-xs text-fg-3" data-ph-mask>
                {c.name ? c.email : ""}
              </span>
              <span className="shrink-0 text-xs text-fg-3">{t("ticketCount", { count: c.ticket_count })}</span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
