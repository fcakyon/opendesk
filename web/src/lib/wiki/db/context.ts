// What working out a database's cells needs besides the row itself (contracts/wiki.md
// "Databases"): the API keeps schemas and stored values, the app computes the rest.

import type { Database, DbRow, UserRef } from "../../api/types";

export type DbTicketRef = { id: string; number: number; subject: string; status: string };

export type DbContext = {
  /** The database the rows being read belong to. */
  db: Database;
  /**
   * Rows of the databases relations point at, by database id. A relation to the same
   * database finds its rows here too, so put this database's rows in as well.
   */
  rowsByDb: Map<string, DbRow[]>;
  /** Members by id; people a person property names, and rows' authors. */
  members: Map<string, UserRef>;
  tickets?: Map<string, DbTicketRef>;
  /** Schemas of related databases, by id: a rollup reads the property it names there. */
  databases?: Map<string, Database>;
  /** "Now" for today(), now() and relative date filters, fixed for one render. */
  now: Date;
  /** What a page without a title is called in text; the UI passes its translation. */
  untitled?: string;
};

/** The context for rows of a related database; null when its schema isn't known. */
export function relatedContext(ctx: DbContext, databaseId: string): DbContext | null {
  const db = ctx.databases?.get(databaseId);
  return db ? { ...ctx, db } : null;
}
