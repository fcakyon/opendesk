// Settings › Account › Shortcuts: every shortcut the workspace offers, by where it works,
// with the person's keys. Click the keys to record new ones (a clash names the shortcut that
// has them), reset one or all, or turn one off. The editor's and the canvas's own keys are
// listed and can't be changed. Saved per person and kept on every device (lib/shortcutSync.ts).

import { CircleSlash, Keyboard, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Section, SettingsPage } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useCollab } from "@/lib/collab/hooks";
import { recorder, stepOf } from "@/lib/shortcutRecorder";
import { orderedScopes, useHereScopes, useOfferedShortcuts, useShortcutLabels } from "@/lib/shortcutLabels";
import { bindingOf, conflictsFor, displayKeys, shortcutDef, useShortcutKeys, type ShortcutBindings, type ShortcutDef } from "@/lib/shortcuts";
import { useSaveShortcuts } from "@/lib/shortcutSync";

/** How long a first press waits for a second ("g", then "p"). */
const SECOND_STEP_MS = 900;

export default function Shortcuts() {
  const { t } = useTranslation("shortcuts");
  const label = useShortcutLabels();
  const offered = useOfferedShortcuts();
  const collab = useCollab();
  const bindings = useShortcutKeys((s) => s.bindings);
  const save = useSaveShortcuts();
  const confirm = useConfirm();
  const here = useHereScopes();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);

  const set = (id: string, keys: string | null | undefined) => {
    const next: ShortcutBindings = { ...bindings };
    if (keys === undefined || keys === shortcutDef(id)?.keys) delete next[id];
    else next[id] = keys;
    save(next);
  };

  const needle = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      orderedScopes(here)
        .map((scope) => ({
          scope,
          items: offered.filter(
            (s) => s.scope === scope && (s.scope !== "mail" || collab.enabled) && (!needle || label(s).toLowerCase().includes(needle) || displayKeys(s.keys).includes(needle) || t(`scopes.${scope}`).toLowerCase().includes(needle)),
          ),
        }))
        .filter((g) => g.items.length),
    [here, offered, collab.enabled, needle, label, t],
  );
  const changed = Object.keys(bindings).length;

  return (
    <SettingsPage
      title={t("settings.title")}
      description={t("settings.description")}
      actions={
        changed > 0 ? (
          <Button
            icon={<RotateCcw />}
            onClick={() => confirm.show(t("settings.resetAllBody"), () => save({}), { title: t("settings.resetAllTitle"), confirmLabel: t("settings.resetAll") })}
          >
            {t("settings.resetAll")}
          </Button>
        ) : undefined
      }
    >
      <SearchInput value={query} onChange={setQuery} placeholder={t("settings.search")} className="mb-4 max-w-sm" inputSize="md" />
      {groups.length === 0 ? (
        <EmptyState icon={<Search />} title={t("settings.none", { query: query.trim() })} />
      ) : (
        groups.map((g) => (
          <Section key={g.scope} title={t(`scopes.${g.scope}`)} flush>
            <ul className="divide-y divide-line-soft">
              {g.items.map((s) => (
                <ShortcutRow
                  key={s.id}
                  def={s}
                  label={label(s)}
                  keys={bindingOf(s.id, bindings)}
                  changed={s.id in bindings}
                  recording={recording === s.id}
                  onRecord={() => setRecording(s.id)}
                  onStop={() => setRecording(null)}
                  onSet={(k) => set(s.id, k)}
                  clashLabel={(d) => label(d)}
                />
              ))}
            </ul>
          </Section>
        ))
      )}
    </SettingsPage>
  );
}

function ShortcutRow({
  def,
  label,
  keys,
  changed,
  recording,
  onRecord,
  onStop,
  onSet,
  clashLabel,
}: {
  def: ShortcutDef;
  label: string;
  keys: string | null;
  changed: boolean;
  recording: boolean;
  onRecord: () => void;
  onStop: () => void;
  onSet: (keys: string | null | undefined) => void;
  clashLabel: (d: ShortcutDef) => string;
}) {
  const { t } = useTranslation("shortcuts");
  const [heard, setHeard] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  // While recording, every press is the new keys': nothing else in the app hears it.
  useEffect(() => {
    if (!recording) return;
    setHeard(null);
    const rec = recorder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (b: string | null) => {
      clearTimeout(timer);
      if (b) {
        const clashes = conflictsFor(def.id, b);
        if (clashes.length) {
          setHeard(b);
          toast.error(
            clashes.length > 1
              ? t("settings.clashMore", { label: clashLabel(clashes[0]!), count: clashes.length - 1 })
              : t("settings.clash", { label: clashLabel(clashes[0]!) }),
          );
          return;
        }
        onSet(b);
        toast.success(t("settings.saved"));
      }
      onStop();
      button.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        clearTimeout(timer);
        onStop();
        button.current?.focus();
        return;
      }
      const step = stepOf(e);
      if (!step) return;
      const b = rec.press(step);
      setHeard(b ?? step);
      clearTimeout(timer);
      if (b) done(b);
      else timer = setTimeout(() => done(rec.flush()), SECOND_STEP_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
    };
    // The row's own callbacks change each render; the recording is what starts and stops this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, def.id]);

  const shown = recording ? heard : keys;
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-1.5">
      <span className={cn("min-w-0 flex-1 text-[13px]", keys ? "text-fg" : "text-fg-3")}>{label}</span>
      {changed && !recording && <span className="text-[11.5px] text-fg-4">{keys ? t("settings.changed") : t("settings.off")}</span>}
      {def.fixed ? (
        <Tooltip content={t("settings.fixed")}>
          <span className="opacity-70">
            <Kbd>{displayKeys(def.keys)}</Kbd>
          </span>
        </Tooltip>
      ) : (
        <>
          <button
            ref={button}
            type="button"
            aria-label={t("settings.change", { label })}
            aria-pressed={recording}
            onClick={() => (recording ? onStop() : onRecord())}
            className={cn(
              "flex h-7 min-w-[88px] items-center justify-end gap-1 rounded-md border px-1.5 outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)]",
              recording ? "border-focus-line bg-surface shadow-[0_0_0_3px_var(--focus)]" : "border-transparent hover:border-line hover:bg-hover",
            )}
          >
            {recording && !heard ? (
              <span className="flex items-center gap-1.5 px-1 text-[12px] text-fg-3">
                <Keyboard className="size-3.5" />
                {t("settings.record")}
              </span>
            ) : shown ? (
              <Kbd>{displayKeys(shown)}</Kbd>
            ) : (
              <span className="px-1 text-[12px] text-fg-4">{t("settings.off")}</span>
            )}
          </button>
          <span className="flex w-14 justify-end gap-0.5">
            {changed && (
              <Tooltip content={t("settings.reset")}>
                <Button square variant="ghost" size="xs" aria-label={`${t("settings.reset")}: ${label}`} onClick={() => onSet(undefined)}>
                  <RotateCcw />
                </Button>
              </Tooltip>
            )}
            {keys && (
              <Tooltip content={t("settings.turnOff")}>
                <Button square variant="ghost" size="xs" aria-label={`${t("settings.turnOff")}: ${label}`} onClick={() => onSet(null)}>
                  <CircleSlash />
                </Button>
              </Tooltip>
            )}
          </span>
        </>
      )}
      {recording && <span className="sr-only" aria-live="polite">{t("settings.recordHint")}</span>}
    </li>
  );
}
