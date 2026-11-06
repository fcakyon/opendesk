// A page's cover (contracts/wiki.md "Page settings"): one of the app's gradients, an
// uploaded image or an image link, across the top of the page. People who may edit change
// it, drag it to show another part of the picture, or remove it.

import { Check, ImageIcon, Move, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { cn } from "@/lib/cn";
import { coverStyle, GRADIENT_NAMES, GRADIENTS } from "./covers";

export function CoverPicker({ value, onChange, trigger, open, onOpenChange }: { value: string; onChange: (cover: string) => void; trigger: React.ReactNode; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const [tab, setTab] = useState<"gallery" | "upload" | "link">("gallery");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pick = (c: string) => {
    onChange(c);
    onOpenChange(false);
  };
  const tabs = [
    ["gallery", t("cover.gallery")],
    ["upload", t("cover.upload")],
    ["link", t("cover.link")],
  ] as const;
  return (
    <Popover open={open} onOpenChange={onOpenChange} trigger={trigger} align="end" className="w-[380px] p-0">
      <div className="flex items-center gap-1 border-b border-line px-2 pt-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn("relative h-8 rounded-t-md px-2.5 text-[12.5px] text-fg-3 transition-colors hover:text-fg", tab === id && "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-fg")}
          >
            {label}
          </button>
        ))}
        {value && (
          <button type="button" onClick={() => pick("")} className="ml-auto h-8 px-2 text-[12.5px] text-fg-3 hover:text-fg">
            {t("cover.remove")}
          </button>
        )}
      </div>
      {tab === "gallery" && (
        <div className="grid grid-cols-5 gap-1.5 p-3">
          {GRADIENT_NAMES.map((g) => (
            <button
              key={g}
              type="button"
              aria-label={t(`cover.gradients.${g}`)}
              title={t(`cover.gradients.${g}`)}
              onClick={() => pick(`gradient:${g}`)}
              className="wiki-cover-swatch relative h-12 rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] transition-transform hover:scale-[1.04] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
              style={{ background: GRADIENTS[g] }}
            >
              {value === `gradient:${g}` && <Check className="absolute right-1 top-1 size-3.5 text-fg" />}
            </button>
          ))}
        </div>
      )}
      {tab === "upload" && (
        <div className="p-3">
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setBusy(true);
              try {
                const a = await api.attachments.upload(f);
                pick(a.url);
              } catch (err) {
                toast.error(err, t("page.uploadFailed"));
              } finally {
                setBusy(false);
              }
            }}
          />
          <Button className="w-full" onClick={() => file.current?.click()} disabled={busy}>
            {busy ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" />}
            {t("cover.uploadButton")}
          </Button>
          <p className="mt-2 text-center text-[11.5px] text-fg-4">{t("cover.uploadHint")}</p>
        </div>
      )}
      {tab === "link" && (
        <form
          className="flex gap-1.5 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = link.trim();
            if (/^https:\/\/\S+$/i.test(v)) pick(v);
            else toast.error(t("cover.linkInvalid"));
          }}
        >
          <TextInput autoFocus inputSize="sm" value={link} onChange={(e) => setLink(e.target.value)} placeholder={t("cover.linkPlaceholder")} aria-label={t("cover.link")} />
          <Button type="submit" size="sm" variant="primary">
            {t("cover.apply")}
          </Button>
        </form>
      )}
    </Popover>
  );
}

export function PageCover({ cover, coverY, canEdit, onChange }: { cover: string; coverY: number; canEdit: boolean; onChange: (patch: { cover?: string; cover_y?: number }) => void }) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const style = coverStyle(cover);
  if (!style) return null;
  const y = moving ?? coverY;

  const startMove = (e: React.PointerEvent) => {
    if (!style.image) return;
    e.preventDefault();
    const h = box.current?.getBoundingClientRect().height ?? 200;
    const startY = e.clientY;
    const start = coverY;
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(100, Math.max(0, start - ((ev.clientY - startY) / h) * 100)));
      setMoving(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMoving(null);
      if (latest !== coverY) onChange({ cover_y: latest });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={box} className={cn("wiki-cover group/cover relative h-[180px] w-full shrink-0 overflow-hidden md:h-[220px]", style.background && "wiki-cover-gradient", moving !== null && "cursor-grabbing")} style={style.background ? { background: style.background } : undefined}>
      {style.image && (
        <img
          src={style.image}
          alt=""
          draggable={false}
          className="size-full select-none object-cover"
          style={{ objectPosition: `center ${y}%` }}
          referrerPolicy="no-referrer"
        />
      )}
      {canEdit && (
        <div className="absolute bottom-3 right-3 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/cover:opacity-100 [@media(hover:none)]:opacity-100">
          <CoverPicker
            value={cover}
            onChange={(c) => onChange({ cover: c, cover_y: 50 })}
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" className="wiki-cover-btn">
                <ImageIcon />
                {t("cover.change")}
              </button>
            }
          />
          {style.image && (
            <button type="button" className="wiki-cover-btn cursor-grab" onPointerDown={startMove} title={t("cover.repositionHint")}>
              <Move />
              {t("cover.reposition")}
            </button>
          )}
          <button type="button" className="wiki-cover-btn" onClick={() => onChange({ cover: "" })} aria-label={t("cover.remove")}>
            <Trash2 />
          </button>
        </div>
      )}
    </div>
  );
}

