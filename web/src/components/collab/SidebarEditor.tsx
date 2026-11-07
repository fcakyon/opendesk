// The sidebar's edit mode (lib/collab/sidebarEdit.ts): the sidebar arranged where it is.
// Every section and row has a handle to drag it (sections among sections; a row inside its
// section, into Favorites, or into a section of the member's own) and an eye to hide it, so
// hidden things stay listed, dimmed, and come back in one click. The member's own sections
// and rows are renamed by clicking their name and take an emoji. A slim bar on top has Done,
// Reset and the starting points (layouts, a Space's sections) and the dialog's other options.
// With a Space picked, the same mode edits that Space's sections and rows.

import { motion, useReducedMotion } from "motion/react";
import { Copy, CornerUpLeft, Ellipsis, Eye, EyeOff, FolderInput, GripVertical, Hash, LayoutTemplate, ListTree, Pencil, Pin, PinOff, Plus, RotateCcw, Settings2, SlidersHorizontal, SmilePlus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useShortcuts } from "@/lib/shortcuts";
import { buildEverywhereRow, buildRow, RowEmoji, useRowLabels } from "@/components/spaces/rows";
import { SpaceGlyph } from "@/components/spaces/icons";
import { useSpaceActions } from "@/components/spaces/actions";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuChoice, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { IconPicker } from "@/components/wiki/IconPicker";
import { PageIcon } from "@/components/wiki/PageTree";
import { useFavorites } from "@/components/wiki/hooks";
import type { SidebarPin, SidebarPrefs, SidebarSectionId, Space, SpaceItem } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useCollab } from "@/lib/collab/hooks";
import { copySpaceSections } from "@/lib/collab/copySpace";
import { useBackIntoLabel } from "@/components/tickets/inboxes/backInto";
import { useInboxParts } from "@/components/tickets/inboxes/InboxSection";
import { useInboxNames } from "@/components/tickets/inboxes/inboxNames";
import { inboxKey, setInboxSection, type InboxScope } from "@/lib/collab/inboxSections";
import { asSpace, entryKey, newOwnSection, OWN_LIMITS, sectionOf, sidebarEntries, toggleInSection, withSpace, type SidebarEntry } from "@/lib/collab/ownSections";
import { ownSectionsUi, type OwnRow } from "@/lib/collab/ownSectionsUi";
import { applyRowOrder, isOrdered } from "@/lib/collab/rowOrder";
import { canDrop, dropInSpace, dropOnSidebar, FAVORITES, pinKey, starKey, type EditSource, type EditTarget } from "@/lib/collab/sidebarEditModel";
import { sidebarEdit } from "@/lib/collab/sidebarEdit";
import { resetPrefs } from "@/lib/collab/layouts";
import { badgeChoices, badgeFor, badgeWord, hid, isHidden, isPinned, nameOf, sectionKey, sectionsOffered, setBadge, setHidden, setIcon, setName, togglePin } from "@/lib/collab/sidebarPrefs";
import { collabUi } from "@/lib/collab/ui";
import { useProducts } from "@/lib/products";
import { useSession } from "@/lib/session";
import { useSpaces, useWorkspacesData } from "@/lib/spaces/hooks";
import { addSection, isEverywhere, isSectionId, itemKey, pickedSpace, removeItem, removeSection, replaceSpace, updateItem, updateSection } from "@/lib/spaces/model";
import { spaceUi, usePickedSpaceId } from "@/lib/spaces/store";
import { useOwnSidebar } from "./AddToSidebar";
import { layoutsUi } from "./LayoutsDialog";
import { ownRowOf, useSidebarItems, type Item, type ItemBadge } from "./sidebarItems";
import { useEditDrag } from "./useEditDrag";

// ─── Parts ──────────────────────────────────────────────────────────────────

const tool =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-fg-4 outline-none transition-colors hover:bg-chrome-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] [&_svg]:size-3.5";

/** The grip a section or row is dragged by; arrow keys move it one place without a pointer. */
function Handle({ label, props, onStep }: { label: string; props: ReturnType<ReturnType<typeof useEditDrag<EditSource>>["handle"]>; onStep?: (dir: -1 | 1) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      {...props}
      onKeyDown={(e: KeyboardEvent) => {
        if (!onStep || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        onStep(e.key === "ArrowUp" ? -1 : 1);
      }}
      className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-fg-4 outline-none transition-colors hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] active:cursor-grabbing [&_svg]:size-3.5"
    >
      <GripVertical />
    </button>
  );
}

function EyeToggle({ hidden, name, onToggle }: { hidden: boolean; name: string; onToggle: () => void }) {
  const { t } = useTranslation("collab");
  const label = hidden ? t("customize.show", { name }) : t("customize.hide", { name });
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} aria-pressed={!hidden} onClick={onToggle} className={cn(tool, !hidden && "text-fg-3")}>
        {hidden ? <EyeOff /> : <Eye />}
      </button>
    </Tooltip>
  );
}

function RemoveButton({ label, onClick, icon }: { label: string; onClick: () => void; icon?: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} onClick={onClick} className={tool}>
        {icon ?? <X />}
      </button>
    </Tooltip>
  );
}

