// The wiki in mock mode (contracts/wiki.md), checked as internal/helpdesk/wiki checks it:
// the tree with its spaces (the workspace's, a member's private pages, teamspaces), pages
// with versions, history with coalesced revisions, moves that refuse cycles, the trash,
// templates and copies, favorites, recent pages and readers, the journal, verification,
// links and search. The mock's person is db.meId. The first workspace starts with a
// small support handbook and two templates; the others start empty, to show the
// first-run state.

import DOMPurify from "dompurify";
import type { Role, WikiDailyNote, WikiNode, WikiPage, WikiPageSettings, WikiPageViews, WikiRef, WikiRevision, WikiSearchHit, WikiTrashed } from "@/lib/api/types";
import { MAX_DEPTH, buildTree, childrenOf } from "@/lib/wiki/tree";
import { DEFAULT_LOOK } from "@/lib/wiki/look";
import { linkedIds, pageTags } from "@/lib/wiki/links";
import { db, userRef, type WsData } from "../db";
import { publish } from "../gateway";
import { del, get, HttpError, invalid, notFound, patch, post, put, respond, s, type Ctx } from "../router";
import { roleIn, teamRole } from "../teams";
import { ago, DAY, HOUR, MIN, NOW, nowIso, parseUUID, stripHtml, uuid } from "../util";

type Row = WikiPageSettings & {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  body_html: string;
  position: number;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** The member a private page belongs to. */
  private_to: string | null;
  team_id: string | null;
  template: boolean;
  journal: boolean;
  daily_date: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  /** The page whose trashing took this one along (itself for the page trashed). */
  trashed_with: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verified_until: string | null;
};
type Rev = { id: string; page_id: string; title: string; icon: string; body_html: string; author: string | null; created_at: string; updated_at: string };
type Visit = { user_id: string; page_id: string; visits: number; last_at: string; seq: number };
type State = { pages: Row[]; revisions: Rev[]; favorites: Map<string, string[]>; visits: Visit[] };

const MAX_PAGES = 5000;
const MAX_BODY = 512 * 1024;
const MAX_REVISIONS = 100;
const MAX_FAVORITES = 100;
const COALESCE_GAP = 10 * MIN;
const COALESCE_SPAN = HOUR;
const TRASH_KEEP = 30 * DAY;

const states = new WeakMap<WsData, State>();
let visitSeq = 0;

function stateOf(ws: WsData): State {
  let st = states.get(ws);
  if (!st) {
    st = { pages: [], revisions: [], favorites: new Map(), visits: [] };
    states.set(ws, st);
    if (ws === db.workspaces[0]) seedHandbook(ws, st);
  }
  purge(st);
  return st;
}

/** Pages 30 days in the trash go for good, with everything under them. */
function purge(st: State) {
  const before = Date.now() - TRASH_KEEP;
  const roots = st.pages.filter((r) => r.trashed_with === r.id && r.deleted_at && Date.parse(r.deleted_at) < before);
  if (roots.length) removeRows(st, roots.flatMap((r) => everythingUnder(st, r.id)));
}

const rank: Record<Role, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
const role = (ctx: Ctx) => roleIn(ctx.ws, db.meId);

function requireAgent(ctx: Ctx) {
  if (rank[role(ctx)] < rank.agent) throw new HttpError(403, "forbidden", "You don't have permission to do that");
}

// ─── Who sees what (visibility.go) ─────────────────────────────────────────

type Viewer = { me: string; hidden: Set<string> };

/** The person's view: their own private pages, and no page of a private team they are not on. */
function viewerOf(ws: WsData, me = db.meId): Viewer {
  return { me, hidden: new Set(ws.teams.filter((t) => t.private && !teamRole(t, me)).map((t) => t.id)) };
}

/** seesSQL: in the viewer's space, whether in the trash or a template. */
const sees = (v: Viewer, r: Row) => (r.private_to === null || r.private_to === v.me) && (r.team_id === null || !v.hidden.has(r.team_id));
/** liveSQL: a page of the viewer's tree. */
const live = (v: Viewer, r: Row) => !r.deleted_at && !r.template && sees(v, r);

const verifiedNow = (r: Row) => !!r.verified_at && (!r.verified_until || Date.parse(r.verified_until) > Date.now());

const node = (r: Row): WikiNode => ({
  id: r.id,
  parent_id: r.parent_id,
  title: r.title,
  icon: r.icon,
  position: r.position,
  version: r.version,
  updated_at: r.updated_at,
  created_by_id: r.created_by,
  tags: pageTags(r.body_html, stripHtml),
  private: r.private_to !== null,
  team_id: r.team_id,
  ...(r.journal ? { journal: true } : {}),
  ...(r.daily_date ? { daily_date: r.daily_date } : {}),
  ...(r.template ? { template: true } : {}),
  ...(verifiedNow(r) ? { verified: true } : {}),
});
const refOf = (r: Pick<Row, "id" | "title" | "icon">): WikiRef => ({ id: r.id, title: r.title, icon: r.icon });
const settingsOf = (r: Row): WikiPageSettings => ({ cover: r.cover, cover_y: r.cover_y, full_width: r.full_width, small_text: r.small_text, font: r.font, locked: r.locked });
const byPosition = (a: Row, b: Row) => a.position - b.position || a.id.localeCompare(b.id);

/** The pages above id, the top-level one first, whatever their state. */
function ancestorsOf(st: State, id: string): Row[] {
  const out: Row[] = [];
  let cur = st.pages.find((r) => r.id === id)?.parent_id ?? null;
  while (cur && out.length < 64) {
    const up = st.pages.find((r) => r.id === cur);
    if (!up) break;
    out.unshift(up);
    cur = up.parent_id;
  }
  return out;
}

