import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "@/i18n";
import type { WikiPageAnalytics } from "@/lib/api/types";
import { Chart } from "./PageAnalytics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const day = (i: number) => new Date(Date.UTC(2026, 9, 11 + i)).toISOString().slice(0, 10);
const data = (views: (i: number) => number): WikiPageAnalytics => {
  const days = Array.from({ length: 28 }, (_, i) => ({ date: day(i), views: views(i), viewers: views(i) ? 1 : 0 }));
  return { days, total_views: days.reduce((n, d) => n + d.views, 0), total_viewers: 3, edits: days.map((d, i) => ({ date: d.date, count: i === 27 ? 2 : 0 })) };
};

async function render(d: WikiPageAnalytics) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Chart data={d} />));
}

describe("page analytics chart", () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("says how many views by how many people, a bar per day with views, and the edits", async () => {
    await render(data((i) => (i % 2 ? 0 : i + 1)));
    expect(host.textContent).toContain("196 views by 3 people");
    expect([...host.querySelectorAll("svg path")].filter((p) => p.getAttribute("d")).length).toBe(14);
    expect(host.querySelectorAll("svg circle")).toHaveLength(1);
    expect(host.textContent).toContain("2 edits");
    expect(host.querySelectorAll("table tbody tr")).toHaveLength(28);
  });

  it("steps through the days with the arrow keys", async () => {
    await render(data((i) => i));
    const group = host.querySelector("[role=group]")!;
    await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(host.querySelector("[aria-live]")?.textContent).toContain("27 views by 1 person · 2 edits");
    await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(host.querySelector("[aria-live]")?.textContent).toContain("26 views by 1 person");
  });

  it("says when nobody opened it", async () => {
    await render(data(() => 0));
    expect(host.textContent).toContain("Nobody opened it in the last 28 days.");
  });
});
