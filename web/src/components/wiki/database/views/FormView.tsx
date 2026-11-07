// The form layout (Notion's forms, for members only): a clean, centred form that asks the
// properties its settings name, each with its own input (the cells' editors), and makes a
// row when sent; the title is always asked. Editors shape it in the builder beside it:
// title, description, questions (order, required, hint) and what it says once sent. Its
// link opens the database on this view; viewers read it but can't send it.

import { CheckCircle2, ClipboardList, GripVertical, Info, Link2, PanelRightClose, PanelRightOpen, Plus, X } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TextInput, Textarea, parseNumber } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { menuItemCls } from "@/components/ui/menu";
import { floatingPanel } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { DbFormField, DbFormSettings, DbProperty, DbRow, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { answers, defaultForm, formQuestions, missingAnswers, unasked, type FormQuestion } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { Cell } from "../Cell";
import { PropIcon } from "../cells";

/** Types answered by typing, in a field of the form itself. */
const TYPED: ReadonlySet<DbProperty["type"]> = new Set(["title", "text", "url", "email", "phone", "number"]);

/** The row a form fills in before it is sent: the cells' editors read and write it. */
function draftRow(props: Record<string, DbValue>): DbRow {
  return {
    id: "form-draft",
    parent_id: null,
    title: "",
    icon: "",
    position: 0,
    version: 0,
    updated_at: "",
    created_by_id: null,
    tags: [],
    props,
    cover: "",
    cover_y: 50,
    excerpt: "",
    created_at: "",
    created_by: null,
    updated_by: null,
  };
}

/** The link that opens the database on this view. */
export const formLink = (databaseId: string, viewId: string) => `${window.location.origin}/wiki/${databaseId}?view=${encodeURIComponent(viewId)}`;

export default function FormView(p: ViewProps) {
  const { t } = useTranslation("wiki");
  const { db, view, canEdit, databaseId } = p;
  const [building, setBuilding] = useState(canEdit);
  const form = view.settings?.form;
  const save = (next: DbFormSettings) => p.onSettings({ ...view.settings, form: next });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formLink(databaseId, view.id));
      toast.success(t("db.form.linkCopied"));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="pb-4">
      <div className="flex h-9 items-center gap-1">
        <Tooltip content={t("db.form.shareHint")}>
          <Button size="sm" variant="ghost" icon={<Link2 />} onClick={() => void copy()}>
            {t("db.form.copyLink")}
          </Button>
        </Tooltip>
        <span className="flex-1" />
        {canEdit && (
          <Button size="sm" variant="ghost" icon={building ? <PanelRightClose /> : <PanelRightOpen />} aria-expanded={building} onClick={() => setBuilding(!building)}>
            {building ? t("db.form.hideBuilder") : t("db.form.editForm")}
          </Button>
        )}
      </div>
      <div className={cn("grid items-start gap-4", building && "@[52rem]/db:grid-cols-[minmax(0,1fr)_296px]")}>
        <FormFill p={p} questions={formQuestions(db, form)} form={form} />
        {building && canEdit && <FormBuilder p={p} form={form ?? defaultForm(db)} onSave={save} />}
      </div>
    </div>
  );
}

// ─── Filling it in ───────────────────────────────────────────────────────────