/** id and every page under it in the same state (both in the tree, or trashed together), and how many levels it spans. */
function subtree(st: State, id: string): { ids: string[]; height: number } {
  const root = st.pages.find((r) => r.id === id);
  if (!root) return { ids: [], height: 0 };
  const ids: string[] = [];
  let level = [root];
  let height = 0;
  while (level.length && height < 64) {
    height++;
    ids.push(...level.map((r) => r.id));
    const at = new Set(level.map((r) => r.id));
    level = st.pages.filter((r) => r.parent_id !== null && at.has(r.parent_id) && r.trashed_with === root.trashed_with);
  }
  return { ids, height };
}

/** id and everything under it, in the tree or in the trash. */
function everythingUnder(st: State, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of st.pages) if (r.parent_id === out[i]) out.push(r.id);
  return out;
}

function removeRows(st: State, ids: string[]) {
  const gone = new Set(ids);
  st.pages = st.pages.filter((r) => !gone.has(r.id));
  st.revisions = st.revisions.filter((x) => !gone.has(x.page_id));
  st.visits = st.visits.filter((x) => !gone.has(x.page_id));
  for (const [user, list] of st.favorites) st.favorites.set(user, list.filter((id) => !gone.has(id)));
}

/**
 * Puts id at index among the children of parent in the tree (the end when index is past it,
 * or left out) and numbers them from 0; without id it only renumbers them. Top-level pages
 * are numbered within their space; trashed pages and templates keep their numbers.
 */
function place(st: State, parent: string | null, owner: string | null, team: string | null, template: boolean, id?: string, index?: number) {
  const order = st.pages
    .filter((r) => r.parent_id === parent && !r.deleted_at && r.template === template && (parent !== null || (r.private_to === owner && r.team_id === team)) && r.id !== id)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const moving = id ? st.pages.find((r) => r.id === id) : undefined;
  if (moving) order.splice(index !== undefined && index >= 0 && index < order.length ? index : order.length, 0, moving);
  order.forEach((r, i) => (r.position = i));
}

function pageOut(st: State, r: Row): WikiPage {
  return {
    ...node(r),
    ...settingsOf(r),
    body_html: r.body_html,
    template: r.template,
    journal: r.journal,
    verification: r.verified_at
      ? { by: userRef(r.verified_by), at: r.verified_at, until: r.verified_until, expired: !!r.verified_until && Date.parse(r.verified_until) < Date.now() }
      : null,
    deleted_at: r.deleted_at,
    deleted_by: userRef(r.deleted_by),
    created_at: r.created_at,
    created_by: userRef(r.created_by),
    updated_by: userRef(r.updated_by),
    breadcrumbs: ancestorsOf(st, r.id).map(refOf),
    // A page in the tree shows its subpages in the tree; one in the trash, those trashed with it.
    children: st.pages
      .filter((c) => c.parent_id === r.id && c.trashed_with === r.trashed_with)
      .sort(byPosition)
      .map(refOf),
  };
}

/** The page of the path the viewer may see, in the trash or not; else not found, as if it didn't exist. */
function find(ctx: Ctx, st = stateOf(ctx.ws)): Row {
  const r = st.pages.find((p) => p.id === ctx.params.id);
  if (!r || !sees(viewerOf(ctx.ws), r)) throw notFound("Page");
  return r;
}

const inTrash = () => new HttpError(422, "page_in_trash", "This page is in the trash. Restore it to change it.");
const cycle = () => new HttpError(422, "page_cycle", "A page can't move under itself or one of its subpages.");
const tooDeep = () => new HttpError(422, "page_too_deep", "Pages nest up to 10 levels deep.");

/** Refuses n more pages in a full wiki (the trash and templates count). */
function roomFor(st: State, n: number) {
  if (st.pages.length + n > MAX_PAGES)
    throw new HttpError(422, "wiki_full", "A workspace's wiki holds up to 5,000 pages, the trash included. Delete pages you no longer need first.");
}

type Parent = { row: Row; up: Row[] };

/** A parent page id ("" or null is the top level): a page of the tree the viewer may see. */
function parentRef(ctx: Ctx, st: State, raw: unknown): Parent | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const id = parseUUID(raw.trim());
  if (!id) throw invalid("parent_id is not a valid id");
  const row = st.pages.find((r) => r.id === id);
  if (!row || row.deleted_at || !sees(viewerOf(ctx.ws), row)) throw invalid("parent page not found in this workspace");
  return { row, up: ancestorsOf(st, id) };
}

/** The space a top-level page goes to: "workspace", "private" or "team" (with team_id, a team the viewer may see). */
function spaceRef(ctx: Ctx, space: unknown, rawTeam: unknown): { owner: string | null; team: string | null } {
  switch (space ?? "") {
    case "":
    case "workspace":
      return { owner: null, team: null };
    case "private":
      return { owner: db.meId, team: null };
    case "team": {
      if (typeof rawTeam !== "string") throw invalid("team_id is required for a teamspace page");
      const id = parseUUID(rawTeam.trim());
      if (!id) throw invalid("team_id is not a valid id");
      const hidden = viewerOf(ctx.ws).hidden;
      if (!ctx.ws.teams.some((t) => t.id === id && !hidden.has(t.id))) throw invalid("team not found in this workspace");
      return { owner: null, team: id };
    }
  }
  throw invalid("space must be workspace, private or team");
}

/**
 * Admins and owners delete (or trash) any page; agents a page when they created it (or it is
 * their private page) and every page under it.
 */
function canDelete(ctx: Ctx, st: State, ids: string[]) {
  if (rank[role(ctx)] >= rank.admin) return;
  const me = db.meId;
  const others = new Set(st.pages.filter((r) => ids.includes(r.id) && r.created_by !== me && r.private_to !== me).map((r) => r.id));
  if (others.has(ids[0] ?? "")) throw new HttpError(403, "forbidden", "Someone else created this page, so only an admin can delete it.");
  if (others.size) throw new HttpError(403, "forbidden", "Someone else created pages under this one, so only an admin can delete it.");
}

function cleanTitle(v: unknown): string {
  if (typeof v !== "string") return "";
  if ([...v].length > 200) throw invalid("title must be at most 200 characters");
  return v.replace(/\s+/g, " ").trim();
}

