// Addresses edited in place: a Cc / Bcc / side-conversation chip, or the address a new ticket
// was typed to, opens as text with the caret at its end, so a typo is fixed by adding or
// removing a letter instead of deleting the address and typing it again.

import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";

export const splitAddresses = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

/**
 * The chip `from` edited into `text`: its place in `values` takes the addresses typed there,
 * minus those already in the list, and an emptied chip is removed. Null while a part is not an
 * address: nothing changes and the edit stays open.
 */
export function editChip(values: string[], from: string, text: string, isEmail: (s: string) => boolean): string[] | null {
  const parts = splitAddresses(text);
  if (parts.some((p) => !isEmail(p))) return null;
  const others = values.filter((v) => v !== from);
  const at = values.indexOf(from);
  const pos = at < 0 ? others.length : at;
  const add = parts.filter((p, i) => !others.includes(p) && parts.indexOf(p) === i);
  return [...others.slice(0, pos), ...add, ...others.slice(pos)];
}

/**
 * The text an address is edited in. It opens focused with the caret at the end; Enter, Tab, a
 * comma, a semicolon, a space or leaving it commits (`onCommit` returns false to keep it open,
 * marked invalid); Escape drops the edit.
 */
export function AddressInput({
  initial,
  label,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  label: string;
  onCommit: (text: string) => boolean;
  onCancel: () => void;
  className?: string;
}) {
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = () => {
    if (done.current) return true;
    done.current = onCommit(text);
    if (!done.current) setInvalid(true);
    return done.current;
  };
  return (
    <input
      ref={ref}
      value={text}
      aria-label={label}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      size={Math.max(text.length + 1, 12)}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        } else if (e.key === "Tab") {
          // Tab moves on once the address is taken.
          if (!commit()) e.preventDefault();
        } else if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") {
          e.preventDefault();
          commit();
        }
      }}
      className={cn("mono min-w-0 bg-transparent outline-none", invalid && "text-danger-fg", className)}
      data-ph-mask
    />
  );
}

/** One chip of EmailChips: a click on its address edits it in place, its × removes it. */
export function EmailChip({ value, values, onChange, isEmail }: { value: string; values: string[]; onChange: (v: string[]) => void; isEmail: (s: string) => boolean }) {
  const { t } = useTranslation("indicators");
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <span className="inline-flex h-5 items-center rounded-sm bg-surface text-[11.5px]">
        <AddressInput
          className="h-5 rounded-sm px-1.5"
          initial={value}
          label={t("tickets.editAddress", { name: value })}
          onCancel={() => setEditing(false)}
          onCommit={(text) => {
            const next = editChip(values, value, text, isEmail);
            if (!next) return false;
            setEditing(false);
            if (next.join("\n") !== values.join("\n")) onChange(next);
            return true;
          }}
        />
      </span>
    );
  }
  return (
    <span className="mono inline-flex h-5 items-center gap-1 rounded-sm bg-hover pl-1.5 pr-0.5 text-[11.5px] animate-pop-in motion-reduce:animate-none" data-ph-mask>
      <Tooltip content={t("tickets.editAddress", { name: value })}>
        <button type="button" aria-label={t("tickets.editAddress", { name: value })} onClick={() => setEditing(true)} className="cursor-text hover:text-fg">
          {value}
        </button>
      </Tooltip>
      <button type="button" aria-label={t("tickets.remove", { name: value })} onClick={() => onChange(values.filter((x) => x !== value))} className="flex size-4 items-center justify-center rounded-xs text-fg-4 hover:text-fg">
        <X className="size-3" />
      </button>
    </span>
  );
}

/** The address a new ticket was typed to (no contact yet): a click edits it in place; emptied, it is cleared. */
export function TypedAddress({ email, onChange, isEmail }: { email: string; onChange: (email: string | null) => void; isEmail: (s: string) => boolean }) {
  const { t } = useTranslation("indicators");
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <AddressInput
        initial={email}
        label={t("tickets.editAddress", { name: email })}
        className="flex-1 rounded-sm px-1 text-sm"
        onCancel={() => setEditing(false)}
        onCommit={(text) => {
          const v = text.trim();
          if (v && !isEmail(v)) return false;
          setEditing(false);
          if (v !== email) onChange(v || null);
          return true;
        }}
      />
    );
  }
  return (
    <Tooltip content={t("tickets.editAddress", { name: email })}>
      <button
        type="button"
        aria-label={t("tickets.editAddress", { name: email })}
        onClick={() => setEditing(true)}
        className="min-w-0 flex-1 cursor-text truncate text-left text-fg-3 hover:text-fg"
        data-ph-mask
      >
        {email}
      </button>
    </Tooltip>
  );
}
