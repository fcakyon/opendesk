// A wiki page that is a canvas (contracts/wiki.md "Canvas"; Obsidian's Canvas): cards of
// text, pages, links, files and groups on an endless board, connected by curves. The board
// pans (drag empty space, Space and drag, scroll) and zooms (Ctrl or Cmd and scroll, pinch,
// the zoom controls); cards select (click, Shift and click, Shift and drag a marquee), move
// (drag, arrow keys; on a grid unless Alt is held), resize, connect from their sides, copy,
// paste, duplicate and delete, with undo. The whole scene is one transformed layer; cards
// are memoized and drags draw once per frame, so hundreds of cards stay smooth.

import { useQuery } from "@tanstack/react-query";
import { useReducedMotion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { RichEditorHandle } from "@/components/editor/RichEditor";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { Canvas, CanvasEdge, CanvasNode, CanvasSide, WikiNode, WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { escapeHtml } from "@/lib/collab/html";
import { q } from "@/lib/queries";
import { RowPeek } from "../database/RowPeek";
import { Card, CardEnvContext, LabelInput, cardLabel, type CardActions, type CardEnv } from "./Cards";
import { FormatBar, Minimap, Toolbar, ZoomHud, type ArrowMode } from "./Chrome";
import { DraftEdge, EdgeLabels, EdgeLayer } from "./Edges";
import {
  GRID,
  MAX_NODES,
  WIKI_SRC,
  anchor,
  boundsOf,
  bringToFront,
  clampZoom,
  cleanUrl,
  dragSet,
  edgeGeometry,
  extract,
  fitView,
  fromApi,
  hitNode,
  historyReducer,
  initHistory,
  isImageName,
  marqueeHits,
  moveNodes,
  nearestSide,
  newId,
  paste,
  placeNode,
  rectFrom,
  removeItems,
  renderOrder,
  resizeRect,
  toScreen,
  toWorld,
  updateEdge,
  updateNode,
  zoomAt,
  type Handle,
  type Point,
  type Rect,
  type Size,
  type View,
} from "./model";
import { useCanvasSync } from "./useCanvasSync";
import "./canvas.css";

type Selection = { nodes: ReadonlySet<string>; edges: ReadonlySet<string> };
const NONE: Selection = { nodes: new Set(), edges: new Set() };
const only = (nodes: Iterable<string> = [], edges: Iterable<string> = []): Selection => ({ nodes: new Set(nodes), edges: new Set(edges) });

type Editing = { kind: "node"; id: string; fresh: boolean } | { kind: "edge"; id: string } | null;

type Gesture =
  | { kind: "pan"; start: Point; view: View; moved: boolean }
  | { kind: "marquee"; start: Point; base: Selection }
  | { kind: "move"; start: Point; screen: Point; ids: Set<string>; moved: boolean; click: string | null }
  | { kind: "resize"; id: string; handle: Handle; start: Point; rect: Rect }
  | { kind: "connect"; from: string; side: CanvasSide; screen: Point }
  | { kind: "pinch"; dist: number; mid: Point; view: View };

/** What Copy puts on the clipboard: the cards, marked so a paste here knows them. */
const CLIP_MARK = "opendesk-canvas:";
let lastClip: Canvas | null = null;

const DRAG_SLOP = 3;
const viewKey = (id: string) => `od:wiki:canvas:view:${id}`;
const miniKey = "od:wiki:canvas:minimap";

function readView(id: string): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(id)) ?? "null") as View | null;
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? { ...v, zoom: clampZoom(v.zoom) } : null;
  } catch {
    return null;
  }
}