// One emoji as the API reads it (internal/helpdesk/wiki/emoji.go): pictographs with a
// variation selector and skin tone, joined by ZWJ; a flag; a tag flag; or a keycap.
const pict = String.raw`\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}]?[\u{1F3FB}-\u{1F3FF}]?`;
const oneEmoji = new RegExp(
  String.raw`^(?:${pict}(?:\u{200D}${pict})*|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\u{FE0F}?\u{20E3}|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})$`,
  "u",
);

function cleanIcon(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  const t = v.trim();
  if (t.length > 64 || !oneEmoji.test(t)) throw invalid("icon must be one emoji");
  return t;
}

function cleanBody(v: unknown): string {
  const html = typeof v === "string" ? v : "";
  if (new TextEncoder().encode(html).length > MAX_BODY) throw new HttpError(422, "page_too_large", "A page can hold up to 512 KB of text and formatting. Split it into subpages.");
  // The server keeps the rich-text allowlist and the wiki's blocks (hd.SanitizeWiki); the
  // mock drops what can run and the to-do checkboxes the app draws itself.
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["input", "label", "iframe", "form", "style", "script"], ADD_ATTR: ["datetime", "colwidth"] });
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function record(st: State, r: Row, merge: boolean) {
  const now = Date.now();
  const mine = st.revisions.filter((x) => x.page_id === r.id).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const last = mine[0];
  if (merge && last && r.updated_by && last.author === r.updated_by && now - Date.parse(last.updated_at) < COALESCE_GAP && now - Date.parse(last.created_at) < COALESCE_SPAN) {
    Object.assign(last, { title: r.title, icon: r.icon, body_html: r.body_html, updated_at: nowIso() });
    return;
  }
  const fresh: Rev = { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: r.updated_by, created_at: nowIso(), updated_at: nowIso() };
  // The newest 100 stay: this one and the 99 before it.
  const keep = new Set([fresh.id, ...mine.slice(0, MAX_REVISIONS - 1).map((x) => x.id)]);
  st.revisions = [...st.revisions, fresh].filter((x) => x.page_id !== r.id || keep.has(x.id));
}

const GRADIENTS = new Set(["dawn", "ocean", "forest", "dusk", "sand", "slate", "rose", "lagoon", "aurora", "ember"]);

/** The look a PATCH asks for, checked as the API checks it. */
function settingsPatch(body: Record<string, unknown>, cur: WikiPageSettings): WikiPageSettings {
  const next = { ...cur };
  if ("cover" in body) {
    const c = String(body.cover ?? "").trim();
    const ok = c === "" || (c.startsWith("gradient:") && GRADIENTS.has(c.slice(9))) || /^(https:\/\/\S+|\/v1\/attachments\/[0-9a-f-]{36}(\?\S*)?)$/i.test(c);
    if (!ok) throw invalid("cover must be a gradient, an https image or an uploaded image");
    next.cover = c;
  }
  if ("cover_y" in body) next.cover_y = Math.max(0, Math.min(100, Number(body.cover_y) || 0));
  if ("full_width" in body) next.full_width = !!body.full_width;
  if ("small_text" in body) next.small_text = !!body.small_text;
  if ("font" in body) {
    if (!["default", "serif", "mono"].includes(String(body.font))) throw invalid("font must be default, serif or mono");
    next.font = body.font as WikiPageSettings["font"];
  }
  if ("locked" in body) next.locked = !!body.locked;
  return next;
}

/**
 * The verification a PATCH asks for, checked before anything changes: undefined leaves it,
 * null takes it away, else verifies the page as the person for some days (or until changed).
 */
function verificationPatch(body: Record<string, unknown>): { days: number | null } | null | undefined {
  const days = body.verified_days ?? null;
  if (typeof body.verified !== "boolean") {
    if (days !== null) throw invalid("verified_days goes with verified: true");
    return undefined;
  }
  if (!body.verified) return null;
  if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) throw invalid("verified_days must be between 1 and 3650");
  return { days };
}

/** Applies a verificationPatch; whether anything changed. */
function applyVerification(r: Row, v: { days: number | null } | null | undefined): boolean {
  if (v === undefined) return false;
  if (v === null) {
    if (!r.verified_at) return false;
    Object.assign(r, { verified_by: null, verified_at: null, verified_until: null });
    return true;
  }
  const at = Date.now();
  Object.assign(r, { verified_by: db.meId, verified_at: new Date(at).toISOString(), verified_until: v.days ? new Date(at + v.days * DAY).toISOString() : null });
  return true;
}

const revOut = (x: Rev, body: boolean): WikiRevision => ({
  id: x.id,
  title: x.title,
  icon: x.icon,
  ...(body ? { body_html: x.body_html } : {}),
  author: userRef(x.author),
  created_at: x.created_at,
  updated_at: x.updated_at,
});

/**
 * Publishes an event about a page to the people who may see it: a private page's member
 * only, a private team's page that team only, else the workspace.
 */
function pageEvent(ws: WsData, space: Pick<Row, "private_to" | "team_id">, type: string, data: Record<string, unknown>) {
  if (space.private_to) {
    // Scoped to the member: their user channel gets it in full, the workspace channel a stand-in.
    publish(ws, type, data, { teamId: "__wiki_private", topics: [`user:${space.private_to}`] });
    return;
  }
  const team = space.team_id ? ws.teams.find((t) => t.id === space.team_id) : undefined;
  publish(ws, type, data, { teamId: team?.private ? team.id : null });
}

/** What wiki_page.created, .updated and .moved carry: the page without its body, and who changed it. */
const eventPage = (r: Row): Record<string, unknown> => ({ wiki_page: node(r), updated_by: userRef(r.updated_by) });

function newRow(fields: Partial<Row> & Pick<Row, "id" | "parent_id" | "title" | "icon" | "body_html">): Row {
  const now = nowIso();
  return {
    position: Number.MAX_SAFE_INTEGER,
    version: 1,
    created_by: db.meId,
    updated_by: db.meId,
    created_at: now,
    updated_at: now,
    private_to: null,
    team_id: null,
    template: false,
    journal: false,
    daily_date: null,
    deleted_at: null,
    deleted_by: null,
    trashed_with: null,
    verified_by: null,
    verified_at: null,
    verified_until: null,
    ...DEFAULT_LOOK,
    ...fields,
  };
}

