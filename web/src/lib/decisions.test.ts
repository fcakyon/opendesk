import { describe, expect, it } from "vitest";
import { aiDecisions, aiSuggestions, decisionNote, pct, withoutSuggestion } from "./decisions";
import { ticket } from "./test/fixtures";

const at = "2026-10-01T10:00:00Z";
const sugg = (value: unknown, confidence = 0.6) => ({ value, confidence, probability: 0.7, model: "jev", decided_at: at });

describe("decisions", () => {
  it("lists valid suggestions in display order and drops malformed ones", () => {
    const t = ticket({
      custom: {
        ai_suggestions: {
          labels: sugg(["billing"]),
          priority: sugg("high"),
          severity: sugg("sev2"),
          team: sugg(""),
          spam: sugg(false),
          bogus: sugg("x"),
        },
      },
    });
    expect(aiSuggestions(t).map(([f]) => f)).toEqual(["severity", "priority", "labels"]);
    expect(aiSuggestions(ticket({ custom: { ai_suggestions: { severity: sugg("sev9") } } }))).toEqual([]);
    expect(aiSuggestions(ticket())).toEqual([]);
  });

  it("keeps why a suggestion was not applied, and ignores a reason it does not know", () => {
    const t = ticket({ custom: { ai_suggestions: { priority: { ...sugg("high"), reason: "below_threshold" }, severity: { ...sugg("sev2"), reason: "something_new" } } } });
    const [sev, pri] = aiSuggestions(t);
    expect(pri[1].reason).toBe("below_threshold");
    expect(sev[1].reason).toBeUndefined();
  });

  it("removes one suggestion without touching the rest", () => {
    const t = ticket({ custom: { ai_suggestions: { priority: sugg("high"), severity: sugg("sev3") }, other: 1 } });
    const next = withoutSuggestion(t, "priority");
    expect(aiSuggestions(next).map(([f]) => f)).toEqual(["severity"]);
    expect(next.custom.other).toBe(1);
    expect(withoutSuggestion(next, "priority")).toBe(next);
  });

  it("reads decisions and says how sure Jev was", () => {
    const t = ticket({
      custom: { ai_decisions: { engine: "jev", model: "jev", threshold: 0.8, decided_at: at, fields: { severity: { value: "sev1", confidence: 0.923, probability: 0.95, applied: true } } } },
    });
    const d = aiDecisions(t);
    expect(d?.threshold).toBe(0.8);
    expect(d?.fields.severity?.applied).toBe(true);
    expect(decisionNote(d, "severity")).toEqual({ sure: 92, jev: true, threshold: 80 });
    expect(decisionNote(d, "priority")).toBeNull();
    const llm = aiDecisions(ticket({ custom: { ai_decisions: { engine: "llm", fields: { priority: { value: "high", confidence: 0.9 } } } } }));
    expect(decisionNote(llm, "priority")).toEqual({ sure: null, jev: false, threshold: null });
    expect(aiDecisions(ticket({ custom: { ai_decisions: "nope" } }))).toBeNull();
  });

  it("rounds and clamps percentages", () => {
    expect(pct(0.705)).toBe(71);
    expect(pct(1.4)).toBe(100);
    expect(pct(null)).toBeNull();
  });
});