/** A name that turns into a field on click: Enter or leaving it saves, Escape keeps the old one. */
function InlineName({ value, placeholder, label, editing, onEditing, onSave, className }: { value: string; placeholder: string; label: string; editing: boolean; onEditing: (on: boolean) => void; onSave: (v: string) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  if (!editing)
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          setDraft(value);
          onEditing(true);
        }}
        className={cn("min-w-0 flex-1 cursor-text truncate rounded px-1 py-0.5 text-left outline-none transition-colors hover:bg-chrome-hover hover:shadow-[inset_0_0_0_1px_var(--line)] focus-visible:shadow-[0_0_0_2px_var(--focus)]", className)}
      >
        {value || placeholder}
      </button>
    );
  const done = (save: boolean) => {
    onEditing(false);
    if (save && draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={draft}
      maxLength={OWN_LIMITS.title + 24}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
      }}
      className={cn("h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1 text-fg outline-none focus:shadow-[0_0_0_2px_var(--focus)]", className)}
    />
  );
}

/** The emoji slot of an own section or row: its emoji, or its own icon (a quiet smiley for a section), and the picker on click. */
function EmojiSlot({ value, fallback, label, onChange, open: openProp, onOpenChange }: { value?: string; fallback?: ReactNode; label: string; onChange: (v: string) => void; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [openHere, setOpenHere] = useState(false);
  const open = openProp ?? openHere;
  const setOpen = onOpenChange ?? setOpenHere;
  return (
    <IconPicker
      value={value ?? ""}
      onChange={onChange}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" aria-label={label} className={cn(tool, "size-5 text-fg-3", !value && !fallback && "text-fg-4")}>
          {value ? <RowEmoji emoji={value} /> : (fallback ?? <SmilePlus />)}
        </button>
      }
    />
  );
}

/** The line where a drag would land. */
const Line = () => <div aria-hidden className="pointer-events-none mx-4 h-0.5 rounded-full bg-tone-blue-solid" />;

const rowCls = "mx-2.5 flex h-7 items-center gap-1 rounded-md pl-0.5 pr-1 text-[12.5px] transition-[opacity,background-color] duration-150 motion-reduce:transition-none";

type RowView = {
  key: string;
  label: string;
  icon: ReactNode;
  depth?: number;
  hidden?: boolean;
  /** Dimmed and not draggable: a section header row of Views. */
  header?: boolean;
  source?: EditSource;
  /** Its own name and emoji, in a section of the member's own or a Space. */
  /** Its name and emoji of the member's own: every row has them, a built-in one in `names` and `icons`. */
  own?: { name?: string; emoji?: string; fallbackIcon: ReactNode; onRename: (v: string) => void; onEmoji: (v: string) => void };
  /** The row's ⋯ menu in edit mode. */
  menu?: (start: { rename: () => void; icon: () => void }) => ReactNode;
  onHide?: () => void;
  onRemove?: { label: string; run: () => void; icon?: ReactNode };
};

type BlockView = {
  key: string;
  label: string;
  hidden?: boolean;
  rows: RowView[];
  /** Its name and emoji: the member's own section's, or the member's own for a built-in one. */
  own?: { emoji?: string; placeholder?: string; onRename: (v: string) => void; onEmoji: (v: string) => void; onDelete?: () => void; onAdd?: () => void };
  onHide?: () => void;
  empty?: string;
  /** A ticket inbox or team shown apart: back into Tickets or Teams. */
  back?: { label: string; run: () => void };
};

