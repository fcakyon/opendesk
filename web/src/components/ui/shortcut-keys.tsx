import { Kbd } from "@/components/ui/kbd";
import { useShortcutLabel } from "@/lib/shortcuts";

/** A shortcut's keys by id, as the person set them; nothing for one turned off. */
export function ShortcutKeys({ id, className }: { id: string; className?: string }) {
  const keys = useShortcutLabel(id);
  return keys ? <Kbd className={className}>{keys}</Kbd> : null;
}
