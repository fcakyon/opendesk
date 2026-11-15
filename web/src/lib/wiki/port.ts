// Wiki import and export in the app (contracts/wiki.md "Import and export"): which files the
// import takes, its skipped list grouped by reason, and saving an export under the name the
// API gives it (or the same name made here, when the browser may not read the header).

import type { WikiExportFormat, WikiImportResult, WikiImportSkipReason, WikiKind, WikiArea } from "@/lib/api/types";

/** What the import reads: one zip, or page sources (Obsidian canvases too). */
export const IMPORT_EXTENSIONS = [".zip", ".md", ".markdown", ".txt", ".html", ".htm", ".csv", ".canvas"] as const;
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.join(",");
/** The most one import uploads, in all. */
export const MAX_IMPORT_BYTES = 100 << 20;

export function importable(name: string): boolean {
  const lower = name.toLowerCase();
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The reasons in the order the result lists them: what changed a page before what was left out. */
export const SKIP_REASONS: readonly WikiImportSkipReason[] = [
  "moved_up",
  "body_too_large",
  "columns_dropped",
  "canvas_trimmed",
  "canvas_simplified",
  "files_limit",
  "too_large",
  "unreadable",
  "unsupported",
  "nested_archive",
  "executable",
  "unused",
];

export type SkipGroup = { reason: string; paths: string[] };

/** The skipped list by reason, known reasons in SKIP_REASONS's order and any other after them. */
export function groupSkipped(skipped: WikiImportResult["skipped"]): SkipGroup[] {
  const by = new Map<string, string[]>();
  for (const s of skipped) by.set(s.reason, [...(by.get(s.reason) ?? []), s.path]);
  const rank = (r: string) => {
    const i = SKIP_REASONS.indexOf(r as WikiImportSkipReason);
    return i < 0 ? SKIP_REASONS.length : i;
  };
  return [...by].map(([reason, paths]) => ({ reason, paths })).sort((a, b) => rank(a.reason) - rank(b.reason));
}

/**
 * A page's file name as the API names it (wikiport.fileName): the title without characters
 * file systems or links refuse, spaces folded, up to 100 characters, "Untitled" when empty.
 */
export function exportBaseName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const kept = title.replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|#^[\]]/g, "");
  const folded = kept.split(/\s+/).filter(Boolean).join(" ").replace(/^[. ]+|[. ]+$/g, "");
  const name = [...folded].slice(0, 100).join("");
  return name || "Untitled";
}

/** The name of a page's export (wikiport.ExportFileName): one file (a canvas's Markdown export is a JSON Canvas file), or a zip with its subpages. */
export function pageExportName(page: { title: string; kind?: WikiKind }, format: WikiExportFormat, zip: boolean): string {
  const ext = zip ? "zip" : format === "html" ? "html" : page.kind === "canvas" ? "canvas" : "md";
  return `${exportBaseName(page.title)}.${ext}`;
}

/** The name of the whole wiki's export, dated in UTC as the API dates it. */
export function wikiExportName(now = new Date(), area: WikiArea = "wiki"): string {
  return `${area === "pages" ? "Pages" : "Wiki"} ${now.toISOString().slice(0, 10)}.zip`;
}

/** Hands a downloaded file to the browser to save. */
export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
