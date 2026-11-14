// The person's own shortcut keys (lib/shortcuts.ts): loaded from /v1/me/shortcuts into the
// registry's store, and saved back from Settings › Shortcuts. Until the server answers, and if
// it can't, the keys kept in this browser (or the defaults) apply.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "./api/endpoints";
import type { ShortcutKeys } from "./api/types";
import { q, qk } from "./queries";
import { cleanBindings, setShortcutBindings, useShortcutKeys, type ShortcutBindings } from "./shortcuts";

/** Keeps the registry on the person's saved keys; mounted once in the app shell. */
export function useSyncShortcuts(enabled: boolean) {
  const { data } = useQuery({ ...q.shortcuts(), enabled, refetchOnWindowFocus: true });
  useEffect(() => {
    if (data) setShortcutBindings(data.bindings);
  }, [data]);
}

/** Saves the person's keys: at once here, then on the server, put back when it refuses. */
export function useSaveShortcuts() {
  const qc = useQueryClient();
  const { t } = useTranslation("shortcuts");
  const m = useMutation({
    mutationFn: (bindings: ShortcutBindings) => api.me.putShortcuts({ bindings: bindings as Record<string, string | null> }),
    onMutate: (bindings) => {
      const before = useShortcutKeys.getState().bindings;
      setShortcutBindings(bindings);
      return { before };
    },
    onSuccess: (saved) => qc.setQueryData<ShortcutKeys>(qk.shortcuts, saved),
    onError: (e, _b, ctx) => {
      if (ctx) setShortcutBindings(ctx.before);
      toast.error(e, t("settings.failed"));
    },
  });
  return (next: ShortcutBindings) => m.mutate(cleanBindings(next) ?? {});
}
