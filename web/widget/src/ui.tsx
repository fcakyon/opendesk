/** @jsxImportSource preact */
// The widget's screens: launcher, home and a conversation thread.

import { Fragment, type ComponentChildren, type VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { aiHandling, isAiAnswer, latestAiAnswer, teamReplied } from "./ai";
import { canAttach, fileProblem, readBot } from "./config";
import { homeConversations, isFinished, sortConversations } from "./conversations";
import { NEW, type Controller } from "./controller";
import { canRecord, clock, useRecorder, VoicePlayer, type Recording } from "./voice";
import { current, dayLabel, isRtl, relTime, t } from "./i18n";
import { Arrow, Back, ChatIc, Clip, Clock, Down, Ext, FileIc, Mic, OdMark, StopIc, Trash, Up, X } from "./icons";
import { repliesFor, type LiveReply } from "./live";
import { AiMessage, AvatarStack, BotGreeting, Bubble, Dots, HandedOff, LiveReplyView, reducedMotion, type Offer } from "./messages";
import { primeSound } from "./sound";
import { useStore, type State } from "./store";
import type { BotIdentity, UiMessage, WidgetConfig, WidgetTopic } from "./types";

const THINK_MS = 15_000;
/** How long the bot's hop lasts when a reply lands (BOT_LOOK_CSS odb-hop). */
const HOP_MS = 700;

const typingReply = (ticket: string): LiveReply => ({
  id: "typing",
  ticket_id: ticket,
  bot: null,
  text: "",
  tools: [],
  phase: "typing",
  partial: false,
  message_id: null,
  handoff: false,
  action_id: null,
  at: 0,
});

const DEFAULT_BOT = readBot(null);
const botOf = (cfg: WidgetConfig | null): BotIdentity => cfg?.bot ?? DEFAULT_BOT;
const titleOf = (cfg: WidgetConfig | null) => cfg?.title || cfg?.brand?.name || cfg?.workspace_name || t("support");
const subtitleOf = (cfg: WidgetConfig | null) => cfg?.subtitle || (cfg?.ai_answers ? t("replyTimeAi", { name: botOf(cfg).name }) : t("replyTime"));

/** The theme attribute: forced light or dark, or "auto" (follows the system, or the preview's choice). */
function themeOf(s: State): "light" | "dark" | "auto" {
  const th = s.config?.theme ?? "auto";
  if (th !== "auto") return th;
  return s.dark === null ? "auto" : s.dark ? "dark" : "light";
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function App({ c }: { c: Controller }) {
  const s = useStore(c.store);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [live, setLive] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Why the last picked, dropped or pasted file was left out.
  const [fileNote, setFileNote] = useState("");
  const [drag, setDrag] = useState(false);
  // The panel stays mounted for its exit, so closing eases out instead of vanishing.
  const [shown, setShown] = useState(s.open);
  const [leaving, setLeaving] = useState(false);
  const cfg = s.config;

  useEffect(() => {
    c.announce = (text) => {
      // Re-announce identical text: clear first, then set on the next frame.
      setLive("");
      requestAnimationFrame(() => setLive(text));
    };
  }, [c]);

  useEffect(() => {
    if (s.open) {
      setShown(true);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    if (reducedMotion()) {
      setShown(false);
      return;
    }
    setLeaving(true);
    const id = setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, 160);
    return () => clearTimeout(id);
  }, [s.open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus moves into the panel when it opens and back to the launcher when it closes
  // (not in the dashboard preview, which must never take the page's focus).
  const wasOpen = useRef(s.open);
  useEffect(() => {
    if (!s.preview) {
      if (s.open && !wasOpen.current) {
        requestAnimationFrame(() => {
          const p = panel.current;
          const el = p?.querySelector<HTMLElement>("textarea:not(:disabled)") ?? p?.querySelector<HTMLElement>(".primary:not(:disabled), .topic:not(:disabled)") ?? p?.querySelector<HTMLElement>("button");
          el?.focus({ preventScroll: true });
        });
      } else if (!s.open && wasOpen.current) launcher.current?.focus();
    }
    wasOpen.current = s.open;
  }, [s.open, s.preview]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      c.close();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not([hidden]), a[href]")).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const root = panel.current.getRootNode() as ShadowRoot;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && root.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && root.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const addFiles = (list: FileList | File[] | null) => {
    if (!list || !canAttach(cfg)) return;
    const all = Array.from(list);
    if (!all.length) return;
    const exts = cfg?.attachment_extensions;
    const bad = all.find((f) => fileProblem(f, exts));
    setFileNote(bad ? t(fileProblem(bad, exts) === "size" ? "fileTooLarge" : "fileTypeRefused", { name: bad.name }) : "");
    if (s.view !== "thread") c.newConversation();
    const arr = all.filter((f) => !fileProblem(f, exts)).slice(0, 5);
    if (arr.length) setFiles((f) => [...f, ...arr].slice(0, 5));
  };

  const label = cfg?.launcher === "label";
  const rootClass = [
    "root",
    cfg?.position === "left" ? "pos-left" : "pos-right",
    `radius-${cfg?.radius ?? "soft"}`,
    s.preview ? "preview" : "",
    cfg ? "" : "pending",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={rootClass} data-theme={themeOf(s)} dir={isRtl(s.lang) ? "rtl" : "ltr"} lang={current()} onPointerDown={() => cfg?.sound && primeSound()}>
      <div class="sr" aria-live="polite">
        {live}
      </div>
      {(s.open || shown) && (
        <div
          ref={panel}
          class={`panel${!s.open && leaving ? " leaving" : ""}`}
          role="dialog"
          aria-hidden={!s.open || undefined}
          aria-label={t("chatWith", { name: titleOf(cfg) })}
          onKeyDown={onKey}
          onDragOver={(e) => {
            if (canAttach(cfg) && e.dataTransfer?.types.includes("Files")) {
              e.preventDefault();
              setDrag(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.target === panel.current) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer?.files ?? null);
          }}
        >
          {s.view === "home" ? <Home c={c} /> : <Thread c={c} files={files} setFiles={setFiles} addFiles={addFiles} fileNote={fileNote} setFileNote={setFileNote} />}
          {drag && <div class="drop">{t("dropFiles")}</div>}
        </div>
      )}
      {cfg && !s.open && s.teaser && <Teaser c={c} s={s} />}
      {cfg && (
        <button
          ref={launcher}
          class={`launcher${label ? " pill" : ""}${s.open ? " hide-mobile" : ""}`}
          aria-label={s.open ? t("closeChat") : s.unread ? t("openChatUnread", { count: s.unread }) : t("openChat")}
          aria-expanded={s.open}
          onClick={() => c.toggle()}
        >
          <span class="l-ic">
            <span class="ic ic-open">{cfg.launcher_icon_url ? <img src={cfg.launcher_icon_url} alt="" referrerpolicy="no-referrer" /> : ChatIc(label ? 20 : 24)}</span>
            <span class="ic ic-x">{X(label ? 18 : 22)}</span>
          </span>
          {label && (
            <span class="l-label" aria-hidden="true">
              <span>{cfg.launcher_label || t("chatWithUs")}</span>
            </span>
          )}
          {!s.open && s.unread > 0 && (
            <span class="badge" key={s.unread}>
              {s.unread > 9 ? "9+" : s.unread}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

// ── Teaser: the team's latest unread reply, above the closed launcher ─────────

function Teaser({ c, s }: { c: Controller; s: State }) {
  const m = s.teaser!;
  const who = c.senderName(m);
  const text = (m.body_text || m.body_html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return (
    <div class="teaser" key={m.id}>
      <button class="teaser-main" onClick={() => c.openTeaser()} aria-label={t("newMessage", { name: who, text: text.slice(0, 200) })}>
        <span class="teaser-who">{who}</span>
        <span class="teaser-text">{text || t("conversation")}</span>
      </button>
      <button
        class="teaser-x"
        aria-label={t("dismiss")}
        onClick={() => c.dismissTeaser()}
        onKeyDown={(e) => {
          if (e.key === "Escape") c.dismissTeaser();
        }}
      >
        {X(14)}
      </button>
    </div>
  );
}

// ── Home: greeting, suggestions and conversations ────────────────────────────

/** A workspace's own greeting, or the stock one in the visitor's language. */
function greeting(g: string | null | undefined) {
  const v = g?.trim();
  return !v || STOCK_GREETINGS.has(v.toLowerCase()) ? t("greeting") : v;
}
const STOCK_GREETINGS = new Set(["hi there. how can we help?", "hi there! how can we help?"]);

function Logo({ cfg }: { cfg: WidgetConfig | null }) {
  const name = titleOf(cfg);
  return (
    <span class="ws-glyph" aria-hidden="true">
      {cfg?.avatar_url ? <img src={cfg.avatar_url} alt="" referrerpolicy="no-referrer" /> : name.charAt(0).toUpperCase()}
    </span>
  );
}

function Home({ c }: { c: Controller }) {
  const s = useStore(c.store);
  const cfg = s.config;
  const convs = s.conversations;
  // The home screen lists the conversations that matter now; "See older conversations" swaps in all of them.
  const [allConvs, setAllConvs] = useState(false);
  const home = homeConversations(convs ?? []);
  const team = cfg?.team ?? [];
  const bot = cfg?.ai_answers ? botOf(cfg) : null;
  const ready = !!s.session;
  const suggestions = cfg?.suggestions ?? [];
  const topics = cfg?.topics ?? [];
  return (
    <>
      <div class="head home">
        <div class="head-row">
          <div class="ws">
            <Logo cfg={cfg} />
            <span class="ws-name">{titleOf(cfg)}</span>
          </div>
          <button class="icon-btn" aria-label={t("closeChat")} onClick={() => c.close()}>
            {X()}
          </button>
        </div>
        <div class="greet" dir="auto">
          {greeting(cfg?.greeting)}
        </div>
        <div class="sub-row">
          <AvatarStack team={team} bot={bot} size={22} />
          <span class="sub">{subtitleOf(cfg)}</span>
        </div>
      </div>
      <div class="body">
        <div class="home-body">
          {cfg?.open === false && !(s.error && !s.session) && <Away cfg={cfg} />}
          {s.error && !s.session ? (
            <div class="empty">
              <b>{t("unavailable")}</b>
              {t("unavailableHint")}
            </div>
          ) : topics.length > 0 ? (
            <div class="card">
              <div class="card-h" id="od-topics-h">
                {t("topicsTitle")}
              </div>
              <Topics topics={topics} labelledBy="od-topics-h" disabled={!ready} onPick={(id) => c.newConversation(id)} />
            </div>
          ) : (
            <button class="primary start" disabled={!ready} onClick={() => c.newConversation()}>
              <span>{t("sendMessage")}</span>
              <span class="start-ic flip">
                <Arrow />
              </span>
            </button>
          )}
          {suggestions.length > 0 && (
            <div class="suggest" role="group" aria-label={t("suggested")}>
              {suggestions.map((q, i) => (
                <button key={q} class="sugg" style={{ "--i": i }} disabled={!ready} onClick={() => void c.startWith(q)} dir="auto">
                  {q}
                </button>
              ))}
            </div>
          )}
          {convs === null ? (
            s.booting && (
              <div class="card" aria-busy="true">
                <div class="skel" style={{ width: "40%" }} />
                <div class="skel" style={{ width: "75%" }} />
              </div>
            )
          ) : convs.length > 0 ? (
            <div class="card">
              <div class="card-h">{t(allConvs ? "allConversations" : "yourConversations")}</div>
              {(allConvs ? sortConversations(convs) : home.shown).map((v) => (
                <button key={v.id} class="conv" onClick={() => void c.openConversation(v.id)}>
                  <span class={`dot${isFinished(v) ? "" : " open"}`} aria-hidden="true" />
                  <span class="conv-main">
                    <span class="conv-top">
                      <span class={`conv-subject${v.unread ? " unread" : ""}`}>{v.subject || t("conversation")}</span>
                      <span class="time">{relTime(v.last_message_at)}</span>
                    </span>
                    <span class="conv-prev">{s.typing[v.id] ? t("typing", { name: s.typing[v.id] }) : v.last_message_preview}</span>
                  </span>
                </button>
              ))}
              {(allConvs || home.hidden > 0) && (
                <button type="button" class="link-row more" onClick={() => setAllConvs(!allConvs)}>
                  {t(allConvs ? "backHome" : "olderConversations")}
                </button>
              )}
            </div>
          ) : null}
          {cfg?.help_center_url && (
            <div class="card">
              <a class="link-row" href={cfg.help_center_url} target="_blank" rel="noopener noreferrer">
                {t("searchHelp")}
                <span class="flip">
                  <Ext />
                </span>
              </a>
            </div>
          )}
        </div>
      </div>
      <a class="foot" href="https://opendesk.sh" target="_blank" rel="noopener noreferrer">
        <OdMark />
        {t("poweredBy")}
      </a>
    </>
  );
}

// ── Thread ───────────────────────────────────────────────────────────────────

function Thread({
  c,
  files,
  setFiles,
  addFiles,
  fileNote,
  setFileNote,
}: {
  c: Controller;
  files: File[];
  setFiles: (f: File[]) => void;
  addFiles: (f: FileList | null) => void;
  fileNote: string;
  setFileNote: (note: string) => void;
}) {
  const s = useStore(c.store);
  const cfg = s.config;
  const bot = botOf(cfg);
  const key = s.active ?? NEW;
  const msgs = s.messages[key];
  const conv = s.conversations?.find((v) => v.id === s.active);
  const typing = s.active ? s.typing[s.active] : undefined;
  const needsEmail = c.needsEmail();
  const needsTopic = c.needsTopic();
  const topic = !s.active && s.topic ? cfg?.topics?.find((x) => x.id === s.topic) : undefined;
  const handed = !!s.active && (conv?.ai_handoff === true || s.handoff[s.active] === "done");
  const handling = aiHandling({ aiAnswers: cfg?.ai_answers === true, conversation: conv, handedOff: handed, msgs: msgs ?? [] });
  const replies = s.active ? repliesFor(s.live, s.active) : [];
  const writing = replies.some((r) => r.phase !== "leaving");
  const composing = replies.some((r) => r.phase === "typing" || r.phase === "streaming");
  const since = s.active ? s.awaiting[s.active] : undefined;
  const [now, setNow] = useState(Date.now());
  // The agent will answer the visitor's message: show it typing until its first live event.
  const last = msgs?.[msgs.length - 1];
  const decided = !!last?.ai_action && (last.ai_action.status !== "pending" || !!s.actions[last.ai_action.id]?.status);
  const thinking = handling && !!last && since !== undefined && now - since < THINK_MS && !typing && !replies.length && (last.direction === "inbound" || decided);

  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const left = since + THINK_MS - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => setNow(Date.now()), left + 20);
    return () => clearTimeout(id);
  }, [since]);

  const landed = useLanded(key, msgs);
  // The header's bot: thinking while it writes, a hop when its reply lands, else idle.
  const mood = thinking || composing ? "thinking" : landed ? "happy" : undefined;

  const latest = msgs ? latestAiAnswer(msgs) : null;
  const items: VNode[] = [];
  (msgs ?? []).forEach((m, i) => {
    const prev = msgs![i - 1];
    const me = m.direction === "inbound";
    const ai = isAiAnswer(m);
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
    const grouped =
      !!prev &&
      !newDay &&
      !ai &&
      !isAiAnswer(prev) &&
      prev.direction === m.direction &&
      prev.author.type === m.author.type &&
      prev.author.user?.id === m.author.user?.id &&
      Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60_000;
    const offer: Offer = ai && s.active && m.id === latest?.id && handling && !writing && i === msgs!.length - 1 ? (s.handoff[s.active] === "failed" ? "failed" : s.handoff[s.active] === "pending" ? "pending" : "idle") : null;
    items.push(
      <Fragment key={m.id}>
        {newDay ? <div class="day">{dayLabel(m.created_at)}</div> : null}
        {ai ? (
          <AiMessage
            c={c}
            m={m}
            convId={s.active}
            bot={bot}
            offer={offer}
            swapped={!!s.swapped[m.id]}
            rating={m.id in s.ratings ? s.ratings[m.id] : (m.ai_rating ?? null)}
            action={m.ai_action ? s.actions[m.ai_action.id] : undefined}
            landed={m.id === landed}
          />
        ) : (
          <Bubble m={m} me={me} grouped={grouped} onRetry={() => void c.retry(key, m.id)} />
        )}
      </Fragment>,
    );
  });
  replies.forEach((r, i) => items.push(<LiveReplyView key={i === 0 ? "ai-live" : `live-${r.id}`} r={r} bot={bot} />));
  // Same component and key as the first live reply, so its arrival doesn't remount the bubble.
  if (thinking) items.push(<LiveReplyView key="ai-live" r={typingReply(s.active ?? NEW)} bot={bot} />);

  const avatars = handling ? { bot, team: [] } : { bot: null, team: cfg?.team ?? [] };
  // The bot's greeting opens a new chat while the agent answers, and stays at the top of the conversations it took.
  const hello = cfg?.ai_answers && bot.greeting ? bot.greeting : "";
  const opener = hello && (!s.active || handling || (msgs ?? []).some(isAiAnswer)) ? <BotGreeting key="greeting" bot={bot} text={hello} /> : null;

  return (
    <>
      <div class="head" data-bot-state={handling ? mood : undefined}>
        <button class="icon-btn flip" aria-label={t("back")} onClick={() => c.home()}>
          <Back />
        </button>
        <AvatarStack team={avatars.team} bot={avatars.bot} size={26} />
        <div class="head-main">
          <div class="title">{conv?.subject || (s.active ? t("conversation") : titleOf(cfg))}</div>
          <div class="title-sub">{handling ? subtitleOf(cfg) : conv?.subject || s.active ? titleOf(cfg) : subtitleOf(cfg)}</div>
        </div>
        <button class="icon-btn" aria-label={t("closeChat")} onClick={() => c.close()}>
          {X()}
        </button>
      </div>
      <Scroller watch={`${key}:${msgs?.length ?? -1}:${items.length}:${needsTopic}:${!!s.queued}`}>
        {needsEmail && <Capture c={c} />}
        {s.queued && (
          <div class="thread queued">
            <div class="row me is-pending">
              <div class="msg" dir="auto">
                {s.queued}
              </div>
            </div>
          </div>
        )}
        {topic && items.length === 0 && (
          <div class="topic-row">
            <span class="topic-chip">
              <span dir="auto">{topic.label}</span>
              <button aria-label={t("changeTopic")} title={t("changeTopic")} onClick={() => void c.pickTopic(null)}>
                {X(12)}
              </button>
            </span>
          </div>
        )}
        {msgs === undefined ? (
          <div aria-busy="true" style={{ paddingTop: "12px" }}>
            <div class="skel" style={{ width: "55%" }} />
            <div class="skel" style={{ width: "35%", marginInlineStart: "auto" }} />
          </div>
        ) : needsTopic && !needsEmail ? (
          <TopicPicker c={c} />
        ) : items.length === 0 && !needsEmail && !s.queued ? (
          opener ? (
            <div class="thread">{opener}</div>
          ) : cfg?.chat_welcome === false ? null : (
            <div class="empty">
              <b dir="auto">{greeting(cfg?.greeting)}</b>
              <span class="intro" dir="auto">{cfg?.intro?.trim() || t("emptyHint")}</span>
            </div>
          )
        ) : items.length > 0 ? (
          <div class="thread">
            {opener}
            {items}
          </div>
        ) : null}
        {handed && msgs && !teamReplied(msgs) && <HandedOff />}
        {typing && (
          <div class="typing" role="status" aria-label={t("typing", { name: typing })}>
            <Dots />
            <span aria-hidden="true">{typing}</span>
          </div>
        )}
      </Scroller>
      {cfg?.open === false && <Away cfg={cfg} bar />}
      <Composer c={c} files={files} setFiles={setFiles} addFiles={addFiles} fileNote={fileNote} setFileNote={setFileNote} disabled={needsEmail || needsTopic || !s.session} hint={needsEmail ? t("placeholderEmail") : needsTopic ? t("placeholderTopic") : undefined} focusOn={s.preview || s.active ? null : s.topic} />
    </>
  );
}

/**
 * The id of an agent reply that just arrived in the open thread (not one that
 * was already there when the thread loaded), for HOP_MS: its bot hops once.
 */
function useLanded(key: string, msgs: UiMessage[] | undefined): string | null {
  const seen = useRef<{ key: string; ids: Set<string> | null }>({ key, ids: null });
  const [landed, setLanded] = useState<string | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const ids = msgs ? new Set(msgs.filter(isAiAnswer).map((m) => m.id)) : null;
    seen.current = { key, ids };
    // A new thread, or its first load: what is there already doesn't hop.
    if (!ids || prev.key !== key || !prev.ids) return;
    const fresh = [...ids].reverse().find((id) => !prev.ids!.has(id));
    if (fresh) setLanded(fresh);
  }, [key, msgs]);
  useEffect(() => {
    if (!landed) return;
    const id = setTimeout(() => setLanded(null), HOP_MS);
    return () => clearTimeout(id);
  }, [landed]);
  return landed;
}

// ── Topics and closed hours ──────────────────────────────────────────────────

/** The widget's topics as one list of buttons: Tab reaches each, arrow keys move between them. */
function Topics({ topics, onPick, disabled, labelledBy }: { topics: WidgetTopic[]; onPick: (id: string) => void; disabled?: boolean; labelledBy: string }) {
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(e.key in keys) && e.key !== "Home" && e.key !== "End") return;
    const list = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const at = list.indexOf(e.target as HTMLButtonElement);
    if (at < 0 || !list.length) return;
    e.preventDefault();
    const dir = keys[e.key] ?? 0;
    // In a right-to-left layout, left and right swap; up and down don't.
    const flip = (e.key === "ArrowLeft" || e.key === "ArrowRight") && isRtl() ? -1 : 1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (at + dir * flip + list.length) % list.length;
    list[next].focus();
  };
  return (
    <div class="topics" role="group" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {topics.map((x, i) => (
        <button key={x.id} class="topic" style={{ "--i": i }} disabled={disabled} onClick={() => onPick(x.id)}>
          <span dir="auto">{x.label}</span>
          <span class="topic-ic flip" aria-hidden="true">
            <Arrow />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Asked before the first message of a new conversation when the widget has topics. */
function TopicPicker({ c }: { c: Controller }) {
  const s = useStore(c.store);
  const box = useRef<HTMLDivElement>(null);
  // Keyboard users land on the first topic (never in the dashboard preview).
  useEffect(() => {
    if (s.preview) return;
    const id = requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>(".topic:not(:disabled)")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div class="picker" ref={box}>
      <b id="od-pick-h">{t("topicsTitle")}</b>
      <p>{t("topicsHint")}</p>
      <div class="card">
        <Topics topics={s.config?.topics ?? []} labelledBy="od-pick-h" disabled={!s.session} onPick={(id) => void c.pickTopic(id)} />
      </div>
    </div>
  );
}

/** Outside business hours: the widget's offline message, else the translated default. */
function Away({ cfg, bar }: { cfg: WidgetConfig; bar?: boolean }) {
  const text = cfg.offline_message?.trim() || t("offlineDefault");
  return (
    <div class={bar ? "away bar" : "away"} role="status">
      <span class="away-ic" aria-hidden="true">
        {Clock(bar ? 12 : 14)}
      </span>
      <span class="away-text" dir="auto" title={bar ? text : undefined}>
        {text}
      </span>
    </div>
  );
}

/**
 * The thread's scroll area. It stays pinned to the bottom while the visitor is
 * there (new messages, streamed text, images loading), and offers a way back
 * down when they scrolled up and something new arrived.
 */
function Scroller({ watch, children }: { watch: string; children: ComponentChildren }) {
  const el = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const first = useRef(true);

  const toBottom = (smooth: boolean) => {
    const e = el.current;
    if (!e) return;
    if (smooth && !reducedMotion() && typeof e.scrollTo === "function") e.scrollTo({ top: e.scrollHeight, behavior: "smooth" });
    else e.scrollTop = e.scrollHeight;
  };

  // A new message or conversation: glide down (jump on first paint).
  useLayoutEffect(() => {
    if (first.current || stuck.current) toBottom(!first.current);
    else setAway(true);
    first.current = false;
  }, [watch]);

  // Growth inside the thread (streaming, images): follow it while pinned.
  useEffect(() => {
    const target = inner.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) toBottom(false);
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      class="body"
      ref={el}
      onScroll={() => {
        const e = el.current;
        if (!e) return;
        stuck.current = e.scrollHeight - e.scrollTop - e.clientHeight < 48;
        if (stuck.current && away) setAway(false);
      }}
    >
      <div ref={inner} class="body-inner">
        {children}
      </div>
      {away && (
        <button
          class="jump"
          aria-label={t("jumpLatest")}
          onClick={() => {
            stuck.current = true;
            setAway(false);
            toBottom(true);
          }}
        >
          <Down />
        </button>
      )}
    </div>
  );
}

// ── Email capture ────────────────────────────────────────────────────────────

function Capture({ c }: { c: Controller }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr(t("invalidEmail"));
    setBusy(true);
    setErr(null);
    try {
      await c.captureEmail(name.trim(), email.trim());
    } catch {
      setErr(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="capture" onSubmit={submit}>
      <p>{t("captureHint")}</p>
      <input class="field" placeholder={t("name")} aria-label={t("name")} value={name} onInput={(e) => setName(e.currentTarget.value)} autocomplete="name" />
      <input class="field" type="email" placeholder={t("emailPlaceholder")} aria-label={t("email")} dir="ltr" value={email} onInput={(e) => setEmail(e.currentTarget.value)} autocomplete="email" required />
      {err && <div class="err">{err}</div>}
      <button class="primary" type="submit" disabled={busy} style={{ height: "36px" }}>
        {busy ? t("saving") : t("continue")}
      </button>
    </form>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

const MAX_INPUT = 120;

function Composer({
  c,
  files,
  setFiles,
  addFiles,
  fileNote,
  setFileNote,
  disabled,
  hint,
  focusOn,
}: {
  c: Controller;
  files: File[];
  setFiles: (f: File[]) => void;
  addFiles: (f: FileList | null) => void;
  fileNote: string;
  setFileNote: (note: string) => void;
  disabled: boolean;
  hint?: string;
  /** Focus the field when this becomes set (a topic was picked). */
  focusOn?: string | null;
}) {
  const [text, setText] = useState("");
  const [height, setHeight] = useState(30);
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cfg = useStore(c.store).config;
  const attachments = canAttach(cfg);
  const maxVoice = cfg?.voice_max_seconds ?? 60;
  const [voice, setVoice] = useState<Recording | null>(null);
  const recorder = useRecorder(maxVoice, setVoice);
  const recording = recorder.phase === "recording";
  const mic = cfg?.voice_messages === true && canRecord();
  const ready = !disabled && !recording && (!!text.trim() || files.length > 0 || !!voice);

  // A recording let go of (deleted, sent, or the thread left) frees its audio.
  useEffect(() => () => voice && URL.revokeObjectURL(voice.url), [voice]);

  useEffect(() => {
    if (focusOn && !disabled) ta.current?.focus({ preventScroll: true });
  }, [focusOn, disabled]);

  // Measure on a hidden twin, so the field's own height can ease between sizes.
  useLayoutEffect(() => {
    const m = mirror.current;
    if (!m) return;
    m.value = text;
    setHeight(Math.max(30, Math.min(m.scrollHeight, MAX_INPUT)));
  }, [text]);

  const send = () => {
    if (!ready) return;
    void c.send(text, voice ? [...files, voice.file] : files);
    setText("");
    setFiles([]);
    setVoice(null);
    setFileNote("");
    ta.current?.focus();
  };

  return (
    <div class="composer">
      {(fileNote || recorder.error) && (
        <div class="err" role="alert">
          {recorder.error || fileNote}
        </div>
      )}
      {voice && (
        <div class="pending-voice">
          <VoicePlayer
            src={voice.url}
            seconds={voice.seconds}
            action={
              <button class="voice-del" aria-label={t("deleteRecording")} onClick={() => setVoice(null)}>
                <Trash />
              </button>
            }
          />
        </div>
      )}
      {files.length > 0 && (
        <div class="pending-files">
          {files.map((f, i) => (
            <span class="chip" key={`${f.name}-${i}`}>
              <FileIc />
              <span>{f.name}</span>
              <button aria-label={t("removeFile", { name: f.name })} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                {X(12)}
              </button>
            </span>
          ))}
        </div>
      )}
      <div class={`cbar${disabled ? " off" : ""}${attachments && !recording ? " lead" : ""}${recording ? " rec" : ""}`}>
        {attachments && !recording && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept={cfg?.attachment_extensions?.join(",") || undefined}
              onChange={(e) => {
                addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <button class="icon-btn" aria-label={t("attach")} disabled={disabled} onClick={() => picker.current?.click()}>
              <Clip />
            </button>
          </>
        )}
        {recording && (
          <button class="icon-btn" aria-label={t("cancelRecording")} onClick={recorder.cancel}>
            {X(16)}
          </button>
        )}
        {recording ? (
          <div class="rec-bar" role="timer" aria-label={t("recording")}>
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-time">{clock(recorder.elapsed)}</span>
            {recorder.levels ? (
              <div class="rec-wave" aria-hidden="true">
                {recorder.levels.map((v, k) => (
                  <span key={k} style={{ height: `${Math.max(14, v * 100)}%` }} />
                ))}
              </div>
            ) : (
              <div class="rec-track" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (recorder.elapsed / maxVoice) * 100)}%` }} />
              </div>
            )}
            <span class="rec-max">{clock(maxVoice)}</span>
          </div>
        ) : (
          <div class="input-wrap">
            <textarea
              ref={ta}
              class="input"
              rows={1}
              value={text}
              style={{ height: `${height}px`, overflowY: height >= MAX_INPUT ? "auto" : "hidden" }}
              disabled={disabled}
              placeholder={disabled ? (hint ?? t("placeholder")) : t("placeholder")}
              aria-label={t("message")}
              dir="auto"
              onInput={(e) => {
                setText(e.currentTarget.value);
                c.typing();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => {
                const f = e.clipboardData?.files;
                if (attachments && f && f.length) {
                  e.preventDefault();
                  addFiles(f);
                }
              }}
            />
            {/* After the field, and disabled, so focus and selectors never land on it. */}
            <textarea ref={mirror} class="input mirror" rows={1} tabIndex={-1} aria-hidden="true" disabled />
          </div>
        )}
        {recording ? (
          <button class="rec-stop" aria-label={t("stopRecording")} onClick={recorder.stop}>
            <StopIc />
          </button>
        ) : (
          mic &&
          !voice && (
            <button class="icon-btn" aria-label={t("recordVoice")} disabled={disabled || recorder.phase === "asking"} onClick={() => void recorder.start()}>
              <Mic />
            </button>
          )
        )}
        {!recording && (
          <button class={`send${ready ? " ready" : ""}`} aria-label={t("send")} disabled={!ready} onClick={send}>
            <Up />
          </button>
        )}
      </div>
    </div>
  );
}
