// A page's look in its menu (contracts/wiki.md "Page settings"): the font, small text, full
// width and the lock. Changes show at once and are saved without the page's version, so
// they never collide with someone typing on it.

import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu as M } from "radix-ui";
import { Lock, LockOpen, MoveHorizontal, CaseSensitive } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MenuCheckItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { WikiPage, WikiPageSettings } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/queries";

/** Saves a change of look, shown before the answer and put back if it fails. */
export function useLook(page: WikiPage) {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  const set = useCallback(
    async (patch: Partial<WikiPageSettings>) => {
      const key = qk.wikiPage(page.id);
      const before = qc.getQueryData<WikiPage>(key);
      qc.setQueryData<WikiPage>(key, (old) => (old ? { ...old, ...patch } : old));
      try {
        const saved = await api.wiki.update(page.id, patch);
        qc.setQueryData<WikiPage>(key, (old) => (old ? { ...old, ...pickLook(saved) } : old));
      } catch (e) {
        if (before) qc.setQueryData(key, before);
        toast.error(e, t("style.saveFailed"));
      }
    },
    [page.id, qc, t],
  );
  return { set };
}

const pickLook = (p: WikiPageSettings): WikiPageSettings => ({ cover: p.cover, cover_y: p.cover_y, full_width: p.full_width, small_text: p.small_text, font: p.font, locked: p.locked });

const FONTS = [
  { id: "default", sample: "Ag", cls: "font-sans" },
  { id: "serif", sample: "Ag", cls: "font-[ui-serif,Georgia,serif]" },
  { id: "mono", sample: "Ag", cls: "font-mono" },
] as const;

/** The style part of a page's menu: three font tiles, then the switches. */
export function PageStyleItems({ page, onChange }: { page: WikiPage; onChange: (patch: Partial<WikiPageSettings>) => void }) {
  const { t } = useTranslation("wiki");
  return (
    <>
      <div className="label-caps px-2 pb-1.5 pt-1">{t("style.title")}</div>
      <div className="grid grid-cols-3 gap-1 px-1 pb-1">
        {FONTS.map((f) => (
          <M.Item
            key={f.id}
            onSelect={(e) => {
              e.preventDefault();
              onChange({ font: f.id });
            }}
            className={cn(
              "flex cursor-default select-none flex-col items-center gap-0.5 rounded-md py-1.5 outline-none transition-colors data-[highlighted]:bg-hover",
              page.font === f.id ? "text-tone-blue" : "text-fg-2",
            )}
          >
            <span className={cn("text-[20px] leading-7", f.cls)}>{f.sample}</span>
            <span className="text-[11px] text-fg-3">{t(`style.font.${f.id}`)}</span>
          </M.Item>
        ))}
      </div>
      <MenuCheckItem icon={<CaseSensitive />} checked={page.small_text} onSelect={() => onChange({ small_text: !page.small_text })}>
        {t("style.smallText")}
      </MenuCheckItem>
      <MenuCheckItem icon={<MoveHorizontal />} checked={page.full_width} onSelect={() => onChange({ full_width: !page.full_width })}>
        {t("style.fullWidth")}
      </MenuCheckItem>
      <MenuCheckItem icon={page.locked ? <Lock /> : <LockOpen />} checked={page.locked} onSelect={() => onChange({ locked: !page.locked })}>
        {t("style.lock")}
      </MenuCheckItem>
    </>
  );
}

/** Under the header of a locked page, for people who may unlock it. */
export function LockedBar({ onUnlock }: { onUnlock: () => void }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-1.5 text-[12.5px] text-fg-3 animate-rise-in motion-reduce:animate-none">
      <Lock className="size-3.5" />
      <span className="min-w-0 flex-1">{t("style.lockedBody")}</span>
      <Button size="sm" variant="ghost" onClick={onUnlock}>
        <LockOpen className="size-3.5" />
        {t("style.unlock")}
      </Button>
    </div>
  );
}
