// How the latest message to many customers the member sent is going (contracts/api.md "Messages
// to many customers"): a strip over the People list while it sends, with a way to stop it, and a
// line once it is done with a link to the replies. The server tells its sender alone as it goes,
// over the realtime connection; nothing polls.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { ContactMessage } from "@/lib/api/types";
import { api } from "@/lib/api/endpoints";
import { q, qk } from "@/lib/queries";
import { useSession } from "@/lib/session";

export function MessageProgress() {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ ...q.contactMessages(), retry: false });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const me = useSession((s) => s.user?.id);
  const m = me ? data?.find((x) => x.created_by === me) : undefined;
  const stop = useMutation({
    mutationFn: (id: string) => api.contactMessages.cancel(id),
    onSuccess: (next) => qc.setQueryData<ContactMessage[]>(qk.contactMessages, (old) => [next, ...(old ?? []).filter((x) => x.id !== next.id)]),
    onError: (e) => toast.error(e, t("message.stopFailed")),
  });
  // Only what is going now, or finished in the last few minutes and not yet put away.
  const recent = !!m && (m.state === "sending" || (!!m.finished_at && Date.now() - Date.parse(m.finished_at) < 10 * 60_000));
  if (!m || !recent || dismissed === m.id) return null;

  const working = m.state === "sending";
  const problem = m.failed > 0 || m.state === "cancelled";
  const done = m.sent + m.failed;
  return (
    <div
      role="status"
      className="flex animate-rise-in items-center gap-2.5 border-b border-line-soft bg-sunken px-5 py-2 text-[12.5px] motion-reduce:animate-none"
    >
      {working ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-3" aria-hidden />
      ) : problem ? (
        <TriangleAlert className="size-3.5 shrink-0 text-tone-amber" aria-hidden />
      ) : (
        <Check className="size-3.5 shrink-0 text-tone-green" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-fg-2">
        <bdi className="font-medium text-fg">{m.subject}</bdi>
        {" · "}
        {working
          ? t("message.progress", { done, total: m.total })
          : m.state === "cancelled"
            ? t("message.stopped", { sent: m.sent, total: m.total })
            : m.failed > 0
              ? t("message.doneWithFailures", { sent: m.sent, failed: m.failed })
              : t("message.done", { count: m.sent })}
        {!working && m.last_error && <span className="text-fg-3"> {m.last_error}</span>}
      </span>
      {working ? (
        <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => stop.mutate(m.id)}>
          {t("message.stop")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          // Every ticket of the label in any status: what was sent shows at once, even when the tickets
          // started as solved, and a customer's answer reopens their ticket in the same list.
          onClick={() => void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "all", ticketId: undefined }, search: { tag: m.label } })}
        >
          {t("message.replies")}
        </Button>
      )}
      {!working && <Button size="sm" variant="ghost" square aria-label={t("message.dismiss")} icon={<X className="size-3.5" />} onClick={() => setDismissed(m.id)} />}
    </div>
  );
}
