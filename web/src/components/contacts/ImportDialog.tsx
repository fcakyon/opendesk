// Adds people from a CSV file: drop the file, say which column holds what and how to treat
// someone who is already there, then watch the run. The server reads the file once on upload
// and guesses the columns from their headers; a job adds the people in chunks while the list
// stays usable (contracts/imports.md "Contacts").

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileSpreadsheet, X, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CsvDrop } from "@/components/imports/Csv";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useRecordFields } from "@/components/contacts/LabelsAndFields";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { ContactImport, ContactImportMapping, ContactImportMatch, ContactImportOnMatch, ContactImportUpload } from "@/lib/api/types";
import { number } from "@/lib/format";
import { qk } from "@/lib/queries";

const NONE = "__none";

type BuiltIn = "name" | "email" | "phone" | "company" | "external_id" | "notes" | "labels";
const FIELDS: BuiltIn[] = ["email", "name", "phone", "company", "external_id", "notes", "labels"];

/** The mapping a person can start: a name or an email, and the key that finds who is already there. */
export function mappingProblem(m: ContactImportMapping, match: ContactImportMatch): "identity" | "email" | "external_id" | null {
  if (!m.email && !m.name) return "identity";
  if (match === "email" && !m.email) return "email";
  if (match === "external_id" && !m.external_id) return "external_id";
  return null;
}

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // The dialog starts over each time it opens.
  return open ? <Inner onClose={() => onOpenChange(false)} /> : null;
}

