// Customize sidebar: the member orders sections, hides and shows sections and what
// is in them (accounts, folders, boxes, views, teams, the parts and pages of Pages), pins favorites, chooses the number
// beside each section's rows (and any one row's), and turns All inboxes and mark-as-read
// on and off. Each change shows at once and is saved with
// PUT /v1/collab/sidebar. Every member has it; without Collab it arranges the ticket side
// (Favorites, Inbox, Teams, Views, Pages, Workspace) and leaves out Mail and the mail options.

import { ChevronDown, ChevronRight, Copy, CornerUpLeft, Eye, EyeOff, Hash, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SidebarBadge, SidebarPrefs, SidebarSection, SidebarSectionId, Space } from "@/lib/api/types";
import { useCollab, useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import {
  badgeChoices,
  badgeFor,
  badgeWord,
  hid,
  isHidden,
  isPinned,
  MAX_PINS,
  movePin,
  sectionsOffered,
  setBadge,
  setHidden,
  togglePin,
  type BadgeKind,
} from "@/lib/collab/sidebarPrefs";
import { useCollabUi, collabUi } from "@/lib/collab/ui";
import { cn } from "@/lib/cn";
import { ReorderButtons } from "@/components/settings2/bits";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuChoice, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useSidebarItems, type Item, type ItemBadge } from "./sidebarItems";
import { SpaceGlyph } from "@/components/spaces/icons";
import { useSession } from "@/lib/session";
import { useSpaces } from "@/lib/spaces/hooks";
import { pickedSpace } from "@/lib/spaces/model";
import { spaceUi, usePickedSpaceId } from "@/lib/spaces/store";
import { useConfirm } from "@/components/ui/confirm";
import { asSpace, entryKey, moveEntry, OWN_LIMITS, reorderEntries, sidebarEntries, withSpace } from "@/lib/collab/ownSections";
import { copySpaceSections } from "@/lib/collab/copySpace";
import { setInboxSection } from "@/lib/collab/inboxSections";
import { useBackIntoLabel } from "@/components/tickets/inboxes/backInto";
import { useInboxNames } from "@/components/tickets/inboxes/inboxNames";
import { ownSectionsUi } from "@/lib/collab/ownSectionsUi";
import { removeSection } from "@/lib/spaces/model";

function IconToggle({ on, onClick, label, iconOn, iconOff, disabled }: { on: boolean; onClick: () => void; label: string; iconOn: ReactNode; iconOff: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex size-6 items-center justify-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5",
          on ? "text-fg-2 hover:text-fg" : "text-fg-4 hover:text-fg-2",
        )}
      >
        {on ? iconOn : iconOff}
      </button>
    </Tooltip>
  );
}


/** The sections whose rows carry numbers, and what kind. */
const SECTION_BADGE: Partial<Record<SidebarSectionId, BadgeKind | "both">> = { mail: "mail", favorites: "both", inbox: "ticket", teams: "team", views: "ticket" };

/** Favorites mixes mail and ticket rows: its own choice is a mail number, and a ticket row reads unread or total as its count. */
const choicesFor = (kind: BadgeKind | "both"): readonly SidebarBadge[] => badgeChoices(kind === "both" ? "mail" : kind);

