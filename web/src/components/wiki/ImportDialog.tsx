// Importing pages into the wiki (contracts/wiki.md "Import and export"): files dropped or
// picked (a zip, or Markdown, HTML, CSV and text files), where they land (under the page it
// was opened from, or the top of a space), an upload with its progress, then what came in and
// what was left out, grouped by reason. One dialog for the app, opened with openImport (app/quickAdd) from
// the sidebars' "+" and new-page popup, files dropped on the main sidebar's Pages, the wiki's
// home and a page's menu. The new pages arrive in the tree by
// their events; the tree is fetched again too, in case the socket missed some.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, CircleCheck, FileArchive, FileText, UploadCloud, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { quickAdd, useQuickAdd, type ImportStart } from "@/app/quickAdd";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select, type SelectOption } from "@/components/ui/select";
import { TeamDot } from "@/components/tickets/teams";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import type { WikiImportResult, WikiImportTarget } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { bytes } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { groupSkipped, IMPORT_ACCEPT, importable, MAX_IMPORT_BYTES, SKIP_REASONS, type SkipGroup } from "@/lib/wiki/port";
import { ancestorsOf, spaceBody, type SpaceKey } from "@/lib/wiki/tree";
import { areaOf, pageTo, useDefaultArea } from "@/lib/wiki/area";
import { useExpanded, useTitle, useWikiTree } from "./hooks";
import { PageIcon } from "./PageTree";

const GUIDE = "https://docs.opendesk.sh/guides/wiki-import-export/";

/** The app's one import dialog (openImport in app/quickAdd); each opening starts afresh. */
export function ImportDialogHost() {
  const importing = useQuickAdd((s) => s.importing);
  const nonce = useQuickAdd((s) => s.importNonce);
  return <ImportDialog key={nonce} open={!!importing} start={importing ?? { parentId: null, files: [] }} onClose={quickAdd.closeImport} />;
}

type Step = { kind: "pick" } | { kind: "sending"; progress: number } | { kind: "done"; result: WikiImportResult };

/** The API's own message for a refused import ("Too many imports", "wiki_full"'s counts), else a plain one. */
function importError(e: unknown, fallback: string): string {
  if (isApiError(e) && e.detail && e.code !== "network_error") return e.detail;
  return errorMessage(e, fallback);
}