function FormFill({ p, questions, form }: { p: ViewProps; questions: FormQuestion[]; form: DbFormSettings | undefined }) {
  const { t } = useTranslation("wiki");
  const { canEdit } = p;
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, DbValue>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<DbRow | null>(null);
  const root = useRef<HTMLFormElement>(null);

  const set = (id: string, v: DbValue) => {
    setValues((cur) => ({ ...cur, [id]: v }));
    setMissing((m) => m.filter((x) => x !== id));
  };
  const setText = (id: string, v: string) => {
    setTexts((cur) => ({ ...cur, [id]: v }));
    setMissing((m) => m.filter((x) => x !== id));
  };

  /** Typed answers as values; numbers that aren't count as missing. */
  const collect = (): { values: Record<string, DbValue>; bad: string[] } => {
    const out = { ...values };
    const bad: string[] = [];
    for (const q of questions) {
      if (q.prop.type === "title" || !TYPED.has(q.prop.type)) continue;
      const s = (texts[q.prop.id] ?? "").trim();
      if (q.prop.type !== "number") out[q.prop.id] = s || null;
      else {
        const n = parseNumber(s, true);
        if (n === undefined) bad.push(q.prop.id);
        out[q.prop.id] = n ?? null;
      }
    }
    return { values: out, bad };
  };

  const submit = async () => {
    if (!canEdit || sending) return;
    const got = collect();
    const miss = [...new Set([...missingAnswers(questions, title, got.values), ...got.bad])];
    setMissing(miss);
    if (miss.length) {
      root.current?.querySelector<HTMLElement>(`[data-question="${miss[0]}"] input, [data-question="${miss[0]}"] textarea, [data-question="${miss[0]}"] button`)?.focus();
      return;
    }
    setSending(true);
    const row = await p.onCreate(answers(questions, got.values), { title: title.trim() });
    setSending(false);
    if (!row) return;
    setSent(row);
    setTitle("");
    setValues({});
    setTexts({});
  };

  const heading = form?.title?.trim() || p.view.name;
  if (sent)
    return (
      <div className="mx-auto w-full max-w-[640px] animate-pop-in rounded-xl border border-line bg-surface px-8 py-10 text-center shadow-xs" role="status">
        <CheckCircle2 className="mx-auto size-8 text-tone-green-solid" aria-hidden />
        <h3 className="mt-3 text-[16px] font-semibold text-fg">{t("db.form.submittedTitle")}</h3>
        <p className="mx-auto mt-1.5 max-w-[420px] whitespace-pre-wrap text-[13px] leading-5 text-fg-2">{form?.submitted?.trim() || t("db.form.submittedDefault")}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button size="md" variant="primary" autoFocus onClick={() => setSent(null)}>
            {t("db.form.another")}
          </Button>
          <Button size="md" onClick={() => p.onOpen(sent)}>
            {t("db.form.openRow")}
          </Button>
        </div>
      </div>
    );

  return (
    <form
      ref={root}
      noValidate
      aria-label={heading}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
      className="mx-auto w-full max-w-[640px] rounded-xl border border-line bg-surface shadow-xs"
    >
      <header className="border-b border-line-soft px-7 pb-5 pt-6">
        <span className="flex size-8 items-center justify-center rounded-lg bg-tone-blue-soft text-tone-blue" aria-hidden>
          <ClipboardList className="size-4" />
        </span>
        <h3 className="mt-3 text-[18px] font-semibold tracking-[-0.01em] text-fg">{heading}</h3>
        {form?.description?.trim() && <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-5 text-fg-2">{form.description}</p>}
      </header>
      {!canEdit && (
        <p className="mx-7 mt-5 flex items-start gap-2 rounded-lg border border-tone-blue-line bg-tone-blue-soft px-3 py-2.5 text-[12.5px] leading-[18px] text-tone-blue">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          {t("db.form.viewerNote")}
        </p>
      )}
      <div className="flex flex-col gap-5 px-7 py-6">
        {questions.map((q) => (
          <Question key={q.prop.id} q={q} invalid={missing.includes(q.prop.id)}>
            {q.prop.type === "title" ? (
              <TextInput id={`q-${q.prop.id}`} value={title} disabled={!canEdit} invalid={missing.includes(q.prop.id)} maxLength={200} placeholder={t("db.form.answer")} onChange={(e) => (setTitle(e.target.value), setMissing((m) => m.filter((x) => x !== q.prop.id)))} onKeyDown={noImplicitSubmit} />
            ) : TYPED.has(q.prop.type) ? (
              <TypedAnswer prop={q.prop} value={texts[q.prop.id] ?? ""} disabled={!canEdit} invalid={missing.includes(q.prop.id)} onChange={(v) => setText(q.prop.id, v)} />
            ) : (
              <div className={cn("rounded-md border bg-surface shadow-xs transition-colors", missing.includes(q.prop.id) ? "border-danger" : "border-line hover:border-line-strong", !canEdit && "bg-sunken")}>
                <Cell prop={q.prop} row={draftRow(values)} ctx={p.ctx} canEdit={canEdit} variant="page" placeholder={t("db.form.answer")} onChange={(v) => set(q.prop.id, v)} onAddOption={p.onAddOption} />
              </div>
            )}
          </Question>
        ))}
      </div>
      <footer className="flex items-center gap-3 border-t border-line-soft px-7 py-4">
        <Button type="submit" size="md" variant="primary" loading={sending} disabled={!canEdit}>
          {t("db.form.submit")}
        </Button>
        {canEdit && (
          <span className="hidden items-center gap-1.5 text-[12px] text-fg-4 @[36rem]/db:flex">
            <Kbd>mod Enter</Kbd>
            {t("db.form.submitHint")}
          </span>
        )}
        {missing.length > 0 && (
          <span role="alert" className="ml-auto text-[12px] text-danger-fg">
            {t("db.form.missing", { count: missing.length })}
          </span>
        )}
      </footer>
    </form>
  );
}

/** Enter in a one-line answer doesn't send the form; mod+Enter does. */
const noImplicitSubmit = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault();
};

