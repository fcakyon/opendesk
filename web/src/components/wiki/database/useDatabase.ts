// A wiki database's data for its views (contracts/wiki.md "Databases"): its schema from the
// database page, its rows, the rows of the databases its relations point at (relations and
// rollups read them), and the workspace's members, as one DbContext. Changes show at once
// and are saved behind: a schema replaced whole, a row's values merged.

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { Database, DbRow, DbRows, DbValue, UserRef, WikiNode, WikiPage } from "@/lib/api/types";
import { q, qk } from "@/lib/queries";
import { patchTree } from "../hooks";
import { pairedWrites, type DbContext } from "@/lib/wiki/db";

export type DatabaseData = {
  page: WikiPage | undefined;
  db: Database | undefined;
  rows: DbRow[];
  templates: WikiNode[];
  ctx: DbContext | null;
  isLoading: boolean;
  isError: boolean;
};

export function useDatabase(id: string): DatabaseData {
  const page = useQuery(q.wikiPage(id));
  const rows = useQuery(q.wikiRows(id));
  const members = useQuery(q.members());
  const { t } = useTranslation("wiki");
  const db = page.data?.database ?? undefined;
  // The databases the relations point at, for their rows' titles and rollups.
  const related = useMemo(() => [...new Set((db?.properties ?? []).filter((p) => p.type === "relation" && p.database_id).map((p) => p.database_id!))], [db]);
  const relatedRows = useQueries({ queries: related.map((rid) => ({ ...q.wikiRows(rid), retry: false })) });
  const relatedPages = useQueries({ queries: related.map((rid) => ({ ...q.wikiPage(rid), retry: false })) });

  const ctx = useMemo<DbContext | null>(() => {
    if (!db) return null;
    const rowsByDb = new Map<string, DbRow[]>([[id, rows.data?.data ?? []]]);
    const databases = new Map<string, Database>([[id, db]]);
    related.forEach((rid, i) => {
      rowsByDb.set(rid, relatedRows[i]?.data?.data ?? []);
      const d = relatedPages[i]?.data?.database;
      if (d) databases.set(rid, d);
    });
    const people = new Map<string, UserRef>((members.data ?? []).map((m) => [m.user.id, m.user]));
    return { db, rowsByDb, databases, members: people, now: new Date(), untitled: t("untitled") };
    // The related queries' data identities change with their content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, id, rows.data, members.data, related, t, ...relatedRows.map((r) => r.data), ...relatedPages.map((r) => r.data)]);

  return {
    page: page.data,
    db,
    rows: rows.data?.data ?? [],
    templates: rows.data?.templates ?? [],
    ctx,
    isLoading: page.isLoading || rows.isLoading,
    isError: page.isError || rows.isError,
  };
}

const merged = (props: Record<string, DbValue>, values: Record<string, DbValue>) => {
  const next = { ...props };
  for (const [k, v] of Object.entries(values)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
};

/** The writes a database's views make. */
export function useDatabaseActions(id: string) {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  const patchRows = (fn: (rows: DbRow[]) => DbRow[]) => qc.setQueryData<DbRows>(qk.wikiRows(id), (old) => (old ? { ...old, data: fn(old.data) } : old));
  const schema = () => qc.getQueryData<WikiPage>(qk.wikiPage(id))?.database ?? undefined;
  const cachedRows = () => qc.getQueryData<DbRows>(qk.wikiRows(id))?.data ?? [];

  /**
   * Saves values on rows: one row's change and what its paired relations (sub-items,
   * dependencies) mirror on the rows they name (contracts/wiki.md "Databases"). Shown at
   * once; put back and read again if any is refused.
   */
  const writeRows = async (writes: Map<string, Record<string, DbValue>>) => {
    const before = qc.getQueryData<DbRows>(qk.wikiRows(id));
    patchRows((rows) => rows.map((r) => (writes.has(r.id) ? { ...r, props: merged(r.props, writes.get(r.id)!) } : r)));
    try {
      const saved = await Promise.all([...writes].map(([rowId, props]) => api.wiki.update(rowId, { props })));
      const byId = new Map(saved.map((s) => [s.id, s]));
      patchRows((rows) => rows.map((r) => (byId.has(r.id) ? { ...r, props: byId.get(r.id)!.props, updated_at: byId.get(r.id)!.updated_at, updated_by: byId.get(r.id)!.updated_by } : r)));
      for (const s of saved) qc.setQueryData<WikiPage>(qk.wikiPage(s.id), (old) => (old ? { ...old, props: s.props } : old));
    } catch (e) {
      if (before) qc.setQueryData(qk.wikiRows(id), before);
      if (writes.size > 1) void qc.invalidateQueries({ queryKey: qk.wikiRows(id) });
      toast.error(e, t("db.saveFailed"));
    }
  };

  /** The other side of a new row's paired relations, once the row is made with its values. */
  const mirrorNew = async (rowId: string, props: Record<string, DbValue>) => {
    const db = schema();
    if (!db || (!db.sub_items && !db.dependencies)) return;
    const rows = [...cachedRows().filter((r) => r.id !== rowId), { id: rowId, props: {} }];
    const writes = pairedWrites(db, rows, rowId, props);
    writes.delete(rowId);
    await Promise.all([...writes].map(([other, values]) => api.wiki.update(other, { props: values })));
  };

  return {
    /** Replaces the schema (properties and views); shown at once, put back if refused. */
    saveSchema: async (next: Database) => {
      const key = qk.wikiPage(id);
      const before = qc.getQueryData<WikiPage>(key);
      qc.setQueryData<WikiPage>(key, (old) => (old ? { ...old, database: next } : old));
      try {
        const saved = await api.wiki.update(id, { database: next });
        qc.setQueryData<WikiPage>(key, (old) => (old ? { ...old, database: saved.database } : old));
        // A unique id added now numbered the rows.
        if (next.properties.some((p) => p.type === "unique_id")) void qc.invalidateQueries({ queryKey: qk.wikiRows(id) });
      } catch (e) {
        if (before) qc.setQueryData(key, before);
        toast.error(e, t("db.saveFailed"));
      }
    },
    /** Merges values into a row (null takes one away), and mirrors its paired relations. */
    updateRow: (rowId: string, props: Record<string, DbValue>) => {
      const db = schema();
      return writeRows(db ? pairedWrites(db, cachedRows(), rowId, props) : new Map([[rowId, props]]));
    },
    /** Renames a row (its page title). */
    renameRow: async (rowId: string, title: string) => {
      patchRows((rows) => rows.map((r) => (r.id === rowId ? { ...r, title } : r)));
      try {
        const saved = await api.wiki.update(rowId, { title });
        qc.setQueryData<WikiPage>(qk.wikiPage(rowId), saved);
        patchTree(qc, (nodes) => nodes.map((n) => (n.id === rowId ? { ...n, title: saved.title, version: saved.version } : n)));
      } catch (e) {
        toast.error(e, t("db.saveFailed"));
        void qc.invalidateQueries({ queryKey: qk.wikiRows(id) });
      }
    },
    /** A new row, with values (a board column's, a calendar day's) or from a template. */
    createRow: async (props: Record<string, DbValue> = {}, opts: { title?: string; template?: string; position?: number } = {}): Promise<DbRow | null> => {
      try {
        const page = opts.template
          ? await api.wiki.duplicate(opts.template, { parent_id: id, template: false, title: opts.title })
          : await api.wiki.create({ parent_id: id, title: opts.title ?? "", props, position: opts.position });
        if (opts.template && Object.keys(props).length) await api.wiki.update(page.id, { props });
        await mirrorNew(page.id, props);
        await qc.invalidateQueries({ queryKey: qk.wikiRows(id) });
        void qc.invalidateQueries({ queryKey: qk.wikiTree });
        const row = qc.getQueryData<DbRows>(qk.wikiRows(id))?.data.find((r) => r.id === page.id);
        return row ?? null;
      } catch (e) {
        toast.error(e, t("db.createFailed"));
        return null;
      }
    },
    /** A new template of the database, resolving to its id: new rows can start as a copy of it. */
    createTemplate: async (): Promise<string | null> => {
      try {
        const page = await api.wiki.create({ parent_id: id, template: true, title: t("db.templateTitle") });
        void qc.invalidateQueries({ queryKey: qk.wikiRows(id) });
        return page.id;
      } catch (e) {
        toast.error(e, t("db.createFailed"));
        return null;
      }
    },
    /** Moves rows to the trash. */
    trashRows: async (ids: string[]) => {
      const before = qc.getQueryData<DbRows>(qk.wikiRows(id));
      patchRows((rows) => rows.filter((r) => !ids.includes(r.id)));
      try {
        await Promise.all(ids.map((x) => api.wiki.trash(x)));
        void qc.invalidateQueries({ queryKey: qk.wikiTree });
        void qc.invalidateQueries({ queryKey: qk.wikiTrash });
        toast.success(t("db.trashed", { count: ids.length }));
      } catch (e) {
        if (before) qc.setQueryData(qk.wikiRows(id), before);
        toast.error(e, t("trash.moveFailed"));
      }
    },
    /** Puts a row at an index among the rows (a view without sorts keeps this order). */
    moveRow: async (rowId: string, position: number) => {
      const before = qc.getQueryData<DbRows>(qk.wikiRows(id));
      patchRows((rows) => {
        const list = rows.filter((r) => r.id !== rowId);
        const moving = rows.find((r) => r.id === rowId);
        if (!moving) return rows;
        list.splice(Math.max(0, Math.min(position, list.length)), 0, moving);
        return list.map((r, i) => ({ ...r, position: i }));
      });
      try {
        await api.wiki.move(rowId, { parent_id: id, position });
      } catch (e) {
        if (before) qc.setQueryData(qk.wikiRows(id), before);
        toast.error(e, t("toast.moveFailed"));
      }
    },
  };
}
