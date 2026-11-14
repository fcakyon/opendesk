import { Tooltip as T } from "radix-ui";
import { forwardRef, type ReactNode } from "react";
import { useShortcutLabel } from "@/lib/shortcuts";
import { Kbd } from "./kbd";

export const TooltipProvider = T.Provider;

type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Keys ("mod k") or a shortcut id ("go.pages"), shown as the person's own keys. */
  shortcut?: string;
  align?: "start" | "center" | "end";
};

/**
 * Wraps one focusable child. Forwards props and ref to it, so it can sit
 * inside another Radix trigger (`<PopoverTrigger asChild><Tooltip>…`).
 */
export const Tooltip = forwardRef<HTMLElement, TooltipProps & Omit<React.HTMLAttributes<HTMLElement>, "content" | "children">>(function Tooltip(
  { content, children, side = "top", shortcut: asked, align = "center", ...rest },
  ref,
) {
  // A shortcut id (lib/shortcuts.ts) shows the person's own keys; other text shows as it is.
  const shortcut = useShortcutLabel(asked);
  if (!content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild ref={ref as React.Ref<HTMLButtonElement>} {...rest}>
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] flex items-center gap-2 rounded-md bg-inverse px-2 py-1 text-xs font-medium text-inverse-fg shadow-pop origin-[var(--radix-tooltip-content-transform-origin)] data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-fade-in motion-reduce:animate-none"
        >
          {content}
          {shortcut && (
            <Kbd className="[&_kbd]:border-transparent [&_kbd]:bg-white/15 [&_kbd]:text-inverse-fg [&_kbd]:shadow-none dark:[&_kbd]:bg-black/10">
              {shortcut}
            </Kbd>
          )}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
});
