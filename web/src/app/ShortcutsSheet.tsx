import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty";
import { Dialog } from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { spaceKeys } from "@/components/spaces/actions";
import { useCollab } from "@/lib/collab/hooks";
import { orderedScopes, useHereScopes, useOfferedShortcuts, useShortcutLabels } from "@/lib/shortcutLabels";
import { bindingOf, displayKeys, useShortcutKeys, type ShortcutScope } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { shell, useShell } from "./shellStore";
import { quickSwitchKeys } from "./useAccounts";

type Row = { id: string; keys: string; label: string };

/**
 * The ? sheet: every shortcut the workspace offers with the person's own keys, this page's
 * first, and a search. Settings › Shortcuts changes them.
 */
export function ShortcutsSheet() {
  const open = useShell((s) => s.shortcutsOpen);
  const { t } = useTranslation("shortcuts");
  return (
    <Dialog open={open} onOpenChange={(o) => shell.shortcuts(o)} title={t("title")} description={t("description")} size="xl">
      {open && <SheetBody />}
    </Dialog>
  );
}

function SheetBody() {
  const { t } = useTranslation("shortcuts");
  const { t: tShell } = useTranslation("shell");
  const { t: ts } = useTranslation("spaces");
  const label = useShortcutLabels();
  const offered = useOfferedShortcuts();
  const collab = useCollab();
  const here = useHereScopes();
  const bindings = useShortcutKeys((s) => s.bindings);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const rows = new Map<ShortcutScope, Row[]>();
    for (const s of offered) {
      if (s.scope === "mail" && !collab.enabled) continue;
      const keys = bindingOf(s.id, bindings);
      if (!keys) continue;
      const r = { id: s.id, keys: displayKeys(keys), label: label(s) };
      // Two ids with one label and the same purpose (j and the down arrow) read as one row.
      const list = rows.get(s.scope) ?? [];
      const twin = list.find((x) => x.label === r.label);
      if (twin) twin.keys = `${twin.keys} / ${r.keys}`;
      else list.push(r);
      rows.set(s.scope, list);
    }
    // Switching workspaces and Spaces: their own keys, by number.
    rows.get("global")?.push(
      { id: "switch.workspace", keys: quickSwitchKeys("1-9"), label: tShell("shortcuts.switchWorkspace") },
      { id: "switch.space", keys: spaceKeys("1-9"), label: ts("shortcuts.openSpace") },
    );
    const needle = query.trim().toLowerCase();
    return orderedScopes(here)
      .map((scope) => ({
        scope,
        rows: (rows.get(scope) ?? []).filter((r) => !needle || r.label.toLowerCase().includes(needle) || r.keys.toLowerCase().includes(needle) || t(`scopes.${scope}`).toLowerCase().includes(needle)),
      }))
      .filter((g) => g.rows.length);
  }, [offered, collab.enabled, bindings, label, here, query, t, tShell, ts]);

  return (
    <div className="flex flex-col gap-4 pb-2">
      <div className="flex items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder={t("sheet.search")} autoFocus className="flex-1" inputSize="md" />
        <Link to="/settings/shortcuts" onClick={() => shell.shortcuts(false)} className="shrink-0 rounded-md px-2 py-1.5 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
          {t("sheet.customize")}
        </Link>
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={<Search />} title={t("sheet.empty", { query: query.trim() })} />
      ) : (
        <div className="columns-1 gap-x-8 sm:columns-2">
          {groups.map((g) => (
            <section key={g.scope} className="mb-5 break-inside-avoid">
              <h3 className="label-caps mb-1.5 flex items-center gap-2">
                {t(`scopes.${g.scope}`)}
                {here.includes(g.scope) && <span className="rounded-sm bg-tone-blue-soft px-1 py-px text-[10px] font-medium normal-case tracking-normal text-tone-blue">{t("sheet.here")}</span>}
              </h3>
              <ul className="flex flex-col">
                {g.rows.map((r) => (
                  <li key={r.id} className={cn("flex min-h-8 items-center justify-between gap-4 border-b border-line-soft py-1 text-[12.5px] text-fg-2 last:border-0")}>
                    <span className="min-w-0">{r.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.split(" / ").map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
