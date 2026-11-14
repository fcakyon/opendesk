// Adding a ticket inbox from the sidebar, in place (app/quickAdd): a new address through the
// same steps as Settings › Mailboxes (address, how mail arrives, team and brand), or a Collab
// mail account the caller connected, handed over (contracts/collab.md "Using an account for
// tickets"). Then how it answers (auto-reply, signature, Ollie) and where it shows: its own
// sidebar section, opened. Admins only; anyone else is asked to find one.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AddMailboxWizard } from "@/components/mailboxes/AddMailboxWizard";
import { MailboxBrandField, MailboxTeamField } from "@/components/mailboxes/addressing";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useAI } from "@/lib/ai";
import { errorMessage } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { MailAccount, Mailbox } from "@/lib/api/types";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { escapeHtml } from "@/lib/collab/html";
import { setInboxSection } from "@/lib/collab/inboxSections";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { quickAdd, type InboxStart } from "@/app/quickAdd";

type Stage = { kind: "connect" } | { kind: "account"; account: MailAccount } | { kind: "replies"; mailbox: Mailbox; handedOver: boolean };

/** Plain lines as the paragraphs settings HTML takes. */
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

export function AddInboxDialog({ start }: { start: InboxStart }) {
  const { t } = useTranslation("inbox");
  const role = useRole();
  const close = () => quickAdd.inbox(null);
  const { data: accounts } = useQuery({ ...q.mailAccounts(), enabled: !!start.accountId });
  const account = start.accountId ? accounts?.find((a) => a.id === start.accountId) : undefined;
  const [stage, setStage] = useState<Stage | null>(null);
  const now: Stage | null = stage ?? (start.accountId ? (account ? { kind: "account", account } : null) : { kind: "connect" });
  const admin = atLeast(role, "admin");

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      size={now?.kind === "connect" ? "lg" : "md"}
      title={now?.kind === "replies" ? t("inboxes.dialog.repliesTitle", { name: now.mailbox.name }) : account ? t("inboxes.dialog.fromAccountTitle") : t("inboxes.dialog.title")}
      description={!admin ? undefined : now?.kind === "connect" ? t("inboxes.dialog.description") : now?.kind === "account" ? t("inboxes.dialog.fromAccountDescription", { email: now.account.email }) : undefined}
    >
      {!admin ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">{t("inboxes.dialog.askAdmin")}</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              {t("inboxes.dialog.ok")}
            </Button>
          </div>
        </div>
      ) : now?.kind === "connect" ? (
        <AddMailboxWizard compact onCancel={close} onDone={(m) => (m ? setStage({ kind: "replies", mailbox: m, handedOver: false }) : close())} />
      ) : now?.kind === "account" ? (
        <FromAccount account={now.account} onCancel={close} onDone={(m) => setStage({ kind: "replies", mailbox: m, handedOver: true })} />
      ) : now?.kind === "replies" ? (
        <Replies mailbox={now.mailbox} handedOver={now.handedOver} onDone={close} />
      ) : (
        <p className="text-sm text-fg-3">{t("inboxes.dialog.loading")}</p>
      )}
    </Dialog>
  );
}

/** A Collab account the caller connected, handed over: its name, team and brand, and whether it stays in Mail. */
function FromAccount({ account, onCancel, onDone }: { account: MailAccount; onCancel: () => void; onDone: (m: Mailbox) => void }) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const [name, setName] = useState(account.name.includes("@") ? "" : account.name);
  const [team, setTeam] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const hand = useMutation({
    mutationFn: async () => {
      const r = await api.collab.accounts.useForTickets(account.id, { name: name.trim() || undefined, team_id: team, brand_id: brand, keep_account: keep });
      const m = await api.mailboxes.get(r.mailbox_id);
      return m;
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: qk.mailboxes });
      void qc.invalidateQueries({ queryKey: qk.mailAccounts });
      onDone(m);
    },
    onError: (e) => toast.error(e, t("inboxes.dialog.failed")),
  });
  return (
    <div className="flex flex-col gap-4">
      <Field label={t("inboxes.dialog.name")} hint={t("inboxes.dialog.nameHint")}>
        {({ id }) => <TextInput id={id} autoFocus value={name} placeholder={t("inboxes.dialog.namePlaceholder")} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("inboxes.dialog.team")}>{() => <MailboxTeamField className="w-full" value={team} onChange={setTeam} />}</Field>
        <Field label={t("inboxes.dialog.brand")}>{() => <MailboxBrandField className="w-full" value={brand} onChange={setBrand} />}</Field>
      </div>
      <label className="flex items-start justify-between gap-4 rounded-md border border-line px-3 py-2.5">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-fg">{t("inboxes.dialog.keep")}</span>
          <span className="text-xs text-fg-3">{keep ? t("inboxes.dialog.keepOn") : t("inboxes.dialog.keepOff")}</span>
        </span>
        <Switch checked={keep} onCheckedChange={setKeep} aria-label={t("inboxes.dialog.keep")} />
      </label>
      <p className="text-xs text-fg-3">{t("inboxes.dialog.fromNow")}</p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={hand.isPending}>
          {t("inboxes.dialog.cancel")}
        </Button>
        <Button variant="primary" loading={hand.isPending} onClick={() => hand.mutate()} iconRight={<ArrowRight className="size-3.5" />}>
          {t("inboxes.dialog.useForTickets")}
        </Button>
      </div>
    </div>
  );
}

