// Changes the database editor makes to a schema. Each returns a new Database and keeps
// it valid for the API (contracts/wiki.md "Databases"): one title first, rollups on
// relations of their own database, views naming only properties that exist.

import type { Database, DbFilterGroup, DbOption, DbProperty, DbPropType, DbTone, DbValue, DbView, DbViewSettings, DbViewType } from "../../api/types";
import { CALCS_FOR } from "./calc";
import type { DbContext } from "./context";
import { FILTER_OPS } from "./filter";
import { askable, defaultForm } from "./form";

/** Colours new options take in turn. */
export const TONE_ORDER: readonly DbTone[] = ["blue", "green", "yellow", "orange", "red", "purple", "pink", "brown", "gray"];

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

// Ids are never reused: rows may still hold values of a removed property until they are
// next saved, and a new property must not read them.
function randomId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = prefix + Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!taken(id)) return id;
  }
}

export function newPropId(db: Database): string {
  return randomId("p", (id) => db.properties.some((p) => p.id === id));
}

export function newOptionId(prop: DbProperty): string {
  return randomId("o", (id) => (prop.options ?? []).some((o) => o.id === id));
}

export function newViewId(db: Database): string {
  return randomId("v", (id) => db.views.some((v) => v.id === id));
}

/** The colour the next new option of a property takes. */
export function nextTone(prop: DbProperty): DbTone {
  return TONE_ORDER[(prop.options?.length ?? 0) % TONE_ORDER.length];
}

export function addOption(prop: DbProperty, name: string): { prop: DbProperty; option: DbOption } {
  const option: DbOption = { id: newOptionId(prop), name: name.trim(), color: nextTone(prop) };
  return { prop: { ...prop, options: [...(prop.options ?? []), option] }, option };
}

const VIEW_NAMES: Record<DbViewType, string> = { table: "Table", board: "Board", list: "List", gallery: "Gallery", calendar: "Calendar", timeline: "Timeline", chart: "Chart", form: "Form" };

const firstOf = (db: Database, ...types: DbPropType[]) => types.map((t) => db.properties.find((p) => p.type === t)).find(Boolean);

/** A new view of a type, set up to show something: a board grouped, a calendar on a date. The UI names it. */
export function defaultView(type: DbViewType, db: Database, name = VIEW_NAMES[type]): DbView {
  const settings: DbViewSettings = {};
  const options = firstOf(db, "status", "select");
  const date = firstOf(db, "date");
  switch (type) {
    case "board":
      if (options) settings.group_by = options.id;
      break;
    case "calendar":
    case "timeline":
      settings.date_property = (date ?? firstOf(db, "created_time"))?.id;
      if (!settings.date_property) delete settings.date_property;
      if (type === "timeline") settings.timeline_scale = "week";
      break;
    case "gallery":
      settings.card_preview = "cover";
      break;
    case "chart": {
      const x = options ?? firstOf(db, "multi_select", "person", "checkbox");
      settings.chart = { kind: "column", x: x?.id ?? "title" };
      break;
    }
    case "form":
      settings.form = defaultForm(db);
      break;
  }
  return { id: newViewId(db), name, type, ...(Object.keys(settings).length ? { settings } : {}) };
}

/** A status property's options when it starts; the UI passes its translations. */
export type StatusNames = { todo: string; doing: string; done: string };
const STATUS_NAMES: StatusNames = { todo: "Not started", doing: "In progress", done: "Done" };

function statusDefaults(names: StatusNames): Pick<DbProperty, "options" | "groups"> {
  return {
    options: [
      { id: "not_started", name: names.todo, color: "gray" },
      { id: "in_progress", name: names.doing, color: "blue" },
      { id: "done", name: names.done, color: "green" },
    ],
    groups: [
      { id: "todo", option_ids: ["not_started"] },
      { id: "doing", option_ids: ["in_progress"] },
      { id: "done", option_ids: ["done"] },
    ],
  };
}

/** What a new property of a type starts with besides id, name and type. */
function defaultsFor(type: DbPropType, db: Database, names: StatusNames): Partial<DbProperty> {
  switch (type) {
    case "select":
    case "multi_select":
      return { options: [] };
    case "status":
      return statusDefaults(names);
    case "number":
      return { number_format: "number" };
    case "formula":
      return { formula: "" };
    case "rollup": {
      // The editor picks the relation; the API takes a rollup only once it names one.
      const relation = db.properties.find((p) => p.type === "relation");
      return { rollup: { relation: relation?.id ?? "", property: "title", fn: "count" } };
    }
    default:
      return {};
  }
}

