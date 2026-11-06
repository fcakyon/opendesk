// The chart layout: the view's rows grouped by one property and measured (a count, or the sum
// or average of a number), drawn as horizontal bars, columns, a donut or a line. Plain SVG.
// Groups of options take their option's tone, everything else one calm colour; values show on
// the marks where they fit, in a tooltip on hover or arrow keys, and in a table for screen readers.

import { BarChart3 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { formatPercent, NO_VALUE } from "@/lib/wiki/db";
import { monotonePath, useWidth } from "@/components/reports/useSize";
import type { ViewProps } from "../DatabaseView";
import { chartData, foldTail, niceTicks, type ChartData, type ChartPoint } from "./chart";

const PLOT_H = 280;
/** A bar or column is never thicker than this; the rest of its band is air. */
const THICK = 24;
const ROW = 30;
/** Donut slices before the rest fold into "other". */
const SLICES = 8;

const toneClass = (pt: ChartPoint) => `db-bar-${pt.tone ?? "blue"}`;

export default function ChartView(p: ViewProps) {
  const { t, i18n } = useTranslation("wiki");
  const lang = i18n.resolvedLanguage ?? "en";
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const chart = p.view.settings?.chart;
  const xName = p.db.properties.find((x) => x.id === chart?.x)?.name ?? "";
  const data = chartData(p.rows, chart, p.ctx, { none: t("db.noValue", { name: xName }), checked: t("db.checked"), unchecked: t("db.unchecked") }, lang);
  const kind = chart?.kind ?? "column";
  // A donut shows shares, at most eight; a line runs through values, so rows without one sit out.
  const points = !data ? [] : kind === "donut" ? foldTail(data, SLICES, t("db.chartView.other"), p.ctx).filter((pt) => pt.value > 0) : kind === "line" ? data.points.filter((pt) => pt.key !== NO_VALUE) : data.points;

  // The measured box stays mounted, so the width is known once there is something to draw.
  if (!data || !points.length)
    return (
      <div ref={ref} className="pb-2">
        <Empty>{t("db.chartEmpty")}</Empty>
      </div>
    );

  const caption = data.fn === "count" ? t("db.chartView.count", { x: data.x.name }) : t(`db.chartView.${data.fn}`, { x: data.x.name, y: data.y?.name ?? "" });
  const tick = data.tick;
  const total = points.reduce((a, b) => a + b.value, 0);
  const move = (dir: 1 | -1) => setHover((h) => (h === null ? (dir > 0 ? 0 : points.length - 1) : Math.min(points.length - 1, Math.max(0, h + dir))));

  const plot = (() => {
    if (width <= 0) return null;
    const props = { points, data, width, hover, setHover, tick };
    switch (kind) {
      case "bar":
        return <Bars {...props} />;
      case "donut":
        return <Donut {...props} total={total} totalLabel={t("db.total")} />;
      case "line":
        return <Line {...props} />;
      default:
        return <Columns {...props} />;
    }
  })();
  const h = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} className="pb-2">
      <p className="mb-2 truncate pl-0.5 text-[12.5px] text-fg-3">{caption}</p>
      <div
        role="img"
        tabIndex={0}
        aria-label={caption}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
          else if (e.key === "Escape") setHover(null);
          else return;
          e.preventDefault();
        }}
        onBlur={() => setHover(null)}
        className="relative w-full select-none rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-safe:animate-fade-in"
      >
        {plot}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {h ? `${h.label}: ${data.format(h.value)}` : ""}
      </span>
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {points.map((pt) => (
            <tr key={pt.key}>
              <th scope="row">{pt.label}</th>
              <td>{data.format(pt.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PlotProps = {
  points: ChartPoint[];
  data: ChartData;
  width: number;
  hover: number | null;
  setHover: (i: number | null) => void;
  tick: (n: number) => string;
};

/** A path for a bar with a 4px round end away from the baseline and a square one on it. */
function barPath(x: number, y: number, w: number, h: number, end: "top" | "bottom" | "left" | "right"): string {
  if (w <= 0 || h <= 0) return "";
  const r = end === "top" || end === "bottom" ? Math.min(4, w / 2, h) : Math.min(4, h / 2, w);
  switch (end) {
    case "top":
      return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    case "bottom":
      return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
    case "right":
      return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    case "left":
      return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
  }
}

/** Rough text width at 11px, for fitting labels without measuring the DOM. */
const textW = (s: string, size = 11) => s.length * size * 0.56;

const markCls = (hover: number | null, i: number) => cn("transition-opacity duration-100 motion-reduce:transition-none", hover !== null && hover !== i && "opacity-45");

function Columns({ points, data, width, hover, setHover, tick }: PlotProps) {
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const ML = Math.max(28, ...ticks.map((v) => textW(tick(v), 10.5))) + 10;
  const MT = 18;
  const MB = 28;
  const H = PLOT_H - MT - MB;
  const plotW = Math.max(1, width - ML - 4);
  const band = plotW / points.length;
  const thick = Math.min(THICK, Math.max(2, band * 0.62));
  const y = (v: number) => MT + H - ((v - lo) / (hi - lo || 1)) * H;
  const base = y(0);
  const step = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 72))));
  const showValues = points.every((p) => textW(data.short(p.value)) <= band - 4);
  return (
    <div className="relative" style={{ height: PLOT_H }}>
      <svg width={width} height={PLOT_H} className="block overflow-visible" aria-hidden>
        <Grid ticks={ticks} y={y} x0={ML} x1={ML + plotW} tick={tick} />
        {points.map((pt, i) => {
          const cx = ML + band * i + band / 2;
          const top = Math.min(y(pt.value), base);
          const hgt = Math.abs(y(pt.value) - base);
          return (
            <g key={pt.key} className={cn(toneClass(pt), markCls(hover, i))} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={ML + band * i} y={MT} width={band} height={H} fill="transparent" />
              <path d={barPath(cx - thick / 2, top, thick, hgt, pt.value >= 0 ? "top" : "bottom")} fill="var(--db-bar)" />
              {showValues && (
                <text x={cx} y={pt.value >= 0 ? top - 5 : top + hgt + 12} textAnchor="middle" className="mono" fontSize={10.5} fill="var(--fg-2)">
                  {data.short(pt.value)}
                </text>
              )}
              {i % step === 0 && <AxisLabel x={cx} y={MT + H + 17} width={band * step - 6} text={pt.label} />}
            </g>
          );
        })}
        <line x1={ML} x2={ML + plotW} y1={base} y2={base} stroke="var(--line)" shapeRendering="crispEdges" />
      </svg>
      {hover !== null && <Tip pt={points[hover]} data={data} left={ML + band * hover + band / 2} top={Math.min(y(points[hover].value), base)} width={width} />}
    </div>
  );
}

function Bars({ points, data, width, hover, setHover, tick }: PlotProps) {
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const labelW = Math.min(Math.max(...points.map((p) => textW(p.label, 12))) + 12, Math.max(80, width * 0.3));
  const valueW = Math.max(...points.map((p) => textW(data.short(p.value), 10.5))) + 10;
  const MB = 24;
  const H = points.length * ROW;
  const plotW = Math.max(1, width - labelW - valueW);
  const x = (v: number) => labelW + ((v - lo) / (hi - lo || 1)) * plotW;
  const base = x(0);
  const thick = Math.min(THICK, ROW - 10);
  return (
    <div className="relative" style={{ height: H + MB }}>
      <svg width={width} height={H + MB} className="block overflow-visible" aria-hidden>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={0} y2={H} stroke="var(--line-soft)" shapeRendering="crispEdges" />
            <text x={x(v)} y={H + 16} textAnchor="middle" className="mono" fontSize={10.5} fill="var(--fg-4)">
              {tick(v)}
            </text>
          </g>
        ))}
        {points.map((pt, i) => {
          const cy = i * ROW + ROW / 2;
          const left = Math.min(x(pt.value), base);
          const w = Math.abs(x(pt.value) - base);
          return (
            <g key={pt.key} className={cn(toneClass(pt), markCls(hover, i))} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={i * ROW} width={width} height={ROW} fill="transparent" />
              <AxisLabel x={labelW - 10} y={cy + 4} width={labelW - 12} text={pt.label} anchor="end" size={12} />
              <path d={barPath(left, cy - thick / 2, w, thick, pt.value >= 0 ? "right" : "left")} fill="var(--db-bar)" />
              <text x={pt.value >= 0 ? left + w + 6 : left - 6} y={cy} dy="0.32em" textAnchor={pt.value >= 0 ? "start" : "end"} className="mono" fontSize={10.5} fill="var(--fg-2)">
                {data.short(pt.value)}
              </text>
            </g>
          );
        })}
        <line x1={base} x2={base} y1={0} y2={H} stroke="var(--line)" shapeRendering="crispEdges" />
      </svg>
      {hover !== null && <Tip pt={points[hover]} data={data} left={Math.max(x(points[hover].value), base)} top={hover * ROW + 2} width={width} />}
    </div>
  );
}