const isTyping = (el: EventTarget | null) =>
  el instanceof Element && (!!el.closest("[data-editing]") || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

export default function CanvasView({ page, canEdit }: { page: WikiPage; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const reduceMotion = useReducedMotion();
  const [history, dispatch] = useReducer(historyReducer, page.canvas, (c) => initHistory(fromApi(c)));
  const doc = history.present;
  const { setBusy } = useCanvasSync(page, canEdit, doc, dispatch);
  const docRef = useRef(doc);
  docRef.current = doc;

  const [sel, setSel] = useState<Selection>(NONE);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [editing, setEditing] = useState<Editing>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [editor, setEditor] = useState<RichEditorHandle | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ from: Point; side: CanvasSide; to: Point; toSide: CanvasSide | null } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [space, setSpace] = useState(false);
  const [minimap, setMinimap] = useState(() => {
    try {
      return localStorage.getItem(miniKey) === "1";
    } catch {
      return false;
    }
  });

  // ─── The view ──────────────────────────────────────────────────────────────

  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [view, setViewState] = useState<View>(() => readView(page.id) ?? { x: 0, y: 0, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const anim = useRef(0);
  const placed = useRef(!!readView(page.id));
  const setView = useCallback((next: View | ((v: View) => View)) => {
    cancelAnimationFrame(anim.current);
    setViewState(next);
  }, []);

  /** Glides to a view (fast, eased); jumps there under reduced motion. */
  const glide = useCallback(
    (to: View) => {
      cancelAnimationFrame(anim.current);
      if (reduceMotion) return setViewState(to);
      const from = viewRef.current;
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 200);
        const e = 1 - Math.pow(1 - k, 3);
        setViewState({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, zoom: from.zoom + (to.zoom - from.zoom) * e });
        if (k < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [reduceMotion],
  );

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The first time it opens here, the canvas fits its cards.
  useLayoutEffect(() => {
    if (placed.current || !size.width) return;
    placed.current = true;
    setViewState(fitView(boundsOf(docRef.current.nodes), size));
  }, [size]);

  useEffect(() => {
    const h = setTimeout(() => {
      try {
        localStorage.setItem(viewKey(page.id), JSON.stringify(view));
      } catch {
        // Private mode: the view holds for this visit.
      }
    }, 400);
    return () => clearTimeout(h);
  }, [view, page.id]);

  const center = useCallback((): Point => toWorld(viewRef.current, { x: size.width / 2, y: size.height / 2 }), [size]);
  const zoomBy = useCallback((factor: number) => glide(zoomAt(viewRef.current, { x: size.width / 2, y: size.height / 2 }, viewRef.current.zoom * factor)), [glide, size]);
  const fit = useCallback((ids?: ReadonlySet<string>) => {
    const nodes = ids?.size ? docRef.current.nodes.filter((n) => ids.has(n.id)) : docRef.current.nodes;
    glide(fitView(boundsOf(nodes), size, 72, ids?.size ? 1.5 : 1));
  }, [glide, size]);

  // ─── The cards' surroundings ───────────────────────────────────────────────

  const tree = useQuery(q.wikiTree());
  const pages = useMemo(() => (tree.data ? new Map<string, WikiNode>(tree.data.map((n) => [n.id, n])) : null), [tree.data]);
  const io = useRef<{ obs: IntersectionObserver; cbs: Map<Element, (v: boolean) => void> } | null>(null);
  const observe = useCallback((el: Element, cb: (v: boolean) => void) => {
    if (!io.current) {
      const cbs = new Map<Element, (v: boolean) => void>();
      io.current = { cbs, obs: new IntersectionObserver((entries) => entries.forEach((e) => cbs.get(e.target)?.(e.isIntersecting)), { root: root.current, rootMargin: "240px" }) };
    }
    const { obs, cbs } = io.current;
    cbs.set(el, cb);
    obs.observe(el);
    return () => {
      cbs.delete(el);
      obs.unobserve(el);
    };
  }, []);
  useEffect(() => () => io.current?.obs.disconnect(), []);
  const env = useMemo<CardEnv>(() => ({ pages, observe }), [pages, observe]);

  const byId = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes]);
  const selectedNodes = useMemo(() => doc.nodes.filter((n) => sel.nodes.has(n.id)), [doc.nodes, sel.nodes]);
  const selectedEdges = useMemo(() => doc.edges.filter((e) => sel.edges.has(e.id)), [doc.edges, sel.edges]);

  // ─── Edits ─────────────────────────────────────────────────────────────────

  const set = useCallback((next: Canvas | ((d: Canvas) => Canvas)) => dispatch({ type: "set", doc: next }), []);

  const focusCard = useCallback((id: string) => {
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
  }, []);

  const exitEdit = useCallback(() => {
    const e = editingRef.current;
    if (!e) return;
    if (e.kind === "node") {
      const n = docRef.current.nodes.find((x) => x.id === e.id);
      // A card made to type in and left empty goes again, as if never made.
      if (e.fresh && n?.type === "text" && !n.html.trim()) {
        dispatch({ type: "cancel" });
        setSel(NONE);
      } else dispatch({ type: "commit" });
      if (n) focusCard(n.id);
    }
    setEditing(null);
    setEditor(null);
    setBusy(false);
  }, [focusCard, setBusy]);

  const startEdit = useCallback(
    (id: string, fresh = false) => {
      if (!canEdit) return;
      setSel(only([id]));
      setEditing({ kind: "node", id, fresh });
      setBusy(true);
    },
    [canEdit, setBusy],
  );

  const actions = useMemo<CardActions>(
    () => ({
      textChange: (id, html) => dispatch({ type: "preview", doc: (d) => updateNode(d, id, { html }) }),
      exitEdit,
      labelChange: (id, label) => dispatch({ type: "set", doc: (d) => updateNode(d, id, { label }) }),
    }),
    [exitEdit],
  );

  const full = () => {
    if (docRef.current.nodes.length < MAX_NODES) return false;
    toast.error(t("canvas.full"));
    return true;
  };

  const addText = useCallback(
    (at: Point, html = "", edit = true) => {
      if (full()) return null;
      const n = placeNode("text", at, { html });
      if (edit) {
        dispatch({ type: "preview", doc: (d) => ({ ...d, nodes: [...d.nodes, n] }) });
        startEdit(n.id, true);
      } else {
        set((d) => ({ ...d, nodes: [...d.nodes, n] }));
        setSel(only([n.id]));
      }
      return n;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [set, startEdit],
  );

  const addNode = (n: CanvasNode) => {
    if (full()) return;
    set((d) => ({ ...d, nodes: [...d.nodes, n] }));
    setSel(only([n.id]));
  };

  const addLink = (url: string, at = center()) => {
    if (full()) return;
    const n = placeNode("link", at, { url });
    addNode(n);
    api.wiki
      .unfurl(url)
      .then((card) => {
        const image = card.image && WIKI_SRC.test(card.image) ? card.image : undefined;
        dispatch({ type: "amend", doc: (d) => updateNode(d, n.id, { title: card.title.slice(0, 300) || undefined, description: card.description.slice(0, 500) || undefined, image }) });
      })
      .catch(() => {
        // The card keeps its address alone, as a bookmark does.
      });
  };

  const addFiles = async (files: File[], at = center()) => {
    for (const [i, f] of files.entries()) {
      if (full()) return;
      try {
        const a = await api.attachments.upload(f);
        const image = isImageName(a.filename) || a.content_type.startsWith("image/");
        const name = image && !isImageName(a.filename) ? `${a.filename}.png` : a.filename;
        addNode(placeNode("file", { x: at.x + i * GRID * 2, y: at.y + i * GRID * 2 }, { src: a.url, name, ...(image ? {} : { width: 280, height: 80 }) }));
      } catch (e) {
        toast.error(e, t("canvas.uploadFailed"));
      }
    }
  };

  const addGroup = () => {
    if (full()) return;
    const around = boundsOf(selectedNodes);
    const pad = GRID * 2;
    const g = around
      ? ({ id: newId(), type: "group", x: around.x - pad, y: around.y - pad * 2, width: around.width + pad * 2, height: around.height + pad * 3 } as CanvasNode)
      : placeNode("group", center(), {});
    // A group goes under the cards (first in the order), so it never covers them.
    set((d) => ({ ...d, nodes: [g, ...d.nodes] }));
    setSel(only([g.id]));
    setEditing({ kind: "node", id: g.id, fresh: false });
  };

  const deleteSelection = () => {
    const s = selRef.current;
    if (!s.nodes.size && !s.edges.size) return;
    set((d) => removeItems(d, s.nodes, s.edges));
    setSel(NONE);
    root.current?.focus({ preventScroll: true });
  };

  const duplicate = () => {
    const s = selRef.current;
    if (!s.nodes.size) return;
    const { doc: next, ids } = paste(docRef.current, extract(docRef.current, s.nodes), null);
    set(next);
    setSel(only(ids));
  };

  const setColor = (color: string | undefined) => {
    const s = selRef.current;
    set((d) => ({
      nodes: d.nodes.map((n) => (s.nodes.has(n.id) ? ({ ...n, color } as CanvasNode) : n)),
      edges: d.edges.map((e) => (s.edges.has(e.id) ? { ...e, color } : e)),
    }));
  };

  const setArrows = (mode: ArrowMode) => {
    const [id] = selRef.current.edges;
    if (!id) return;
    set((d) => updateEdge(d, id, { fromEnd: mode === "both" ? "arrow" : "none", toEnd: mode === "none" ? "none" : "arrow" }));
  };

  /** What a double-click or Enter does to a card. */
  const activate = (n: CanvasNode) => {
    switch (n.type) {
      case "text":
        return startEdit(n.id);
      case "group":
        if (canEdit) setEditing({ kind: "node", id: n.id, fresh: false });
        return;
      case "page":
        if (pages?.has(n.page_id)) setPeek(n.page_id);
        return;
      case "link":
        return void window.open(n.url, "_blank", "noopener,noreferrer");
      case "file":
        return void window.open(n.src, "_blank", "noopener,noreferrer");
    }
  };

  // ─── Pointer ───────────────────────────────────────────────────────────────

  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const lastPointer = useRef<Point | null>(null);
  const frame = useRef(0);
  const latest = useRef<{ x: number; y: number; alt: boolean } | null>(null);
  const focusByPointer = useRef(false);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inside = (e: { target: EventTarget | null }) => !!root.current && e.target instanceof Node && root.current.contains(e.target);

  const run = useCallback(() => {
    frame.current = 0;
    const g = gesture.current;
    const p = latest.current;
    if (!g || !p) return;
    const v = viewRef.current;
    const w = toWorld(v, p);
    switch (g.kind) {
      case "pan": {
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        g.moved = true;
        setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
        return;
      }
      case "marquee": {
        const r = rectFrom(g.start, p);
        setMarquee(r);
        const tl = toWorld(v, { x: r.x, y: r.y });
        const hits = marqueeHits(docRef.current.nodes, { x: tl.x, y: tl.y, width: r.width / v.zoom, height: r.height / v.zoom });
        setSel({ nodes: new Set([...g.base.nodes, ...hits]), edges: g.base.edges });
        return;
      }
      case "move": {
        if (!g.moved && Math.hypot(p.x - g.screen.x, p.y - g.screen.y) < DRAG_SLOP) return;
        if (!g.moved) {
          g.moved = true;
          setBusy(true);
        }
        dispatch({ type: "preview", doc: moveNodes(historyBase(), g.ids, w.x - g.start.x, w.y - g.start.y, p.alt ? 0 : GRID) });
        return;
      }
      case "resize": {
        const r = resizeRect(g.rect, g.handle, w.x - g.start.x, w.y - g.start.y, p.alt ? 0 : GRID);
        setBusy(true);
        dispatch({ type: "preview", doc: (d) => updateNode(d, g.id, r) });
        return;
      }
      case "connect": {
        const from = docRef.current.nodes.find((n) => n.id === g.from);
        if (!from) return;
        const target = hitNode(docRef.current.nodes.filter((n) => n.id !== g.from && n.type !== "group"), w) ?? hitNode(docRef.current.nodes.filter((n) => n.id !== g.from), w);
        const toSide = target ? nearestSide(target, w) : null;
        setDraft({ from: anchor(from, g.side), side: g.side, to: target && toSide ? anchor(target, toSide) : w, toSide });
        return;
      }
      case "pinch":
        return;
    }
  }, [setBusy, setView]);

  // The canvas before the gesture under way: drags apply their whole offset to it each frame.
  const historyRef = useRef(history);
  historyRef.current = history;
  const historyBase = () => historyRef.current.base ?? historyRef.current.present;

  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(run);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!inside(e)) return;
    const target = e.target as Element;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    focusByPointer.current = true;
    if (pointers.current.size === 2) {
      // Two fingers: pinch to zoom, whatever the first one started.
      if (gesture.current?.kind === "move" || gesture.current?.kind === "resize") dispatch({ type: "cancel" });
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: viewRef.current };
      setMarquee(null);
      setDraft(null);
      return;
    }
    if (isTyping(target)) return;
    if (editingRef.current) exitEdit();
    if (e.button === 2) return;
    const w = toWorld(viewRef.current, p);
    lastPointer.current = w;
    try {
      root.current?.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows moves over the canvas.
    }
    if (e.button === 1 || space) {
      e.preventDefault();
      gesture.current = { kind: "pan", start: p, view: viewRef.current, moved: true };
      return;
    }
    const nodeEl = target.closest<HTMLElement>("[data-node-id]");
    const nodeId = nodeEl?.dataset.nodeId ?? null;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    const side = target.closest<HTMLElement>("[data-connect]")?.dataset.connect as CanvasSide | undefined;
    const edgeId = target.closest<Element>("[data-edge-id]")?.getAttribute("data-edge-id");
    if (canEdit && nodeId && handle) {
      const n = docRef.current.nodes.find((x) => x.id === nodeId)!;
      gesture.current = { kind: "resize", id: nodeId, handle, start: w, rect: { x: n.x, y: n.y, width: n.width, height: n.height } };
      return;
    }
    if (canEdit && nodeId && side) {
      e.preventDefault();
      gesture.current = { kind: "connect", from: nodeId, side, screen: p };
      return;
    }
    if (edgeId) {
      const s = selRef.current;
      if (e.shiftKey) {
        const edges = new Set(s.edges);
        if (edges.has(edgeId)) edges.delete(edgeId);
        else edges.add(edgeId);
        setSel({ nodes: s.nodes, edges });
      } else setSel(only([], [edgeId]));
      gesture.current = null;
      return;
    }
    if (nodeId) {
      const s = selRef.current;
      let nodes: Set<string>;
      if (e.shiftKey) {
        nodes = new Set(s.nodes);
        if (nodes.has(nodeId)) nodes.delete(nodeId);
        else nodes.add(nodeId);
        setSel({ nodes, edges: s.edges });
      } else if (!s.nodes.has(nodeId)) {
        nodes = new Set([nodeId]);
        setSel(only(nodes));
      } else nodes = new Set(s.nodes);
      gesture.current = canEdit && nodes.has(nodeId) ? { kind: "move", start: w, screen: p, ids: dragSet(docRef.current.nodes, nodes), moved: false, click: e.shiftKey ? null : nodeId } : null;
      return;
    }
    // Empty space: Shift draws a marquee, else the board pans (and a click clears the selection).
    gesture.current = e.shiftKey ? { kind: "marquee", start: p, base: selRef.current } : { kind: "pan", start: p, view: viewRef.current, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (inside(e)) lastPointer.current = toWorld(viewRef.current, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts as [Point, Point];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAt(g.view, g.mid, (g.view.zoom * dist) / Math.max(g.dist, 1));
      setView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y });
      return;
    }
    latest.current = { ...p, alt: e.altKey };
    schedule();
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    pointers.current.delete(e.pointerId);
    if (root.current?.hasPointerCapture(e.pointerId)) root.current.releasePointerCapture(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (!pointers.current.size) gesture.current = null;
      return;
    }
    // The last frame of the drag lands before it ends.
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      run();
    }
    gesture.current = null;
    const w = toWorld(viewRef.current, local(e));
    switch (g.kind) {
      case "pan":
        if (!g.moved && !cancelled) setSel(NONE);
        break;
      case "marquee":
        setMarquee(null);
        break;
      case "move":
        if (g.moved) {
          dispatch({ type: cancelled ? "cancel" : "commit" });
          setBusy(false);
        } else if (g.click) setSel(only([g.click]));
        if (g.moved && !cancelled) dispatch({ type: "amend", doc: (d) => bringToFront(d, selRef.current.nodes) });
        break;
      case "resize":
        dispatch({ type: cancelled ? "cancel" : "commit" });
        setBusy(false);
        break;
      case "connect": {
        setDraft(null);
        if (cancelled) break;
        const others = docRef.current.nodes.filter((n) => n.id !== g.from);
        const target = hitNode(others.filter((n) => n.type !== "group"), w) ?? hitNode(others, w);
        if (target) {
          const edge: CanvasEdge = { id: newId(), fromNode: g.from, fromSide: g.side, toNode: target.id, toSide: nearestSide(target, w) };
          set((d) => ({ ...d, edges: [...d.edges, edge] }));
          setSel(only([], [edge.id]));
        } else if (Math.hypot(local(e).x - g.screen.x, local(e).y - g.screen.y) > 24 && !full()) {
          // Let go on empty space: a new card there, connected, to type in (as Obsidian does).
          const n = placeNode("text", w, { html: "" });
          const opposite: Record<CanvasSide, CanvasSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
          const edge: CanvasEdge = { id: newId(), fromNode: g.from, fromSide: g.side, toNode: n.id, toSide: opposite[g.side] };
          dispatch({ type: "preview", doc: (d) => ({ nodes: [...d.nodes, n], edges: [...d.edges, edge] }) });
          startEdit(n.id, true);
        }
        break;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!inside(e) || isTyping(e.target)) return;
    const target = e.target as Element;
    const edgeId = target.closest<Element>("[data-edge-id]")?.getAttribute("data-edge-id");
    if (edgeId) {
      if (canEdit) {
        setSel(only([], [edgeId]));
        setEditing({ kind: "edge", id: edgeId });
      }
      return;
    }
    const nodeId = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const n = nodeId ? docRef.current.nodes.find((x) => x.id === nodeId) : undefined;
    if (n) return activate(n);
    if (canEdit) addText(toWorld(viewRef.current, local(e)));
  };

  // Links inside cards open with Ctrl or Cmd and a click; a plain click selects the card.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest?.("a[href]");
    if (!a || !inside(e) || isTyping(e.target)) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) window.open((a as HTMLAnchorElement).href, "_blank", "noopener,noreferrer");
  };

  // Scroll pans; Ctrl or Cmd and scroll (and a trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.target instanceof Node) || !el.contains(e.target)) return;
      const zooming = e.ctrlKey || e.metaKey;
      if (!zooming && e.target instanceof Element && e.target.closest("[data-editing]")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (zooming) {
        const factor = Math.exp(-e.deltaY * unit * 0.0045);
        setView((v) => zoomAt(v, at, v.zoom * factor));
      } else {
        const sideways = e.shiftKey && !e.deltaX;
        const dx = (sideways ? e.deltaY : e.deltaX) * unit;
        const dy = (sideways ? 0 : e.deltaY) * unit;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stop);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stop);
    };
  }, [setView]);

  // Space held: dragging anywhere pans.
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.key === " " && setSpace(false);
    const blur = () => setSpace(false);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!inside(e) || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const s = selRef.current;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === " " && !mod) {
      handled();
      setSpace(true);
      return;
    }
    if (mod && key === "z") {
      handled();
      dispatch({ type: e.shiftKey ? "redo" : "undo" });
      return;
    }
    if (mod && key === "y") {
      handled();
      dispatch({ type: "redo" });
      return;
    }
    if (mod && key === "a") {
      handled();
      setSel(only(docRef.current.nodes.map((n) => n.id)));
      return;
    }
    if (mod && (key === "=" || key === "+")) return (handled(), zoomBy(1.25));
    if (mod && key === "-") return (handled(), zoomBy(0.8));
    if (mod && key === "0") return (handled(), glide(zoomAt(viewRef.current, { x: size.width / 2, y: size.height / 2 }, 1)));
    if (!mod && (e.key === "+" || e.key === "=")) return (handled(), zoomBy(1.25));
    if (!mod && e.key === "-") return (handled(), zoomBy(0.8));
    if (e.shiftKey && e.code === "Digit1") return (handled(), fit());
    if (e.shiftKey && e.code === "Digit2") return (handled(), fit(s.nodes));
    if (e.key === "Escape") {
      if (s.nodes.size || s.edges.size) handled();
      setSel(NONE);
      root.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "Enter") {
      const id = (document.activeElement as HTMLElement | null)?.dataset?.nodeId ?? (s.nodes.size === 1 ? [...s.nodes][0] : undefined);
      const n = id ? docRef.current.nodes.find((x) => x.id === id) : undefined;
      if (n) {
        handled();
        activate(n);
      } else if (s.edges.size === 1 && canEdit) {
        handled();
        setEditing({ kind: "edge", id: [...s.edges][0]! });
      }
      return;
    }
    if (e.key.startsWith("Arrow")) {
      handled();
      const step = e.altKey ? 1 : GRID;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (canEdit && s.nodes.size) set((d) => moveNodes(d, dragSet(d.nodes, s.nodes), dx, dy));
      else setView((v) => ({ ...v, x: v.x - dx * 2, y: v.y - dy * 2 }));
      return;
    }
    if (!canEdit) return;
    if (e.key === "Delete" || e.key === "Backspace") return (handled(), deleteSelection());
    if (mod && key === "d") return (handled(), duplicate());
    if (mod && key === "g") return (handled(), addGroup());
  };

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).dataset?.nodeId;
    const by = focusByPointer.current;
    focusByPointer.current = false;
    if (!id || by || editingRef.current) return;
    // Tabbing to a card selects it and brings it into view.
    if (!selRef.current.nodes.has(id) || selRef.current.nodes.size > 1) setSel(only([id]));
    const n = docRef.current.nodes.find((x) => x.id === id);
    if (!n) return;
    const tl = toScreen(viewRef.current, n);
    const br = toScreen(viewRef.current, { x: n.x + n.width, y: n.y + n.height });
    if (tl.x < 0 || tl.y < 0 || br.x > size.width || br.y > size.height) {
      const c = { x: n.x + n.width / 2, y: n.y + n.height / 2 };
      glide({ ...viewRef.current, x: size.width / 2 - c.x * viewRef.current.zoom, y: size.height / 2 - c.y * viewRef.current.zoom });
    }
  };

  // ─── Clipboard and files ───────────────────────────────────────────────────

  const pasteAt = () => {
    const p = lastPointer.current;
    const c = center();
    if (!p) return c;
    const tl = toWorld(viewRef.current, { x: 0, y: 0 });
    const br = toWorld(viewRef.current, { x: size.width, y: size.height });
    return p.x > tl.x && p.x < br.x && p.y > tl.y && p.y < br.y ? p : c;
  };

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>, cut = false) => {
    if (!inside(e) || isTyping(e.target)) return;
    const s = selRef.current;
    if (!s.nodes.size) return;
    e.preventDefault();
    lastClip = extract(docRef.current, s.nodes);
    e.clipboardData.setData("text/plain", CLIP_MARK + JSON.stringify(lastClip));
    if (cut && canEdit) deleteSelection();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!inside(e) || isTyping(e.target) || !canEdit) return;
    const files = [...e.clipboardData.files];
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    const at = pasteAt();
    if (files.length) return void addFiles(files, at);
    let clip: Canvas | null = null;
    if (text.startsWith(CLIP_MARK)) {
      try {
        clip = fromApi(JSON.parse(text.slice(CLIP_MARK.length)) as Canvas);
      } catch {
        clip = lastClip;
      }
    }
    if (clip) {
      const b = boundsOf(clip.nodes);
      const { doc: next, ids } = paste(docRef.current, clip, b ? { x: at.x - b.width / 2, y: at.y - b.height / 2 } : at);
      set(next);
      setSel(only(ids));
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    const url = !/\s/.test(trimmed) && /^(https:\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(trimmed) ? cleanUrl(trimmed) : null;
    if (url) return addLink(url, at);
    addText(at, trimmed.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`).join(""), false);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canEdit || !e.dataTransfer.files.length) return;
    e.preventDefault();
    void addFiles([...e.dataTransfer.files], toWorld(viewRef.current, local(e)));
  };

  // ─── Drawing ───────────────────────────────────────────────────────────────

  const editingNode = editing?.kind === "node" ? doc.nodes.find((n) => n.id === editing.id) : undefined;
  const editingEdge = editing?.kind === "edge" ? doc.edges.find((e) => e.id === editing.id) : undefined;
  const editorAt = editingNode?.type === "text" && editor?.editor ? toScreen(view, { x: editingNode.x + editingNode.width / 2, y: editingNode.y }) : null;
  const gridGap = GRID * view.zoom;
  const gridStyle: CSSProperties | undefined =
    gridGap >= 8
      ? {
          backgroundImage: `radial-gradient(circle, color-mix(in oklab, var(--fg) ${view.zoom < 0.6 ? 9 : 14}%, transparent) ${Math.max(0.6, Math.min(1.2, view.zoom))}px, transparent 0)`,
          backgroundSize: `${gridGap}px ${gridGap}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }
      : undefined;
  const bounds = useMemo(() => boundsOf(doc.nodes), [doc.nodes]);
  const empty = doc.nodes.length === 0;
  const anySelected = sel.nodes.size > 0;

  return (
    <CardEnvContext.Provider value={env}>
      <div
        ref={root}
        tabIndex={0}
        role="application"
        aria-roledescription={t("canvas.label")}
        aria-label={t("canvas.aria")}
        className={cn(
          "canvas-root relative h-full min-h-[420px] w-full select-none overflow-hidden outline-none",
          space || gesture.current?.kind === "pan" ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        )}
        style={gridStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onDragOver={(e) => canEdit && e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={onDrop}
        onContextMenu={(e) => inside(e) && !isTyping(e.target) && e.preventDefault()}
      >
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0", ["--z" as string]: view.zoom }}
        >
          <Scene
            doc={doc}
            byId={byId}
            sel={sel}
            editingId={editing?.kind === "node" ? editing.id : null}
            editingEdge={editing?.kind === "edge" ? editing.id : null}
            canEdit={canEdit}
            actions={actions}
            onEditor={setEditor}
          />
          {draft && <DraftEdge {...draft} />}
          {editingEdge && byId.get(editingEdge.fromNode) && byId.get(editingEdge.toNode) && (
            <EdgeLabelEditor
              edge={editingEdge}
              mid={edgeGeometry(editingEdge, byId.get(editingEdge.fromNode)!, byId.get(editingEdge.toNode)!).mid}
              onDone={(label) => {
                set((d) => updateEdge(d, editingEdge.id, { label: label || undefined }));
                setEditing(null);
                root.current?.focus({ preventScroll: true });
              }}
              onCancel={() => {
                setEditing(null);
                root.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </div>

        {marquee && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-[3px] border border-[color-mix(in_oklab,var(--tone-blue-solid)_70%,transparent)] bg-[color-mix(in_oklab,var(--tone-blue-solid)_8%,transparent)]"
            style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
          />
        )}

        {editorAt && editor?.editor && <FormatBar editor={editor.editor} at={editorAt} />}

        {empty && (
          <div className="pointer-events-none absolute inset-0 flex">
            <EmptyState
              art="wiki"
              title={t("canvas.empty.title")}
              description={canEdit ? t("canvas.empty.description") : t("canvas.empty.readOnly")}
              className="bg-transparent [&_button]:pointer-events-auto"
              action={
                canEdit ? (
                  <Button variant="primary" onClick={() => addText(center())}>
                    {t("canvas.empty.action")}
                  </Button>
                ) : undefined
              }
              tips={canEdit ? [{ label: t("canvas.empty.tipAdd") }, { label: t("canvas.empty.tipPan") }, { label: t("canvas.empty.tipZoom") }] : undefined}
            />
          </div>
        )}

        <Toolbar
          canEdit={canEdit}
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          pages={tree.data ?? []}
          selfId={page.id}
          canUndo={history.past.length > 0 && !history.base}
          canRedo={history.future.length > 0 && !history.base}
          onAddText={() => addText(center())}
          onAddPage={(id) => addNode(placeNode("page", center(), { page_id: id }))}
          onAddLink={(url) => addLink(url)}
          onAddGroup={addGroup}
          onAddFiles={(files) => void addFiles(files)}
          onColor={setColor}
          onArrows={setArrows}
          onEditLabel={() => {
            const [id] = sel.edges;
            if (id) setEditing({ kind: "edge", id });
          }}
          onDuplicate={duplicate}
          onDelete={deleteSelection}
          onUndo={() => dispatch({ type: "undo" })}
          onRedo={() => dispatch({ type: "redo" })}
        />
        {!canEdit && (
          <span className="pointer-events-none absolute left-4 top-4 z-30 rounded-md border border-line bg-raised/90 px-2 py-1 text-[11.5px] text-fg-3 shadow-xs">{t("canvas.readOnly")}</span>
        )}
        <ZoomHud
          zoom={view.zoom}
          onZoomIn={() => zoomBy(1.25)}
          onZoomOut={() => zoomBy(0.8)}
          onReset={() => glide(zoomAt(viewRef.current, { x: size.width / 2, y: size.height / 2 }, 1))}
          onFit={() => fit(anySelected ? sel.nodes : undefined)}
          minimap={minimap}
          onMinimap={() => {
            setMinimap((m) => {
              try {
                localStorage.setItem(miniKey, m ? "0" : "1");
              } catch {
                // Kept for this visit.
              }
              return !m;
            });
          }}
        />
        {minimap && !empty && (
          <Minimap
            nodes={doc.nodes}
            bounds={bounds}
            view={view}
            viewport={size}
            onCenter={(w) => setView((v) => ({ ...v, x: size.width / 2 - w.x * v.zoom, y: size.height / 2 - w.y * v.zoom }))}
          />
        )}

        <ScreenReaderList nodes={doc.nodes} edges={doc.edges.length} pages={pages} />
        <RowPeek id={peek} onClose={() => setPeek(null)} />
      </div>
    </CardEnvContext.Provider>
  );
}

/** The cards and connections; drawn again only when they or the selection change, never on pan or zoom. */
const Scene = memo(function Scene({
  doc,
  byId,
  sel,
  editingId,
  editingEdge,
  canEdit,
  actions,
  onEditor,
}: {
  doc: Canvas;
  byId: Map<string, CanvasNode>;
  sel: Selection;
  editingId: string | null;
  editingEdge: string | null;
  canEdit: boolean;
  actions: CardActions;
  onEditor: (h: RichEditorHandle | null) => void;
}) {
  const order = useMemo(() => renderOrder(doc.nodes), [doc.nodes]);
  const groups = order.filter((n) => n.type === "group");
  const cards = order.filter((n) => n.type !== "group");
  const one = sel.nodes.size === 1;
  const card = (n: CanvasNode) => (
    <Card
      key={n.id}
      node={n}
      selected={sel.nodes.has(n.id)}
      editing={editingId === n.id}
      canEdit={canEdit}
      handles={one && sel.nodes.has(n.id)}
      actions={actions}
      editorRef={editingId === n.id ? onEditor : undefined}
    />
  );
  return (
    <>
      {groups.map(card)}
      <EdgeLayer edges={doc.edges} byId={byId} selected={sel.edges} />
      {cards.map(card)}
      <EdgeLabels edges={doc.edges} byId={byId} editing={editingEdge} />
    </>
  );
});

function EdgeLabelEditor({ edge, mid, onDone, onCancel }: { edge: CanvasEdge; mid: Point; onDone: (label: string) => void; onCancel: () => void }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="absolute z-30 -translate-x-1/2 -translate-y-1/2" style={{ left: mid.x, top: mid.y }}>
      <LabelInput initial={edge.label ?? ""} placeholder={t("canvas.edgeLabelPlaceholder")} onDone={onDone} onCancel={onCancel} className="text-[12px] font-normal" />
    </div>
  );
}

const ScreenReaderList = memo(function ScreenReaderList({ nodes, edges, pages }: { nodes: CanvasNode[]; edges: number; pages: Map<string, WikiNode> | null }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="sr-only">
      <p>{t("canvas.sr.list")}</p>
      <ul>
        {nodes.map((n) => (
          <li key={n.id}>{t("canvas.sr.item", { type: t(`canvas.types.${n.type}`), label: cardLabel(n, pages) || t("canvas.emptyCard") })}</li>
        ))}
      </ul>
      <p>{t("canvas.sr.edges", { count: edges })}</p>
    </div>
  );
});
