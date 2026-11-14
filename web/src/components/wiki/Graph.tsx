// The team wiki as a graph of pages and the links between them, drawn on a canvas.
// The layout is graphLayout.ts; this file draws it and handles pointer and keys.
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { WikiLink, WikiNode } from "@/lib/api/types";
import { ALPHA_MIN, buildGraph, clampZoom, cool, fitView, radius, settle, step, type GNode, type Graph, type View } from "./graphLayout";

type Props = {
  nodes: WikiNode[];
  links: WikiLink[];
  focus?: string;
  depth?: 1 | 2;
  subpageLinks?: boolean;
  orphans?: boolean;
  tag?: string;
  query?: string;
  height?: number | string;
  /** A small graph beside a page: one colour, labels only on hover and the focus. */
  compact?: boolean;
  onOpen: (id: string) => void;
};

const PAN_KEYS: Record<string, [number, number] | undefined> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };

const TONES = ["blue", "teal", "amber", "pink", "green", "orange", "indigo"];

type Colours = { node: string; focus: string; edge: string; label: string; halo: string; tones: string[]; font: string };

function readColours(el: Element): Colours {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    node: v("--fg-3", "#737373"),
    focus: v("--tone-violet-solid", "#7048e8"),
    edge: v("--line-strong", "#d6d6d6"),
    label: v("--fg-2", "#4a4a4a"),
    halo: v("--surface", "#ffffff"),
    tones: TONES.map((t) => v(`--tone-${t}-solid`, "#737373")),
    font: v("--font-sans", '"Geist Variable", sans-serif'),
  };
}

type Drag =
  | { kind: "node"; i: number; x0: number; y0: number; moved: boolean }
  | { kind: "pan"; x0: number; y0: number; view: View }
  | { kind: "pinch"; d0: number; k0: number };

