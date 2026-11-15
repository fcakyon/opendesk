// Settings > AI agent > Bots > one bot (contracts/bots.md): build its look,
// shape its personality and test it, with a live face beside every step.
// Edits stay a draft until saved; the Test tab answers with the draft, in the
// real widget and in a playground chat. R shuffles the look, Z undoes it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Copy, Dices, MessageCircle, MoreHorizontal, Palette, RotateCcw, Sparkles, Star, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackLink, NoAccess, SettingsPage } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty";
import { TextInput } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { SaveBar } from "@/components/settings/SaveBar";
import { UnsavedGuard } from "@/components/settings2/UnsavedGuard";
import { BotFace, type BotState } from "@/components/bots/BotFace";
import { LookEditor } from "@/components/bots/LookEditor";
import { LIMITS, PersonalityEditor, textProblem } from "@/components/bots/PersonalityEditor";
import { useUsageLine, usageCount } from "@/components/bots/bits";
import { LivePreview } from "@/components/widget/LivePreview";
import { toWidgetConfig, widgetBotOf } from "@/components/widget/fields";
import { Chat, chatBot, usePlaygroundChat } from "@/pages/settings/agent/AgentPlayground";
import { api } from "@/lib/api/endpoints";
import type { Bot, BotPersonality, PlaygroundSettings } from "@/lib/api/types";
import { OLLIE_LOOK, randomLook, type BotLook } from "@/lib/botlook";
import { useShortcuts } from "@/lib/shortcuts";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole, useWorkspace } from "@/lib/session";
import { AI_TONE, tone } from "@/lib/tones";
import { cn } from "@/lib/cn";
import { sameJSON } from "@/lib/sameJSON";

export type BotTab = "look" | "personality" | "test";
type Draft = {
  name: string;
  role: string;
  language: string;
  look: BotLook;
  personality: BotPersonality;
};
const toDraft = (b: Bot): Draft => ({
  name: b.name,
  role: b.role,
  language: b.language,
  look: b.look,
  personality: b.personality,
});
const same = (a: unknown, b: unknown) => sameJSON(a, b);

export default function BotDetail() {
  const { t } = useTranslation("bots");
  const admin = atLeast(useRole(), "admin");
  const { botId } = useParams({ from: "/app/settings/ai/bots/$botId" });
  const { data: bots, isLoading } = useQuery(q.bots());
  const bot = bots?.find((b) => b.id === botId);
  const back = <BackLink to="/settings/ai/bots">{t("detail.back")}</BackLink>;

  if (!admin)
    return (
      <SettingsPage title={t("list.title")} back={back}>
        <NoAccess what={t("list.what")} />
      </SettingsPage>
    );
  if (isLoading)
    return (
      <SettingsPage title={<Skeleton className="h-6 w-40" />} back={back} wide>
        <Skeleton className="h-[420px] rounded-lg" />
      </SettingsPage>
    );
  if (!bot)
    return (
      <SettingsPage title={t("detail.missingTitle")} back={back}>
        <EmptyState
          art="generic"
          title={t("detail.missingTitle")}
          description={t("detail.missingBody")}
          action={
            <Button asChild>
              <Link to="/settings/ai/bots">{t("detail.back")}</Link>
            </Button>
          }
        />
      </SettingsPage>
    );
  return <Builder bot={bot} back={back} />;
}

