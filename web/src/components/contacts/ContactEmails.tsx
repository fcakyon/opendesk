// A contact's other email addresses (contracts/api.md "Contact emails"): mail from any of them
// lands on the contact. email on the contact is the primary; these sit beside it. Each change
// is saved at once, apart from the rest of the form.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Field, TextInput } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Contact } from "@/lib/api/types";
import { patchContact } from "./cache";

export function ContactEmails({ c }: { c: Contact }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const done = (updated: Contact, message: string) => {
    patchContact(qc, updated);
    setError(null);
    toast.success(message);
  };
  const add = useMutation({
    mutationFn: (value: string) => api.contacts.addEmail(c.id, value),
    onSuccess: (updated) => {
      setEmail("");
      done(updated, t("emails.added"));
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (value: string) => api.contacts.removeEmail(c.id, value),
    onSuccess: (updated) => done(updated, t("emails.removed")),
    onError: (e) => toast.error(e, t("emails.failed")),
  });
  const makePrimary = useMutation({
    mutationFn: (value: string) => api.contacts.makePrimaryEmail(c.id, value),
    onSuccess: (updated) => done(updated, t("emails.madePrimary")),
    onError: (e) => toast.error(e, t("emails.failed")),
  });

  return (
    <Field label={t("emails.label")} hint={t("emails.hint")} error={error}>
      {({ id }) => (
        <div className="flex flex-col gap-2">
          {c.emails.length > 0 && (
            <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line">
              {c.emails.map((value) => (
                <li key={value} className="flex min-h-9 items-center gap-2 py-1 pl-3 pr-1.5">
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px]" data-ph-mask>
                    {value}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={makePrimary.isPending && makePrimary.variables === value}
                    onClick={() =>
                      confirm.show(t("emails.primaryBody", { email: value, old: c.email ?? "" }), () => makePrimary.mutateAsync(value), {
                        title: t("emails.primaryTitle"),
                        confirmLabel: t("emails.makePrimary"),
                      })
                    }
                  >
                    {t("emails.makePrimary")}
                  </Button>
                  <Tooltip content={t("emails.remove")}>
                    <Button size="xs" variant="ghost" square aria-label={t("emails.removeLabel", { email: value })} onClick={() => remove.mutate(value)}>
                      <X />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <TextInput
              id={id}
              type="email"
              className="mono"
              placeholder={t("emails.placeholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds the address here, not the whole form.
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (email.trim()) add.mutate(email.trim());
                }
              }}
            />
            <Button icon={<Plus />} loading={add.isPending} disabled={!email.trim()} onClick={() => add.mutate(email.trim())}>
              {t("emails.add")}
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
}
