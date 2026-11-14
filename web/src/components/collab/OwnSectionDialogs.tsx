// The popups of a member's own sidebar sections (lib/collab/ownSectionsUi.ts): naming a new
// section (with the row that asked for it) or renaming one, and adding rows to one from
// everything the workspace offers, the Space editor's list (components/spaces/SpaceEditor.tsx).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddFrom } from "@/components/spaces/SpaceEditor";
import { useRowLabels } from "@/components/spaces/rows";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { asSpace, hasRoom, newOwnSection, OWN_LIMITS, sectionOf, toggleInSection, withSpace } from "@/lib/collab/ownSections";
import { ownSectionsUi, useOwnSectionsUi, type Naming, type RenamingRow, type SpaceAdding } from "@/lib/collab/ownSectionsUi";
import { useFavorites } from "@/components/wiki/hooks";
import type { SidebarPin, SpaceItem } from "@/lib/api/types";
import { isPinned, MAX_PINS, setName, togglePin } from "@/lib/collab/sidebarPrefs";
import { useSpaceActions } from "@/components/spaces/actions";
import { useSession } from "@/lib/session";
import { useSpaces, useWorkspacesData } from "@/lib/spaces/hooks";
import { addItems, cleanName, hasItem, itemKey, moveItemTo, removeItem, replaceSpace, updateSection } from "@/lib/spaces/model";
import { useOwnSidebar } from "./AddToSidebar";

function NameDialog({ naming }: { naming: Naming }) {
  const { t } = useTranslation("collab");
  const { t: ui } = useTranslation("ui");
  const { prefs, wid, change } = useOwnSidebar();
  const current = naming.mode === "rename" ? prefs.sections.find((s) => s.id === naming.id) : undefined;
  const [title, setTitle] = useState(current?.title ?? "");
  const clean = cleanName(title);
  const tooMany = naming.mode === "new" && prefs.sections.length >= OWN_LIMITS.sections;
  const submit = () => {
    if (!clean || tooMany) return;
    if (naming.mode === "rename") {
      if (current) change(withSpace(prefs, updateSection(asSpace(prefs, wid), current.id, { title: clean })));
    } else {
      const moving = !!naming.item && !!sectionOf(prefs, wid, naming.item);
      if (naming.item && !moving && prefs.sections.reduce((n, s) => n + s.items.length, 0) >= OWN_LIMITS.items) return void toast.error(t("ownSections.full"));
      change(newOwnSection(prefs, wid, clean, naming.item, naming.at).prefs);
    }
    ownSectionsUi.close();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ownSectionsUi.close()}
      size="sm"
      title={naming.mode === "rename" ? t("ownSections.renameTitle") : t("ownSections.newTitle")}
      description={naming.mode === "new" ? t("ownSections.nameHint") : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => ownSectionsUi.close()}>
            {ui("cancel")}
          </Button>
          <Button variant="primary" disabled={!clean || tooMany} onClick={submit}>
            {naming.mode === "rename" ? t("ownSections.save") : t("ownSections.create")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("ownSections.nameLabel")} hint={tooMany ? t("ownSections.tooMany") : undefined}>
          {(f) => <TextInput {...f} autoFocus value={title} maxLength={OWN_LIMITS.title} placeholder={t("ownSections.namePlaceholder")} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function AddRowsDialog({ sectionId }: { sectionId: string }) {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const labels = useRowLabels();
  const memberships = useSession((s) => s.memberships);
  const ws = memberships.find((m) => m.workspace.id === wid)?.workspace;
  const data = useWorkspacesData(wid ? [wid] : [], { folders: () => true, wiki: () => true });
  const section = prefs.sections.find((s) => s.id === sectionId);
  // The section went away (deleted elsewhere): nothing to add to.
  useEffect(() => {
    if (!section) ownSectionsUi.close();
  }, [section]);
  if (!section || !ws) return null;
  const all = asSpace(prefs, wid);
  // Checked: in this section. A row in another of the member's sections moves here.
  const only = { ...all, sections: all.sections.filter((s) => s.id === sectionId) };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ownSectionsUi.close()}
      size="md"
      title={t("ownSections.addRowsTitle", { name: section.title || t("ownSections.untitled") })}
      description={t("ownSections.addRowsHint", { workspace: ws.name })}
      footer={
        <Button variant="primary" onClick={() => ownSectionsUi.close()}>
          {t("ownSections.done")}
        </Button>
      }
    >
      <div className="flex h-[min(420px,52vh)] flex-col">
        <AddFrom
          space={only}
          workspaces={[{ id: ws.id, name: ws.name, logo: ws.avatar_url }]}
          data={data}
          active={ws.id}
          onActive={() => undefined}
          labels={labels}
          omit={["sections"]}
          onToggle={(item, on) => {
            if (item.kind === "section" || item.kind === "everywhere") return;
            const row = { kind: item.kind, id: item.id };
            const elsewhere = !!sectionOf(prefs, wid, row);
            if (on && !hasRoom(prefs, sectionId, elsewhere)) return void toast.error(t("ownSections.full"));
            change(toggleInSection(prefs, wid, sectionId, row));
          }}
        />
      </div>
    </Dialog>
  );
}

