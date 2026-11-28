// Ollie's decisions on a ticket (contracts/ai.md "Decisions"): the latest triage
// run in custom.ai_decisions and the ones below the workspace's confidence
// threshold in custom.ai_suggestions. Jev is the model behind them; everything is
// still shown as Ollie.

import type { AIDecisions, AISuggestions, Decision, DecisionField, Severity, Suggestion, SuggestionField, Ticket } from "@/lib/api/types";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const SEVERITIES: Severity[] = ["sev1", "sev2", "sev3", "sev4"];
export const isSeverity = (v: unknown): v is Severity => typeof v === "string" && (SEVERITIES as string[]).includes(v);

/** custom.ai_decisions, or null when triage never ran or the shape is unknown. */
export function aiDecisions(t: Pick<Ticket, "custom"> | null | undefined): AIDecisions | null {
  const d = t?.custom?.ai_decisions;
  if (!isObj(d) || !isObj(d.fields)) return null;
  const fields: AIDecisions["fields"] = {};
  for (const [k, v] of Object.entries(d.fields)) {
    if (!isObj(v)) continue;
    fields[k as DecisionField] = {
      value: (v.value ?? null) as Decision["value"],
      probability: num(v.probability),
      confidence: num(v.confidence),
      applied: v.applied === true,
    };
  }
  return {
    engine: d.engine === "llm" ? "llm" : "jev",
    model: typeof d.model === "string" ? d.model : "",
    model_version: typeof d.model_version === "string" ? d.model_version : undefined,
    threshold: num(d.threshold) ?? 0.7,
    decided_at: typeof d.decided_at === "string" ? d.decided_at : "",
    fields,
  };
}

const isSuggestReason = (r: unknown): r is NonNullable<Suggestion["reason"]> => r === "below_threshold" || r === "field_off" || r === "not_on_team";

export const SUGGESTION_FIELDS: SuggestionField[] = ["severity", "priority", "team", "labels", "spam"];

/** custom.ai_suggestions, in display order, dropping anything malformed. */
export function aiSuggestions(t: Pick<Ticket, "custom"> | null | undefined): [SuggestionField, Suggestion][] {
  const s = t?.custom?.ai_suggestions;
  if (!isObj(s)) return [];
  const out: [SuggestionField, Suggestion][] = [];
  for (const f of SUGGESTION_FIELDS) {
    const v = s[f];
    if (!isObj(v)) continue;
    const value = v.value;
    const ok =
      f === "labels" ? Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string")
      : f === "spam" ? value === true
      : f === "severity" ? isSeverity(value)
      : typeof value === "string" && value !== "";
    if (!ok) continue;
    out.push([f, { value: value as Suggestion["value"], confidence: num(v.confidence), probability: num(v.probability), model: typeof v.model === "string" ? v.model : "", decided_at: typeof v.decided_at === "string" ? v.decided_at : "", ...(isSuggestReason(v.reason) ? { reason: v.reason } : {}) }]);
  }
  return out;
}

/** The ticket without one suggestion (optimistic dismiss and accept). */
export function withoutSuggestion<T extends Pick<Ticket, "custom">>(t: T, field: SuggestionField): T {
  const s = t.custom?.ai_suggestions;
  if (!isObj(s) || !(field in s)) return t;
  const next = { ...s };
  delete next[field];
  return { ...t, custom: { ...t.custom, ai_suggestions: next as AISuggestions } };
}

/** 0.923 → 92. */
export const pct = (v: number | null | undefined) => (v == null ? null : Math.round(Math.max(0, Math.min(1, v)) * 100));

/** What to say about one AI-set value: how sure, and whether Jev decided it. */
export function decisionNote(d: AIDecisions | null, field: DecisionField): { sure: number | null; jev: boolean; threshold: number | null } | null {
  const f = d?.fields[field];
  if (!d || !f) return null;
  const jev = d.engine === "jev";
  return { sure: jev ? pct(f.confidence) : null, jev, threshold: jev && f.confidence != null ? pct(d.threshold) : null };
}