/** The best matching pages of the tree the person sees, as GET /v1/wiki/search answers. */
export function searchWiki(ws: WsData, q: string, limit = 20): WikiSearchHit[] {
  const st = stateOf(ws);
  const v = viewerOf(ws);
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return [];
  const scored = st.pages
    .filter((r) => live(v, r))
    .map((r) => {
      const title = r.title.toLowerCase();
      const text = stripHtml(r.body_html);
      const lower = text.toLowerCase();
      const has = (w: string, s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(s);
      if (!words.every((w) => has(w, title) || has(w, lower))) return null;
      const score = words.reduce((n, w) => n + (has(w, title) ? 3 : 0) + (has(w, lower) ? 1 : 0), 0);
      const at = Math.max(0, lower.indexOf(words[0] ?? "") - 40);
      const snippet = text.slice(at, at + 180).trim();
      return { r, score, snippet };
    })
    .filter((x): x is { r: Row; score: number; snippet: string } => !!x)
    .sort((a, b) => b.score - a.score || Date.parse(b.r.updated_at) - Date.parse(a.r.updated_at));
  return scored.slice(0, limit).map(({ r, snippet }) => ({ ...refOf(r), parent_id: r.parent_id, snippet, path: ancestorsOf(st, r.id).map(refOf), updated_at: r.updated_at }));
}

const pageOf = <T>(data: T[]) => ({ data, next_cursor: null });

export function registerWiki() {
  registerPages();
  registerTrash();
  registerTemplates();
  registerPersonal();
  registerLinks();
}

function registerPages() {
  get("/v1/wiki/pages", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const tree = buildTree(st.pages.filter((r) => live(v, r)).map(node));
    const out: WikiNode[] = [];
    const walk = (p: string | null) => childrenOf(tree, p).forEach((n) => (out.push(n), walk(n.id)));
    walk(null);
    return pageOf(out);
  });

  get("/v1/wiki/pages/:id", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (!r.deleted_at) recordVisit(st, db.meId, r.id);
    return pageOut(st, r);
  });

  post("/v1/wiki/pages", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const title = cleanTitle(ctx.body.title);
    const icon = cleanIcon(ctx.body.icon);
    const body = cleanBody(ctx.body.body_html);
    roomFor(st, 1);
    const par = parentRef(ctx, st, ctx.body.parent_id);
    let space: { owner: string | null; team: string | null };
    let template: boolean;
    if (par) {
      if (par.up.length + 2 > MAX_DEPTH) throw tooDeep();
      space = { owner: par.row.private_to, team: par.row.team_id };
      template = par.row.template;
    } else {
      space = spaceRef(ctx, ctx.body.space, ctx.body.team_id);
      template = ctx.body.template === true;
    }
    const r = newRow({ id: uuid(), parent_id: par?.row.id ?? null, title, icon, body_html: body, private_to: space.owner, team_id: space.team, template });
    st.pages.push(r);
    place(st, r.parent_id, r.private_to, r.team_id, r.template, r.id, typeof ctx.body.position === "number" ? ctx.body.position : undefined);
    record(st, r, false);
    pageEvent(ctx.ws, r, "wiki_page.created", eventPage(r));
    return respond(201, pageOut(st, r));
  });

  patch("/v1/wiki/pages/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    if (typeof ctx.body.version === "number" && ctx.body.version !== r.version)
      throw new HttpError(409, "page_changed", "Someone else changed this page since you opened it. Reload it to see their changes.");
    const next = {
      title: "title" in ctx.body ? cleanTitle(ctx.body.title) : r.title,
      icon: "icon" in ctx.body ? cleanIcon(ctx.body.icon) : r.icon,
      body_html: "body_html" in ctx.body ? cleanBody(ctx.body.body_html) : r.body_html,
    };
    const look = settingsPatch(ctx.body, settingsOf(r));
    const lookChanged = JSON.stringify(look) !== JSON.stringify(settingsOf(r));
    const textChanged = next.title !== r.title || next.icon !== r.icon || next.body_html !== r.body_html;
    const verify = verificationPatch(ctx.body);
    if (textChanged) {
      Object.assign(r, next, { version: r.version + 1, updated_by: db.meId, updated_at: nowIso() });
      record(st, r, true);
    }
    if (lookChanged) Object.assign(r, look);
    const verifyChanged = applyVerification(r, verify);
    if (textChanged || lookChanged || verifyChanged) {
      const data = eventPage(r);
      // Readers of the page take the new look as it comes: it has no version to compare.
      if (lookChanged) data.settings = look;
      if (verifyChanged) data.verification = pageOut(st, r).verification;
      pageEvent(ctx.ws, r, "wiki_page.updated", data);
    }
    return pageOut(st, r);
  });

  post("/v1/wiki/pages/:id/move", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    if (r.journal) throw new HttpError(422, "journal_fixed", "A journal stays at the top of your private pages.");
    const par = parentRef(ctx, st, ctx.body.parent_id);
    const old = { parent: r.parent_id, owner: r.private_to, team: r.team_id, template: r.template };
    let owner = old.owner;
    let team = old.team;
    let template = old.template;
    if (par) {
      if (par.row.id === r.id || par.up.some((a) => a.id === r.id)) throw cycle();
      owner = par.row.private_to;
      team = par.row.team_id;
      template = par.row.template;
    } else if (typeof ctx.body.space === "string" && ctx.body.space !== "") ({ owner, team } = spaceRef(ctx, ctx.body.space, ctx.body.team_id));
    const { ids: gone, height } = subtree(st, r.id);
    if ((par ? par.up.length + 1 : 0) + height > MAX_DEPTH) throw tooDeep();
    // Only the person a private page belongs to moves it out of their own.
    if (old.owner && old.owner !== owner && old.owner !== db.meId) throw notFound("Page");
    r.parent_id = par?.row.id ?? null;
    // The pages under it live where it does now; a daily note out of its journal is a page.
    for (const x of st.pages.filter((p) => gone.includes(p.id))) {
      Object.assign(x, { private_to: owner, team_id: team, template });
      if (!par?.row.journal) x.daily_date = null;
    }
    place(st, r.parent_id, owner, team, template, r.id, typeof ctx.body.position === "number" ? ctx.body.position : 0);
    const spaceChanged = old.owner !== owner || old.team !== team;
    if (old.parent !== r.parent_id || spaceChanged) place(st, old.parent, old.owner, old.team, old.template);
    if (spaceChanged) {
      // Readers of the old space drop it; readers of the new one fetch the tree again.
      pageEvent(ctx.ws, { private_to: old.owner, team_id: old.team }, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: gone, moved: true });
    }
    pageEvent(ctx.ws, r, "wiki_page.moved", eventPage(r));
    return respond(200, pageOut(st, r));
  });

  del("/v1/wiki/pages/:id", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    // Everything under it goes, whether in the tree or in the trash.
    const all = everythingUnder(st, r.id);
    canDelete(ctx, st, all);
    removeRows(st, all);
    if (!r.deleted_at) place(st, r.parent_id, r.private_to, r.team_id, r.template);
    pageEvent(ctx.ws, r, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: all });
    return respond(204);
  });

  get("/v1/wiki/pages/:id/revisions", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const list = st.revisions.filter((x) => x.page_id === r.id).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return pageOf(list.map((x) => revOut(x, false)));
  });

  get("/v1/wiki/pages/:id/revisions/:rid", (ctx) => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const x = st.revisions.find((v) => v.page_id === r.id && v.id === ctx.params.rid);
    if (!x) throw notFound("Revision");
    return revOut(x, true);
  });

  post("/v1/wiki/pages/:id/revisions/:rid/restore", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    const x = st.revisions.find((v) => v.page_id === r.id && v.id === ctx.params.rid);
    if (!x) throw notFound("Revision");
    Object.assign(r, { title: x.title, icon: x.icon, body_html: x.body_html, version: r.version + 1, updated_by: db.meId, updated_at: nowIso() });
    record(st, r, false);
    pageEvent(ctx.ws, r, "wiki_page.updated", eventPage(r));
    return respond(200, pageOut(st, r));
  });

  post("/v1/wiki/unfurl", (ctx) => {
    requireAgent(ctx);
    const url = s(ctx, "url")?.trim() ?? "";
    if (!/^https:\/\//i.test(url)) throw invalid("url must start with https://");
    const host = new URL(url).hostname.replace(/^www\./, "");
    const name = host.split(".")[0] ?? host;
    return { title: `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "home").replace(/[-_]/g, " ")}`, description: `A page on ${host}.`, image: "", site: host };
  });

  get("/v1/wiki/search", (ctx) => {
    const q = ctx.query.get("q") ?? "";
    const limit = Math.min(Number(ctx.query.get("limit") ?? 20) || 20, 50);
    return pageOf(searchWiki(ctx.ws, q, limit));
  });
}

