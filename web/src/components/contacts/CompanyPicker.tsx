import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Picker } from "@/components/ui/picker";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { CompanyRef } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { atLeast, useRole } from "@/lib/session";
import { CompanyGlyph } from "./bits";
import { useDebounced } from "./hooks";
import { qk } from "@/lib/queries";

/** Pick a company with server-side search. `null` clears it. A name that matches no company can be created from the list and is picked at once. */
export function CompanyPicker({ value, onChange, id }: { value: CompanyRef | null; onChange: (c: CompanyRef | null) => void; id?: string }) {
  const { t: ui } = useTranslation("ui");
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const canCreate = atLeast(useRole(), "agent");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const term = useDebounced(query, 200);
  const { data, isFetching } = useQuery({
    queryKey: qk.of("companies", "pick", term),
    queryFn: () => api.companies.search({ q: term || undefined, limit: 12 }),
  });
  const rows = data?.data ?? [];
  // Offer to create only once the search for what was typed has answered, so an existing
  // company still loading is never created again.
  const searched = term === query && data !== undefined && !isFetching;
  const create = useMutation({
    mutationFn: (name: string) => api.companies.create({ name, domain: "", notes: "" }),
    onSuccess: (c) => {
      qc.setQueryData(qk.company(c.id), c);
      void qc.invalidateQueries({ queryKey: qk.companyLists });
      toast.success(t("toast.companyCreated"));
      setOpen(false);
      onChange({ id: c.id, name: c.name, domain: c.domain, avatar_url: c.avatar_url });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Picker
      open={open}
      onOpenChange={setOpen}
      items={[
        { value: "__none", label: "No company", icon: <span className="size-3.5" /> },
        ...rows.map((c) => ({ value: c.id, label: c.name, hint: c.domain, icon: <CompanyGlyph name={c.name} src={c.avatar_url} size="xs" /> })),
      ]}
      value={value?.id ?? "__none"}
      width={300}
      placeholder={ui("searchCompanies")}
      onQueryChange={setQuery}
      onSelect={(v) => {
        if (v === "__none") return onChange(null);
        const c = rows.find((r) => r.id === v);
        if (c) onChange({ id: c.id, name: c.name, domain: c.domain, avatar_url: c.avatar_url });
      }}
      onCreate={canCreate && searched && !create.isPending ? (name) => create.mutate(name) : undefined}
      createLabel={t("createCompany")}
      trigger={
        <button
          id={id}
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm shadow-[0_1px_1px_rgb(0_0_0/0.02)] hover:border-line-strong focus-visible:border-fg-3"
        >
          {value ? <CompanyGlyph name={value.name} src={value.avatar_url} size="xs" /> : <Building2 className="size-3.5 shrink-0 text-fg-3" />}
          <span className={cn("min-w-0 flex-1 truncate", !value && "text-fg-4")}>{value?.name ?? "No company"}</span>
          <ChevronDown className="size-3.5 text-fg-3" />
        </button>
      }
    />
  );
}