function EditList({
  blocks,
  rootRef,
  drag,
  target,
  handle,
  step,
  renaming,
  setRenaming,
  picking,
  setPicking,
}: {
  picking: string | null;
  setPicking: (k: string | null) => void;
  blocks: BlockView[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  drag: ReturnType<typeof useEditDrag<EditSource>>["drag"];
  target: EditTarget | null;
  handle: ReturnType<typeof useEditDrag<EditSource>>["handle"];
  step: (source: EditSource, dir: -1 | 1) => void;
  renaming: string | null;
  setRenaming: (k: string | null) => void;
}) {
  const { t } = useTranslation("collab");
  const reduce = useReducedMotion();
  const dragging = drag?.source;
  const lineBeforeSection = (key: string | null) => target?.kind === "section" && target.before === key;
  const lineBeforeRow = (section: string, key: string | null) => target?.kind === "row" && target.section === section && target.before === key;
  return (
    <div ref={rootRef} className="flex flex-col pb-1">
      {blocks.map((b, bi) => {
        const isDragged = dragging?.kind === "section" && dragging.key === b.key;
        const sectionSource: EditSource = { kind: "section", key: b.key };
        const over = target?.kind === "row" && target.section === b.key;
        return (
          <div key={b.key}>
            {lineBeforeSection(b.key) && <Line />}
            <motion.div
              layout={reduce ? false : "position"}
              transition={{ duration: 0.16, ease: "easeOut" }}
              data-edit-section={b.key}
              className={cn("rounded-lg transition-[opacity,background-color] duration-150", bi > 0 && "mt-3", isDragged && "opacity-40", over && "bg-chrome-hover/60")}
            >
              <div data-edit-head="" className={cn("group/head mx-2.5 flex h-7 items-center gap-1 pl-0.5 pr-1", b.hidden && "opacity-50")}>
                <Handle label={t("edit.move", { name: b.label })} props={handle(sectionSource, b.label)} onStep={(dir) => step(sectionSource, dir)} />
                {b.own && <EmojiSlot value={b.own.emoji} label={t("edit.icon", { name: b.label })} onChange={b.own.onEmoji} open={picking === b.key} onOpenChange={(o) => setPicking(o ? b.key : null)} />}
                {b.own ? (
                  <InlineName
                    value={b.label}
                    placeholder={b.own.placeholder ?? t("ownSections.untitled")}
                    label={t("edit.rename", { name: b.label })}
                    editing={renaming === b.key}
                    onEditing={(on) => setRenaming(on ? b.key : null)}
                    onSave={b.own.onRename}
                    className="label-caps"
                  />
                ) : (
                  <span className="label-caps min-w-0 flex-1 truncate px-1">{b.label}</span>
                )}
                {b.onHide && <EyeToggle hidden={!!b.hidden} name={b.label} onToggle={b.onHide} />}
                {b.back && <RemoveButton label={b.back.label} icon={<CornerUpLeft />} onClick={b.back.run} />}
                {b.own?.onDelete && <RemoveButton label={t("ownSections.delete")} icon={<Trash2 />} onClick={b.own.onDelete} />}
              </div>
              {!b.hidden && (
                <div className="flex flex-col gap-px">
                  {b.rows.map((r) => {
                    const rowDragged = dragging?.kind === "row" && dragging.from === b.key && dragging.key === r.key;
                    return (
                      <div key={r.key}>
                        {lineBeforeRow(b.key, r.key) && <Line />}
                        <div
                          data-edit-row={r.key}
                          className={cn(rowCls, r.hidden && "opacity-50", rowDragged && "opacity-40")}
                          style={r.depth ? { paddingLeft: 2 + r.depth * 14 } : undefined}
                        >
                          {r.source ? <Handle label={t("edit.move", { name: r.label })} props={handle(r.source, r.label)} onStep={(dir) => step(r.source!, dir)} /> : <span aria-hidden className="w-4 shrink-0" />}
                          {r.own ? (
                            <EmojiSlot
                              value={r.own.emoji}
                              fallback={r.own.fallbackIcon}
                              label={t("edit.icon", { name: r.label })}
                              onChange={r.own.onEmoji}
                              open={picking === `${b.key}|${r.key}`}
                              onOpenChange={(o) => setPicking(o ? `${b.key}|${r.key}` : null)}
                            />
                          ) : (
                            <span className={cn("flex size-5 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-[15px]", r.header && "text-fg-4")}>{r.icon}</span>
                          )}
                          {r.own ? (
                            <InlineName
                              value={r.own.name || r.label}
                              placeholder={r.label}
                              label={t("edit.rename", { name: r.own.name || r.label })}
                              editing={renaming === `${b.key}|${r.key}`}
                              onEditing={(on) => setRenaming(on ? `${b.key}|${r.key}` : null)}
                              onSave={r.own.onRename}
                              className="text-fg-2"
                            />
                          ) : (
                            <span className={cn("min-w-0 flex-1 truncate px-1", r.header ? "text-[11.5px] text-fg-4" : "text-fg-2")}>{r.label}</span>
                          )}
                          {r.menu && (
                            <Menu>
                              <Tooltip content={t("edit.rowMenu", { name: r.own?.name || r.label })}>
                                <MenuTrigger asChild>
                                  <button type="button" aria-label={t("edit.rowMenu", { name: r.own?.name || r.label })} className={cn(tool, "data-[state=open]:bg-chrome-hover data-[state=open]:text-fg")}>
                                    <Ellipsis />
                                  </button>
                                </MenuTrigger>
                              </Tooltip>
                              <MenuContent align="end" className="w-[210px]">
                                {r.menu({ rename: () => setRenaming(`${b.key}|${r.key}`), icon: () => setTimeout(() => setPicking(`${b.key}|${r.key}`), 0) })}
                              </MenuContent>
                            </Menu>
                          )}
                          {r.onHide && <EyeToggle hidden={!!r.hidden} name={r.label} onToggle={r.onHide} />}
                          {r.onRemove && <RemoveButton label={r.onRemove.label} icon={r.onRemove.icon} onClick={r.onRemove.run} />}
                        </div>
                      </div>
                    );
                  })}
                  {lineBeforeRow(b.key, null) && <Line />}
                  {!b.rows.length && b.empty && <p className="mx-2.5 flex h-7 items-center px-6 text-[12px] text-fg-4">{b.empty}</p>}
                  {b.own?.onAdd && (
                    <button type="button" onClick={b.own.onAdd} className={cn(rowCls, "w-[calc(100%-1.25rem)] gap-2 pl-6 text-fg-4 outline-none hover:bg-chrome-hover hover:text-fg-2 focus-visible:shadow-[0_0_0_2px_var(--focus)] [&>svg]:size-3.5")}>
                      <Plus />
                      <span>{t("edit.add")}</span>
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          </div>
        );
      })}
      {lineBeforeSection(null) && <Line />}
      {drag &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed z-[90] flex h-7 max-w-[220px] items-center gap-2 rounded-md bg-surface px-2.5 text-[12.5px] text-fg shadow-lg ring-1 ring-line"
            style={{ left: drag.x + 10, top: drag.y - 14 }}
          >
            <GripVertical className="size-3.5 shrink-0 text-fg-4" />
            <span className="truncate">{drag.label}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A word-labelled action of the bar. */
const barBtn =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-chrome-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-chrome-hover data-[state=open]:text-fg [&_svg]:size-3.5";

/** The bar on top while editing: what this is and Done, then its actions in words. */
function EditBar({ title, menu, onReset, onLayouts }: { title: ReactNode; menu: ReactNode; onReset?: () => void; onLayouts?: () => void }) {
  const { t } = useTranslation("collab");
  return (
    <div className="sticky -top-1 z-10 -mt-1 mb-2 border-b border-chrome-line bg-chrome px-3 pb-1.5 pt-1">
      <div className="flex h-9 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{title}</span>
        <Button size="xs" variant="primary" onClick={() => sidebarEdit.stop()}>
          {t("edit.done")}
        </Button>
      </div>
      <div className="-ml-1.5 flex items-center gap-0.5">
        {onLayouts && (
          <button type="button" onClick={onLayouts} className={barBtn}>
            <LayoutTemplate />
            {t("edit.layoutsShort")}
          </button>
        )}
        {onReset && (
          <button type="button" onClick={onReset} className={barBtn}>
            <RotateCcw />
            {t("edit.reset")}
          </button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={barBtn}>
              <Ellipsis />
              {t("edit.more")}
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="w-[220px]">
            {menu}
          </MenuContent>
        </Menu>
      </div>
      <p className="mt-1 text-[11.5px] leading-4 text-fg-4">{t("edit.barHint")}</p>
    </div>
  );
}

// ─── The workspace's own sidebar ────────────────────────────────────────────

function WorkspaceEditor() {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const collab = useCollab().enabled;
  const products = useProducts();
  const confirm = useConfirm();
  const { itemsOf, pinLabel } = useSidebarItems();
  const fav = useFavorites();
  const labels = useRowLabels();
  const d = useWorkspacesData(wid ? [wid] : [], { folders: () => true, wiki: () => true }).get(wid);
  const { spaces } = useSpaces();
  const rootRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  // Saves, and offers the way back for what takes something away.
  const undoable = (next: SidebarPrefs, message: string) => {
    const before = prefs;
    change(next);
    toast.undo(message, () => change(before), t("edit.undo"));
  };

  const { t: ti } = useTranslation("inbox");
  const inboxNames = useInboxNames();
  const inboxParts = useInboxParts();
  const backMailbox = useBackIntoLabel("mailbox");
  const backTeam = useBackIntoLabel("team");
  const offered = sectionsOffered(collab).filter((id) => products.tickets || (id !== "inbox" && id !== "teams" && id !== "views")).filter((id) => products.pages || id !== "pages");
  const entries = sidebarEntries(prefs).filter((e) => (e.kind === "builtin" ? offered.includes(e.id) : e.kind === "custom" || (products.tickets && !!inboxNames(e.scope))));
  const space = asSpace(prefs, wid);
  const name = (id: SidebarSectionId) => labels.section(id, collab);

  const pinIcon = (p: SidebarPin): ReactNode => {
    if (p.kind === "view_section") return <ListTree />;
    return (d && buildRow({ kind: p.kind, id: p.id }, d, { labels })?.icon) ?? null;
  };

  // Every row's name and emoji of the member's own (contracts/collab.md "Names and icons"): an empty name resets it.
  const ownLabel = (key: string, fallbackIcon: ReactNode) => ({
    name: prefs.names[key],
    emoji: prefs.icons[key],
    fallbackIcon,
    onRename: (v: string) => change(setName(prefs, key, v)),
    onEmoji: (v: string) => change(setIcon(prefs, key, v)),
  });
  // A row's ⋯ menu in edit mode: rename, icon, number, hide, favorite, a section of the member's own, remove.
  const rowMenu =
    (o: { key: string; label: string; hideId?: string; pin?: SidebarPin; row?: OwnRow | null; badge?: ItemBadge; remove?: { label: string; run: () => void } }) =>
    ({ rename, icon }: { rename: () => void; icon: () => void }) => {
      const hidden = o.hideId ? isHidden(prefs, o.hideId) : false;
      const where = o.row ? sectionOf(prefs, wid, o.row) : null;
      return (
        <>
          <MenuItem icon={<Pencil />} onSelect={rename}>
            {t("edit.renameRow")}
          </MenuItem>
          <MenuItem icon={<SmilePlus />} onSelect={icon}>
            {t("edit.pickIcon")}
          </MenuItem>
          {(prefs.names[o.key] || prefs.icons[o.key]) && (
            <MenuItem icon={<RotateCcw />} onSelect={() => change(setIcon(setName(prefs, o.key, ""), o.key, ""))}>
              {t("edit.resetName")}
            </MenuItem>
          )}
          {o.badge && (
            <MenuSub icon={<Hash />} label={t("rowMenu.number")}>
              {badgeChoices(o.badge.kind).map((v) => (
                <MenuChoice key={v} checked={badgeFor(prefs, o.badge!.key, o.badge!.sections, o.badge!.kind) === v} onSelect={() => change(setBadge(prefs, o.badge!.key, v))}>
                  {v === "none" ? t("rowMenu.hideNumber") : t(`customize.badge.${badgeWord(v, o.badge!.kind)}`)}
                </MenuChoice>
              ))}
            </MenuSub>
          )}
          <MenuSeparator />
          {o.pin && o.pin.kind !== "view_section" && (
            <MenuItem icon={isPinned(prefs, o.pin) ? <PinOff /> : <Pin />} onSelect={() => change(togglePin(prefs, o.pin!))}>
              {isPinned(prefs, o.pin) ? t("rowMenu.unpin") : t("rowMenu.pin")}
            </MenuItem>
          )}
          {o.row && (
            <MenuSub icon={<FolderInput />} label={t("edit.moveToSection")}>
              {prefs.sections.map((sec) => (
                <MenuChoice key={sec.id} checked={where?.id === sec.id} onSelect={() => change(toggleInSection(prefs, wid, sec.id, o.row!))}>
                  {sec.title || t("ownSections.untitled")}
                </MenuChoice>
              ))}
              {prefs.sections.length > 0 && <MenuSeparator />}
              <MenuItem icon={<Plus />} onSelect={() => change(newOwnSection(prefs, wid, o.label.slice(0, OWN_LIMITS.title), o.row!).prefs)}>
                {t("ownSections.newSection")}
              </MenuItem>
            </MenuSub>
          )}
          {o.hideId && (
            <MenuItem icon={hidden ? <Eye /> : <EyeOff />} onSelect={() => (hidden ? change(setHidden(prefs, o.hideId!, false)) : undoable(setHidden(prefs, o.hideId!, true), t("edit.hidden", { name: o.label })))}>
              {hidden ? t("edit.show") : t("rowMenu.hide")}
            </MenuItem>
          )}
          {o.remove && (
            <MenuItem icon={<X />} onSelect={o.remove.run}>
              {o.remove.label}
            </MenuItem>
          )}
        </>
      );
    };

  // The rows of a built-in section as the sidebar shows them, in the member's order.
  const builtinRows = (id: SidebarSectionId): RowView[] => {
    if (id === "favorites") {
      const pins = prefs.pinned.filter((p) => pinLabel(p)).map((p): RowView => {
        const label = pinLabel(p) ?? "";
        const row = ownRowOf({ pin: p });
        const remove = { label: t("customize.unpin", { name: label }), run: () => undoable(togglePin(prefs, p), t("edit.unpinned", { name: label })) };
        return {
          key: pinKey(p),
          label,
          icon: pinIcon(p),
          own: ownLabel(pinKey(p), pinIcon(p)),
          menu: rowMenu({ key: pinKey(p), label, row, remove }),
          source: { kind: "row", from: FAVORITES, key: pinKey(p), pin: p, row: row ?? undefined },
          onRemove: remove,
        };
      });
      const stars = fav.list.map((n): RowView => {
        const label = n.title.trim() || labels.untitled;
        const remove = {
          label: t("edit.unstar", { name: label }),
          run: () => {
            fav.toggle(n);
            toast.undo(t("edit.unpinned", { name: label }), () => fav.toggle(n), t("edit.undo"));
          },
        };
        return {
          key: starKey(n.id),
          label,
          icon: <PageIcon icon={n.icon} kind={n.kind} />,
          own: ownLabel(hid.wikiPage(n.id), <PageIcon icon={n.icon} kind={n.kind} />),
          menu: rowMenu({ key: hid.wikiPage(n.id), label, row: { kind: "wiki_page", id: n.id }, remove }),
          source: { kind: "row", from: FAVORITES, key: starKey(n.id), page: n.id, row: { kind: "wiki_page", id: n.id } },
          onRemove: remove,
        };
      });
      return [...pins, ...stars];
    }
    let items: Item[] = itemsOf(id);
    // In the sidebar Mail shows its boxes and accounts; folders and the every-account boxes are arranged under More options.
    if (id === "mail") items = items.filter((x) => !x.depth && !x.key.startsWith("every:"));
    const keyOf = (x: Item) => x.hideId ?? x.key;
    if (isOrdered(id)) {
      const fixed = id === "mail" ? items.filter((x) => !x.key.startsWith("account:")) : [];
      const moving = id === "mail" ? items.filter((x) => x.key.startsWith("account:")) : items;
      items = [...fixed, ...applyRowOrder(moving, keyOf, prefs.row_order[id])];
    }
    return items.map((x): RowView => {
      const key = keyOf(x);
      const row = ownRowOf(x);
      const orderable = isOrdered(id) && !(id === "mail" && !x.key.startsWith("account:"));
      const header = x.pin?.kind === "view_section";
      const hidden = x.hideId ? isHidden(prefs, x.hideId) : false;
      // The icon the sidebar row wears (an inbox folder's own), else the listing's.
      const model = row && d ? buildRow(row, d, { labels }) : null;
      return {
        key,
        label: x.label,
        icon: model?.icon ?? x.icon,
        own: header ? undefined : ownLabel(key, model?.icon ?? x.icon),
        menu: header ? undefined : rowMenu({ key, label: nameOf(prefs, key, x.label), hideId: x.hideId, pin: x.pin, row, badge: x.badge }),
        depth: x.depth,
        hidden,
        header,
        source: orderable || row || x.pin ? { kind: "row", from: id, key, row: row ?? undefined, pin: x.pin, page: row?.kind === "wiki_page" ? row.id : undefined } : undefined,
        onHide: x.hideId ? () => (hidden ? change(setHidden(prefs, x.hideId!, false)) : undoable(setHidden(prefs, x.hideId!, true), t("edit.hidden", { name: x.label }))) : undefined,
      };
    });
  };

  const ownBlock = (e: Extract<SidebarEntry, { kind: "custom" }>): BlockView => {
    const sec = e.section;
    const title = sec.title || t("ownSections.untitled");
    const save = (next: Space) => change(withSpace(prefs, next));
    const rows = sec.items.flatMap((item): RowView[] => {
      const full: SpaceItem = { workspace_id: wid, ...item };
      const model = d ? buildRow(item, d, { labels }) : null;
      if (!model) return [];
      const key = itemKey(full);
      const label = item.name || model.label;
      return [
        {
          key,
          label: model.label,
          icon: model.icon,
          source: { kind: "row", from: entryKey(e), key, row: { kind: item.kind, id: item.id } },
          own: {
            name: item.name,
            emoji: item.icon,
            fallbackIcon: model.icon,
            onRename: (v) => save(updateItem(space, key, { name: !v || v === model.label ? null : v })),
            onEmoji: (v) => save(updateItem(space, key, { icon: v || null })),
          },
          menu: rowMenu({ key, label, row: { kind: item.kind, id: item.id }, remove: { label: t("edit.remove", { name: label }), run: () => undoable(withSpace(prefs, removeItem(space, key)), t("edit.removed", { name: label })) } }),
          onRemove: { label: t("edit.remove", { name: label }), run: () => undoable(withSpace(prefs, removeItem(space, key)), t("edit.removed", { name: label })) },
        },
      ];
    });
    return {
      key: entryKey(e),
      label: title,
      rows,
      empty: t("edit.emptySection"),
      own: {
        emoji: sec.icon,
        onRename: (v) => v && save(updateSection(space, sec.id, { title: v })),
        onEmoji: (v) => save(updateSection(space, sec.id, { icon: v || null })),
        onDelete: () => undoable(withSpace(prefs, removeSection(space, sec.id)), t("edit.sectionDeleted", { name: title })),
        onAdd: () => ownSectionsUi.add(sec.id),
      },
    };
  };

  // A ticket inbox or team shown apart: its name and emoji, its folders or tabs to hide, and back into Tickets or Teams.
  const inboxBlock = (scope: InboxScope): BlockView => {
    const names = inboxNames(scope)!;
    const key = inboxKey(scope);
    const sk = `section:${key}`;
    const hidden = isHidden(prefs, sk);
    return {
      key,
      label: names.title,
      hidden,
      rows: inboxParts(scope).map((r): RowView => {
        const off = isHidden(prefs, r.key);
        return {
          key: r.key,
          label: r.label,
          icon: r.icon,
          hidden: off,
          own: ownLabel(r.key, r.icon),
          onHide: () => (off ? change(setHidden(prefs, r.key, false)) : undoable(setHidden(prefs, r.key, true), t("edit.hidden", { name: r.label }))),
        };
      }),
      own: {
        emoji: prefs.icons[sk],
        placeholder: names.own,
        onRename: (v: string) => change(setName(prefs, sk, v === names.own ? "" : v)),
        onEmoji: (v: string) => change(setIcon(prefs, sk, v)),
      },
      onHide: () => (hidden ? change(setHidden(prefs, sk, false)) : undoable(setHidden(prefs, sk, true), t("edit.hidden", { name: names.title }))),
      back: {
        label: scope.kind === "mailbox" ? backMailbox : backTeam,
        run: () => undoable(setInboxSection(prefs, scope, false), ti(scope.kind === "mailbox" ? "inboxes.backDone" : "inboxes.backTeamDone", { name: names.title })),
      },
    };
  };

  const blocks: BlockView[] = entries.map((e) => {
    if (e.kind === "custom") return ownBlock(e);
    if (e.kind === "inbox") return inboxBlock(e.scope);
    const hidden = isHidden(prefs, hid.section(e.id));
    const sk = sectionKey(e.id);
    return {
      key: e.id,
      label: nameOf(prefs, sk, name(e.id)),
      hidden,
      rows: builtinRows(e.id),
      empty: e.id === "favorites" ? t("edit.emptyFavorites") : undefined,
      own: {
        emoji: prefs.icons[sk],
        placeholder: name(e.id),
        onRename: (v: string) => change(setName(prefs, sk, v === name(e.id) ? "" : v)),
        onEmoji: (v: string) => change(setIcon(prefs, sk, v)),
        onAdd: e.id === "favorites" ? () => ownSectionsUi.addFavorites() : undefined,
      },
      onHide: () => (hidden ? change(setHidden(prefs, hid.section(e.id), false)) : undoable(setHidden(prefs, hid.section(e.id), true), t("edit.hidden", { name: name(e.id) }))),
    };
  });
  const rowsOf = (key: string) => blocks.find((b) => b.key === key)?.rows.map((r) => r.key) ?? [];

  const apply = (source: EditSource, target: EditTarget) => {
    const r = dropOnSidebar(prefs, wid, source, target, rowsOf);
    if (!r) return;
    if ("prefs" in r) change(r.prefs);
    else if ("stars" in r) fav.reorder(r.stars);
    else {
      const node = d?.wiki?.find((n) => n.id === r.star);
      if (node) fav.place(node, r.before);
    }
  };
  const { drag, target, handle } = useEditDrag<EditSource>({ root: rootRef, accepts: (s, tg) => canDrop(prefs, wid, s, tg), onDrop: apply });

  // Arrow keys on a handle: one place up or down in its own list.
  const step = (source: EditSource, dir: -1 | 1) => {
    if (source.kind === "section") {
      const keys = blocks.map((b) => b.key);
      const i = keys.indexOf(source.key);
      const j = i + dir;
      if (j < 0 || j >= keys.length) return;
      apply(source, { kind: "section", before: dir < 0 ? keys[j] : (keys[j + 1] ?? null) });
      return;
    }
    const keys = rowsOf(source.from);
    const i = keys.indexOf(source.key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    const t2: EditTarget = { kind: "row", section: source.from, before: dir < 0 ? keys[j] : (keys[j + 1] ?? null) };
    if (canDrop(prefs, wid, source, t2)) apply(source, t2);
  };

  const newSection = () => {
    if (prefs.sections.length >= OWN_LIMITS.sections) return void toast.error(t("ownSections.tooMany"));
    const made = newOwnSection(prefs, wid, t("edit.newSectionTitle"));
    change(made.prefs);
    setRenaming(`custom:${made.id}`);
  };

  const reset = () =>
    confirm.show(
      t("edit.resetConfirm"),
      () => {
        const before = prefs;
        change(resetPrefs(prefs));
        toast.undo(t("edit.resetDone"), () => change(before), t("edit.undo"));
      },
      { confirmLabel: t("edit.resetAction") },
    );

  const copyable = (spaces ?? []).filter((sp) => sp.sections.some((sec) => sec.items.some((i) => i.workspace_id === wid && i.kind !== "section" && i.kind !== "everywhere")));
  const copyFrom = (sp: Space) => {
    const r = copySpaceSections(prefs, wid, sp);
    if (!r.made) return void toast.error(t("ownSections.nothingToCopy"));
    undoable(r.prefs, t("ownSections.copied", { count: r.made }));
  };

  const menu = (
    <>
      {copyable.length > 0 && (
        <MenuSub icon={<Copy />} label={t("edit.copySpace")}>
          {copyable.map((sp) => (
            <MenuItem key={sp.id} icon={<SpaceGlyph icon={sp.icon} name={sp.name} color={sp.color} />} onSelect={() => copyFrom(sp)}>
              {sp.name}
            </MenuItem>
          ))}
        </MenuSub>
      )}
      <MenuItem icon={<SlidersHorizontal />} onSelect={() => collabUi.customize(true)}>
        {t("edit.options")}
      </MenuItem>
    </>
  );

  return (
    <>
      <EditBar title={t("edit.title")} menu={menu} onReset={reset} onLayouts={() => layoutsUi.open()} />
      <EditList blocks={blocks} rootRef={rootRef} drag={drag} target={target} handle={handle} step={step} renaming={renaming} setRenaming={setRenaming} picking={picking} setPicking={setPicking} />
      <button type="button" onClick={newSection} className={cn(rowCls, "mt-3 w-[calc(100%-1.25rem)] gap-2 pl-1.5 text-fg-3 outline-none hover:bg-chrome-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] [&>svg]:size-3.5")}>
        <Plus />
        <span>{t("edit.newSection")}</span>
      </button>
    </>
  );
}

// ─── A picked Space ─────────────────────────────────────────────────────────

function SpaceEditor({ spaces, space }: { spaces: Space[]; space: Space }) {
  const { t } = useTranslation("collab");
  const memberships = useSession((s) => s.memberships);
  const members = useMemo(() => new Set(memberships.map((m) => m.workspace.id)), [memberships]);
  const actions = useSpaceActions(spaces);
  const labels = useRowLabels();
  const wids = useMemo(() => {
    const out: string[] = [];
    for (const sec of space.sections) for (const i of sec.items) if (members.has(i.workspace_id) && !out.includes(i.workspace_id)) out.push(i.workspace_id);
    return out;
  }, [space, members]);
  const data = useWorkspacesData(wids, { folders: () => true, wiki: () => true });
  const rootRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const save = (next: Space) => actions.put(replaceSpace(spaces, next));
  const undoable = (next: Space, message: string) => {
    const before = space;
    save(next);
    toast.undo(message, () => save(before), t("edit.undo"));
  };

  const blocks: BlockView[] = space.sections.map((sec) => {
    const title = sec.title || t("ownSections.untitled");
    const rows = sec.items.flatMap((item): RowView[] => {
      const key = itemKey(item);
      const d = isEverywhere(item) ? undefined : data.get(item.workspace_id);
      let label: string;
      let icon: ReactNode;
      if (item.kind === "section") {
        if (!d || !isSectionId(item.id)) return [];
        label = labels.section(item.id, d.collab);
        icon = <ListTree />;
      } else {
        const model = isEverywhere(item) ? buildEverywhereRow(item.id, labels, []) : d ? buildRow(item, d, { labels }) : null;
        if (!model) return [];
        label = model.label;
        icon = model.icon;
      }
      const shown = item.name || label;
      return [
        {
          key,
          label,
          icon,
          source: { kind: "row", from: sec.id, key },
          own: {
            name: item.name,
            emoji: item.icon,
            fallbackIcon: icon,
            onRename: (v) => save(updateItem(space, key, { name: !v || v === label ? null : v })),
            onEmoji: (v) => save(updateItem(space, key, { icon: v || null })),
          },
          onRemove: { label: t("edit.remove", { name: shown }), run: () => undoable(removeItem(space, key), t("edit.removed", { name: shown })) },
        },
      ];
    });
    return {
      key: sec.id,
      label: title,
      rows,
      empty: t("edit.emptySection"),
      own: {
        emoji: sec.icon,
        onRename: (v) => save(updateSection(space, sec.id, { title: v })),
        onEmoji: (v) => save(updateSection(space, sec.id, { icon: v || null })),
        onDelete: () => undoable(removeSection(space, sec.id), t("edit.sectionDeleted", { name: title })),
        onAdd: () => ownSectionsUi.addToSpace(space.id, sec.id),
      },
    };
  });

  const apply = (source: EditSource, target: EditTarget) => {
    const next = dropInSpace(space, source, target);
    if (next) save(next);
  };
  const accepts = (s: EditSource, tg: EditTarget) => (s.kind === "section" ? tg.kind === "section" : tg.kind === "row");
  const { drag, target, handle } = useEditDrag<EditSource>({ root: rootRef, accepts, onDrop: apply });
  const step = (source: EditSource, dir: -1 | 1) => {
    const keys = source.kind === "section" ? blocks.map((b) => b.key) : (blocks.find((b) => b.key === source.from)?.rows.map((r) => r.key) ?? []);
    const i = keys.indexOf(source.key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    const before = dir < 0 ? keys[j] : (keys[j + 1] ?? null);
    apply(source, source.kind === "section" ? { kind: "section", before } : { kind: "row", section: source.from, before });
  };
  const newSection = () => {
    if (space.sections.length >= 20) return void toast.error(t("ownSections.tooMany"));
    const made = addSection(space, t("edit.newSectionTitle"));
    save(made.space);
    setRenaming(made.id);
  };

  const menu = (
    <MenuItem icon={<Settings2 />} onSelect={() => spaceUi.edit({ kind: "space", id: space.id })}>
      {t("edit.spaceSettings")}
    </MenuItem>
  );

  return (
    <>
      <EditBar
        title={
          <span className="flex min-w-0 items-center gap-2">
            <SpaceGlyph icon={space.icon} name={space.name} color={space.color} />
            <span className="truncate">{t("edit.editingSpace", { name: space.name })}</span>
          </span>
        }
        menu={menu}
      />
      <EditList blocks={blocks} rootRef={rootRef} drag={drag} target={target} handle={handle} step={step} renaming={renaming} setRenaming={setRenaming} picking={picking} setPicking={setPicking} />
      <button type="button" onClick={newSection} className={cn(rowCls, "mt-3 w-[calc(100%-1.25rem)] gap-2 pl-1.5 text-fg-3 outline-none hover:bg-chrome-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)] [&>svg]:size-3.5")}>
        <Plus />
        <span>{t("edit.newSection")}</span>
      </button>
    </>
  );
}

/** The edit mode in the sidebar: the picked Space's, or the workspace's own. Escape leaves it. */
export function SidebarEditor() {
  const { spaces } = useSpaces();
  const space = pickedSpace(spaces, usePickedSpaceId());
  useShortcuts({ "sidebar.done": () => sidebarEdit.stop() });
  return space && spaces ? <SpaceEditor spaces={spaces} space={space} /> : <WorkspaceEditor />;
}