/** A name not taken by another property: prop("Name") reads properties by name. */
function uniqueName(db: Database, name: string, except?: string): string {
  const base = name.trim() || "Property";
  const taken = (n: string) => db.properties.some((p) => p.id !== except && p.name.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

/** Adds a property at the end. A database has one title: asking for another adds text. */
export function addProperty(db: Database, type: DbPropType, name: string, statusNames: StatusNames = STATUS_NAMES): { db: Database; id: string; prop: DbProperty } {
  const t = type === "title" ? "text" : type;
  const prop: DbProperty = { id: newPropId(db), name: uniqueName(db, name), type: t, ...defaultsFor(t, db, statusNames) };
  return { db: { ...db, properties: [...db.properties, prop] }, id: prop.id, prop };
}

const OPTION_TYPES: ReadonlySet<DbPropType> = new Set(["select", "multi_select", "status"]);

/**
 * Gives a property another type. Options stay between select, multi-select and status
 * (all in "to do" when they become a status); what only the old type had goes, and so
 * do the views' filters and calculations the new type doesn't offer.
 */
export function changePropertyType(db: Database, propId: string, type: DbPropType, statusNames: StatusNames = STATUS_NAMES): Database {
  const old = db.properties.find((p) => p.id === propId);
  if (!old || old.type === type || old.type === "title" || type === "title") return db;
  const next: DbProperty = { id: old.id, name: old.name, type, ...(old.description ? { description: old.description } : {}), ...defaultsFor(type, db, statusNames) };
  if (OPTION_TYPES.has(type) && OPTION_TYPES.has(old.type) && old.options?.length) {
    next.options = old.options;
    next.groups = type === "status" ? [{ id: "todo", option_ids: old.options.map((o) => o.id) }, { id: "doing", option_ids: [] }, { id: "done", option_ids: [] }] : undefined;
    if (!next.groups) delete next.groups;
  }
  const properties = db.properties.map((p) => (p.id === propId ? next : p));
  // A relation that becomes something else takes its rollups with it.
  const gone = old.type === "relation" ? dependentRollups(db, propId) : new Set<string>();
  const kept = withoutPairs({ ...db, properties: properties.filter((p) => !gone.has(p.id)) }, new Set([...gone, propId]));
  return { ...kept, views: kept.views.map((v) => tidyView(scrubView(v, gone), next)) };
}

/** A database without the sub-items or dependencies that name a property gone or changed. */
function withoutPairs(db: Database, gone: Set<string>): Database {
  const next = { ...db };
  if (next.sub_items && (gone.has(next.sub_items.parent) || gone.has(next.sub_items.children))) delete next.sub_items;
  if (next.dependencies && (gone.has(next.dependencies.blocked_by) || gone.has(next.dependencies.blocking))) delete next.dependencies;
  return next;
}

function dependentRollups(db: Database, relationId: string): Set<string> {
  return new Set(db.properties.filter((p) => p.type === "rollup" && p.rollup?.relation === relationId).map((p) => p.id));
}

/** Removes a property, the rollups reading through it, and every mention of them in views. The title stays. */
export function removeProperty(db: Database, propId: string): Database {
  const prop = db.properties.find((p) => p.id === propId);
  if (!prop || prop.type === "title") return db;
  const gone = new Set([propId, ...dependentRollups(db, propId)]);
  return withoutPairs({ ...db, properties: db.properties.filter((p) => !gone.has(p.id)), views: db.views.map((v) => scrubView(v, gone)) }, gone);
}

function isGroup(r: DbFilterGroup["rules"][number]): r is DbFilterGroup {
  return Array.isArray((r as DbFilterGroup).rules);
}

function filterRules(group: DbFilterGroup, keep: (property: string, op: string) => boolean): DbFilterGroup | undefined {
  const rules = group.rules.flatMap<DbFilterGroup["rules"][number]>((r) => {
    if (!isGroup(r)) return keep(r.property, r.op) ? [r] : [];
    const g = filterRules(r, keep);
    return g ? [g] : [];
  });
  return rules.length ? { ...group, rules } : undefined;
}

function without<T>(record: Record<string, T> | undefined, gone: Set<string>): Record<string, T> | undefined {
  const kept = Object.entries(record ?? {}).filter(([k]) => !gone.has(k));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** A view without any mention of the properties gone. */
function scrubView(view: DbView, gone: Set<string>): DbView {
  const s = view.settings;
  if (!s || !gone.size) return view;
  const next: DbViewSettings = {
    ...s,
    filter: s.filter && filterRules(s.filter, (p) => !gone.has(p)),
    sorts: s.sorts?.filter((x) => !gone.has(x.property)),
    group_by: s.group_by && gone.has(s.group_by) ? undefined : s.group_by,
    hidden: s.hidden?.filter((id) => !gone.has(id)),
    order: s.order?.filter((id) => !gone.has(id)),
    widths: without(s.widths, gone),
    calculations: without(s.calculations, gone),
    date_property: s.date_property && gone.has(s.date_property) ? undefined : s.date_property,
    end_property: s.end_property && gone.has(s.end_property) ? undefined : s.end_property,
    chart: s.chart && gone.has(s.chart.x) ? undefined : s.chart && s.chart.y && gone.has(s.chart.y.property) ? { ...s.chart, y: undefined } : s.chart,
    form: s.form && { ...s.form, fields: s.form.fields.filter((f) => !gone.has(f.property)) },
  };
  return { ...view, settings: compact(next) };
}

/** A view without the filters and calculations a property's new type doesn't offer. */
function tidyView(view: DbView, prop: DbProperty): DbView {
  const s = view.settings;
  if (!s) return view;
  const ops = FILTER_OPS[prop.type];
  const calc = s.calculations?.[prop.id];
  const calculations = calc && !CALCS_FOR[prop.type].includes(calc) ? without(s.calculations, new Set([prop.id])) : s.calculations;
  const filter = s.filter && filterRules(s.filter, (p, op) => p !== prop.id || ops.includes(op));
  // A form asks only what a row stores.
  const form = s.form && !askable(prop) ? { ...s.form, fields: s.form.fields.filter((f) => f.property !== prop.id) } : s.form;
  return { ...view, settings: compact({ ...s, filter, calculations, form }) };
}

function compact(s: DbViewSettings): DbViewSettings {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as DbViewSettings;
}

/** The properties a view shows, in its order: the title first, then its order, then the rest as the schema has them. */
export function visibleProps(db: Database, view: DbView | undefined): DbProperty[] {
  const hidden = new Set(view?.settings?.hidden ?? []);
  const byId = new Map(db.properties.map((p) => [p.id, p]));
  const title = db.properties.find((p) => p.type === "title");
  const ordered = (view?.settings?.order ?? []).flatMap((id) => byId.get(id) ?? []);
  const rest = db.properties.filter((p) => !ordered.includes(p));
  const all = [...new Set([...(title ? [title] : []), ...ordered, ...rest])];
  return all.filter((p) => p.type === "title" || !hidden.has(p.id));
}

/** The value a new row starts with: a status its first "to do" option, a checkbox unchecked, the rest nothing. */
export function defaultValueFor(prop: DbProperty, _ctx?: DbContext): DbValue {
  switch (prop.type) {
    case "status": {
      const todo = prop.groups?.find((g) => g.id === "todo")?.option_ids.find((id) => prop.options?.some((o) => o.id === id));
      return todo ?? prop.options?.[0]?.id ?? null;
    }
    case "checkbox":
      return false;
    default:
      return null;
  }
}

/** What the properties of a relation pair are called; the UI passes its translations. */
export type PairNames = { first: string; second: string };

/**
 * Turns on sub-items or dependencies: two relations of the database (dbId) to itself, kept in
 * step. Two such relations already named so (left from turning it off) are taken up again.
 * Sub-items' properties are hidden in the views, which show the nesting instead.
 */
export function enablePair(db: Database, dbId: string, kind: "sub_items" | "dependencies", names: PairNames): Database {
  if (db[kind]) return db;
  const other = kind === "sub_items" ? db.dependencies && [db.dependencies.blocked_by, db.dependencies.blocking] : db.sub_items && [db.sub_items.parent, db.sub_items.children];
  const reuse = (name: string) => db.properties.find((p) => p.type === "relation" && p.database_id === dbId && p.name.toLowerCase() === name.toLowerCase() && !other?.includes(p.id));
  let next = db;
  const take = (name: string): string => {
    const found = reuse(name);
    if (found) return found.id;
    const made = addProperty(next, "relation", name);
    next = { ...made.db, properties: made.db.properties.map((p) => (p.id === made.id ? { ...p, database_id: dbId } : p)) };
    return made.id;
  };
  const a = take(names.first);
  const b = take(names.second);
  if (a === b) return db;
  if (kind === "dependencies") return { ...next, dependencies: { blocked_by: a, blocking: b } };
  const hide = (v: DbView): DbView => (v.type === "table" || v.type === "list" ? { ...v, settings: { ...v.settings, hidden: [...new Set([...(v.settings?.hidden ?? []), a, b])] } } : v);
  return { ...next, sub_items: { parent: a, children: b }, views: next.views.map(hide) };
}

/** Turns sub-items or dependencies off; the two relations stay, as plain relations. */
export function disablePair(db: Database, kind: "sub_items" | "dependencies"): Database {
  const next = { ...db };
  delete next[kind];
  return next;
}