/** Everything the frame loop reads and writes, kept out of React state so a frame never re-renders. */
type Sim = {
  g: Graph;
  alpha: number;
  view: View;
  size: { w: number; h: number; dpr: number };
  hover: number;
  /** The hovered node and its neighbours. */
  lit: Set<number>;
  drag: Drag | null;
  pointers: Map<number, { x: number; y: number }>;
  /** Until the user pans or zooms, the view follows the layout and fits it once it settles. */
  userView: boolean;
  colours: Colours | null;
  raf: number;
};

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function WikiGraph({ nodes, links, focus, depth, subpageLinks = true, orphans = true, tag, query, height = "100%", compact = false, onOpen }: Props) {
  const { t } = useTranslation("wiki");
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onOpenRef = useRef(onOpen);
  const simRef = useRef<Sim | null>(null);
  const loopRef = useRef<{ wake: () => void; fit: () => void } | null>(null);
  // Drawing reads props through a ref, so the frame loop never needs re-binding.
  const drawRef = useRef<(ctx: CanvasRenderingContext2D, sim: Sim) => void>(() => {});

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  const graph = useMemo(
    () => buildGraph(nodes, links, { subpageLinks, orphans, focus, depth, tag, query }),
    [nodes, links, subpageLinks, orphans, focus, depth, tag, query],
  );

  // A colour per top-level page with subpages; a lone page stays grey.
  const groupTone = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const n of graph.nodes) sizes.set(n.group, (sizes.get(n.group) ?? 0) + 1);
    const tones = new Map<string, number>();
    for (const [group, size] of sizes) if (size > 1) tones.set(group, tones.size % TONES.length);
    return tones;
  }, [graph]);

  const focusIndex = graph.nodes.findIndex((n) => n.id === focus);

  // The frame loop and its listeners, once per mount.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;
    const sim: Sim = {
      g: { nodes: [], edges: [] },
      alpha: 0,
      view: { x: 0, y: 0, k: 1 },
      size: { w: 0, h: 0, dpr: 1 },
      hover: -1,
      lit: new Set(),
      drag: null,
      pointers: new Map(),
      userView: false,
      colours: readColours(wrap),
      raf: 0,
    };
    simRef.current = sim;

    const fit = () => {
      if (sim.size.w) sim.view = fitView(sim.g.nodes, sim.size.w, sim.size.h);
    };
    const frame = () => {
      sim.raf = 0;
      const running = sim.alpha > ALPHA_MIN && !reducedMotion();
      if (running) {
        step(sim.g, sim.alpha);
        // A held node keeps the layout warm so its neighbours follow it.
        sim.alpha = sim.drag?.kind === "node" ? Math.max(cool(sim.alpha), 0.1) : cool(sim.alpha);
      }
      if (!sim.userView && sim.size.w) {
        // Ease towards the fit while the layout spreads out, then land on it exactly.
        const t = fitView(sim.g.nodes, sim.size.w, sim.size.h);
        const ease = running ? 0.12 : 1;
        sim.view = { x: sim.view.x + (t.x - sim.view.x) * ease, y: sim.view.y + (t.y - sim.view.y) * ease, k: sim.view.k + (t.k - sim.view.k) * ease };
      }
      paint();
      if (sim.alpha > ALPHA_MIN && !reducedMotion()) sim.raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!sim.raf) sim.raf = requestAnimationFrame(frame);
    };
    loopRef.current = { wake, fit };

    const paint = () => drawRef.current(ctx, sim);

    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      sim.size = { w: width, h: height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      wake();
    });
    resize.observe(wrap);

    // The theme is a class on <html>: read the colours again when it changes.
    const theme = new MutationObserver(() => {
      sim.colours = readColours(wrap);
      wake();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    const world = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      return { sx, sy, x: (sx - sim.view.x) / sim.view.k, y: (sy - sim.view.y) / sim.view.k };
    };
    const hit = (x: number, y: number) => {
      // Topmost first; a few screen pixels of slack so small nodes are easy to catch.
      const slack = 4 / sim.view.k;
      for (let i = sim.g.nodes.length - 1; i >= 0; i--) {
        const n = sim.g.nodes[i];
        const r = radius(n.degree) + slack;
        if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return i;
      }
      return -1;
    };
    const setHover = (i: number) => {
      if (i === sim.hover) return;
      sim.hover = i;
      sim.lit = new Set(i < 0 ? [] : [i]);
      for (const e of i < 0 ? [] : sim.g.edges) {
        if (e.a === i) sim.lit.add(e.b);
        else if (e.b === i) sim.lit.add(e.a);
      }
      canvas.style.cursor = i < 0 ? "" : "pointer";
      wake();
    };
    const zoomAt = (sx: number, sy: number, k: number) => {
      const v = sim.view;
      const nk = clampZoom(k);
      sim.view = { k: nk, x: sx - ((sx - v.x) * nk) / v.k, y: sy - ((sy - v.y) * nk) / v.k };
      sim.userView = true;
      wake();
    };
    const pinchDistance = () => {
      const [a, b] = [...sim.pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      sim.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (sim.pointers.size === 2) {
        if (sim.drag?.kind === "node") sim.g.nodes[sim.drag.i].fixed = false;
        sim.drag = { kind: "pinch", d0: pinchDistance(), k0: sim.view.k };
        return;
      }
      const p = world(e);
      const i = hit(p.x, p.y);
      if (i >= 0) {
        sim.g.nodes[i].fixed = true;
        sim.drag = { kind: "node", i, x0: p.sx, y0: p.sy, moved: false };
      } else sim.drag = { kind: "pan", x0: p.sx, y0: p.sy, view: sim.view };
    };
    const move = (e: PointerEvent) => {
      if (sim.pointers.has(e.pointerId)) sim.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = world(e);
      const d = sim.drag;
      if (!d) return setHover(hit(p.x, p.y));
      if (d.kind === "pinch" && sim.pointers.size === 2) {
        const [a, b] = [...sim.pointers.values()];
        const mid = world({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        zoomAt(mid.sx, mid.sy, (d.k0 * pinchDistance()) / d.d0);
      } else if (d.kind === "node") {
        if (!d.moved && Math.hypot(p.sx - d.x0, p.sy - d.y0) < 4) return;
        d.moved = true;
        const n = sim.g.nodes[d.i];
        n.x = p.x;
        n.y = p.y;
        sim.alpha = Math.max(sim.alpha, 0.3);
        // The camera stops following the layout once a page has been moved by hand.
        sim.userView = true;
        wake();
      } else if (d.kind === "pan") {
        sim.view = { ...d.view, x: d.view.x + p.sx - d.x0, y: d.view.y + p.sy - d.y0 };
        sim.userView = true;
        wake();
      }
    };
    const up = (e: PointerEvent) => {
      sim.pointers.delete(e.pointerId);
      const d = sim.drag;
      sim.drag = null;
      if (d?.kind !== "node") return;
      sim.g.nodes[d.i].fixed = false;
      if (!d.moved && e.type === "pointerup") onOpenRef.current(sim.g.nodes[d.i].id);
    };
    const leave = () => {
      if (!sim.drag) setHover(-1);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = world(e);
      // A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(p.sx, p.sy, sim.view.k * Math.exp(-e.deltaY * speed));
    };
    const dblclick = (e: MouseEvent) => {
      const p = world(e);
      if (hit(p.x, p.y) >= 0) return;
      fit();
      wake();
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    // Not passive, so the page does not scroll while zooming.
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", dblclick);
    return () => {
      cancelAnimationFrame(sim.raf);
      resize.disconnect();
      theme.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", dblclick);
      simRef.current = null;
      loopRef.current = null;
    };
  }, []);

  // A new graph keeps the positions of the pages it shares with the old one, so a
  // filter change or a live edit settles from where things were instead of starting over.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const old = new Map(sim.g.nodes.map((n) => [n.id, n]));
    let kept = 0;
    for (const n of graph.nodes) {
      const o = old.get(n.id);
      if (!o) continue;
      kept++;
      n.x = o.x;
      n.y = o.y;
    }
    sim.g = graph;
    sim.hover = -1;
    sim.lit = new Set();
    sim.drag = null;
    sim.alpha = kept === graph.nodes.length && kept === old.size ? Math.max(sim.alpha, 0.05) : kept ? 0.5 : 1;
    if (!kept) sim.userView = false;
    if (reducedMotion()) {
      settle(graph, 300, sim.alpha);
      sim.alpha = 0;
    }
    loopRef.current?.wake();
  }, [graph]);

  useEffect(() => {
    drawRef.current = (ctx, sim) => draw(ctx, sim, { compact, focusIndex, groupTone });
    loopRef.current?.wake();
  }, [compact, focusIndex, groupTone]);

  const keyDown = (e: KeyboardEvent) => {
    const sim = simRef.current;
    const loop = loopRef.current;
    if (!sim || !loop) return;
    const pan = PAN_KEYS[e.key];
    const zoom = e.key === "+" || e.key === "=" ? 1.25 : e.key === "-" || e.key === "_" ? 0.8 : 0;
    if (pan) sim.view = { ...sim.view, x: sim.view.x + pan[0], y: sim.view.y + pan[1] };
    else if (zoom) {
      const k = clampZoom(sim.view.k * zoom);
      const { w, h } = sim.size;
      sim.view = { k, x: w / 2 - ((w / 2 - sim.view.x) * k) / sim.view.k, y: h / 2 - ((h / 2 - sim.view.y) * k) / sim.view.k };
    } else if (e.key === "0") loop.fit();
    else return;
    e.preventDefault();
    sim.userView = true;
    loop.wake();
  };

  return (
    <div ref={wrapRef} className="relative min-h-0 w-full overflow-hidden" style={{ height }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={t("graph.canvas", { count: graph.nodes.length })}
        onKeyDown={keyDown}
        className="absolute inset-0 size-full touch-none select-none rounded-[inherit] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
      />
      <ul className="sr-only">
        {graph.nodes.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onOpen(n.id)}>
              {n.icon ? `${n.icon} ${n.title}` : n.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Look = { compact: boolean; focusIndex: number; groupTone: Map<string, number> };

function draw(ctx: CanvasRenderingContext2D, sim: Sim, look: Look) {
  const { w, h, dpr } = sim.size;
  const c = sim.colours;
  if (!c || !w) return;
  const { nodes, edges } = sim.g;
  const { x, y, k } = sim.view;
  const hovering = sim.hover >= 0;
  const dim = (i: number) => (hovering && !sim.lit.has(i) ? 0.15 : 1);
  const fill = (n: GNode, i: number) => {
    if (i === look.focusIndex) return c.focus;
    const tone = look.compact ? undefined : look.groupTone.get(n.group);
    return tone === undefined ? c.node : c.tones[tone];
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);

  // Edges: hairlines at any zoom, subpages dashed.
  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = c.edge;
  for (const dashed of [false, true]) {
    ctx.setLineDash(dashed ? [3 / k, 3 / k] : []);
    for (const e of edges) {
      if ((e.kind === "subpage") !== dashed) continue;
      const lit = hovering && (e.a === sim.hover || e.b === sim.hover);
      ctx.globalAlpha = hovering ? (lit ? 1 : 0.15) : 0.85;
      if (lit) ctx.strokeStyle = fill(nodes[sim.hover], sim.hover);
      ctx.beginPath();
      ctx.moveTo(nodes[e.a].x, nodes[e.a].y);
      ctx.lineTo(nodes[e.b].x, nodes[e.b].y);
      ctx.stroke();
      if (lit) ctx.strokeStyle = c.edge;
    }
  }
  ctx.setLineDash([]);

  nodes.forEach((n, i) => {
    ctx.globalAlpha = dim(i);
    ctx.fillStyle = fill(n, i);
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius(n.degree), 0, Math.PI * 2);
    ctx.fill();
    if (i === sim.hover || i === look.focusIndex) {
      // A ring marks the page under the pointer and the page the graph is about.
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n.degree) + 3 / k, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  // Labels in screen space, so they stay 11px at any zoom. They fade in past 0.8x
  // and are all shown from 1.2x; the hovered page, its neighbours and the focus always.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `11px ${c.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = c.halo;
  ctx.fillStyle = c.label;
  const zoomFade = look.compact ? 0 : Math.min(1, Math.max(0, (k - 0.8) / 0.4));
  nodes.forEach((n, i) => {
    const always = i === sim.hover || i === look.focusIndex || (hovering && sim.lit.has(i) && !look.compact);
    const alpha = always ? 1 : zoomFade * dim(i);
    if (alpha <= 0.02) return;
    const sx = n.x * k + x;
    const sy = (n.y + radius(n.degree)) * k + y + 4;
    if (sx < -100 || sx > w + 100 || sy < -20 || sy > h + 20) return;
    const text = n.title.length > 40 ? `${n.title.slice(0, 39)}…` : n.title;
    ctx.globalAlpha = alpha;
    ctx.strokeText(text, sx, sy);
    ctx.fillText(text, sx, sy);
  });
  ctx.globalAlpha = 1;
}