// ─── The trash (trash.go) ──────────────────────────────────────────────────

function registerTrash() {
  post("/v1/wiki/pages/:id/trash", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (r.deleted_at) throw inTrash();
    const { ids: gone } = subtree(st, r.id);
    canDelete(ctx, st, gone);
    const at = nowIso();
    for (const x of st.pages) if (gone.includes(x.id)) Object.assign(x, { deleted_at: at, deleted_by: db.meId, trashed_with: r.id });
    // Favorites of pages in the trash would point nowhere.
    for (const [user, list] of st.favorites) st.favorites.set(user, list.filter((id) => !gone.includes(id)));
    place(st, r.parent_id, r.private_to, r.team_id, r.template);
    pageEvent(ctx.ws, r, "wiki_page.deleted", { wiki_page_id: r.id, wiki_page_ids: gone, trashed: true });
    return respond(200, pageOut(st, r));
  });

  post("/v1/wiki/pages/:id/restore", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    if (!r.trashed_with) throw new HttpError(422, "not_in_trash", "This page isn't in the trash.");
    if (r.trashed_with !== r.id) throw new HttpError(422, "trashed_with_parent", "This page went to the trash with a page above it. Restore that one.");
    const { ids: back, height } = subtree(st, r.id);
    // Back under its parent while that is in the tree; else at the top of its space.
    const parent = r.parent_id ? st.pages.find((p) => p.id === r.parent_id && !p.deleted_at) : undefined;
    const par = parent && ancestorsOf(st, parent.id).length + 1 + height <= MAX_DEPTH ? parent.id : null;
    const rows = st.pages.filter((p) => back.includes(p.id));
    for (const x of rows) Object.assign(x, { deleted_at: null, deleted_by: null, trashed_with: null });
    r.parent_id = par;
    // A journal or a daily note restored next to a live one becomes a plain page.
    const clash = (x: Row) =>
      st.pages.some(
        (o) =>
          o.id !== x.id && !o.deleted_at && x.private_to !== null && o.private_to === x.private_to && ((x.journal && o.journal) || (x.daily_date !== null && o.daily_date === x.daily_date)),
      );
    for (const x of rows.filter(clash)) Object.assign(x, { journal: false, daily_date: null });
    place(st, par, r.private_to, r.team_id, r.template, r.id);
    pageEvent(ctx.ws, r, "wiki_page.restored", { wiki_page: node(r), wiki_page_ids: back });
    return respond(200, pageOut(st, r));
  });

  get("/v1/wiki/trash", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const out = st.pages
      .filter((r): r is Row & { deleted_at: string } => r.trashed_with === r.id && !!r.deleted_at && sees(v, r))
      .sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at))
      .slice(0, 500)
      .map(
        (r): WikiTrashed => ({
          ...node(r),
          deleted_at: r.deleted_at,
          deleted_by: userRef(r.deleted_by),
          purge_at: new Date(Date.parse(r.deleted_at) + TRASH_KEEP).toISOString(),
          subpages: st.pages.filter((x) => x.trashed_with === r.id).length - 1,
          path: ancestorsOf(st, r.id).map(refOf),
        }),
      );
    return pageOf(out);
  });
}