/** A section's number for its rows: picking what rows show anyway clears the choice. */
function SectionNumbers({ id, prefs, onChange }: { id: SidebarSectionId; prefs: SidebarPrefs; onChange: (p: SidebarPrefs) => void }) {
  const { t } = useTranslation("collab");
  const kind = SECTION_BADGE[id];
  if (!kind) return null;
  const key = `section:${id}`;
  const rowKind: BadgeKind = kind === "both" ? "mail" : kind;
  const own = prefs.badges[key];
  const choices = choicesFor(kind);
  // Favorites without a choice of its own: each favorite reads the section it comes from.
  const value: SidebarBadge | "inherit" = own ? badgeFor(prefs, key, [], rowKind) : kind === "both" ? "inherit" : choices[0];
  const word = (v: SidebarBadge | "inherit") => (v === "inherit" ? t("customize.badge.section") : t(`customize.badge.${badgeWord(v, rowKind)}`));
  const set = (v: SidebarBadge | "inherit") => onChange(setBadge(prefs, key, v === "inherit" || (kind !== "both" && v === choices[0]) ? null : v));
  const label = t("customize.numberFor", { name: t(`customize.section.${id}`) });
  return (
    <Menu>
      <Tooltip content={t("customize.numbersHint")}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${word(value)}`}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-hover"
          >
            <span className="hidden text-fg-4 sm:inline">{t("customize.numbers")}</span>
            <span className="font-medium text-fg-2">{word(value)}</span>
            <ChevronDown className="size-3 text-fg-4" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="w-[190px]">
        {kind === "both" && (
          <>
            <MenuChoice checked={value === "inherit"} onSelect={() => set("inherit")}>
              {word("inherit")}
            </MenuChoice>
            <MenuSeparator />
          </>
        )}
        {choices.map((v) => (
          <MenuChoice key={v} checked={value === v} onSelect={() => set(v)}>
            {word(v)}
          </MenuChoice>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** One row's number: a quiet # while it follows its section, its own choice as a word once set. */
function RowNumbers({ item, badge, prefs, onChange }: { item: Item; badge: ItemBadge; prefs: SidebarPrefs; onChange: (p: SidebarPrefs) => void }) {
  const { t } = useTranslation("collab");
  const own = prefs.badges[badge.key] ? badgeFor(prefs, badge.key, [], badge.kind) : null;
  const effective = badgeFor(prefs, badge.key, badge.sections, badge.kind, badge.fallback);
  const word = (v: SidebarBadge) => t(`customize.badge.${badgeWord(v, badge.kind)}`);
  const label = t("customize.numberFor", { name: item.label });
  const pick = (v: SidebarBadge | null) => onChange(setBadge(prefs, badge.key, v));
  return (
    <Menu>
      <Tooltip content={`${label}: ${own ? word(own) : `${t("customize.badge.section")} (${word(effective)})`}`}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "flex h-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:bg-hover",
              own ? "px-1.5 text-[11px] font-medium text-fg-2" : "w-6 text-fg-4 hover:text-fg-2",
            )}
          >
            {own ? word(own) : <Hash className="size-3.5" />}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="w-[190px]">
        <MenuChoice checked={own === null} onSelect={() => pick(null)}>
          {t("customize.badge.section")}
        </MenuChoice>
        <MenuSeparator />
        {badgeChoices(badge.kind).map((v) => (
          <MenuChoice key={v} checked={own === v} onSelect={() => pick(v)}>
            {word(v)}
          </MenuChoice>
        ))}
      </MenuContent>
    </Menu>
  );
}

function ItemRow({ item, prefs, onChange }: { item: Item; prefs: SidebarPrefs; onChange: (p: SidebarPrefs) => void }) {
  const { t } = useTranslation("collab");
  const hidden = item.hideId ? isHidden(prefs, item.hideId) : false;
  const pinned = item.pin ? isPinned(prefs, item.pin) : false;
  return (
    <li className="flex h-8 items-center gap-2 rounded-md pr-1 hover:bg-hover/60" style={{ paddingLeft: 8 + (item.depth ?? 0) * 16 }}>
      <span className={cn("flex size-4 shrink-0 items-center justify-center text-fg-3 [&_svg]:size-3.5", hidden && "opacity-50")}>{item.icon}</span>
      <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", hidden ? "text-fg-4 line-through decoration-fg-4/50" : "text-fg")}>{item.label}</span>
      {item.note && <span className="shrink-0 text-[11px] text-fg-4">{item.note}</span>}
      {item.badge && <RowNumbers item={item} badge={item.badge} prefs={prefs} onChange={onChange} />}
      {item.pin && (
        <IconToggle
          on={pinned}
          disabled={!pinned && prefs.pinned.length >= MAX_PINS}
          label={pinned ? t("customize.unpin", { name: item.label }) : t("customize.pin", { name: item.label })}
          iconOn={<Pin className="fill-current" />}
          iconOff={<Pin />}
          onClick={() => onChange(togglePin(prefs, item.pin!))}
        />
      )}
      {/* A view section is pinned, not hidden: its pin stays in line with its views' pins. */}
      {item.pin && !item.hideId && <span aria-hidden className="size-6 shrink-0" />}
      {item.hideId && (
        <IconToggle
          on={!hidden}
          label={hidden ? t("customize.show", { name: item.label }) : t("customize.hide", { name: item.label })}
          iconOn={<Eye />}
          iconOff={<EyeOff />}
          onClick={() => onChange(setHidden(prefs, item.hideId!, !hidden))}
        />
      )}
    </li>
  );
}

export function CustomizeSidebar() {
  const { t } = useTranslation("collab");
  const open = useCollabUi((s) => s.customizeOpen);
  const collab = useCollab().enabled;
  const prefs = useSidebarPrefs();
  const save = useSaveSidebarPrefs();
  const [expanded, setExpanded] = useState<Set<SidebarSectionId>>(new Set(["mail"]));
  const { t: ts } = useTranslation("spaces");
  const { spaces } = useSpaces();
  const space = pickedSpace(spaces, usePickedSpaceId());
  const wsName = useSession((s) => s.memberships.find((m) => m.workspace.id === s.workspaceId)?.workspace.name ?? "");

  const change = (p: SidebarPrefs) => save.mutate(p, { onError: (e) => toast.error(e, t("customize.saveFailed")) });
  const offered = sectionsOffered(collab);
  const inboxNames = useInboxNames();
  const backMailbox = useBackIntoLabel("mailbox");
  const backTeam = useBackIntoLabel("team");
  // The built-in sections offered, the member's own and the inboxes shown apart, in their order.
  const order = sidebarEntries(prefs).filter((e) => (e.kind === "builtin" ? offered.includes(e.id) : e.kind === "custom" || !!inboxNames(e.scope)));
  const name = (id: SidebarSectionId) => t(`customize.section.${id}`);
  const wid = useSession((s) => s.workspaceId) ?? "";
  const confirm = useConfirm();
  // The section being dragged in the list, and the one it would go before.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const dropTo = (before: string) => {
    if (!dragging || dragging === before) return;
    const keys = order.map(entryKey).filter((k) => k !== dragging);
    keys.splice(keys.indexOf(before), 0, dragging);
    change(reorderEntries(prefs, keys));
  };
  const dragProps = (key: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
      setDragging(key);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropBefore(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      if (dropBefore !== key) setDropBefore(key);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dropTo(key);
      setDragging(null);
      setDropBefore(null);
    },
  });
  const ownName = (s: SidebarSection) => s.title || t("ownSections.untitled");
  const removeOwn = (s: SidebarSection) =>
    confirm.show(t("ownSections.deleteConfirm", { name: ownName(s) }), () => change(withSpace(prefs, removeSection(asSpace(prefs, wid), s.id))), {
      confirmLabel: t("ownSections.deleteAction"),
      danger: true,
    });
  // A Space's sections with this workspace's rows, copied as the member's own.
  const copyable = (spaces ?? []).filter((sp) => sp.sections.some((sec) => sec.items.some((i) => i.workspace_id === wid && i.kind !== "section" && i.kind !== "everywhere")));
  const copySpace = (sp: Space) => {
    const r = copySpaceSections(prefs, wid, sp);
    if (!r.made) return void toast.error(t("ownSections.nothingToCopy"));
    change(r.prefs);
    toast.success(t("ownSections.copied", { count: r.made }));
  };

  const { itemsOf, pinLabel, livePinned } = useSidebarItems();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => collabUi.customize(o)}
      size="lg"
      title={t("customize.title")}
      description={t("customize.description")}
      footer={
        <Button variant="primary" onClick={() => collabUi.customize(false)}>
          {t("customize.done")}
        </Button>
      }
    >
      <div className="flex flex-col gap-5 pb-2">
        {space && (
          // These prefs are the workspace's own sidebar (and what is inside its sections in a Space); the picked Space has its editor.
          <div className="flex items-center justify-between gap-3 rounded-lg bg-sunken px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--line-soft)]">
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-fg-3">
              <SpaceGlyph icon={space.icon} name={space.name} color={space.color} />
              <span>{ts("customize.spaces", { space: space.name, workspace: wsName })}</span>
            </span>
            <Button
              size="xs"
              onClick={() => {
                collabUi.customize(false);
                spaceUi.edit({ kind: "space", id: space.id });
              }}
            >
              {ts("customize.editSpace")}
            </Button>
          </div>
        )}
        {collab && (
          <section>
            <h3 className="label-caps mb-1.5">{t("customize.options")}</h3>
            <div className="rounded-lg border border-line">
              <label className="flex items-start justify-between gap-4 border-b border-line-soft px-3.5 py-3">
                <span>
                  <span className="block text-[12.5px] font-medium">{t("customize.unified")}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-3">{t("customize.unifiedHint")}</span>
                </span>
                <Switch checked={prefs.unified_inbox} onCheckedChange={(v) => change({ ...prefs, unified_inbox: v })} aria-label={t("customize.unified")} />
              </label>
              <label className="flex items-start justify-between gap-4 px-3.5 py-3">
                <span>
                  <span className="block text-[12.5px] font-medium">{t("customize.markRead")}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-3">{t("customize.markReadHint")}</span>
                </span>
                <Switch checked={prefs.mark_read_on_open} onCheckedChange={(v) => change({ ...prefs, mark_read_on_open: v })} aria-label={t("customize.markRead")} />
              </label>
            </div>
          </section>
        )}

        <section>
          <h3 className="label-caps mb-1.5">{t("customize.sections")}</h3>
          <ol className="flex flex-col rounded-lg border border-line">
            {order.map((entry, i) => {
              const key = entryKey(entry);
              const dropLine = dragging && dropBefore === key && dragging !== key;
              if (entry.kind === "custom") {
                const s = entry.section;
                return (
                  <li key={key} {...dragProps(key)} className={cn("relative border-b border-line-soft last:border-0", dragging === key && "opacity-50", dropLine && "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-tone-blue-solid")}>
                    <div className="flex h-10 items-center gap-2 px-2">
                      <ReorderButtons label={ownName(s)} first={i === 0} last={i === order.length - 1} onUp={() => change(moveEntry(prefs, key, -1, collab))} onDown={() => change(moveEntry(prefs, key, 1, collab))} />
                      <span className="min-w-0 flex-1 truncate pl-5 text-[13px] font-medium">{ownName(s)}</span>
                      <span className="mono text-[10.5px] text-fg-4">{s.items.length}</span>
                      <IconToggle on label={t("ownSections.addRows")} iconOn={<Plus />} iconOff={<Plus />} onClick={() => ownSectionsUi.add(s.id)} />
                      <IconToggle on label={t("ownSections.rename")} iconOn={<Pencil />} iconOff={<Pencil />} onClick={() => ownSectionsUi.name({ mode: "rename", id: s.id })} />
                      <IconToggle on label={t("ownSections.delete")} iconOn={<Trash2 />} iconOff={<Trash2 />} onClick={() => removeOwn(s)} />
                    </div>
                  </li>
                );
              }
              if (entry.kind === "inbox") {
                const names = inboxNames(entry.scope)!;
                const inboxHidden = isHidden(prefs, `section:${key}`);
                return (
                  <li key={key} {...dragProps(key)} className={cn("relative border-b border-line-soft last:border-0", dragging === key && "opacity-50", dropLine && "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-tone-blue-solid")}>
                    <div className="flex h-10 items-center gap-2 px-2">
                      <ReorderButtons label={names.title} first={i === 0} last={i === order.length - 1} onUp={() => change(moveEntry(prefs, key, -1, collab))} onDown={() => change(moveEntry(prefs, key, 1, collab))} />
                      <span className={cn("min-w-0 flex-1 truncate pl-5 text-[13px] font-medium", inboxHidden && "text-fg-4")}>{names.title}</span>
                      <IconToggle on label={entry.scope.kind === "mailbox" ? backMailbox : backTeam} iconOn={<CornerUpLeft />} iconOff={<CornerUpLeft />} onClick={() => change(setInboxSection(prefs, entry.scope, false))} />
                      <IconToggle
                        on={!inboxHidden}
                        label={inboxHidden ? t("customize.show", { name: names.title }) : t("customize.hide", { name: names.title })}
                        iconOn={<Eye />}
                        iconOff={<EyeOff />}
                        onClick={() => change(setHidden(prefs, `section:${key}`, !inboxHidden))}
                      />
                    </div>
                  </li>
                );
              }
              const id = entry.id;
              const items = itemsOf(id);
              const sectionHidden = isHidden(prefs, hid.section(id));
              const isOpen = expanded.has(id);
              const hasBody = items.length > 0 || id === "favorites";
              return (
                <li key={id} {...dragProps(key)} className={cn("relative border-b border-line-soft last:border-0", dragging === key && "opacity-50", dropLine && "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-tone-blue-solid")}>
                  <div className="flex h-10 items-center gap-2 px-2">
                    <ReorderButtons label={name(id)} first={i === 0} last={i === order.length - 1} onUp={() => change(moveEntry(prefs, key, -1, collab))} onDown={() => change(moveEntry(prefs, key, 1, collab))} />
                    {hasBody ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? t("customize.collapse", { name: name(id) }) : t("customize.expand", { name: name(id) })}
                        onClick={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            if (n.has(id)) n.delete(id);
                            else n.add(id);
                            return n;
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                      >
                        <ChevronRight className={cn("size-3.5 shrink-0 text-fg-4 transition-transform duration-150 motion-reduce:transition-none", isOpen && "rotate-90")} />
                        <span className={cn("truncate text-[13px] font-medium", sectionHidden && "text-fg-4")}>{name(id)}</span>
                        <span className="mono text-[10.5px] text-fg-4">{id === "favorites" ? livePinned.length : items.filter((x) => x.pin?.kind !== "view_section").length}</span>
                      </button>
                    ) : (
                      <span className={cn("flex-1 truncate pl-5 text-[13px] font-medium", sectionHidden && "text-fg-4")}>{name(id)}</span>
                    )}
                    <SectionNumbers id={id} prefs={prefs} onChange={change} />
                    <IconToggle
                      on={!sectionHidden}
                      label={sectionHidden ? t("customize.show", { name: name(id) }) : t("customize.hide", { name: name(id) })}
                      iconOn={<Eye />}
                      iconOff={<EyeOff />}
                      onClick={() => change(setHidden(prefs, hid.section(id), !sectionHidden))}
                    />
                  </div>
                  {isOpen && hasBody && (
                    <div className="px-2 pb-2 animate-rise-in motion-reduce:animate-none">
                      {id === "favorites" ? (
                        livePinned.length ? (
                          <ol className="flex flex-col">
                            {livePinned.map((p, j) => (
                              <li key={`${p.kind}:${p.id}`} className="flex h-8 items-center gap-2 rounded-md pl-2 pr-1 hover:bg-hover/60">
                                <Pin className="size-3.5 shrink-0 fill-current text-fg-3" />
                                <span className="min-w-0 flex-1 truncate text-[12.5px]">{pinLabel(p)}</span>
                                <ReorderButtons label={pinLabel(p) ?? ""} first={j === 0} last={j === livePinned.length - 1} onUp={() => change(movePin(prefs, p, -1))} onDown={() => change(movePin(prefs, p, 1))} />
                                <IconToggle on label={t("customize.unpin", { name: pinLabel(p) ?? "" })} iconOn={<PinOff />} iconOff={<PinOff />} onClick={() => change(togglePin(prefs, p))} />
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="px-2 py-2 text-[12px] text-fg-3">{t("customize.favoritesEmpty")}</p>
                        )
                      ) : (
                        <ul className="flex flex-col">
                          {items.map((item) => (
                            <ItemRow key={item.key} item={item} prefs={prefs} onChange={change} />
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs" icon={<Plus />} disabled={prefs.sections.length >= OWN_LIMITS.sections} onClick={() => ownSectionsUi.name({ mode: "new" })}>
              {t("ownSections.addSection")}
            </Button>
            {copyable.length > 0 && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="xs" variant="ghost" icon={<Copy />} disabled={prefs.sections.length >= OWN_LIMITS.sections}>
                    {t("ownSections.fromSpace")}
                  </Button>
                </MenuTrigger>
                <MenuContent align="start" className="w-[240px]">
                  <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-4 text-fg-4">{t("ownSections.fromSpaceHint")}</p>
                  {copyable.map((sp) => (
                    <MenuItem key={sp.id} icon={<SpaceGlyph icon={sp.icon} name={sp.name} color={sp.color} />} onSelect={() => copySpace(sp)}>
                      {sp.name}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </div>
          {prefs.pinned.length >= MAX_PINS && <p className="mt-1.5 text-[11.5px] text-fg-4">{t("customize.pinLimit")}</p>}
        </section>
      </div>
    </Dialog>
  );
}