function Line({ points, data, width, hover, setHover, tick }: PlotProps) {
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const ML = Math.max(28, ...ticks.map((v) => textW(tick(v), 10.5))) + 10;
  const MR = Math.max(24, textW(data.short(values[values.length - 1]), 11) + 14);
  const MT = 12;
  const MB = 28;
  const H = PLOT_H - MT - MB;
  const plotW = Math.max(1, width - ML - MR);
  const x = (i: number) => ML + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => MT + H - ((v - lo) / (hi - lo || 1)) * H;
  const pts = points.map((p, i) => [x(i), y(p.value)] as [number, number]);
  const d = monotonePath(pts);
  const last = points.length - 1;
  const step = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 72))));
  const dots = plotW / points.length >= 12;
  const pick = (clientX: number, rect: DOMRect) => {
    const i = points.length <= 1 ? 0 : Math.round(((clientX - rect.left - ML) / plotW) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };
  return (
    <div className="relative db-bar-blue" style={{ height: PLOT_H }} onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={PLOT_H} className="block overflow-visible" aria-hidden>
        <Grid ticks={ticks} y={y} x0={ML} x1={ML + plotW} tick={tick} />
        <line x1={ML} x2={ML + plotW} y1={y(0)} y2={y(0)} stroke="var(--line)" shapeRendering="crispEdges" />
        {points.map((pt, i) => (i % step === 0 ? <AxisLabel key={pt.key} x={x(i)} y={MT + H + 17} width={(plotW / Math.max(1, last)) * step - 6} text={pt.label} /> : null))}
        {pts.length > 1 && <path d={`${d}L${x(last)},${y(Math.max(lo, 0))}L${x(0)},${y(Math.max(lo, 0))}Z`} fill="var(--db-bar)" fillOpacity={0.1} />}
        <path d={d} fill="none" stroke="var(--db-bar)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={MT} y2={MT + H} stroke="var(--line-strong)" shapeRendering="crispEdges" />}
        {pts.map(([cx, cy], i) => (dots || i === hover || i === last ? <circle key={points[i].key} cx={cx} cy={cy} r={4} fill="var(--db-bar)" stroke="var(--surface)" strokeWidth={2} /> : null))}
        {hover === null && (
          <text x={x(last) + 9} y={y(values[last])} dy="0.32em" className="mono" fontSize={11} fill="var(--fg-2)">
            {data.short(values[last])}
          </text>
        )}
      </svg>
      {hover !== null && <Tip pt={points[hover]} data={data} left={x(hover)} top={y(points[hover].value)} width={width} line />}
    </div>
  );
}