// ─── Templates and copies (templates.go) ───────────────────────────────────

function registerTemplates() {
  get("/v1/wiki/templates", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const isTemplate = (id: string | null) => !!id && !!st.pages.find((a) => a.id === id)?.template;
    const out = st.pages
      .filter((r) => r.template && !r.deleted_at && !isTemplate(r.parent_id) && sees(v, r))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return pageOf(out.map(node));
  });

  post("/v1/wiki/pages/:id/duplicate", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const src = find(ctx, st);
    if (src.deleted_at) throw inTrash();
    const { ids: pages, height } = subtree(st, src.id);
    roomFor(st, pages.length);
    const par = parentRef(ctx, st, ctx.body.parent_id);
    const asTemplate = typeof ctx.body.template === "boolean" ? ctx.body.template : undefined;
    let owner = src.private_to;
    let team = src.team_id;
    let template = src.template;
    if (par) {
      ({ private_to: owner, team_id: team, template } = par.row);
      if (par.row.template && asTemplate === false) throw invalid("a page under a template is part of the template");
      if (pages.includes(par.row.id)) throw cycle();
      if (par.up.length + 1 + height > MAX_DEPTH) throw tooDeep();
    } else {
      if (typeof ctx.body.space === "string" && ctx.body.space !== "") ({ owner, team } = spaceRef(ctx, ctx.body.space, ctx.body.team_id));
      else if (src.private_to && src.private_to !== db.meId) throw notFound("Page");
      if (asTemplate !== undefined) template = asTemplate;
    }
    if (height > MAX_DEPTH) throw tooDeep();
    const rootTitle = "title" in ctx.body && ctx.body.title !== null ? cleanTitle(ctx.body.title) : src.title;
    // Copies of the pages, ids mapped so links inside the copy point at the copy.
    const fresh = new Map(pages.map((id) => [id, uuid()]));
    const remap = (body: string) => [...fresh].reduce((b, [old, now]) => b.replaceAll(old, now), body);
    for (const id of pages) {
      const x = st.pages.find((p) => p.id === id)!;
      const copy = newRow({
        ...settingsOf(x),
        id: fresh.get(id)!,
        parent_id: id === src.id || !x.parent_id ? (par?.row.id ?? null) : (fresh.get(x.parent_id) ?? null),
        title: id === src.id ? rootTitle : x.title,
        icon: x.icon,
        body_html: remap(x.body_html),
        position: x.position,
        private_to: owner,
        team_id: team,
        template,
      });
      st.pages.push(copy);
      record(st, copy, false);
    }
    const root = st.pages.find((p) => p.id === fresh.get(src.id))!;
    place(st, root.parent_id, owner, team, template, root.id, typeof ctx.body.position === "number" ? ctx.body.position : undefined);
    pageEvent(ctx.ws, root, "wiki_page.created", { ...eventPage(root), wiki_page_ids: [...fresh.values()] });
    return respond(201, pageOut(st, root));
  });
}

// ─── A member's own wiki (personal.go) ─────────────────────────────────────

function recordVisit(st: State, user: string, page: string) {
  const v = st.visits.find((x) => x.user_id === user && x.page_id === page);
  if (v) Object.assign(v, { visits: v.visits + 1, last_at: nowIso(), seq: ++visitSeq });
  else st.visits.push({ user_id: user, page_id: page, visits: 1, last_at: nowIso(), seq: ++visitSeq });
}

const lastFirst = (a: Visit, b: Visit) => Date.parse(b.last_at) - Date.parse(a.last_at) || b.seq - a.seq;

function registerPersonal() {
  const favoritesOut = (ctx: Ctx, st: State) => {
    const v = viewerOf(ctx.ws);
    const rows = (st.favorites.get(db.meId) ?? []).map((id) => st.pages.find((r) => r.id === id)).filter((r): r is Row => !!r && live(v, r));
    return pageOf(rows.map(node));
  };

  get("/v1/wiki/favorites", (ctx) => favoritesOut(ctx, stateOf(ctx.ws)));

  put("/v1/wiki/favorites", (ctx) => {
    const st = stateOf(ctx.ws);
    const raw = Array.isArray(ctx.body.page_ids) ? (ctx.body.page_ids as unknown[]) : [];
    if (raw.length > MAX_FAVORITES) throw invalid("at most 100 favorites");
    const list = raw.map((x) => {
      const id = typeof x === "string" ? parseUUID(x.trim()) : undefined;
      if (!id) throw invalid("page_ids is not a valid id");
      return id;
    });
    // Pages out of sight, in the trash or templates are left out; each page once, where it first comes.
    const v = viewerOf(ctx.ws);
    const keep = [...new Set(list)].filter((id) => st.pages.some((r) => r.id === id && live(v, r)));
    st.favorites.set(db.meId, keep);
    return favoritesOut(ctx, st);
  });

  get("/v1/wiki/recent", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const limit = Math.min(Number(ctx.query.get("limit")) || 15, 50);
    const out = st.visits
      .filter((x) => x.user_id === db.meId)
      .sort(lastFirst)
      .map((x) => st.pages.find((r) => r.id === x.page_id))
      .filter((r): r is Row => !!r && live(v, r))
      .slice(0, limit);
    return pageOf(out.map(node));
  });

  get("/v1/wiki/pages/:id/views", (ctx): WikiPageViews => {
    const st = stateOf(ctx.ws);
    const r = find(ctx, st);
    const all = st.visits.filter((x) => x.page_id === r.id);
    const readers = all
      .sort(lastFirst)
      .flatMap((x) => {
        const user = userRef(x.user_id);
        return user ? [{ user, visits: x.visits, last_at: x.last_at }] : [];
      })
      .slice(0, 20);
    return { views: all.reduce((n, x) => n + x.visits, 0), people: all.length, readers };
  });

  get("/v1/wiki/daily", (ctx) => {
    const st = stateOf(ctx.ws);
    const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const from = ctx.query.get("from") || day(-60);
    const to = ctx.query.get("to") || day(60);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw invalid("from and to must be YYYY-MM-DD");
    const out = st.pages
      .filter((r): r is Row & { daily_date: string } => r.private_to === db.meId && !!r.daily_date && r.daily_date >= from && r.daily_date <= to && !r.deleted_at)
      .sort((a, b) => a.daily_date.localeCompare(b.daily_date))
      .map((r): WikiDailyNote => ({ date: r.daily_date, id: r.id }));
    return pageOf(out);
  });

  post("/v1/wiki/daily", (ctx) => {
    requireAgent(ctx);
    const st = stateOf(ctx.ws);
    const me = db.meId;
    const date = ctx.body.date;
    if (!isDate(date)) throw invalid("date must be YYYY-MM-DD");
    const title = cleanTitle(ctx.body.title);
    const journalTitle = cleanTitle(ctx.body.journal_title);
    const body = cleanBody(ctx.body.body_html);
    const existing = st.pages.find((r) => r.private_to === me && r.daily_date === date && !r.deleted_at);
    if (existing) return respond(200, pageOut(st, existing));
    let journal = st.pages.find((r) => r.private_to === me && r.journal && !r.deleted_at);
    if (!journal) {
      roomFor(st, 2);
      journal = newRow({ id: uuid(), parent_id: null, title: journalTitle || "Journal", icon: "📓", body_html: "", private_to: me, journal: true });
      st.pages.push(journal);
      place(st, null, me, null, false, journal.id, 0);
      record(st, journal, false);
      pageEvent(ctx.ws, journal, "wiki_page.created", eventPage(journal));
    } else roomFor(st, 1);
    const note = newRow({ id: uuid(), parent_id: journal.id, title: title || date, icon: "", body_html: body, private_to: me, daily_date: date });
    st.pages.push(note);
    // Newest day first, as a journal reads.
    place(st, journal.id, me, null, false, note.id, 0);
    record(st, note, false);
    pageEvent(ctx.ws, note, "wiki_page.created", eventPage(note));
    return respond(200, pageOut(st, note));
  });
}

