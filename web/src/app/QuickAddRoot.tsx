// The dialogs the sidebar and the header open in place (app/quickAdd): a new page, database or
// canvas, an import, a team, a view and a mail account. Loaded once one is asked for.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ConnectAccountDialog } from "@/components/collab/ConnectAccount";
import { NewTeamDialog } from "@/components/settings2/NewTeamDialog";
import { AddInboxDialog } from "@/components/tickets/inboxes/AddInboxDialog";
import { ViewDrawer } from "@/components/settings2/ViewDrawer";
import { ImportDialogHost } from "@/components/wiki/ImportDialog";
import { NewPageDialog } from "@/components/wiki/NewPageDialog";
import { useCollab } from "@/lib/collab/hooks";
import { q } from "@/lib/queries";
import { orderViews } from "@/lib/viewSections";
import { quickAdd, useQuickAdd } from "./quickAdd";

export default function QuickAddRoot() {
  const { newPage, team, view, mail, inbox } = useQuickAdd();
  const navigate = useNavigate();
  const collab = useCollab();
  return (
    <>
      {newPage && <NewPageDialog />}
      <ImportDialogHost />
      {team && <NewTeamDialog onClose={() => quickAdd.team(false)} onCreated={(t) => void navigate({ to: "/teams/$teamId/{-$ticketId}", params: { teamId: t.id, ticketId: undefined } })} />}
      {view && <ViewEditor />}
      {collab.status && <ConnectAccountDialog open={mail} onOpenChange={quickAdd.mail} status={collab.status} />}
      {inbox && <AddInboxDialog start={inbox} />}
    </>
  );
}

/** The view editor over the open page: a new view, one to change, or a copy. */
function ViewEditor() {
  const edit = useQuickAdd((s) => s.view);
  const { data: views } = useQuery(q.views());
  const sorted = useMemo(() => orderViews(views ?? []), [views]);
  if (!edit || !views) return null;
  const close = () => quickAdd.view(null);
  if (edit.kind === "new") return <ViewDrawer key="new" view={null} views={sorted} nextPosition={sorted.length} onClose={close} />;
  // A view deleted elsewhere while its editor was asked for: nothing to open.
  const target = sorted.find((v) => v.id === edit.id);
  if (!target) return null;
  return edit.kind === "duplicate" ? (
    <ViewDrawer key={`copy:${target.id}`} view={null} copyOf={target} views={sorted} nextPosition={sorted.length} onClose={close} />
  ) : (
    <ViewDrawer key={target.id} view={target} views={sorted} nextPosition={sorted.length} onClose={close} />
  );
}
