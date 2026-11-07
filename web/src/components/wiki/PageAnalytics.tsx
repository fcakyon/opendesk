// A page's views over the last 28 days (contracts/wiki.md "Page analytics"), as Notion's page
// analytics: "N views by M people", a bar per day, and the days it was edited as dots under
// them. Counts only: who read it is the readers list's. Each day answers on hover and with the
// arrow keys, and a table carries the same numbers for screen readers.

import { useQuery } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import type { WikiPageAnalytics } from "@/lib/api/types";
import { number } from "@/lib/format";
import { intlLocale } from "@/i18n";
import { q } from "@/lib/queries";

const W = 296;
const PLOT = 56;
const TOP = 14;
const RUG = 10;
const H = TOP + PLOT + RUG;
const GAP = 2;

/** A column with a rounded top (4px, less when thin or short), square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0 || h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** "3 Nov" in the reader's language, from a UTC day. */
function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: "numeric", month: "short", timeZone: "UTC" });
}

export function PageAnalytics({ pageId }: { pageId: string }) {
  const { t } = useTranslation("wiki");
  const { data, isLoading, isError } = useQuery(q.wikiAnalytics(pageId));
  return (
    <section className="mt-4" aria-labelledby={`wiki-views-${pageId}`}>
      <div className="flex items-baseline justify-between pb-1">
        <h3 id={`wiki-views-${pageId}`} className="label-caps">
          {t("analytics.title")}
        </h3>
        <span className="text-[11px] text-fg-4">{t("analytics.range")}</span>
      </div>
      {isLoading ? (
        <>
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-[72px] w-full" />
        </>
      ) : isError || !data ? (
        <p className="text-[12px] text-fg-4">{t("analytics.failed")}</p>
      ) : (
        <Chart data={data} />
      )}
    </section>
  );
}

export function Chart({ data }: { data: WikiPageAnalytics }) {
  const { t } = useTranslation("wiki");
  const [hover, setHover] = useState<number | null>(null);
  const days = data.days;
  const n = days.length;
  const edits = new Map(data.edits.map((e) => [e.date, e.count]));
  const totalEdits = data.edits.reduce((s, e) => s + e.count, 0);
  const peak = Math.max(0, ...days.map((d) => d.views));
  const band = W / Math.max(1, n);
  const bar = Math.min(24, band - GAP);
  const peakAt = peak ? days.findIndex((d) => d.views === peak) : -1;
  const base = TOP + PLOT;
  const height = (v: number) => (peak ? Math.max(v > 0 ? 2 : 0, (v / peak) * PLOT) : 0);
  const at = hover !== null ? days[hover] : null;
  const count = (k: "views" | "by" | "edits", c: number) => t(`analytics.${k}`, { count: c, n: number(c) });
  const line = (d: { date: string; views: number; viewers: number }) => {
    const e = edits.get(d.date) ?? 0;
    return `${count("views", d.views)} ${count("by", d.viewers)}${e ? ` · ${count("edits", e)}` : ""}`;
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Escape") setHover(null);
  };

  return (
    <>
      <p className="text-[12.5px] text-fg-2">
        <span className="font-semibold tabular-nums text-fg">{count("views", data.total_views)}</span> {count("by", data.total_viewers)}
      </p>
      {data.total_views === 0 && <p className="mt-0.5 text-[12px] text-fg-4">{t("analytics.empty")}</p>}
      <div
        role="group"
        aria-label={t("analytics.chart")}
        tabIndex={0}
        onKeyDown={key}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
        className="relative mt-2 rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-safe:animate-fade-in"
      >
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" aria-hidden className="block overflow-visible">
          {days.map((d, i) => {
            const x = band * i + (band - bar) / 2;
            const h = height(d.views);
            const edited = edits.get(d.date) ?? 0;
            return (
              <g key={d.date} onPointerEnter={() => setHover(i)}>
                {/* The whole column answers the pointer, not just the bar. */}
                <rect x={band * i} y={0} width={band} height={H} fill="transparent" />
                <path d={columnPath(x, base - h, bar, h)} fill="var(--tone-blue)" opacity={hover === null || hover === i ? 1 : 0.45} className="transition-opacity duration-100 motion-reduce:transition-none" />
                {edited > 0 && <circle cx={band * i + band / 2} cy={base + RUG / 2 + 1} r={2} fill="var(--fg-4)" />}
              </g>
            );
          })}
          <line x1={0} x2={W} y1={base + 0.5} y2={base + 0.5} stroke="var(--line)" />
          {peakAt >= 0 && hover === null && (
            <text x={Math.min(W - 4, Math.max(4, band * peakAt + band / 2))} y={base - height(peak) - 4} textAnchor="middle" className="mono" fontSize={10} fill="var(--fg-3)">
              {number(peak)}
            </text>
          )}
        </svg>
        <div className="mt-1 flex justify-between text-[10.5px] text-fg-4">
          <span>{n ? dayLabel(days[0].date) : ""}</span>
          <span>{t("analytics.today")}</span>
        </div>
        {at && hover !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] shadow-float"
            // It grows away from the edge nearer the day, so it stays inside the panel.
            style={hover < n / 2 ? { left: `${(hover / n) * 100}%` } : { right: `${((n - 1 - hover) / n) * 100}%` }}
          >
            <span className="font-medium text-fg">{hover === n - 1 ? t("analytics.today") : dayLabel(at.date)}</span>
            <span className="text-fg-3">
              {" · "}
              {line(at)}
            </span>
          </div>
        )}
      </div>
      {totalEdits > 0 && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
          <span className="size-1 rounded-full bg-fg-4" aria-hidden />
          {count("edits", totalEdits)}
        </p>
      )}
      <table className="sr-only">
        <caption>{t("analytics.chart")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("analytics.date")}</th>
            <th scope="col">{t("analytics.title")}</th>
            <th scope="col">{t("analytics.people")}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{dayLabel(d.date)}</td>
              <td>{d.views}</td>
              <td>{d.viewers}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="sr-only" aria-live="polite">
        {at ? `${dayLabel(at.date)}: ${line(at)}` : ""}
      </span>
    </>
  );
}