// ─── Links and tags (links.go), read from the bodies as the API indexes them ─

function registerLinks() {
  const linksOf = (st: State) => {
    const known = new Set(st.pages.map((r) => r.id));
    return st.pages.flatMap((r) => linkedIds(r.body_html).filter((to) => to !== r.id && known.has(to)).map((to) => ({ from: r.id, to })));
  };
  const mentionOut = (r: Row, title: string) => {
    const text = stripHtml(r.body_html).replace(/\s+/g, " ");
    const at = title ? text.toLowerCase().indexOf(title.toLowerCase()) : -1;
    const start = Math.max(0, at - 60);
    return { id: r.id, parent_id: r.parent_id, title: r.title, icon: r.icon, snippet: (start ? "…" : "") + text.slice(start, start + 180), updated_at: r.updated_at };
  };
  const newestFirst = (a: Row, b: Row) => Date.parse(b.updated_at) - Date.parse(a.updated_at);

  get("/v1/wiki/pages/:id/backlinks", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const target = find(ctx, st);
    const from = new Set(linksOf(st).filter((l) => l.to === target.id).map((l) => l.from));
    const out = st.pages.filter((r) => from.has(r.id) && live(v, r)).sort(newestFirst);
    return pageOf(out.slice(0, 200).map((r) => mentionOut(r, target.title)));
  });

  get("/v1/wiki/pages/:id/mentions", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const target = find(ctx, st);
    const title = target.title.trim().toLowerCase();
    if (!title) return pageOf([]);
    const linked = new Set(linksOf(st).filter((l) => l.to === target.id).map((l) => l.from));
    const out = st.pages.filter((r) => r.id !== target.id && live(v, r) && !linked.has(r.id) && stripHtml(r.body_html).toLowerCase().includes(title)).sort(newestFirst);
    return pageOf(out.slice(0, 100).map((r) => mentionOut(r, target.title)));
  });

  get("/v1/wiki/graph", (ctx) => {
    const st = stateOf(ctx.ws);
    const v = viewerOf(ctx.ws);
    const shown = new Set(st.pages.filter((r) => live(v, r)).map((r) => r.id));
    return pageOf(linksOf(st).filter((l) => shown.has(l.from) && shown.has(l.to)));
  });
}

// ─── The starter handbook ──────────────────────────────────────────────────

type Seed = { title: string; icon: string; body: string; days: number; by: number; cover?: string; verified?: { by: number; days: number; for: number }; children?: Seed[] };