function Question({ q, invalid, children }: { q: FormQuestion; invalid: boolean; children: ReactNode }) {
  const { t } = useTranslation("wiki");
  return (
    <div data-question={q.prop.id} className="flex flex-col gap-1.5">
      <label htmlFor={`q-${q.prop.id}`} className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
        <PropIcon type={q.prop.type} />
        {q.prop.name}
        {q.required && (
          <span className={cn("text-[12px]", invalid ? "text-danger-fg" : "text-fg-4")} aria-label={t("db.form.required")}>
            *
          </span>
        )}
      </label>
      {q.help && <p className="-mt-0.5 whitespace-pre-wrap text-[12px] leading-[17px] text-fg-3">{q.help}</p>}
      {children}
    </div>
  );
}

function TypedAnswer({ prop, value, disabled, invalid, onChange }: { prop: DbProperty; value: string; disabled: boolean; invalid: boolean; onChange: (v: string) => void }) {
  const { t } = useTranslation("wiki");
  if (prop.type === "text")
    return <Textarea id={`q-${prop.id}`} value={value} disabled={disabled} invalid={invalid} rows={3} maxLength={10000} placeholder={t("db.form.answer")} onChange={(e) => onChange(e.target.value)} />;
  return (
    <TextInput
      id={`q-${prop.id}`}
      value={value}
      disabled={disabled}
      invalid={invalid}
      inputMode={prop.type === "number" ? "decimal" : prop.type === "phone" ? "tel" : prop.type === "email" ? "email" : prop.type === "url" ? "url" : undefined}
      placeholder={prop.type === "url" ? "https://" : t("db.form.answer")}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={noImplicitSubmit}
    />
  );
}

// ─── The builder ─────────────────────────────────────────────────────────────