function Donut({ points, data, width, hover, setHover, total, totalLabel }: PlotProps & { total: number; totalLabel: string }) {
  const size = Math.min(PLOT_H - 40, width);
  const r = size / 2;
  const ring = Math.max(18, Math.round(r * 0.26));
  const cx = r;
  const cy = r;
  let angle = -Math.PI / 2;
  const arcs = points.map((pt) => {
    const a0 = angle;
    const a1 = angle + (pt.value / total) * Math.PI * 2;
    angle = a1;
    return { pt, d: arcPath(cx, cy, r, r - ring, a0, a1) };
  });
  const side = width >= size + 220;
  const h = hover !== null ? points[hover] : null;
  return (
    <div className={cn("flex items-center gap-8", side ? "flex-row" : "flex-col")} style={side ? { minHeight: PLOT_H } : undefined}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="block" aria-hidden>
          {arcs.map((a, i) => (
            <path
              key={a.pt.key}
              d={a.d}
              className={cn(toneClass(a.pt), markCls(hover, i))}
              fill="var(--db-bar)"
              stroke="var(--surface)"
              strokeWidth={2}
              strokeLinejoin="round"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[22px] font-semibold tracking-[-0.02em] text-fg">{data.short(h ? h.value : total)}</span>
          <span className="max-w-[60%] truncate text-[11.5px] text-fg-3">{h ? `${h.label} · ${formatPercent(h.value / total)}` : totalLabel}</span>
        </div>
      </div>
      <ul className="flex min-w-0 max-w-[320px] flex-1 flex-col gap-px">
        {points.map((pt, i) => (
          <li
            key={pt.key}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors duration-100 motion-reduce:transition-none", hover === i && "bg-hover")}
          >
            <span className={cn("size-2 shrink-0 rounded-[2px]", toneClass(pt))} style={{ background: "var(--db-bar)" }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg-2">{pt.label}</span>
            <span className="mono shrink-0 text-[12px] font-medium tabular-nums text-fg">{data.format(pt.value)}</span>
            <span className="mono w-11 shrink-0 text-right text-[11px] tabular-nums text-fg-4">{formatPercent(pt.value / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A ring slice from a0 to a1 (radians, clockwise from 3 o'clock). */
function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  // A whole ring is two halves: an arc can't start and end on the same point.
  if (a1 - a0 >= Math.PI * 2 - 1e-6) return arcPath(cx, cy, r, inner, a0, a0 + Math.PI) + arcPath(cx, cy, r, inner, a0 + Math.PI, a1);
  const pt = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r, a0)}A${r},${r} 0 ${large} 1 ${pt(r, a1)}L${pt(inner, a1)}A${inner},${inner} 0 ${large} 0 ${pt(inner, a0)}Z`;
}

function Grid({ ticks, y, x0, x1, tick }: { ticks: number[]; y: (v: number) => number; x0: number; x1: number; tick: (n: number) => string }) {
  return (
    <>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x0} x2={x1} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" shapeRendering="crispEdges" />
          <text x={x0 - 8} y={y(v)} dy="0.32em" textAnchor="end" className="mono" fontSize={10.5} fill="var(--fg-4)">
            {tick(v)}
          </text>
        </g>
      ))}
    </>
  );
}

/** A category name under or beside its mark, cut with an ellipsis to the room it has. */
function AxisLabel({ x, y, width, text, anchor = "middle", size = 11 }: { x: number; y: number; width: number; text: string; anchor?: "middle" | "end"; size?: number }) {
  const room = Math.max(0, Math.floor(width / (size * 0.56)));
  const shown = text.length > room ? (room > 1 ? text.slice(0, room - 1) + "…" : "") : text;
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={size} fill="var(--fg-3)">
      <title>{text}</title>
      {shown}
    </text>
  );
}

/** The value first, then its group, keyed with a short stroke of the mark's colour. */
function Tip({ pt, data, left, top, width, line }: { pt: ChartPoint; data: ChartData; left: number; top: number; width: number; line?: boolean }) {
  const flip = left > width - 180;
  return (
    <div
      role="presentation"
      className={cn("pointer-events-none absolute z-10 min-w-[120px] max-w-[240px] rounded-lg border border-line bg-raised px-2.5 py-1.5 shadow-pop", toneClass(line ? { ...pt, tone: undefined } : pt))}
      style={{ left: flip ? left - 12 : left + 12, top: Math.max(0, top - 8), transform: flip ? "translateX(-100%)" : undefined }}
    >
      <div className="mono text-[13px] font-semibold tabular-nums text-fg">{data.format(pt.value)}</div>
      <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
        <span className="h-[2px] w-2.5 shrink-0 rounded-full" style={{ background: "var(--db-bar)" }} aria-hidden />
        <span className="truncate">{pt.label}</span>
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line px-6 py-10 text-center">
      <span className="flex size-9 items-center justify-center rounded-lg bg-sunken text-fg-3 shadow-[inset_0_0_0_1px_var(--line)]">
        <BarChart3 className="size-4" />
      </span>
      <p className="max-w-[340px] text-[12.5px] text-fg-3">{children}</p>
    </div>
  );
}