function Builder({ bot, back }: { bot: Bot; back: React.ReactNode }) {
  const { t } = useTranslation("bots");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const usageLine = useUsageLine();
  const { tab = "look" } = useSearch({ from: "/app/settings/ai/bots/$botId" });
  const setTab = (v: string) =>
    void navigate({
      to: "/settings/ai/bots/$botId",
      params: { botId: bot.id },
      search: {
        tab: v === "look" ? undefined : (v as Exclude<BotTab, "look">),
      },
      replace: true,
    });

  const base = useMemo(() => toDraft(bot), [bot]);
  const [draft, setDraft] = useState<Draft>(base);
  const [prevBase, setPrevBase] = useState(base);
  // Follow the server (realtime, another tab) until the first edit.
  if (prevBase !== base) {
    setPrevBase(base);
    if (same(draft, prevBase)) setDraft(base);
  }
  const [history, setHistory] = useState<BotLook[]>([]);
  const [face, setFace] = useState<BotState>("idle");
  const [hop, setHop] = useState(0);
  const [hopping, setHopping] = useState(false);
  const dirty = !same(draft, base);

  const setLook = (look: BotLook, remember = true) => {
    if (remember) setHistory((h) => [...h.slice(-19), draft.look]);
    setDraft((d) => ({ ...d, look }));
    setHop((n) => n + 1);
  };
  const shuffle = () =>
    setLook({
      ...randomLook(Math.floor(Math.random() * 2147483646) + 1),
      background: draft.look.background,
    });
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setLook(prev, false);
  };
  useShortcuts({
    "bots.shuffle": () => tab === "look" && shuffle(),
    "bots.undo": () => tab === "look" && undo(),
  });

  // A happy hop after each look change, unless you are previewing a state.
  useEffect(() => {
    if (!hop) return;
    setHopping(true);
    const id = setTimeout(() => setHopping(false), 700);
    return () => clearTimeout(id);
  }, [hop]);
  const shownFace: BotState = face === "idle" && hopping ? "happy" : face;

  const nameErr = !draft.name.trim() ? t("detail.nameRequired") : textProblem(draft.name, LIMITS.name) ? t("detail.nameInvalid", { max: LIMITS.name }) : null;
  const roleErr = textProblem(draft.role, LIMITS.role) ? t("detail.roleInvalid", { max: LIMITS.role }) : null;
  const p = draft.personality;
  const personalityBad =
    (p.tone === "custom" && !p.custom_tone.trim()) ||
    !!textProblem(p.custom_tone, LIMITS.custom_tone) ||
    !!textProblem(p.greeting, LIMITS.greeting, true) ||
    !!textProblem(p.handoff_message, LIMITS.handoff_message, true) ||
    !!textProblem(p.sign_off, LIMITS.sign_off, true) ||
    p.instructions.length > LIMITS.instructions;
  const needsPicture = draft.look.kind === "image" && !bot.image_url;
  const invalid = !!nameErr || !!roleErr || personalityBad || needsPicture;

  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof api.bots.update>[1] = {};
      if (draft.name !== base.name) body.name = draft.name.trim();
      if (draft.role !== base.role) body.role = draft.role.trim();
      if (draft.language !== base.language) body.language = draft.language;
      if (!same(draft.look, base.look)) body.look = draft.look;
      const changed: Partial<BotPersonality> = {};
      for (const k of Object.keys(p) as (keyof BotPersonality)[]) if (!same(p[k], base.personality[k])) (changed as Record<string, unknown>)[k] = p[k];
      if (Object.keys(changed).length) body.personality = changed;
      return api.bots.update(bot.id, body);
    },
    onSuccess: (b) => {
      upsertInList(qc, qk.bots, b);
      setDraft(toDraft(b));
      setHistory([]);
      toast.success(t("detail.saved", { name: b.name }));
    },
    onError: (e) => toast.error(e, t("detail.saveError")),
  });

  const upload = async (file: Blob) => {
    const b = await api.bots.uploadImage(bot.id, file);
    upsertInList(qc, qk.bots, b);
    setDraft((d) => ({ ...d, look: { ...d.look, kind: "image" } }));
  };
  const removeImage = async () => {
    try {
      const b = await api.bots.removeImage(bot.id);
      upsertInList(qc, qk.bots, b);
      setDraft((d) => ({ ...d, look: { ...d.look, kind: "built" } }));
    } catch (e) {
      toast.error(e);
    }
  };

  const duplicate = useMutation({
    mutationFn: () => api.bots.duplicate(bot.id),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: qk.bots });
      toast.success(t("list.duplicated", { name: b.name }));
      void navigate({
        to: "/settings/ai/bots/$botId",
        params: { botId: b.id },
      });
    },
    onError: (e) => toast.error(e),
  });
  const makeDefault = useMutation({
    mutationFn: () => api.bots.makeDefault(bot.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.bots });
      toast.success(t("list.defaultSet", { name: bot.name }));
    },
    onError: (e) => toast.error(e),
  });
  const remove = () => {
    if (usageCount(bot) > 0) {
      toast.error(t("delete.inUse", { name: bot.name, where: usageLine(bot) }));
      return;
    }
    confirm.show(
      t("delete.body", { name: bot.name }),
      async () => {
        await api.bots.remove(bot.id);
        removeFromList(qc, qk.bots, bot.id);
        toast.success(t("delete.done", { name: bot.name }));
        void navigate({ to: "/settings/ai/bots" });
      },
      {
        title: t("delete.title", { name: bot.name }),
        confirmLabel: t("delete.confirm"),
        danger: true,
      },
    );
  };

  const shownName = draft.name.trim() || bot.name;
  const here = `/settings/ai/bots/${bot.id}`;

  return (
    <SettingsPage
      wide
      back={back}
      title={
        <span className="flex items-center gap-2.5">
          <BotFace look={draft.look} image={bot.image_url} size={26} blink />
          <span className="truncate">{shownName}</span>
          {bot.is_default && <span className={cn("rounded-sm px-1.5 py-px text-[10.5px] font-medium", tone[AI_TONE].chip)}>{t("list.default")}</span>}
        </span>
      }
      description={usageLine(bot)}
      actions={
        <>
          {!bot.is_default && (
            <Button icon={<Star className="size-3.5 text-fg-3" />} loading={makeDefault.isPending} onClick={() => makeDefault.mutate()}>
              {t("list.makeDefault")}
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button square aria-label={t("list.actions", { name: bot.name })}>
                <MoreHorizontal className="size-3.5" />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Copy />} onSelect={() => duplicate.mutate()}>
                {t("list.duplicate")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} danger disabled={bot.is_default} onSelect={remove}>
                {t("list.delete")}
              </MenuItem>
              {bot.is_default && <MenuLabel>{t("delete.isDefault")}</MenuLabel>}
            </MenuContent>
          </Menu>
        </>
      }
    >
      <UnsavedGuard when={dirty && !save.isPending} allow={(path) => path === here} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mt-3 mb-6">
          <TabsTrigger value="look" icon={<Palette />}>
            {t("detail.tabLook")}
          </TabsTrigger>
          <TabsTrigger value="personality" icon={<Sparkles />}>
            {t("detail.tabPersonality")}
          </TabsTrigger>
          <TabsTrigger value="test" icon={<MessageCircle />}>
            {t("detail.tabTest")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="look" className="outline-none">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-xs">
              <LookEditor look={draft.look} onChange={(l) => setLook(l)} name={shownName} image={bot.image_url} onUpload={upload} onRemoveImage={removeImage} />
            </div>
            <PreviewCard
              draft={draft}
              setDraft={setDraft}
              image={bot.image_url}
              face={face}
              shown={shownFace}
              setFace={setFace}
              nameErr={nameErr}
              roleErr={roleErr}
              onShuffle={draft.look.kind === "image" ? undefined : shuffle}
              onOllie={draft.look.kind === "image" ? undefined : () => setLook({ ...OLLIE_LOOK })}
              onUndo={history.length ? undo : undefined}
            />
          </div>
        </TabsContent>

        <TabsContent value="personality" className="outline-none">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-xs">
              <PersonalityEditor
                value={draft.personality}
                onChange={(personality) => setDraft((d) => ({ ...d, personality }))}
                language={draft.language}
                onLanguage={(language) => setDraft((d) => ({ ...d, language }))}
              />
            </div>
            <PreviewCard draft={draft} setDraft={setDraft} image={bot.image_url} face={face} shown={shownFace} setFace={setFace} nameErr={nameErr} roleErr={roleErr} />
          </div>
        </TabsContent>

        <TabsContent value="test" className="outline-none">
          <TestPane bot={bot} draft={draft} dirty={dirty} />
        </TabsContent>
      </Tabs>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        disabled={invalid}
        message={needsPicture ? t("detail.needsPicture") : undefined}
        onSave={() => save.mutate()}
        onDiscard={() => {
          setDraft(base);
          setHistory([]);
        }}
      />
    </SettingsPage>
  );
}

/** The face, big, with its name and role, a sample message and the look shortcuts. */
function PreviewCard({
  draft,
  setDraft,
  image,
  face,
  shown,
  setFace,
  nameErr,
  roleErr,
  onShuffle,
  onOllie,
  onUndo,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  image: string | null;
  face: BotState;
  /** What the face shows: the picked state, or a happy hop after a change. */
  shown: BotState;
  setFace: (s: BotState) => void;
  nameErr: string | null;
  roleErr: string | null;
  onShuffle?: () => void;
  onOllie?: () => void;
  onUndo?: () => void;
}) {
  const { t } = useTranslation("bots");
  const p = draft.personality;
  const greeting = p.greeting.trim();
  const sample = greeting || (p.tone === "custom" ? t("tone.custom_sample") : t(`tone.${p.tone}_sample`));
  // A written greeting is shown as written; the tone's sample gets the emoji the bot would use.
  const emoji = greeting ? "" : p.emoji === "lots" ? " ✨🙌" : p.emoji === "some" ? " 🙂" : "";
  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
        <div className="relative flex flex-col items-center gap-3 bg-sunken/40 px-5 pb-4 pt-7">
          <BotFace look={draft.look} image={image} size={112} state={shown} blink label={draft.name} />
          <Segmented<BotState>
            size="xs"
            value={face}
            onChange={setFace}
            options={[
              { value: "idle", label: t("detail.stateIdle") },
              { value: "thinking", label: t("detail.stateThinking") },
              { value: "happy", label: t("detail.stateHappy") },
            ]}
          />
          {(onShuffle || onOllie || onUndo) && (
            <div className="flex items-center gap-1">
              {onShuffle && (
                <Tooltip content={t("detail.shuffleHint")} shortcut="R">
                  <Button size="sm" icon={<Dices className="size-3.5 text-fg-3" />} onClick={onShuffle}>
                    {t("detail.shuffle")}
                  </Button>
                </Tooltip>
              )}
              {onUndo && (
                <Tooltip content={t("detail.undo")} shortcut="Z">
                  <Button size="sm" square variant="ghost" aria-label={t("detail.undo")} onClick={onUndo}>
                    <Undo2 className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
              {onOllie && (
                <Tooltip content={t("detail.ollieHint")}>
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5 text-fg-3" />} onClick={onOllie}>
                    {t("detail.ollie")}
                  </Button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 border-t border-line-soft px-4 py-3.5">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-2">{t("detail.name")}</span>
            <TextInput
              value={draft.name}
              maxLength={LIMITS.name + 10}
              invalid={!!nameErr}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            {nameErr && <span className="text-xs text-danger-fg">{nameErr}</span>}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-2">{t("detail.role")}</span>
            <TextInput
              value={draft.role}
              maxLength={LIMITS.role + 10}
              invalid={!!roleErr}
              placeholder={t("detail.rolePlaceholder")}
              onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
            />
            {roleErr && <span className="text-xs text-danger-fg">{roleErr}</span>}
          </label>
        </div>
        <div className="border-t border-line-soft bg-sunken/60 px-4 py-3.5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">{t("detail.sample")}</div>
          <div className="flex items-start gap-2">
            <BotFace look={draft.look} image={image} size={24} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-fg">{draft.name.trim() || "…"}</span>
                <span className={cn("rounded-sm px-1 py-px text-[10px] font-medium", tone[AI_TONE].chip)}>{t("detail.aiTag")}</span>
              </div>
              {draft.role.trim() && <div className="truncate text-[11px] text-fg-3">{draft.role.trim()}</div>}
              <p className={cn("mt-1.5 whitespace-pre-wrap rounded-xl rounded-tl-sm px-3 py-2 text-[12.5px] leading-[18px] text-fg", tone[AI_TONE].soft)}>
                {sample}
                {emoji}
              </p>
            </div>
          </div>
        </div>
      </div>
      <p className="px-1 text-[11.5px] leading-[17px] text-fg-3">
        {t("detail.keys")} <Kbd>R</Kbd> <Kbd>Z</Kbd>
      </p>
    </aside>
  );
}

/** The draft in the real widget, beside a playground chat that answers as it. */
function TestPane({ bot, draft, dirty }: { bot: Bot; draft: Draft; dirty: boolean }) {
  const { t } = useTranslation("bots");
  const ws = useWorkspace();
  const { data: widget } = useQuery(q.widgetSettings());
  const { data: members } = useQuery(q.members());
  const [dark, setDark] = useState(false);
  const shown: Bot = {
    ...bot,
    name: draft.name.trim() || bot.name,
    role: draft.role.trim(),
    look: draft.look,
    personality: draft.personality,
  };
  const wbot = widgetBotOf(shown);
  const botKey = JSON.stringify(wbot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => (widget ? toWidgetConfig(widget, ws, members, true, wbot) : null), [widget, ws, members, botKey]);
  const settings: PlaygroundSettings = {
    bot_id: bot.id,
    bot: dirty
      ? {
          name: shown.name,
          role: shown.role,
          language: draft.language,
          personality: draft.personality,
        }
      : undefined,
  };
  const chat = usePlaygroundChat(settings, {
    name: "",
    email: "",
    verified: false,
  });
  const suggestions = widget?.suggestions?.length ? widget.suggestions.slice(0, 3) : [t("test.try1"), t("test.try2"), t("test.try3")];
  return (
    <div className="flex flex-col gap-4">
      {dirty && <p className={cn("rounded-md px-3 py-2 text-[12px] text-fg-2", tone[AI_TONE].soft)}>{t("test.draftNote")}</p>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[12.5px] font-medium text-fg">{t("test.widget")}</div>
            <Segmented
              size="xs"
              value={dark ? "dark" : "light"}
              onChange={(v) => setDark(v === "dark")}
              options={[
                { value: "light", label: t("test.light") },
                { value: "dark", label: t("test.dark") },
              ]}
            />
          </div>
          {config ? (
            <LivePreview config={config} scene="chat" dark={dark} className="h-[min(640px,calc(100vh-240px))] min-h-[460px]" />
          ) : (
            <Skeleton className="h-[520px] rounded-xl" />
          )}
          <p className="text-[11.5px] leading-[17px] text-fg-3">{t("test.widgetHint")}</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-fg">{t("test.chat")}</div>
          <Chat chat={chat} bot={chatBot(shown)} suggestions={suggestions} className={cn("h-[min(640px,calc(100vh-240px))]")} />
          <p className="text-[11.5px] leading-[17px] text-fg-3">{t("test.chatHint")}</p>
        </div>
      </div>
    </div>
  );
}
