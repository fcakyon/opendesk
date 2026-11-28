import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { presets, rangeLabel } from "./RangePicker";

describe("today and yesterday presets", () => {
  beforeAll(async () => {
    await loadAgentCatalogs("fr");
    await loadAgentCatalogs("de");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("come first, each a single day, before the 7-day preset", async () => {
    await i18n.changeLanguage("en");
    const now = new Date(2026, 10, 5, 0, 30);
    const list = presets(now);
    expect(list.slice(0, 3).map((p) => p.id)).toEqual(["today", "yesterday", "7"]);
    expect(list[0].range).toEqual({ from: "2026-11-05", to: "2026-11-05" });
    expect(list[1].range).toEqual({ from: "2026-11-04", to: "2026-11-04" });
    expect(list.map((p) => p.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
  });

  it("cross a month boundary", () => {
    const list = presets(new Date(2026, 2, 1, 9));
    expect(list[0].range).toEqual({ from: "2026-03-01", to: "2026-03-01" });
    expect(list[1].range).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  });

  it("name the range button and read in other languages", async () => {
    expect(rangeLabel(presets()[0].range)).toBe("Today");
    await i18n.changeLanguage("fr");
    expect(presets().slice(0, 2).map((p) => p.label)).toEqual(["Aujourd’hui", "Hier"]);
    await i18n.changeLanguage("de");
    expect(rangeLabel(presets()[1].range)).toBe("Gestern");
  });
});