/** Adding rows to a section of a Space, from the sidebar's edit mode: what every workspace offers, as the Space editor lists it. */
function AddToSpaceDialog({ spaceId, sectionId }: SpaceAdding) {
  const { t } = useTranslation("collab");
  const { t: ts } = useTranslation("spaces");
  const labels = useRowLabels();
  const { spaces } = useSpaces();
  const actions = useSpaceActions(spaces);
  const memberships = useSession((s) => s.memberships);
  const wid = useSession((s) => s.workspaceId) ?? "";
  const workspaces = memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, logo: m.workspace.avatar_url }));
  const [active, setActive] = useState(wid || workspaces[0]?.id || "");
  const data = useWorkspacesData(active && active !== "*" ? [active] : [], { folders: () => true, wiki: () => true });
  const space = spaces?.find((x) => x.id === spaceId);
  const section = space?.sections.find((x) => x.id === sectionId);
  useEffect(() => {
    if (spaces && !section) ownSectionsUi.close();
  }, [spaces, section]);
  if (!space || !section) return null;
  const only = { ...space, sections: [section] };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ownSectionsUi.close()}
      size="md"
      title={t("ownSections.addRowsTitle", { name: section.title || t("ownSections.untitled") })}
      footer={
        <Button variant="primary" onClick={() => ownSectionsUi.close()}>
          {t("ownSections.done")}
        </Button>
      }
    >
      <div className="flex h-[min(420px,52vh)] flex-col">
        <AddFrom
          space={only}
          workspaces={[...workspaces, { id: "*", name: ts("editor.everyWorkspace"), logo: null }]}
          data={data}
          active={active}
          onActive={setActive}
          labels={labels}
          onToggle={(item, on) => {
            const key = itemKey(item);
            if (!on) return actions.put(replaceSpace(spaces ?? [], removeItem(space, key)));
            if (hasItem(space, item)) return actions.put(replaceSpace(spaces ?? [], moveItemTo(space, key, sectionId)));
            actions.put(replaceSpace(spaces ?? [], addItems(space, sectionId, [item])));
          }}
        />
      </div>
    </Dialog>
  );
}

/** Names a row in the member's sidebar: their own label, which nobody else sees; empty goes back to its own name. */
function RenameRowDialog({ row }: { row: RenamingRow }) {
  const { t } = useTranslation("collab");
  const { t: ui } = useTranslation("ui");
  const { prefs, change } = useOwnSidebar();
  const [name, setNameValue] = useState(prefs.names[row.key] ?? row.fallback);
  const submit = () => {
    change(setName(prefs, row.key, name.trim() === row.fallback ? "" : name));
    ownSectionsUi.close();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ownSectionsUi.close()}
      size="sm"
      title={t("edit.renameTitle")}
      description={t("edit.renameHint", { name: row.fallback })}
      footer={
        <>
          {prefs.names[row.key] && (
            <Button variant="ghost" className="mr-auto" onClick={() => (change(setName(prefs, row.key, "")), ownSectionsUi.close())}>
              {t("edit.resetName")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => ownSectionsUi.close()}>
            {ui("cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t("edit.renameSave")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("edit.renameLabel")}>
          {(f) => <TextInput {...f} autoFocus value={name} maxLength={64} placeholder={row.fallback} onChange={(e) => setNameValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />}
        </Field>
      </form>
    </Dialog>
  );
}

/** "+ Add" under Favorites: what the workspace offers that can be a favorite, checked when it is. */
function AddFavoritesDialog() {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const labels = useRowLabels();
  const fav = useFavorites();
  const memberships = useSession((s) => s.memberships);
  const ws = memberships.find((m) => m.workspace.id === wid)?.workspace;
  const data = useWorkspacesData(wid ? [wid] : [], { folders: () => true, wiki: () => true });
  if (!ws) return null;
  const items: SpaceItem[] = [
    ...prefs.pinned.filter((p) => p.kind !== "view_section").map((p) => ({ workspace_id: wid, kind: p.kind as SpaceItem["kind"], id: p.id })),
    ...fav.list.map((n) => ({ workspace_id: wid, kind: "wiki_page" as const, id: n.id })),
  ];
  const space = { id: "favorites", name: "", icon: "", color: "grey" as const, marks: false, sections: [{ id: "favorites", title: "", collapsed: false, items }] };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && ownSectionsUi.close()}
      size="md"
      title={t("edit.favoritesTitle")}
      description={t("edit.favoritesHint")}
      footer={
        <Button variant="primary" onClick={() => ownSectionsUi.close()}>
          {t("ownSections.done")}
        </Button>
      }
    >
      <div className="flex h-[min(420px,52vh)] flex-col">
        <AddFrom
          space={space}
          workspaces={[{ id: ws.id, name: ws.name, logo: ws.avatar_url }]}
          data={data}
          active={ws.id}
          onActive={() => undefined}
          labels={labels}
          omit={["sections"]}
          onToggle={(item) => {
            if (item.kind === "wiki_page") {
              const node = data.get(wid)?.wiki?.find((n) => n.id === item.id);
              if (node) fav.toggle(node);
              return;
            }
            if (!PIN_KINDS.includes(item.kind)) return void toast.error(t("edit.notFavorite"));
            const pin = { kind: item.kind, id: item.id } as SidebarPin;
            if (!isPinned(prefs, pin) && prefs.pinned.length >= MAX_PINS) return void toast.error(t("customize.pinLimit"));
            change(togglePin(prefs, pin));
          }}
        />
      </div>
    </Dialog>
  );
}

const PIN_KINDS: readonly string[] = ["ticket_folder", "team", "view", "box", "account", "folder"];

export function OwnSectionDialogs() {
  const { naming, adding, addingToSpace, addingFavorites, renamingRow } = useOwnSectionsUi();
  return (
    <>
      {addingFavorites && <AddFavoritesDialog />}
      {renamingRow && <RenameRowDialog key={renamingRow.key} row={renamingRow} />}
      {naming && <NameDialog key={naming.mode === "rename" ? naming.id : "new"} naming={naming} />}
      {adding && <AddRowsDialog sectionId={adding} />}
      {addingToSpace && <AddToSpaceDialog {...addingToSpace} />}
    </>
  );
}
