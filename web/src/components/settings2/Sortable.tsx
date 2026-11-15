// Drag to reorder for settings lists. Rows lift (shadow, slight scale) while
// dragged and their neighbours glide aside; the grip also takes Alt+Arrow so
// keyboard users can move a row. The new order is reported once, on drop.

import { GripVertical } from "lucide-react";
import { AnimatePresence, Reorder, useDragControls, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dur, springs } from "@/lib/motion";
import { cn } from "@/lib/cn";

export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderRow,
  disabled,
  className,
  handleLabel,
}: {
  items: T[];
  /** Accessible name for the grip, e.g. "Reorder Billing". */
  handleLabel?: (item: T) => string;
  /** Called with the full new order once a drag or keyboard move ends. */
  onReorder: (ids: string[]) => void;
  /** Renders one row; put `handle` at its start. */
  renderRow: (item: T, handle: ReactNode, index: number) => ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const [order, setOrder] = useState(() => items.map((i) => i.id));
  const [prev, setPrev] = useState(items);
  if (prev !== items) {
    setPrev(items);
    setOrder(items.map((i) => i.id));
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    onReorder(next);
  };
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} as="div" className={className}>
      <AnimatePresence initial={false}>
      {order.map((id, index) => {
        const item = byId.get(id);
        if (!item) return null;
        return (
          <SortableItem key={id} id={id} label={handleLabel?.(item)} disabled={disabled} onDrop={() => onReorder(order)} onMove={(d) => move(id, d)}>
            {(handle) => renderRow(item, handle, index)}
          </SortableItem>
        );
      })}
      </AnimatePresence>
    </Reorder.Group>
  );
}

function SortableItem({
  id,
  label,
  disabled,
  onDrop,
  onMove,
  children,
}: {
  id: string;
  label?: string;
  disabled?: boolean;
  onDrop: () => void;
  onMove: (dir: -1 | 1) => void;
  children: (handle: ReactNode) => ReactNode;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const [dragging, setDragging] = useState(false);
  const handle = disabled ? null : (
    <DragHandle
      label={label}
      dragging={dragging}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        controls.start(e);
      }}
      onMove={onMove}
    />
  );
  return (
    <Reorder.Item
      as="div"
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false);
        onDrop();
      }}
      layout="position"
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.99, transition: { duration: dur.fast } }}
      transition={reduce ? { duration: 0 } : springs.row}
      whileDrag={reduce ? undefined : { scale: 1.015, boxShadow: "var(--shadow-float)", zIndex: 3 }}
      className={cn("relative border-b border-line-soft bg-surface last:border-0 [&>*]:border-b-0", dragging && "cursor-grabbing rounded-md")}
    >
      {children(handle)}
    </Reorder.Item>
  );
}

export function DragHandle({ label, onPointerDown, onMove, dragging }: { label?: string; onPointerDown: (e: React.PointerEvent) => void; onMove: (dir: -1 | 1) => void; dragging: boolean }) {
  const { t } = useTranslation("settings");
  return (
    <button
      type="button"
      aria-label={label ?? t("sortable.handle")}
      title={t("sortable.hint")}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          e.stopPropagation();
          onMove(e.key === "ArrowUp" ? -1 : 1);
        }
      }}
      className={cn(
        "absolute left-0.5 top-1/2 z-[1] flex h-7 w-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-sm text-fg-4 transition-opacity hover:text-fg-2 focus-visible:opacity-100 active:cursor-grabbing",
        dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}
