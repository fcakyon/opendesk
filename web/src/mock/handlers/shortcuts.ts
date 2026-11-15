// /v1/me/shortcuts (contracts/api.md "Keyboard shortcuts"): the keys the person chose,
// checked as the server checks them.

import { isBinding } from "@/lib/shortcuts";
import { get, invalid, put, type Ctx } from "../router";

let saved: Record<string, string | null> = {};

const ID = /^[a-z][a-zA-Z]{0,30}\.[a-z][a-zA-Z0-9]{0,40}$/;

function replace(ctx: Ctx) {
  const b = (ctx.body as { bindings?: unknown }).bindings ?? {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("bindings is an object.");
  const entries = Object.entries(b as Record<string, unknown>);
  if (entries.length > 300) throw invalid("at most 300 shortcuts");
  if (JSON.stringify(b).length > 8 << 10) throw invalid("shortcuts are at most 8 KB");
  for (const [id, keys] of entries) {
    if (!ID.test(id)) throw invalid('shortcut ids look like "go.pages"');
    if (keys !== null && (typeof keys !== "string" || !isBinding(keys))) throw invalid(`keys for ${id} are not a shortcut`);
  }
  saved = Object.fromEntries(entries) as Record<string, string | null>;
  return { bindings: saved };
}

export function registerShortcuts() {
  get("/v1/me/shortcuts", () => ({ bindings: saved }));
  put("/v1/me/shortcuts", replace);
}

/** Back to nothing chosen, between tests. */
export function resetShortcuts() {
  saved = {};
}
