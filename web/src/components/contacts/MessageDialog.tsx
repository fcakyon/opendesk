// One message to many customers (contracts/api.md "Messages to many customers"): the people
// ticked on the People list, one subject and body filled for each, from one address, as one ticket
// for each with a shared label. It shows who it reaches before anything goes, previews the email
// the way a customer gets it, and sends a test to the sender first.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { EmailPreview } from "@/components/templates/EmailPreview";
import { TemplateEditor } from "@/components/templates/TemplateEditor";
import { useTeamsCtx } from "@/components/tickets/teams";
import { errorMessage } from "@/lib/api/client";
import type { ContactBulkQuery, DirectoryBulkTarget } from "@/lib/api/endpoints";
import { api } from "@/lib/api/endpoints";
import type { ContactMessage, TemplateProblem } from "@/lib/api/types";
import { q, qk } from "@/lib/queries";

type Status = ContactMessage["status"];

/** A label for a message, from its subject: short, letters and numbers. */
export function labelFor(subject: string): string {
  return subject.replace(/[^\p{L}\p{N} _\-./:&+#]/gu, "").replace(/\s+/g, " ").trim().slice(0, 50);
}

export function MessageDialog({
  open,
  onOpenChange,
  target,
  onSent,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: DirectoryBulkTarget<ContactBulkQuery>;
  onSent: () => void;
}) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const teams = useTeamsCtx();
  const confirm = useConfirm();
  const { data: mailboxes } = useQuery(q.mailboxes());
  const from = (mailboxes ?? []).filter((m) => m.status !== "disabled" && m.sending !== "system_off" && teams.canSendFrom(m));
  const [mailbox, setMailbox] = useState<string | undefined>(undefined);
  const [subject, setSubject] = useState("");
  const [label, setLabel] = useState("");
  const [labelTouched, setLabelTouched] = useState(false);
  const [status, setStatus] = useState<Status>("solved");
  const [html, setHtml] = useState("");
  const [problems, setProblems] = useState<TemplateProblem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const chosen = mailbox && from.some((m) => m.id === mailbox) ? mailbox : (from.find((m) => m.status === "active") ?? from[0])?.id;
  useEffect(() => {
    if (!labelTouched) setLabel(labelFor(subject));
  }, [subject, labelTouched]);

  // Who it reaches, counted by the server for exactly this selection.
  const key = JSON.stringify(target);
  const reach = useQuery({ queryKey: qk.of("contact-message-reach", key), queryFn: () => api.contacts.messagePreview(target), enabled: open, retry: false });
  const noEmail = reach.data?.skipped.no_email ?? 0;
  const blocked = reach.data?.skipped.blocked ?? 0;
  const skipped = noEmail + blocked;
  // Only the reasons that apply: "1 without an email address, 2 blocked".
  const leftOut = [noEmail > 0 && t("message.noEmail", { count: noEmail }), blocked > 0 && t("message.blockedCount", { count: blocked })].filter(Boolean).join(", ");

  // The editor gives "" while nothing is written; the server checks the body again.
  const empty = !html.trim();
  const ready = !!chosen && !!subject.trim() && !empty && !!label.trim() && (reach.data?.reaches ?? 0) > 0;
  const previewBody = useMemo(() => ({ kind: "notice" as const, subject, body_html: html, mailbox_id: chosen }), [subject, html, chosen]);

  const send = useMutation({
    mutationFn: () => api.contacts.sendMessage({ ...target, mailbox_id: chosen!, subject: subject.trim(), body_html: html, label: label.trim(), status }),
    onSuccess: (m) => {
      qc.setQueryData<ContactMessage[]>(qk.contactMessages, (old) => [m, ...(old ?? []).filter((x) => x.id !== m.id)]);
      toast.success(t("message.started", { count: m.total }));
      onOpenChange(false);
      onSent();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const reset = useRef(() => {});
  reset.current = () => {
    setSubject("");
    setHtml("");
    setLabelTouched(false);
    setStatus("solved");
    setError(null);
  };
  useEffect(() => {
    if (!open) reset.current();
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={t("message.title")}
      description={t("message.description")}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <p className="text-xs text-fg-3" role="status">
            {reach.isPending ? (
              <Skeleton className="h-3 w-48" />
            ) : reach.isError ? (
              errorMessage(reach.error)
            ) : (
              <>
                {t("message.reaches", { count: reach.data.reaches })}
                {skipped > 0 && <> {t("message.leftOut", { list: leftOut })}</>}
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("message.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<Send className="size-3.5" />}
              loading={send.isPending}
              disabled={!ready}
              onClick={() => {
                const count = reach.data?.reaches ?? 0;
                confirm.show(t("message.confirmBody", { count }), () => send.mutateAsync(), {
                  title: t("message.confirmTitle", { count }),
                  confirmLabel: t("message.send", { count }),
                });
              }}
            >
              {t("message.send", { count: reach.data?.reaches ?? 0 })}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          {from.length === 0 ? (
            <div className="flex items-start gap-2 rounded-md bg-sunken px-3 py-2.5 text-[12.5px] text-fg-2" role="alert">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-tone-amber" aria-hidden />
              {t("message.noAddress")}
            </div>
          ) : (
            <Field label={t("message.from")}>
              {(f) => <Select id={f.id} value={chosen} onChange={setMailbox} options={from.map((m) => ({ value: m.id, label: m.email, hint: m.name !== m.email ? m.name : undefined }))} />}
            </Field>
          )}
          <Field label={t("message.subject")} hint={t("message.subjectHint")}>
            {(f) => <TextInput {...f} value={subject} maxLength={500} onChange={(e) => setSubject(e.target.value)} placeholder={t("message.subjectPlaceholder")} autoFocus />}
          </Field>
          <Field label={t("message.body")}>
            {() => <TemplateEditor value={html} onChange={setHtml} kind="reply" ariaLabel={t("message.body")} placeholder={t("message.bodyPlaceholder")} minHeight={130} framed problems={problems} />}
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label={t("message.label")} hint={t("message.labelHint")}>
              {(f) => (
                <TextInput
                  {...f}
                  value={label}
                  maxLength={50}
                  onChange={(e) => {
                    setLabelTouched(true);
                    setLabel(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t("message.status")}>
              {() => (
                <Segmented
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: "solved", label: t("message.statusSolved") },
                    { value: "pending", label: t("message.statusPending") },
                    { value: "open", label: t("message.statusOpen") },
                  ]}
                />
              )}
            </Field>
          </div>
          <p className="text-xs leading-[18px] text-fg-3">{t(`message.statusHint.${status}`)}</p>
          {error && (
            <p className="text-[12.5px] text-tone-red" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <EmailPreview body={previewBody} onProblems={setProblems} height={360} title={t("message.preview")} />
        </div>
      </div>
    </Dialog>
  );
}
