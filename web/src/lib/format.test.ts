import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, resetLocale, setLocale } from "@/i18n";
import { bytes, clock, compact, currency, dayLabel, formatUsd, fullDate, messageTime, minutes, number, percent, relLong, relShort, setClock, shortDate, timeOfDay, twelveHour, weekdayClock } from "./format";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Intl separates with no-break spaces; compare on plain spaces. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetLocale();
  setClock("auto");
});

describe("format, English", () => {
  it("keeps the compact agent-app ages", () => {
    expect(relShort(ago(10_000), NOW)).toBe("now");
    expect(relShort(ago(5 * MIN), NOW)).toBe("5m");
    expect(relShort(ago(2 * HOUR), NOW)).toBe("2h");
    expect(relShort(ago(3 * DAY), NOW)).toBe("3d");
  });
  it("writes long ages", () => {
    expect(relLong(ago(10_000), NOW)).toBe("just now");
    expect(relLong(ago(5 * MIN), NOW)).toBe("5 minutes ago");
    expect(relLong(ago(1 * DAY), NOW)).toBe("1 day ago");
    expect(relLong(ago(2 * DAY), NOW)).toBe("2 days ago");
  });
  it("labels days", () => {
    expect(dayLabel(ago(0), NOW)).toBe("Today");
    expect(dayLabel(ago(DAY), NOW)).toBe("Yesterday");
  });
  it("formats durations, sizes and numbers", () => {
    expect(minutes(135)).toBe("2h 15m");
    expect(minutes(2880)).toBe("2d");
    expect(minutes(null)).toBe("–");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(bytes(25 * 1024 * 1024 * 1024)).toBe("25.0 GB");
    expect(compact(1234)).toBe("1.2K");
    expect(compact(999)).toBe("999");
    expect(percent(0.874)).toBe("87%");
  });
  it("formats money from minor units", () => {
    expect(currency(1900, "usd")).toBe("$19");
    expect(currency(1950, "usd")).toBe("$19.50");
    expect(currency(1900, "usd", { exact: true })).toBe("$19.00");
    expect(currency(1900, "jpy")).toBe("¥1,900");
  });
  it("formats US dollars of AI usage", () => {
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(10)).toBe("$10.00");
    expect(formatUsd(1234.567)).toBe("$1,234.57");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0195, { precise: true })).toBe("$0.0195");
    expect(formatUsd(0.0042, { precise: true })).toBe("$0.0042");
    expect(formatUsd(0.000975, { precise: true })).toBe("$0.000975");
    expect(formatUsd(0.007313, { precise: true })).toBe("$0.00731");
    expect(formatUsd(0.5, { precise: true })).toBe("$0.50");
    expect(formatUsd(0.00003, { precise: true })).toBe("<$0.0001");
    expect(formatUsd(12.3456, { precise: true })).toBe("$12.35");
    expect(formatUsd(0.983, { tiny: true })).toBe("$0.98");
    expect(formatUsd(0.0042, { tiny: true })).toBe("$0.0042");
    expect(formatUsd(3, { trim: true })).toBe("$3");
    expect(formatUsd(0.15, { trim: true })).toBe("$0.15");
    expect(formatUsd(1.125, { trim: true })).toBe("$1.125");
    expect(formatUsd(0.3, { trim: true })).toBe("$0.30");
  });
  it("formats dates", () => {
    expect(shortDate("2020-03-04T12:00:00Z")).toMatch(/Mar 4, 2020/);
    expect(fullDate("2026-10-11T12:00:00Z")).toMatch(/Oct 11, 2026/);
  });
});

