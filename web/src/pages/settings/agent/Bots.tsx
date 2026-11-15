// Settings > AI agent > Bots (contracts/bots.md): the identities the AI agent
// answers customers as. One is the default; widgets and addresses pick theirs.
// Drag (or Alt+Arrow) to reorder; open one to build its look and personality.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NoAccess, Section, SettingsPage } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { SortableList } from "@/components/settings2/Sortable";
import { BotFace } from "@/components/bots/BotFace";
import { useUsageLine, usageCount } from "@/components/bots/bits";
import { api } from "@/lib/api/endpoints";
import type { Bot } from "@/lib/api/types";
import { randomLook } from "@/lib/botlook";
import { useShortcuts } from "@/lib/shortcuts";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { AI_TONE, tone } from "@/lib/tones";
import { cn } from "@/lib/cn";

const NAMES = ["Pip", "Nova", "Juno", "Milo", "Iris", "Echo", "Kit", "Remy", "Skye", "Otto", "Wren", "Bea"];

/** A friendly name no bot has yet. */
function freshName(bots: Bot[] | undefined): string {
  const taken = new Set((bots ?? []).map((b) => b.name.toLowerCase()));
  return NAMES.find((n) => !taken.has(n.toLowerCase())) ?? `Bot ${(bots?.length ?? 0) + 1}`;
}

export default function Bots() {
  const { t } = useTranslation("bots");
  const admin = atLeast(useRole(), "admin");
  const { data: bots, isLoading } = useQuery(q.bots());
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const usageLine = useUsageLine();

  const open = (b: Bot) => void navigate({ to: "/settings/ai/bots/$botId", params: { botId: b.id } });

  const create = useMutation({
    mutationFn: () => api.bots.create({ name: freshName(bots), look: randomLook(Date.now() % 2147483647) }),
    onSuccess: (b) => {
      upsertInList(qc, qk.bots, b);
      open(b);
    },
    onError: (e) => toast.error(e, t("list.createError")),
  });
  const duplicate = useMutation({
    mutationFn: (b: Bot) => api.bots.duplicate(b.id),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: qk.bots });
      toast.success(t("list.duplicated", { name: b.name }));
    },
    onError: (e) => toast.error(e),
  });
  const makeDefault = useMutation({
    mutationFn: (b: Bot) => api.bots.makeDefault(b.id),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: qk.bots });
      toast.success(t("list.defaultSet", { name: b.name }));
    },
    onError: (e) => toast.error(e),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.bots.reorder(ids),
    onMutate: (ids) => {
      const prev = qc.getQueryData<Bot[]>(qk.bots);
      if (prev) qc.setQueryData<Bot[]>(qk.bots, ids.map((id) => prev.find((b) => b.id === id)!).filter(Boolean));
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.bots, ctx.prev);
      toast.error(e);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.bots }),
  });

  const remove = (b: Bot) => {
    if (usageCount(b) > 0) {
      toast.error(t("delete.inUse", { name: b.name, where: usageLine(b) }));
      return;
    }
    confirm.show(
      t("delete.body", { name: b.name }),
      async () => {
        await api.bots.remove(b.id);
        removeFromList(qc, qk.bots, b.id);
        toast.success(t("delete.done", { name: b.name }));
      },
      { title: t("delete.title", { name: b.name }), confirmLabel: t("delete.confirm"), danger: true },
    );
  };

  useShortcuts({ "bots.new": () => admin && !create.isPending && create.mutate() }, admin);

  if (!admin)
    return (
      <SettingsPage title={t("list.title")}>
        <NoAccess what={t("list.what")} />
      </SettingsPage>
    );

  return (
    <SettingsPage
      title={t("list.title")}
      description={t("list.description")}
      actions={
        <Button variant="primary" icon={<Plus className="size-3.5" />} loading={create.isPending} onClick={() => create.mutate()} title={t("list.newHint")}>
          {t("list.new")}
        </Button>
      }
    >
      <Section title={t("list.section")} description={t("list.sectionHint")} flush>
        {isLoading || !bots ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-11 rounded-md" />
            <Skeleton className="h-11 rounded-md" />
          </div>
        ) : (
          <SortableList
            items={bots}
            onReorder={(ids) => reorder.mutate(ids)}
            handleLabel={(b) => t("list.reorder", { name: b.name })}
            renderRow={(b, handle) => (
              <div className="group flex min-h-[60px] items-center gap-3 border-b border-line-soft bg-surface px-3 py-2.5 last:border-0">
                {handle}
                <Link
                  to="/settings/ai/bots/$botId"
                  params={{ botId: b.id }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:shadow-[0_0_0_3px_var(--focus)]"
                >
                  <BotFace look={b.look} image={b.image_url} size={36} className="transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transition-none" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">{b.name}</span>
                      {b.is_default && <span className={cn("shrink-0 rounded-sm px-1.5 py-px text-[10.5px] font-medium", tone[AI_TONE].chip)}>{t("list.default")}</span>}
                      {b.role && <span className="truncate text-[12px] text-fg-3">{b.role}</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-fg-3">{usageLine(b)}</div>
                  </div>
                </Link>
                <span className="hidden shrink-0 text-[11.5px] text-fg-4 sm:block">{t(`tone.${b.personality.tone}`)}</span>
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="xs" variant="ghost" square aria-label={t("list.actions", { name: b.name })}>
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    {!b.is_default && (
                      <MenuItem icon={<Star />} onSelect={() => makeDefault.mutate(b)}>
                        {t("list.makeDefault")}
                      </MenuItem>
                    )}
                    <MenuItem icon={<Copy />} onSelect={() => duplicate.mutate(b)}>
                      {t("list.duplicate")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} danger disabled={b.is_default} onSelect={() => remove(b)}>
                      {t("list.delete")}
                    </MenuItem>
                    {b.is_default && <MenuLabel>{t("delete.isDefault")}</MenuLabel>}
                  </MenuContent>
                </Menu>
              </div>
            )}
          />
        )}
      </Section>
      <p className="-mt-6 px-1 text-[12px] leading-[18px] text-fg-3">{t("list.footnote")}</p>
    </SettingsPage>
  );
}
