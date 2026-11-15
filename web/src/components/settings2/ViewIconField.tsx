// The view editor's icon: a button showing the view as its sidebar row, which opens a
// popover with three tabs (an emoji, an icon of the list, one or two characters), the
// palette and None. The preview at its top is the sidebar row as it will read. A view
// section's icon (`section`) takes the same picker, previewed as the section's heading.

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { SearchInput, TextInput } from "@/components/ui/input";
import { Segmented } from "@/components/ui/tabs";
import { ViewIcon, isOneEmoji, viewIconTone, viewName } from "@/components/tickets/ViewIcon";
import { searchViewIcons } from "@/components/tickets/viewIcons";
import { EMOJI, searchEmoji } from "@/components/wiki/emoji";
import type { ViewIcon as ViewIconValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/tones";
import { ColorSwatchPicker } from "./ColorSwatchPicker";

type Tab = ViewIconValue["kind"];

const cell =
  "flex size-8 items-center justify-center rounded-md text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] [&_svg]:size-4";

/** Only letters and digits, at most two of them. */
const cleanText = (s: string) => [...s.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("");

/**
 * The sidebar row a view becomes: its icon and its name, as the sidebar shows them; for a
 * section, its heading: the chevron, the icon if any and the name in semibold.
 */
function RowPreview({ icon, name, section, className }: { icon: ViewIconValue | null; name: string; section?: boolean; className?: string }) {
  return (
    <span
      data-testid="view-icon-preview"
      className={cn(
        "flex h-7 min-w-0 items-center gap-2.5 rounded-md px-2 text-[12.5px] text-fg-2 [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-fg-3",
        section && "font-semibold",
        className,
      )}
    >
      {section && <ChevronRight className="rotate-90" />}
      {(icon || !section) && <ViewIcon icon={icon} />}
      <span className="truncate">{name}</span>
    </span>
  );
}

export function ViewIconField({
  value,
  onChange,
  name,
  section,
}: {
  value: ViewIconValue | null;
  onChange: (icon: ViewIconValue | null) => void;
  name: string;
  /** A view section's icon: no icon is none, not the default one. */
  section?: boolean;
}) {
  const { t } = useTranslation("settingsInbox");
  const { t: tw } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(value?.kind ?? "emoji");
  const [q, setQ] = useState("");
  // The colour stays chosen while the tabs change, so an emoji in between does not lose it.
  const [color, setColor] = useState<Tone | null>(viewIconTone(value));
  const shown = name.trim() ? viewName({ name: name.trim(), icon: value }) : section ? t("views.sectionIcon.namePlaceholder") : t("views.namePlaceholder");

  // A view's plain layers icon is its default one; a section has no default.
  const set = (next: ViewIconValue | null) => onChange(!section && next && next.kind === "icon" && next.value === "layers" && !next.color ? null : next);
  const pickColor = (c: Tone) => {
    const next = color === c ? null : c;
    setColor(next);
    if (!value) {
      if (next) set({ kind: "icon", value: "layers", color: next });
    } else if (value.kind !== "emoji") set({ ...value, color: next });
  };
  const switchTab = (k: Tab) => {
    setTab(k);
    setQ("");
  };

  const emojiCell = (e: string) => (
    <button key={e} type="button" aria-label={e} aria-pressed={value?.kind === "emoji" && value.value === e} onClick={() => set({ kind: "emoji", value: e, color: null })} className={cn(cell, "text-[18px] leading-none", value?.kind === "emoji" && value.value === e && "bg-active")}>
      {e}
    </button>
  );
  const typed = q.trim();
  const found = typed ? searchEmoji(typed) : null;
  // Free input: an emoji that is not in the grid is offered as typed.
  const extra = typed && isOneEmoji(typed) && !found?.includes(typed) ? typed : null;
  const icons = searchViewIcons(tab === "icon" ? q : "");

  return (
    <div className="flex flex-col gap-1.5">
      <span id="view-icon-label" className="text-[12.5px] font-medium text-fg">
        {t("views.icon.label")}
      </span>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) switchTab(value?.kind ?? tab);
        }}
        className="w-[324px] p-0"
        trigger={
          <button
            type="button"
            aria-labelledby="view-icon-label view-icon-current"
            className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface pr-2 text-left outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          >
            <span id="view-icon-current" className="min-w-0 flex-1">
              <RowPreview icon={value} name={shown} section={section} />
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-fg-3">
              {t("views.icon.change")}
              <ChevronDown className="size-3.5" />
            </span>
          </button>
        }
      >
        <div className="border-b border-line p-2">
          <div className="label-caps px-1 pb-1">{t("views.icon.preview")}</div>
          <RowPreview icon={value} name={shown} section={section} className="bg-chrome text-fg" />
        </div>
        <div className="flex items-center justify-between gap-2 px-2 pt-2">
          <Segmented
            size="xs"
            value={tab}
            onChange={switchTab}
            options={[
              { value: "emoji", label: t("views.icon.tabs.emoji") },
              { value: "icon", label: t("views.icon.tabs.icon") },
              { value: "text", label: t("views.icon.tabs.text") },
            ]}
          />
          <Button variant="ghost" size="xs" aria-pressed={!value} onClick={() => set(null)} disabled={!value}>
            {t("views.icon.none")}
          </Button>
        </div>

        {tab === "emoji" && (
          <div className="p-2">
            <SearchInput
              autoFocus
              value={q}
              onChange={setQ}
              placeholder={t("views.icon.searchEmoji")}
              onKeyDown={(e) => {
                const first = extra ?? found?.[0];
                if (e.key === "Enter" && first) {
                  e.preventDefault();
                  set({ kind: "emoji", value: first, color: null });
                }
              }}
            />
            <div className="mt-2 max-h-[204px] overflow-y-auto" role="listbox" aria-label={t("views.icon.tabs.emoji")}>
              {found || extra ? (
                found?.length || extra ? (
                  <div className="grid grid-cols-8 gap-0.5">
                    {extra && emojiCell(extra)}
                    {found?.map(emojiCell)}
                  </div>
                ) : (
                  <p className="px-2 py-6 text-center text-[12.5px] text-fg-3">{t("views.icon.noMatch")}</p>
                )
              ) : (
                EMOJI.map((g) => (
                  <div key={g.id} className="mb-2 last:mb-0">
                    <div className="label-caps px-1 pb-1 pt-0.5">{tw(`icon.groups.${g.id}`)}</div>
                    <div className="grid grid-cols-8 gap-0.5">{g.emoji.map(([e]) => emojiCell(e))}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === "icon" && (
          <div className="p-2">
            <SearchInput
              autoFocus
              value={q}
              onChange={setQ}
              placeholder={t("views.icon.searchIcon")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && icons[0]) {
                  e.preventDefault();
                  set({ kind: "icon", value: icons[0].name, color });
                }
              }}
            />
            <div className="mt-2 max-h-[204px] overflow-y-auto" role="listbox" aria-label={t("views.icon.tabs.icon")}>
              {icons.length ? (
                <div className="grid grid-cols-8 gap-0.5">
                  {icons.map((d) => {
                    const on = value?.kind === "icon" && value.value === d.name;
                    return (
                      <button
                        key={d.name}
                        type="button"
                        aria-label={d.name.replace(/-\d+$/, "").replace(/-/g, " ")}
                        data-icon={d.name}
                        aria-pressed={on}
                        onClick={() => set({ kind: "icon", value: d.name, color })}
                        className={cn(cell, on && "bg-active text-fg")}
                        style={color ? { color: `var(--tone-${color})` } : undefined}
                      >
                        <d.icon aria-hidden />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-6 text-center text-[12.5px] text-fg-3">{t("views.icon.noMatch")}</p>
              )}
            </div>
          </div>
        )}

        {tab === "text" && (
          <div className="flex items-center gap-3 p-3">
            <TextInput
              autoFocus
              aria-label={t("views.icon.textLabel")}
              value={value?.kind === "text" ? value.value : ""}
              placeholder={t("views.icon.textPlaceholder")}
              onChange={(e) => {
                const v = cleanText(e.target.value);
                if (v) set({ kind: "text", value: v, color });
                else if (value?.kind === "text") set(null);
              }}
              className="w-16 text-center font-semibold"
            />
            <p className="text-[12px] text-fg-3">{t("views.icon.textHint")}</p>
          </div>
        )}

        <div className="border-t border-line p-2">
          <div className="label-caps px-1 pb-1.5">{t("views.icon.colour")}</div>
          {/* An emoji keeps its own colours. */}
          <fieldset disabled={value?.kind === "emoji"} className={cn("px-1", value?.kind === "emoji" && "opacity-40")}>
            <ColorSwatchPicker size="sm" value={value?.kind === "emoji" ? null : color} onChange={pickColor} label={t("views.icon.colour")} />
          </fieldset>
          {value?.kind === "emoji" && <p className="px-1 pt-1.5 text-[11.5px] text-fg-3">{t("views.icon.colourEmoji")}</p>}
        </div>
        <div className="flex justify-end border-t border-line p-2">
          <Button size="xs" variant="secondary" onClick={() => setOpen(false)}>
            {t("views.icon.done")}
          </Button>
        </div>
      </Popover>
      <p className="text-[12px] text-fg-3">{section ? t("views.sectionIcon.hint") : t("views.icon.hint")}</p>
    </div>
  );
}