const HANDBOOK: Seed[] = [
  {
    title: "Support handbook",
    icon: "📘",
    cover: "gradient:ocean",
    days: 40,
    by: 0,
    body: "<p>How our team works: who answers what, how fast, and what to do when it gets hard. Start with the escalation process if you are new. #handbook #process</p><h2>Our promises</h2><ul><li><p>A first answer within 4 business hours.</p></li><li><p>Every customer gets a name, never a queue.</p></li><li><p>We say when we don't know yet, and when we'll know.</p></li></ul>",
    children: [
      {
        title: "Escalation process",
        icon: "🚨",
        days: 3,
        by: 1,
        verified: { by: 0, days: 2, for: 90 },
        body: "<p>Escalate when a customer is blocked, money is at stake or you have tried twice without progress.</p><h2>Steps</h2><ol><li><p>Set the ticket to <strong>urgent</strong> and add the <code>escalated</code> label.</p></li><li><p>Leave a note with what you tried and what the customer needs.</p></li><li><p>Assign it to the on-call lead (see Business hours and on-call).</p></li><li><p>Tell the customer who has it now and when they will hear back.</p></li></ol><h2>Sev1 outages</h2><p>Page the on-call engineer from the incident channel. Post a status update every 30 minutes until it is resolved. #process #incidents</p>",
      },
      {
        title: "Refund policy",
        icon: "💸",
        days: 9,
        by: 2,
        body: "<p>Refund within 30 days of a charge, no questions asked, for any plan.</p><ul><li><p>Annual plans: refund the unused months after 30 days, if the customer asks.</p></li><li><p>Duplicate charges: refund at once and apologise.</p></li><li><p>Chargebacks: don't refund twice. Hand it to billing.</p></li></ul>",
        children: [
          {
            title: "Refunds over 100 euros",
            icon: "",
            days: 12,
            by: 2,
            body: "<p>A team lead approves refunds over 100 euros. Leave a note with the amount and the reason, and assign the ticket to a lead. They answer within one business day.</p>",
          },
        ],
      },
      {
        title: "Business hours and on-call",
        icon: "🕐",
        days: 20,
        by: 0,
        body: "<p>We answer Monday to Friday, 8:00 to 18:00 CET. Outside those hours, one lead is on call for sev1 and sev2 issues.</p><p>The on-call rota lives in the team calendar. Swap shifts in the team channel and update the calendar.</p>",
      },
    ],
  },
  {
    title: "Onboarding checklist",
    icon: "👋",
    days: 15,
    by: 1,
    body: "<p>Your first two weeks on the team.</p><h2>Week one</h2><ul><li><p>Read the support handbook.</p></li><li><p>Shadow a teammate for two shifts.</p></li><li><p>Answer ten tickets with a buddy reviewing your drafts.</p></li></ul><h2>Week two</h2><ul><li><p>Take your own queue for half a day.</p></li><li><p>Write or improve one help article.</p></li></ul>",
  },
  {
    title: "Tone of voice",
    icon: "💬",
    days: 60,
    by: 0,
    body: "<p>Warm, plain and specific. Use the customer's name, say what you did and what happens next. No jargon, no exclamation marks in apologies, no \"per my last email\".</p>",
  },
];

// Templates the gallery starts with. {sub} in a body is the id of the template's first subpage.
const TEMPLATES: Seed[] = [
  {
    title: "Incident review",
    icon: "🧯",
    cover: "gradient:ember",
    days: 25,
    by: 1,
    body: '<p>What happened, what it did to customers, and what we change so it doesn\'t happen again. Blameless: name systems and steps, not people. #incidents</p><h2>Summary</h2><p></p><h2>Customer impact</h2><ul><li><p>Who was affected, and for how long:</p></li><li><p>Tickets that came in about it:</p></li></ul><h2>Root cause</h2><p></p><h2>What we change</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul><div data-type="subpage" data-id="{sub}"></div>',
    children: [
      {
        title: "Timeline",
        icon: "🕒",
        days: 25,
        by: 1,
        body: "<p>Times in UTC, from the first sign to the all-clear.</p><table><tbody><tr><th><p>Time</p></th><th><p>What happened</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></tbody></table>",
      },
    ],
  },
  {
    title: "Meeting notes",
    icon: "📝",
    days: 30,
    by: 0,
    body: '<p><strong>Date:</strong> </p><p><strong>Who:</strong> </p><h2>Agenda</h2><ul><li><p></p></li></ul><h2>Notes</h2><p></p><h2>Decisions</h2><ul><li><p></p></li></ul><h2>Action items</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>',
  },
];

function seedHandbook(ws: WsData, st: State) {
  const people = ws.members.map((m) => m.user_id);
  const person = (i: number) => people[i % Math.max(people.length, 1)] ?? null;
  const add = (list: Seed[], parent: string | null, template: boolean) =>
    list.forEach((x, i) => {
      const at = ago(x.days * DAY);
      const by = person(x.by);
      const r = newRow({
        id: uuid(),
        parent_id: parent,
        title: x.title,
        icon: x.icon,
        body_html: x.body,
        position: i,
        version: 3,
        created_by: by,
        updated_by: by,
        created_at: ago((x.days + 30) * DAY),
        updated_at: at,
        template,
        ...(x.cover ? { cover: x.cover } : {}),
        ...(x.verified ? { verified_by: person(x.verified.by), verified_at: ago(x.verified.days * DAY), verified_until: new Date(NOW + (x.verified.for - x.verified.days) * DAY).toISOString() } : {}),
      });
      st.pages.push(r);
      st.revisions.push(
        { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: x.body.replace(/<h2>[\s\S]*$/, ""), author: by, created_at: r.created_at, updated_at: ago((x.days + 29) * DAY) },
        { id: uuid(), page_id: r.id, title: r.title, icon: r.icon, body_html: r.body_html, author: by, created_at: at, updated_at: at },
      );
      if (x.children) add(x.children, r.id, template);
    });
  add(HANDBOOK, null, false);
  // Where one page names another, the first mention becomes a link, as a team would write it:
  // the backlinks, the graph and link previews have something to show.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const r of st.pages) {
    for (const other of st.pages) {
      if (other.id === r.id || !other.title) continue;
      const re = new RegExp(`(>[^<]*?)\\b(${esc(other.title)})\\b`, "i");
      r.body_html = r.body_html.replace(re, (_m, before: string, name: string) => `${before}<a data-type="page" data-id="${other.id}" href="/wiki/${other.id}">${name}</a>`);
    }
  }
  add(TEMPLATES, null, true);
  for (const r of st.pages.filter((p) => p.template && p.body_html.includes("{sub}"))) {
    const sub = st.pages.filter((c) => c.parent_id === r.id).sort(byPosition)[0];
    r.body_html = sub ? r.body_html.replace("{sub}", sub.id) : r.body_html.replace(/<div data-type="subpage"[^>]*><\/div>/, "");
  }
  // Teammates read the handbook, so its readers aren't empty; the person's own visits fill recent pages.
  const handbook = st.pages.filter((p) => !p.template);
  handbook.forEach((p, i) => {
    people.forEach((u, j) => {
      if ((i + j) % 3 === 2) return;
      const visits = 1 + ((i * 5 + j * 3) % 9);
      st.visits.push({ user_id: u, page_id: p.id, visits, last_at: ago(((i + 1) * (j + 2) * 5 * HOUR) % (20 * DAY)), seq: ++visitSeq });
    });
  });
}