/** How the new inbox answers, and its own section in the sidebar; then it opens. */
function Replies({ mailbox, handedOver, onDone }: { mailbox: Mailbox; handedOver: boolean; onDone: () => void }) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ai = useAI();
  const prefs = useSidebarPrefs();
  const savePrefs = useSaveSidebarPrefs();
  const [autoReply, setAutoReply] = useState(mailbox.auto_reply_enabled);
  const [subject, setSubject] = useState(mailbox.auto_reply_subject || t("inboxes.dialog.autoReplySubjectDefault"));
  const [message, setMessage] = useState(t("inboxes.dialog.autoReplyDefault"));
  const [signature, setSignature] = useState("");
  const [ollie, setOllie] = useState(mailbox.ai_answers);
  const [section, setSection] = useState(true);
  const finish = useMutation({
    mutationFn: async () => {
      const patch: Parameters<typeof api.mailboxes.update>[1] = {};
      if (autoReply !== mailbox.auto_reply_enabled) patch.auto_reply_enabled = autoReply;
      if (autoReply) {
        patch.auto_reply_subject = subject.trim();
        patch.auto_reply_html = paragraphs(message);
      }
      if (signature.trim()) patch.signature_html = paragraphs(signature);
      if (ai.enabled && ollie !== mailbox.ai_answers) patch.ai_answers = ollie;
      if (Object.keys(patch).length) await api.mailboxes.update(mailbox.id, patch);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.mailboxes });
      if (section) savePrefs.mutate(setInboxSection(prefs, { kind: "mailbox", id: mailbox.id }, true));
      onDone();
      toast.success(t("inboxes.dialog.ready", { name: mailbox.name }));
      void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "unassigned", ticketId: undefined }, search: { mailbox: mailbox.id } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="flex flex-col gap-4">
      {handedOver && <p className="rounded-md bg-sunken px-3 py-2 text-xs text-fg-2">{t("inboxes.dialog.handedOver", { email: mailbox.email })}</p>}
      <Toggle label={t("inboxes.dialog.autoReply")} hint={t("inboxes.dialog.autoReplyHint")} checked={autoReply} onChange={setAutoReply} />
      {autoReply && (
        <div className="-mt-2 flex flex-col gap-3 border-l-2 border-line pl-3">
          <Field label={t("inboxes.dialog.autoReplySubject")}>{({ id }) => <TextInput id={id} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
          <Field label={t("inboxes.dialog.autoReplyMessage")}>{({ id }) => <Textarea id={id} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
        </div>
      )}
      <Field label={t("inboxes.dialog.signature")} hint={t("inboxes.dialog.signatureHint")} optional>
        {({ id }) => <Textarea id={id} rows={2} value={signature} placeholder={t("inboxes.dialog.signaturePlaceholder")} onChange={(e) => setSignature(e.target.value)} />}
      </Field>
      {ai.enabled && <Toggle label={t("inboxes.dialog.ollie")} hint={t("inboxes.dialog.ollieHint")} checked={ollie} onChange={setOllie} />}
      <Toggle label={t("inboxes.dialog.section")} hint={t("inboxes.dialog.sectionHint")} checked={section} onChange={setSection} />
      <div className="flex items-center justify-end gap-2">
        <Button variant="primary" loading={finish.isPending} onClick={() => finish.mutate()}>
          {t("inboxes.dialog.open")}
        </Button>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <span className="text-xs text-fg-3">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