function Inner({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("contacts");
  const { data: defs } = useRecordFields("contact");
  const [upload, setUpload] = useState<ContactImportUpload | null>(null);
  const [mapping, setMapping] = useState<ContactImportMapping>({});
  const [match, setMatch] = useState<ContactImportMatch>("email");
  const [onMatch, setOnMatch] = useState<ContactImportOnMatch>("skip");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<File | null>(null);
  const [started, setStarted] = useState<ContactImport | null>(null);

  const send = useMutation({
    mutationFn: (f: File) => api.contacts.importUpload(f),
    onMutate: (f) => {
      setError(null);
      setUploading(f);
    },
    onSuccess: (u) => {
      setUpload(u);
      setMapping(u.suggested);
      setMatch(u.suggested.email ? "email" : u.suggested.external_id ? "external_id" : "email");
    },
    onError: (e) => setError(errorMessage(e)),
    onSettled: () => setUploading(null),
  });

  const start = useMutation({
    mutationFn: () => api.contacts.importStart({ upload_id: upload!.upload_id, mapping, match_on: match, on_match: onMatch }),
    onSuccess: setStarted,
    onError: (e) => setError(errorMessage(e)),
  });

  const problem = mappingProblem(mapping, match);
  const title = started ? t("import.runningTitle") : t("import.title");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={title}
      description={started ? undefined : t("import.body")}
      footer={
        started ? (
          <Button variant="primary" onClick={onClose}>
            {t("import.close")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            {upload && (
              <Button variant="primary" disabled={!!problem} loading={start.isPending} onClick={() => start.mutate()}>
                {t("import.start", { count: upload.rows })}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4 px-5 pb-4 pt-1">
        {started ? (
          <Progress id={started.id} first={started} />
        ) : !upload ? (
          <CsvDrop template={false} hint={t("import.dropHint")} onFile={(f) => send.mutate(f)} uploading={uploading} error={error} />
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-xs">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-fg-3">
                <FileSpreadsheet className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-fg">{upload.filename}</div>
                <div className="text-[12px] text-fg-3">{t("import.summary", { rows: number(upload.rows), columns: upload.columns.length })}</div>
              </div>
              <Button size="xs" variant="ghost" icon={<X />} onClick={() => setUpload(null)}>
                {t("import.replace")}
              </Button>
            </div>
            <Mapping upload={upload} mapping={mapping} onChange={setMapping} fields={(defs ?? []).filter((f) => f.type !== "user")} />
            <Matching match={match} onMatch={setMatch} onMatchAction={onMatch} onAction={setOnMatch} />
            {problem && (
              <p role="alert" className="text-[12px] text-danger-fg">
                {t(`import.problem.${problem}`)}
              </p>
            )}
            {error && (
              <p role="alert" className="text-[12px] text-danger-fg">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Mapping({
  upload,
  mapping,
  onChange,
  fields,
}: {
  upload: ContactImportUpload;
  mapping: ContactImportMapping;
  onChange: (m: ContactImportMapping) => void;
  fields: { key: string; name: string }[];
}) {
  const { t } = useTranslation("contacts");
  const options = [{ value: NONE, label: t("import.notInFile") }, ...upload.columns.map((c) => ({ value: c.name, label: c.name }))];
  const samplesOf = (name?: string) => upload.columns.find((c) => c.name === name)?.samples ?? [];
  const row = (key: string, label: string, hint: string | null, col: string | undefined, set: (v: string | undefined) => void) => {
    const samples = samplesOf(col);
    return (
      <div key={key} className="flex flex-col gap-2 border-b border-line-soft px-4 py-2.5 last:border-0 md:flex-row md:items-center">
        <div className="min-w-0 md:w-[200px] md:shrink-0">
          <div className="text-[12.5px] font-medium text-fg">{label}</div>
          {hint && <div className="text-[11.5px] leading-4 text-fg-3">{hint}</div>}
        </div>
        <div className="md:w-[200px] md:shrink-0">
          <Select size="sm" aria-label={label} value={col ?? NONE} onChange={(v) => set(v === NONE ? undefined : v)} options={options} />
        </div>
        <div className="mono min-w-0 flex-1 truncate text-[11px] text-fg-4">{samples.length ? samples.join("  ·  ") : col ? t("import.emptyColumn") : ""}</div>
      </div>
    );
  };
  return (
    <div className="max-h-[300px] overflow-y-auto rounded-lg border border-line bg-surface shadow-xs">
      {FIELDS.map((f) =>
        row(f, t(`import.fields.${f}.label`), t(`import.fields.${f}.hint`), mapping[f], (v) => {
          const next = { ...mapping };
          if (v === undefined) delete next[f];
          else next[f] = v;
          onChange(next);
        }),
      )}
      {fields.map((f) =>
        row(`field:${f.key}`, f.name, t("import.customField"), mapping.fields?.[f.key], (v) => {
          const next = { ...(mapping.fields ?? {}) };
          if (v === undefined) delete next[f.key];
          else next[f.key] = v;
          onChange({ ...mapping, fields: next });
        }),
      )}
    </div>
  );
}

function Matching({
  match,
  onMatch,
  onMatchAction,
  onAction,
}: {
  match: ContactImportMatch;
  onMatch: (m: ContactImportMatch) => void;
  onMatchAction: ContactImportOnMatch;
  onAction: (a: ContactImportOnMatch) => void;
}) {
  const { t } = useTranslation("contacts");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-fg">{t("import.matchOn")}</span>
        <Select
          aria-label={t("import.matchOn")}
          value={match}
          onChange={onMatch}
          options={[
            { value: "email", label: t("import.matchEmail") },
            { value: "external_id", label: t("import.matchExternal") },
          ]}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-fg">{t("import.onMatch")}</span>
        <Select
          aria-label={t("import.onMatch")}
          value={onMatchAction}
          onChange={onAction}
          options={[
            { value: "skip", label: t("import.skip") },
            { value: "fill", label: t("import.fill") },
            { value: "overwrite", label: t("import.overwrite") },
          ]}
        />
        <span className="text-[11.5px] leading-4 text-fg-3">{t(`import.${onMatchAction}Hint`)}</span>
      </label>
    </div>
  );
}

function Progress({ id, first }: { id: string; first: ContactImport }) {
  const { t } = useTranslation("contacts");
  // Progress arrives as events; the read is the start and the way back after a gap.
  const { data } = useQuery({
    queryKey: qk.of("contacts", "import", id),
    queryFn: () => api.contacts.importGet(id),
    initialData: first,
    staleTime: Infinity,
  });
  const x = data;
  const cancel = useMutation({ mutationFn: () => api.contacts.importCancel(id), onError: (e) => toast.error(e, t("import.cancelFailed")) });
  const pct = x.total > 0 ? Math.min(100, Math.round((x.processed / x.total) * 100)) : 100;
  const running = x.status === "running";
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-center gap-2 text-[13px] text-fg">
        {x.status === "done" && <CheckCircle2 className="size-4 text-ok-fg" aria-hidden />}
        {(x.status === "failed" || x.status === "cancelled") && <XCircle className="size-4 text-danger-fg" aria-hidden />}
        <span className="font-medium">{t(`import.status.${x.status}`)}</span>
        <span className="text-fg-3">{t("import.of", { done: number(x.processed), total: number(x.total) })}</span>
        {running && (
          <Button size="xs" variant="ghost" className="ml-auto" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            {t("import.stop")}
          </Button>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-fg transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <dl className="grid grid-cols-4 gap-2 text-center">
        {(["created", "updated", "skipped", "failed"] as const).map((k) => (
          <div key={k} className="rounded-lg border border-line bg-surface px-2 py-2.5">
            <dd className="text-[16px] font-semibold tabular-nums text-fg">{number(x[k])}</dd>
            <dt className="text-[11.5px] text-fg-3">{t(`import.count.${k}`)}</dt>
          </div>
        ))}
      </dl>
      {x.error && (
        <p role="alert" className="text-[12px] text-danger-fg">
          {x.error}
        </p>
      )}
      {x.errors.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[12.5px] font-medium text-fg">{t("import.rowErrors", { count: x.failed })}</div>
          <ul className="max-h-[160px] overflow-y-auto rounded-lg border border-line bg-surface text-[12px]">
            {x.errors.map((e) => (
              <li key={e.line} className="flex gap-3 border-b border-line-soft px-3 py-1.5 last:border-0">
                <span className="mono w-[64px] shrink-0 text-fg-4">{t("import.line", { line: e.line })}</span>
                <span className="min-w-0 text-fg-2">{e.message}</span>
              </li>
            ))}
          </ul>
          {x.failed > x.errors.length && <div className="text-[11.5px] text-fg-3">{t("import.moreErrors", { count: x.failed - x.errors.length })}</div>}
        </div>
      )}
    </div>
  );
}