describe("format, German page", () => {
  it("follows the page language", async () => {
    await setLocale("de", ["common"]);
    expect(number(12345.6)).toBe("12.345,6");
    expect(sp(currency(1950, "eur"))).toBe("19,50 €");
    expect(sp(formatUsd(0.5))).toBe("0,50 $");
    expect(sp(percent(0.5))).toBe("50 %");
    expect(relLong(ago(2 * DAY), NOW)).toBe("vor 2 Tagen");
    expect(relShort(ago(10_000), NOW)).toBe("jetzt");
    expect(sp(relShort(ago(5 * MIN), NOW))).toBe("5 Min.");
    expect(sp(relShort(ago(2 * HOUR), NOW))).toBe("2 Std.");
    expect(dayLabel(ago(DAY), NOW)).toBe("Gestern");
    expect(sp(shortDate("2020-03-04T12:00:00Z"))).toMatch(/4\. März 2020/);
    expect(clock("2026-10-11T14:05:00")).toBe("14:05");
    expect(document.documentElement.lang).toBe("de");
  });
  it("writes a list age as a duration in French, never as \"-6 min\"", async () => {
    await setLocale("fr", ["common"]);
    expect(relShort(ago(10_000), NOW)).toBe("maintenant");
    expect(sp(relShort(ago(6 * MIN), NOW))).toBe("6 min");
    expect(sp(relShort(ago(2 * HOUR), NOW))).toBe("2 h");
    expect(sp(relShort(ago(3 * DAY), NOW))).toBe("3 j");
    expect(relShort(ago(6 * MIN), NOW)).not.toContain("-");
  });
  it("sets right to left for Arabic and resets after", async () => {
    await setLocale("ar", ["common"]);
    expect(document.documentElement.dir).toBe("rtl");
    resetLocale();
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("format, the person's clock", () => {
  const AFTERNOON = "2026-10-11T14:05:00";
  const MIDNIGHT = "2026-10-11T00:05:00";
  it("keeps the locale's clock on auto", async () => {
    await i18n.changeLanguage("de");
    expect(clock(AFTERNOON)).toBe("14:05");
    await i18n.changeLanguage("en");
  });
  it("writes 12-hour times when chosen", async () => {
    await i18n.changeLanguage("de");
    setClock("12h");
    expect(sp(clock(AFTERNOON))).toBe("2:05 PM");
    expect(sp(clock(MIDNIGHT))).toBe("12:05 AM");
    await i18n.changeLanguage("en");
  });
  it("writes 24-hour times when chosen", async () => {
    await i18n.changeLanguage("en-US");
    setClock("24h");
    expect(clock(AFTERNOON)).toBe("14:05");
    expect(clock(MIDNIGHT)).toBe("00:05");
    expect(sp(fullDate(`${AFTERNOON}`))).toMatch(/Oct 11, 2026, 14:05$/);
    expect(sp(weekdayClock(AFTERNOON))).toBe("Sun 14:05");
    await i18n.changeLanguage("en");
  });
  it("leaves dates without a time alone", () => {
    setClock("24h");
    expect(sp(shortDate("2020-03-04T12:00:00Z"))).toMatch(/Mar 4, 2020/);
  });
  it("keeps the page language's clock on customer-facing pages", async () => {
    setClock("12h");
    await setLocale("de", ["common"]);
    expect(clock(AFTERNOON)).toBe("14:05");
  });
});

describe("stored times of day", () => {
  it("reads HH:mm on the person's clock", () => {
    setClock("12h");
    expect(twelveHour()).toBe(true);
    expect(sp(timeOfDay("09:00"))).toBe("9:00 AM");
    expect(sp(timeOfDay("17:30"))).toBe("5:30 PM");
    expect(sp(timeOfDay("00:00"))).toBe("12:00 AM");
    expect(sp(timeOfDay("24:00"))).toBe("12:00 AM");
    setClock("24h");
    expect(twelveHour()).toBe(false);
    expect(timeOfDay("09:00")).toBe("09:00");
    expect(timeOfDay("24:00")).toBe("24:00");
  });
  it("follows the locale on auto", async () => {
    await setLocale("de", ["common"]);
    expect(twelveHour()).toBe(false);
    expect(timeOfDay("17:30")).toBe("17:30");
  });
});

describe("message times", () => {
  // Local times, so the day boundaries hold in any timezone.
  const NOON = new Date(2026, 10, 9, 12, 0);
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  });
  afterEach(() => vi.setSystemTime(NOON));
  afterAll(() => vi.useRealTimers());

  it("reads only the time for today's messages", async () => {
    await i18n.changeLanguage("en-US");
    expect(sp(messageTime("2026-11-09T08:45:00"))).toBe("8:45 AM");
    expect(sp(messageTime("2026-11-09T00:00:00"))).toBe("12:00 AM");
    await i18n.changeLanguage("en");
  });
  it("adds the day to any other day's, from yesterday on", async () => {
    await i18n.changeLanguage("en-US");
    expect(sp(messageTime("2026-11-08T23:59:00"))).toBe("Nov 8 · 11:59 PM");
    expect(sp(messageTime("2026-01-02T20:45:00"))).toBe("Jan 2 · 8:45 PM");
    await i18n.changeLanguage("en");
  });
  it("adds the year outside this one", async () => {
    await i18n.changeLanguage("en-US");
    expect(sp(messageTime("2025-11-08T20:45:00"))).toBe("Nov 8, 2025 · 8:45 PM");
    expect(sp(messageTime("2025-12-31T23:30:00"))).toBe("Dec 31, 2025 · 11:30 PM");
    await i18n.changeLanguage("en");
  });
  it("follows the person's clock", async () => {
    await i18n.changeLanguage("en-US");
    setClock("24h");
    expect(messageTime("2026-11-09T20:45:00")).toBe("20:45");
    expect(sp(messageTime("2026-11-08T20:45:00"))).toBe("Nov 8 · 20:45");
    await i18n.changeLanguage("de");
    setClock("12h");
    expect(sp(messageTime("2026-11-09T20:45:00"))).toBe("8:45 PM");
    expect(sp(messageTime("2026-11-08T20:45:00"))).toBe("8. Nov. · 8:45 PM");
    await i18n.changeLanguage("en");
  });
  it("writes the day in the app's language", async () => {
    await i18n.changeLanguage("fr");
    expect(messageTime("2026-11-09T20:45:00")).toBe("20:45");
    expect(sp(messageTime("2026-11-08T20:45:00"))).toBe("8 nov. · 20:45");
    expect(sp(messageTime("2025-11-08T20:45:00"))).toBe("8 nov. 2025 · 20:45");
    await i18n.changeLanguage("de");
    expect(sp(messageTime("2026-11-08T20:45:00"))).toBe("8. Nov. · 20:45");
    expect(sp(messageTime("2025-11-08T20:45:00"))).toBe("8. Nov. 2025 · 20:45");
    await i18n.changeLanguage("en");
  });
  it("turns at midnight, by the reader's calendar day", () => {
    vi.setSystemTime(new Date(2026, 10, 10, 0, 1));
    expect(messageTime("2026-11-09T23:59:00")).toMatch(/·/);
    expect(messageTime("2026-11-10T00:00:00")).not.toMatch(/·/);
    // The same "now", given rather than read from the clock.
    expect(messageTime("2026-11-09T23:59:00", NOON.getTime())).not.toMatch(/·/);
  });
});
