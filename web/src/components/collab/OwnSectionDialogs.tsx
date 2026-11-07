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
import { ownSectionsUi, useOwnSectionsUi, type Naming } from "@/lib/collab/ownSectionsUi";
import { useSession } from "@/lib/session";
import { useWorkspacesData } from "@/lib/spaces/hooks";
import { cleanName, updateSection } from "@/lib/spaces/model";
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

export function OwnSectionDialogs() {
  const { naming, adding } = useOwnSectionsUi();
  return (
    <>
      {naming && <NameDialog key={naming.mode === "rename" ? naming.id : "new"} naming={naming} />}
      {adding && <AddRowsDialog sectionId={adding} />}
    </>
  );
}