function ImportDialog({ open, start: from, onClose }: { open: boolean; start: ImportStart; onClose: () => void }) {
  const { parentId } = from;
  const { t } = useTranslation("wiki");
  const { t: ui } = useTranslation("ui");
  const title = useTitle();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { tree } = useWikiTree();
  const { data: teams = [] } = useQuery(q.teams());
  const me = useSession((s) => s.user?.id);
  const { open: expand } = useExpanded();
  const parent = parentId ? tree.byId.get(parentId) : undefined;
  const area = useDefaultArea(from.area);
  // Pages can't be imported into a database.
  const under = parent && parent.kind !== "database" ? parent : undefined;

  const [files, setFiles] = useState<File[]>(() => from.files.filter((f) => importable(f.name)));
  const [problem, setProblem] = useState<string | null>(() => {
    const refused = from.files.find((f) => !importable(f.name));
    return refused ? t("import.wrongType", { name: refused.name }) : null;
  });
  const [target, setTarget] = useState<string>(under ? `page:${under.id}` : (from.space ?? "workspace"));
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const abort = useRef<AbortController | null>(null);

  const total = files.reduce((n, f) => n + f.size, 0);
  const over = total > MAX_IMPORT_BYTES;

  const places = useMemo<SelectOption<string>[]>(
    () => [
      ...(under ? [{ value: `page:${under.id}`, label: t("import.under", { title: title(under.title) }), icon: <PageIcon icon={under.icon} kind={under.kind} /> }] : []),
      { value: "workspace", label: t("import.topOf", { space: t("sidebar.workspace") }) },
      ...teams
        .filter((team) => !team.private || (!!me && team.member_ids.includes(me)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((team) => ({ value: `team:${team.id}`, label: t("import.topOf", { space: team.name }), icon: <TeamDot team={team} /> })),
      ...(me ? [{ value: "private", label: t("import.topOf", { space: t("sidebar.private") }) }] : []),
    ],
    [under, teams, me, t, title],
  );

  const add = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    const refused = picked.find((f) => !importable(f.name));
    const fresh = picked.filter((f) => importable(f.name) && !files.some((x) => x.name === f.name && x.size === f.size));
    const next = [...files, ...fresh];
    setFiles(next);
    setProblem(refused ? t("import.wrongType", { name: refused.name }) : null);
  };

  const start = async () => {
    const to: WikiImportTarget = target.startsWith("page:") ? { parent_id: target.slice(5) } : { ...spaceBody(target as SpaceKey), area };
    const ctl = new AbortController();
    abort.current = ctl;
    setProblem(null);
    setStep({ kind: "sending", progress: 0 });
    try {
      const result = await api.wiki.importPages(files, to, (progress) => setStep((s) => (s.kind === "sending" ? { kind: "sending", progress } : s)), ctl.signal);
      void qc.invalidateQueries({ queryKey: qk.wikiTree });
      if ("parent_id" in to) expand([...ancestorsOf(tree, to.parent_id).map((a) => a.id), to.parent_id]);
      setStep({ kind: "done", result });
    } catch (e) {
      setStep({ kind: "pick" });
      if ((e as Error)?.name !== "AbortError") setProblem(importError(e, t("import.failed")));
    } finally {
      abort.current = null;
    }
  };

  const close = () => {
    // An upload still going out stops; one the API is already reading finishes, and its pages arrive.
    if (step.kind === "sending" && step.progress < 1) abort.current?.abort();
    onClose();
  };

  const openFirst = (id: string) => {
    close();
    void navigate(pageTo({ id, area: under ? areaOf(under) : area }));
  };

  const footer =
    step.kind === "done" ? (
      <>
        <Button
          variant="ghost"
          className="mr-auto"
          onClick={() => {
            setFiles([]);
            setStep({ kind: "pick" });
          }}
        >
          {t("import.more")}
        </Button>
        <Button onClick={close}>{t("import.close")}</Button>
        {step.result.root_ids[0] && (
          <Button variant="primary" icon={<ArrowUpRight />} onClick={() => openFirst(step.result.root_ids[0])}>
            {t("import.open")}
          </Button>
        )}
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={close}>
          {step.kind === "sending" && step.progress < 1 ? t("import.cancelUpload") : ui("cancel")}
        </Button>
        <Button variant="primary" disabled={!files.length || over} loading={step.kind === "sending"} onClick={() => void start()}>
          {t("import.start")}
        </Button>
      </>
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={t("import.title")} description={step.kind === "done" ? undefined : t("import.description")} footer={footer}>
      {step.kind === "done" ? (
        <Result result={step.result} />
      ) : step.kind === "sending" ? (
        <Sending files={files} progress={step.progress} />
      ) : (
        <div className="flex flex-col gap-4 pb-1">
          <Drop onFiles={add} invalid={!!problem || over} />
          {files.length > 0 && (
            <FileList
              files={files}
              total={total}
              onRemove={(f) => {
                setFiles(files.filter((x) => x !== f));
                setProblem(null);
              }}
              onClear={() => {
                setFiles([]);
                setProblem(null);
              }}
            />
          )}
          {(problem || over) && (
            <p role="alert" className="animate-rise-in text-[12px] leading-[18px] text-danger-fg motion-reduce:animate-none">
              {problem ?? t("import.tooLarge")}
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2">{t("import.where")}</span>
            <Select value={target} onChange={setTarget} options={places} aria-label={t("import.where")} />
          </label>
          <Sources />
        </div>
      )}
    </Dialog>
  );
}

/** A drop area for files, which also opens the file picker; the new page popup has a compact one. */
export function Drop({ onFiles, invalid, compact }: { onFiles: (list: FileList | null) => void; invalid: boolean; compact?: boolean }) {
  const { t } = useTranslation("wiki");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_3px_var(--focus)] motion-reduce:transition-none",
          compact ? "min-h-[96px] px-5 py-4" : "min-h-[148px] px-6 py-7",
          over ? "border-fg-3 bg-hover" : "border-line-strong bg-surface hover:border-fg-4 hover:bg-canvas",
          invalid && !over && "border-[color-mix(in_srgb,var(--danger)_40%,var(--line))]",
        )}
      >
        <span className={cn("flex items-center justify-center rounded-lg bg-hover text-fg-3", compact ? "size-8" : "size-10")}>
          <UploadCloud className={compact ? "size-4" : "size-5"} aria-hidden />
        </span>
        <span className="text-[13px] font-medium text-fg">{over ? t("import.dropNow") : t("import.drop")}</span>
        <span className="max-w-[420px] text-[12px] leading-[18px] text-fg-3">{t("import.dropHint")}</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={IMPORT_ACCEPT}
        className="hidden"
        data-testid="wiki-import-input"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

const isZip = (f: File) => f.name.toLowerCase().endsWith(".zip");

function FileList({ files, total, onRemove, onClear }: { files: File[]; total: number; onRemove: (f: File) => void; onClear: () => void }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul className="max-h-[168px] divide-y divide-line-soft overflow-y-auto">
        {files.map((f) => (
          <li key={`${f.name}:${f.size}`} className="flex h-9 items-center gap-2.5 pl-3 pr-1.5 animate-rise-in motion-reduce:animate-none">
            {isZip(f) ? <FileArchive className="size-3.5 shrink-0 text-fg-3" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-fg-3" aria-hidden />}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{f.name}</span>
            <span className="mono shrink-0 text-[11px] tabular-nums text-fg-4">{bytes(f.size)}</span>
            <Button square size="xs" variant="ghost" aria-label={t("import.remove", { name: f.name })} onClick={() => onRemove(f)}>
              <X />
            </Button>
          </li>
        ))}
      </ul>
      {files.length > 1 && (
        <div className="flex h-8 items-center justify-between border-t border-line bg-sunken pl-3 pr-1.5 text-[11.5px] text-fg-3">
          <span className="mono tabular-nums">{bytes(total)}</span>
          <Button size="xs" variant="ghost" onClick={onClear}>
            {t("import.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Sources() {
  const { t } = useTranslation("wiki");
  const rows = (["notion", "obsidian", "html", "files"] as const).map((k) => ({ k, name: t(`import.sources.${k}.name`), body: t(`import.sources.${k}.body`) }));
  return (
    <section className="rounded-lg bg-sunken px-3.5 py-3">
      <h3 className="label-caps mb-1.5">{t("import.sources.title")}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.k} className="text-[12px] leading-[18px] text-fg-3">
            <span className="font-medium text-fg-2">{r.name}:</span> {r.body}
          </li>
        ))}
      </ul>
      <a href={GUIDE} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] text-fg-2 underline-offset-2 hover:text-fg hover:underline">
        {t("import.guide")}
        <ArrowUpRight className="size-3" aria-hidden />
      </a>
    </section>
  );
}

function Sending({ files, progress }: { files: File[]; progress: number }) {
  const { t } = useTranslation("wiki");
  const sent = progress >= 1;
  const percent = Math.round(progress * 100);
  return (
    <div className="flex flex-col gap-3 py-6 animate-rise-in motion-reduce:animate-none">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="font-medium text-fg" aria-live="polite">
          {sent ? t("import.making") : t("import.uploading", { percent })}
        </span>
        <span className="mono shrink-0 text-[11px] tabular-nums text-fg-4">{bytes(files.reduce((n, f) => n + f.size, 0))}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-hover"
        role="progressbar"
        aria-label={t("import.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sent ? undefined : percent}
      >
        {sent ? (
          <div className="h-full w-1/3 animate-[pending-bar_1.4s_ease-in-out_infinite] rounded-full bg-fg-3 motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        ) : (
          <div className="h-full rounded-full bg-fg-2 transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${Math.max(2, percent)}%` }} />
        )}
      </div>
      <p className="truncate text-[12px] text-fg-3">{files.map((f) => f.name).join(", ")}</p>
    </div>
  );
}

function Result({ result }: { result: WikiImportResult }) {
  const { t } = useTranslation("wiki");
  const groups = groupSkipped(result.skipped);
  return (
    <div className="flex flex-col gap-4 pb-1 animate-rise-in motion-reduce:animate-none">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-tone-green-soft text-tone-green">
          <CircleCheck className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold tracking-[-0.01em] text-fg" role="status">
            {t("import.done", { count: result.pages })}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-fg-3">{t("import.doneBody")}</p>
        </div>
      </div>
      {groups.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="label-caps">{t("import.skipped", { count: result.skipped.length })}</h3>
          <ul className="flex flex-col gap-2">
            {groups.map((g) => (
              <SkipCard key={g.reason} group={g} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const SHOWN = 4;

function SkipCard({ group }: { group: SkipGroup }) {
  const { t } = useTranslation("wiki");
  const [all, setAll] = useState(false);
  const known = (SKIP_REASONS as readonly string[]).includes(group.reason);
  const key = known ? group.reason : "other";
  const paths = all ? group.paths : group.paths.slice(0, SHOWN);
  const rest = group.paths.length - paths.length;
  let more: ReactNode = null;
  if (rest > 0)
    more = (
      <button type="button" className="mt-0.5 text-left text-[11.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline" onClick={() => setAll(true)}>
        {t("import.showAll", { count: rest })}
      </button>
    );
  return (
    <li className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-fg">{t(`import.reasons.${key}.title` as "import.reasons.other.title")}</span>
        <span className="mono shrink-0 text-[11px] tabular-nums text-fg-4">{group.paths.length}</span>
      </div>
      <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{t(`import.reasons.${key}.body` as "import.reasons.other.body")}</p>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {paths.map((p, i) => (
          <li key={`${p}:${i}`} className="mono truncate text-[11.5px] text-fg-2" title={p}>
            {p}
          </li>
        ))}
      </ul>
      {more}
    </li>
  );
}