function FormBuilder({ p, form, onSave }: { p: ViewProps; form: DbFormSettings; onSave: (f: DbFormSettings) => void }) {
  const { t } = useTranslation("wiki");
  const { db } = p;
  const [drag, setDrag] = useState<string | null>(null);
  const questions = formQuestions(db, form);
  // What's saved: the questions as shown, the title's entry first.
  const fields: DbFormField[] = questions.map((q) => ({ property: q.prop.id, ...(q.required ? { required: true } : {}), ...(q.help ? { help: q.help } : {}) }));
  const setField = (id: string, patch: Partial<DbFormField>) => onSave({ ...form, fields: fields.map((f) => (f.property === id ? { ...f, ...patch } : f)) });
  const move = (id: string, to: number) => {
    const list = fields.filter((f) => f.property !== id);
    list.splice(Math.max(1, Math.min(to, list.length)), 0, fields.find((f) => f.property === id)!);
    onSave({ ...form, fields: list });
  };
  const text = (key: "title" | "description" | "submitted", v: string) => {
    const next = v.trim() ? { ...form, [key]: v.trim() } : { ...form };
    if (!v.trim()) delete next[key];
    if ((form[key] ?? "") !== (next[key] ?? "")) onSave(next);
  };
  const more = unasked(db, form);

  return (
    <aside aria-label={t("db.form.builder")} className="flex flex-col gap-1 rounded-xl border border-line bg-sunken p-2 @[52rem]/db:sticky @[52rem]/db:top-2">
      <Section label={t("db.form.details")}>
        <TextInput inputSize="sm" defaultValue={form.title ?? ""} maxLength={200} placeholder={p.view.name || t("db.form.titlePlaceholder")} aria-label={t("db.form.titlePlaceholder")} onBlur={(e) => text("title", e.target.value)} />
        <Textarea className="min-h-[56px] text-[12.5px]" defaultValue={form.description ?? ""} maxLength={2000} rows={2} placeholder={t("db.form.descriptionPlaceholder")} aria-label={t("db.form.descriptionPlaceholder")} onBlur={(e) => text("description", e.target.value)} />
      </Section>
      <Section label={t("db.form.questions")}>
        <ol className="flex flex-col gap-1">
          {questions.map((q, i) => {
            const isTitle = q.prop.type === "title";
            return (
              <li
                key={q.prop.id}
                onDragOver={(e) => {
                  if (!drag || drag === q.prop.id || isTitle) return;
                  e.preventDefault();
                }}
                onDrop={() => drag && !isTitle && move(drag, i)}
                className={cn("rounded-lg border border-line bg-surface p-1.5 shadow-xs transition-opacity", drag === q.prop.id && "opacity-40")}
              >
                <div className="flex h-7 items-center gap-1.5">
                  {isTitle ? (
                    <span className="w-5" />
                  ) : (
                    <Tooltip content={t("db.form.moveQuestion")}>
                      <button
                        type="button"
                        draggable
                        aria-label={`${t("db.form.moveQuestion")}: ${q.prop.name}`}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          setDrag(q.prop.id);
                        }}
                        onDragEnd={() => setDrag(null)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                            e.preventDefault();
                            move(q.prop.id, e.key === "ArrowUp" ? i - 1 : i + 1);
                          }
                        }}
                        className="flex size-5 cursor-grab items-center justify-center rounded text-fg-4 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                      >
                        <GripVertical className="size-3.5" />
                      </button>
                    </Tooltip>
                  )}
                  <PropIcon type={q.prop.type} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{q.prop.name}</span>
                  <Tooltip content={isTitle ? t("db.form.titleAlways") : t("db.form.required")}>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                      {t("db.form.required")}
                      <Switch checked={q.required} disabled={isTitle} aria-label={`${t("db.form.required")}: ${q.prop.name}`} onCheckedChange={(v) => setField(q.prop.id, { required: v || undefined })} />
                    </span>
                  </Tooltip>
                  {!isTitle && (
                    <button
                      type="button"
                      aria-label={`${t("db.form.removeQuestion")}: ${q.prop.name}`}
                      onClick={() => onSave({ ...form, fields: fields.filter((f) => f.property !== q.prop.id) })}
                      className="flex size-6 items-center justify-center rounded-md text-fg-4 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <input
                  key={`${q.prop.id}:${q.help}`}
                  defaultValue={q.help}
                  maxLength={500}
                  placeholder={t("db.form.helpPlaceholder")}
                  aria-label={`${t("db.form.help")}: ${q.prop.name}`}
                  onBlur={(e) => e.target.value.trim() !== q.help && setField(q.prop.id, { help: e.target.value.trim() || undefined })}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="mt-1 h-6 w-full rounded bg-transparent px-1.5 text-[12px] text-fg-2 outline-none placeholder:text-fg-4 hover:bg-hover focus:bg-sunken"
                />
              </li>
            );
          })}
        </ol>
        <M.Root>
          <M.Trigger asChild>
            <Button size="sm" variant="ghost" icon={<Plus />} disabled={!more.length} className="justify-start">
              {t("db.form.addQuestion")}
            </Button>
          </M.Trigger>
          <M.Portal>
            <M.Content align="start" sideOffset={4} collisionPadding={8} className={cn(floatingPanel, "max-h-[320px] min-w-[220px] overflow-y-auto p-1")}>
              {more.map((prop) => (
                <M.Item key={prop.id} className={menuItemCls} onSelect={() => onSave({ ...form, fields: [...fields, { property: prop.id }] })}>
                  <PropIcon type={prop.type} />
                  <span className="flex-1 truncate">{prop.name}</span>
                </M.Item>
              ))}
            </M.Content>
          </M.Portal>
        </M.Root>
        {!more.length && <p className="px-1 text-[11.5px] text-fg-4">{t("db.form.allAsked")}</p>}
      </Section>
      <Section label={t("db.form.afterSubmit")}>
        <Textarea className="min-h-[56px] text-[12.5px]" defaultValue={form.submitted ?? ""} maxLength={1000} rows={2} placeholder={t("db.form.submittedDefault")} aria-label={t("db.form.afterSubmit")} onBlur={(e) => text("submitted", e.target.value)} />
      </Section>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 p-1">
      <div className="label-caps px-0.5 pt-1">{label}</div>
      {children}
    </section>
  );
}
