// Saving a canvas and taking other people's (contracts/wiki.md "Canvas"). The canvas is
// replaced whole: changes are saved a moment after they stop, the PATCH carries no version,
// and the last save wins. A canvas arriving from someone else (wiki_page.updated puts it on
// the cached page) is taken when this tab has nothing unsaved and nobody is mid-gesture; if
// this tab has unsaved changes, its next save writes over it.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Canvas, WikiPage } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { canonical, fromApi, toApi, type HistoryAction } from "./model";

const SAVE_AFTER = 700;
const RETRY_AFTER = 5000;

export function useCanvasSync(page: WikiPage, canEdit: boolean, doc: Canvas, dispatch: Dispatch<HistoryAction>) {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  const id = page.id;
  const initial = useRef<string | null>(null);
  if (initial.current === null) initial.current = canonical(fromApi(page.canvas));
  /** The canvas this tab last sent, or last took from the server. */
  const sent = useRef(initial.current);
  /** The server's canvas as this tab last heard it. */
  const server = useRef(initial.current);
  const docRef = useRef(doc);
  docRef.current = doc;
  const busy = useRef(false);
  const pendingRemote = useRef<Canvas | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dirty = useCallback(() => canonical(docRef.current) !== sent.current, []);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!canEdit || stopped.current) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    const body = toApi(docRef.current);
    const key = canonical(body);
    if (key === sent.current) return;
    inflight.current = true;
    sent.current = key;
    try {
      const saved = await api.wiki.update(id, { canvas: body });
      server.current = canonical(fromApi(saved.canvas));
      qc.setQueryData<WikiPage>(qk.wikiPage(id), (old) => (old ? { ...old, canvas: saved.canvas, updated_at: saved.updated_at, updated_by: saved.updated_by } : old));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 403 || status === 404) {
        // The page is gone or no longer this person's to edit: saving stops for good.
        stopped.current = true;
        toast.error(e, t("canvas.saveStopped"));
      } else if (status === 422 || status === 413) {
        // Refused as it is: the next change tries again.
        toast.error(e, t("canvas.saveFailed"));
      } else {
        sent.current = server.current;
        toast.error(e, t("canvas.saveFailed"));
        timer.current = setTimeout(() => void save(), RETRY_AFTER);
      }
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [canEdit, id, qc, t]);

  // Save a moment after the canvas stops changing.
  useEffect(() => {
    if (!canEdit || stopped.current || !dirty()) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER);
  }, [doc, canEdit, dirty, save]);

  /** Takes someone else's canvas, now or once this tab is idle. */
  const takeRemote = useCallback(() => {
    const incoming = pendingRemote.current;
    if (!incoming || busy.current || dirty()) return;
    pendingRemote.current = null;
    const key = canonical(incoming);
    sent.current = key;
    server.current = key;
    if (key !== canonical(docRef.current)) dispatch({ type: "reset", doc: incoming });
  }, [dirty, dispatch]);

  useEffect(() => {
    const incoming = fromApi(page.canvas);
    const key = canonical(incoming);
    // This tab's own save coming back (its answer, or its event).
    if (key === server.current || key === sent.current) {
      server.current = key;
      return;
    }
    server.current = key;
    pendingRemote.current = incoming;
    takeRemote();
  }, [page.canvas, takeRemote]);

  /** Marks a gesture or an edit under way (true) or over (false): someone else's canvas waits for it. */
  const setBusy = useCallback(
    (on: boolean) => {
      busy.current = on;
      if (!on) takeRemote();
    },
    [takeRemote],
  );

  // Whatever is unsaved goes when the canvas closes or the tab does.
  useEffect(() => {
    const flush = () => {
      if (!canEdit || stopped.current || !dirty()) return;
      const body = toApi(docRef.current);
      sent.current = canonical(body);
      void api.wiki.update(id, { canvas: body }, { keepalive: true }).catch(() => {});
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!canEdit || stopped.current || !dirty()) return;
      flush();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      clearTimeout(timer.current);
      flush();
    };
  }, [canEdit, dirty, id]);

  return { setBusy, saveNow: save };
}
