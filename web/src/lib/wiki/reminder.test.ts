import { describe, expect, it } from "vitest";
import { formatWhen, parseWhen, reminderId } from "./reminder";

describe("reminder markup", () => {
  it("reads a day, a day with a local time, and RFC 3339 on the reader's clock", () => {
    expect(parseWhen("2026-11-07")).toEqual({ date: "2026-11-07", time: "" });
    expect(parseWhen("2026-11-07T09:30")).toEqual({ date: "2026-11-07", time: "09:30" });
    const d = new Date("2026-11-07T09:30:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(parseWhen("2026-11-07T09:30:00Z")).toEqual({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
  });

  it("names nothing for what isn't a date", () => {
    for (const v of ["", null, "tomorrow", "2026-02-30", "2026-11-07T24:00", "2026-11-07T9:30", "2026-11-07 09:30"]) expect(parseWhen(v), String(v)).toBeNull();
  });

  it("writes the time only when there is one", () => {
    expect(formatWhen("2026-11-07", "")).toBe("2026-11-07");
    expect(formatWhen("2026-11-07", "09:30")).toBe("2026-11-07T09:30");
    expect(parseWhen(formatWhen("2026-11-07", "18:05"))).toEqual({ date: "2026-11-07", time: "18:05" });
  });

  it("keeps a reminder id only when it is a uuid", () => {
    expect(reminderId("3DCB61FA-ABC6-47AC-9916-06ACF5B7FDF7")).toBe("3dcb61fa-abc6-47ac-9916-06acf5b7fdf7");
    expect(reminderId("x")).toBeNull();
    expect(reminderId(null)).toBeNull();
  });
});
