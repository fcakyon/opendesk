// Saves people as a CSV file: the ones selected by id (the server takes 1000 at a time, so a
// longer selection goes in pieces under one header), or everyone a filter matches.

import { api, type ContactBulkQuery } from "@/lib/api/endpoints";
import { saveBlob } from "@/lib/wiki/port";

const PIECE = 1000;

export type ExportTarget = { ids: string[] } | { query: ContactBulkQuery };

export async function exportContacts(target: ExportTarget): Promise<void> {
  if ("query" in target || target.ids.length <= PIECE) {
    const { blob, filename } = await api.contacts.exportCsv(target);
    saveBlob(blob, filename ?? "people.csv");
    return;
  }
  let name: string | null = null;
  const parts: string[] = [];
  for (let i = 0; i < target.ids.length; i += PIECE) {
    const { blob, filename } = await api.contacts.exportCsv({ ids: target.ids.slice(i, i + PIECE) });
    name ??= filename;
    const text = await blob.text();
    // Every piece starts with the header row; only the first keeps it.
    parts.push(i === 0 ? text : text.slice(text.indexOf("\n") + 1));
  }
  saveBlob(new Blob(["﻿", ...parts], { type: "text/csv;charset=utf-8" }), name ?? "people.csv");
}
