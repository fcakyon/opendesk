// A page's comments on the query cache: every write answers with its whole thread, which
// replaces the cached one; wiki_comment.changed (lib/wiki/events.ts) brings everyone
// else's. Following is optimistic: the toggle moves at once and goes back if refused.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { WikiComments, WikiThread } from "@/lib/api/types";
import { mentionIds } from "@/lib/collab/html";
import { q, qk } from "@/lib/queries";
import { withoutComment, withThread } from "@/lib/wiki/comments";

export function useComments(pageId: string) {
  return useQuery(q.wikiComments(pageId));
}

export function useCommentActions(pageId: string) {
  const qc = useQueryClient();
  const put = (t: WikiThread) => {
    qc.setQueryData<WikiComments>(qk.wikiComments(pageId), (cur) => withThread(cur, t));
    return t;
  };
  return {
    create: async (b: { body_html: string; thread_id?: string; quote?: string; inline?: boolean }) =>
      put(await api.wiki.comments.create(pageId, { ...b, mentions: mentionIds(b.body_html) })),
    update: async (id: string, body_html: string) => put(await api.wiki.comments.update(id, { body_html, mentions: mentionIds(body_html) })),
    remove: async (id: string) => {
      await api.wiki.comments.remove(id);
      qc.setQueryData<WikiComments>(qk.wikiComments(pageId), (cur) => withoutComment(cur, id));
    },
    resolve: async (threadId: string, resolved: boolean) => put(await api.wiki.comments.resolve(threadId, resolved)),
    react: async (id: string, emoji: string, on: boolean) => put(await api.wiki.comments.react(id, emoji, on)),
  };
}

/** Whether the person follows the page, and the toggle. */
export function useFollow(pageId: string) {
  const { t } = useTranslation("wiki");
  const qc = useQueryClient();
  const { data } = useComments(pageId);
  const key = qk.wikiComments(pageId);
  const set = useMutation({
    mutationFn: (following: boolean) => api.wiki.follow(pageId, following),
    onMutate: async (following) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<WikiComments>(key);
      qc.setQueryData<WikiComments>(key, (cur) => (cur ? { ...cur, following } : cur));
      return { before };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      toast.error(e, t("follow.failed"));
    },
    onSuccess: (r) => qc.setQueryData<WikiComments>(key, (cur) => (cur ? { ...cur, following: r.following } : cur)),
  });
  return { following: !!data?.following, ready: !!data, toggle: () => set.mutate(!data?.following) };
}
