// The actions of an http panel (contracts/integrations.md "Actions"): buttons the panel's own
// URL offers, which send a signed request back to it. A button may ask the agent to confirm, or
// to fill in a small form, first; what the URL answers shows as a toast and the panel follows it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { PanelAction, PanelActionResult } from "@/lib/api/types";
import { qk } from "@/lib/queries";

/** Which ticket and panel a block belongs to: without it (settings' preview) the buttons do nothing. */
export const PanelContext = createContext<{ ticketId: string; panelId: string } | null>(null);

export function ActionsBlock({ actions }: { actions: PanelAction[] }) {
  const { t } = useTranslation("inbox");
  const ctx = useContext(PanelContext);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<PanelAction | null>(null);
  const press = useMutation({
    mutationFn: ({ action, inputs }: { action: PanelAction; inputs?: Record<string, string> }) =>
      api.tickets.panelAction(ctx!.ticketId, ctx!.panelId, { action: action.id, inputs }),
    onSuccess: (r: PanelActionResult) => {
      if (r.data) qc.setQueryData(qk.ticketPanel(ctx!.ticketId, ctx!.panelId), r.data);
      // The timeline got an entry for it.
      void qc.invalidateQueries({ queryKey: qk.activities(ctx!.ticketId) });
      // A refusal keeps the form open with what the agent filled in, so they can correct it.
      if (r.ok) {
        toast.success(r.message);
        setForm(null);
      } else toast.error(r.message);
    },
    onError: (e) => toast.error(e, t("panels.actions.error")),
  });
  const run = (a: PanelAction, inputs?: Record<string, string>) => press.mutateAsync({ action: a, inputs }).then(() => undefined, () => undefined);
  const start = (a: PanelAction) => {
    if (a.inputs?.length) return setForm(a);
    if (a.confirm) {
      confirm.show(a.confirm, () => run(a), { title: a.label, confirmLabel: a.label, danger: a.tone === "danger" });
      return;
    }
    void run(a);
  };
  return (
    <>
      <div className="flex flex-wrap gap-1.5" data-testid="panel-actions">
        {actions.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={a.tone === "danger" ? "danger" : "secondary"}
            disabled={!ctx || press.isPending}
            loading={press.isPending && press.variables?.action.id === a.id && !form}
            onClick={() => start(a)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {form && <ActionForm action={form} pending={press.isPending} onClose={() => setForm(null)} onSubmit={(inputs) => void run(form, inputs)} />}
    </>
  );
}

/** The small form an action asks for, with its confirmation sentence above it. */
function ActionForm({ action, pending, onClose, onSubmit }: { action: PanelAction; pending: boolean; onClose: () => void; onSubmit: (inputs: Record<string, string>) => void }) {
  const { t } = useTranslation("inbox");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((action.inputs ?? []).map((i) => [i.name, i.default ?? ""])));
  const [error, setError] = useState("");
  const valid = (action.inputs ?? []).every((i) => !i.required || values[i.name]?.trim());
  const set = (name: string, v: string) => setValues((old) => ({ ...old, [name]: v }));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={action.label}
      description={action.confirm}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("panels.actions.cancel")}
          </Button>
          <Button variant={action.tone === "danger" ? "danger" : "primary"} disabled={!valid} loading={pending} onClick={() => (valid ? onSubmit(values) : setError(t("panels.actions.fill")))}>
            {action.label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {(action.inputs ?? []).map((i) => (
          <Field key={i.name} label={i.label} optional={!i.required}>
            {(props) =>
              i.type === "select" ? (
                <Select {...props} value={values[i.name] ?? ""} onChange={(v) => set(i.name, v)} options={i.options ?? []} placeholder={t("panels.actions.choose")} />
              ) : i.type === "textarea" ? (
                <Textarea {...props} rows={3} maxLength={i.max_length} placeholder={i.placeholder} value={values[i.name] ?? ""} onChange={(e) => set(i.name, e.target.value)} />
              ) : (
                <TextInput {...props} maxLength={i.max_length} placeholder={i.placeholder} value={values[i.name] ?? ""} onChange={(e) => set(i.name, e.target.value)} />
              )
            }
          </Field>
        ))}
        {error && <p className="text-[12px] text-danger-fg">{error}</p>}
      </div>
    </Dialog>
  );
}
