// Forms (contracts/wiki.md "Databases"): a view that asks for a new row. Its settings say
// which properties it asks, in order, which must be answered and the hint under each; the
// title is always asked first and always required.

import type { Database, DbFormField, DbFormSettings, DbProperty, DbValue } from "../../api/types";
import { COMPUTED_TYPES } from "./values";

/** Whether a form can ask a property: anything stored on a row, and the title. */
export const askable = (p: DbProperty) => p.type === "title" || !COMPUTED_TYPES.has(p.type);

/** A question as the form shows it. */
export type FormQuestion = { prop: DbProperty; required: boolean; help: string };

/** What a new form asks: the title, then every property it can ask. */
export function defaultForm(db: Database): DbFormSettings {
  return { fields: db.properties.filter(askable).map((p) => (p.type === "title" ? { property: p.id, required: true } : { property: p.id })) };
}

/** The form's questions: the title first, then the fields that name a property it can ask, each once. */
export function formQuestions(db: Database, form: DbFormSettings | undefined): FormQuestion[] {
  const byId = new Map(db.properties.map((p) => [p.id, p]));
  const title = db.properties.find((p) => p.type === "title");
  const fields = form?.fields ?? defaultForm(db).fields;
  const seen = new Set<string>();
  const out: FormQuestion[] = [];
  const titleField = fields.find((f) => f.property === title?.id);
  if (title) {
    out.push({ prop: title, required: true, help: titleField?.help ?? "" });
    seen.add(title.id);
  }
  for (const f of fields) {
    const p = byId.get(f.property);
    if (!p || seen.has(p.id) || !askable(p)) continue;
    seen.add(p.id);
    out.push({ prop: p, required: !!f.required, help: f.help ?? "" });
  }
  return out;
}

/** The properties a form can still ask. */
export function unasked(db: Database, form: DbFormSettings | undefined): DbProperty[] {
  const asked = new Set(formQuestions(db, form).map((q) => q.prop.id));
  return db.properties.filter((p) => askable(p) && !asked.has(p.id));
}

/** No answer: nothing, an empty list or text, or a box left unticked (a required box must be ticked). */
const blank = (v: DbValue | undefined) => v === undefined || v === null || v === false || (Array.isArray(v) && !v.length) || (typeof v === "string" && !v.trim());

/** The required questions left unanswered, by property id. */
export function missingAnswers(questions: readonly FormQuestion[], title: string, values: Record<string, DbValue>): string[] {
  return questions.filter((q) => q.required && (q.prop.type === "title" ? !title.trim() : blank(values[q.prop.id]))).map((q) => q.prop.id);
}

/** The values a submitted form gives its new row: only what it asks, only what was answered. */
export function answers(questions: readonly FormQuestion[], values: Record<string, DbValue>): Record<string, DbValue> {
  const out: Record<string, DbValue> = {};
  for (const q of questions) {
    const v = values[q.prop.id];
    if (q.prop.type !== "title" && !(blank(v) && v !== false)) out[q.prop.id] = v as DbValue;
  }
  return out;
}

/** A form with one question changed, moved or taken out. */
export function setFields(form: DbFormSettings | undefined, db: Database, fields: DbFormField[]): DbFormSettings {
  return { ...(form ?? defaultForm(db)), fields };
}
