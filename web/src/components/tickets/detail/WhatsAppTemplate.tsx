// WhatsApp on a ticket (contracts/whatsapp.md): the 24 hour customer service window, and the
// approved templates that may go out inside or after it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, MessageCircle, Paperclip, Search, Send, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Ticket, WhatsAppTemplate, WhatsAppTemplateButton, WhatsAppTicketState } from "@/lib/api/types";
import { api, type WhatsAppTemplateSendBody } from "@/lib/api/endpoints";
import { cn } from "@/lib/cn";
import { bytes, minutes } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { tone } from "@/lib/tones";
import { useNow } from "@/lib/useNow";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";

/** The ticket's WhatsApp state from the server: the connection a reply goes out from and the window. */
export function useWhatsAppTicket(ticket: Ticket): WhatsAppTicketState | undefined {
  return useQuery({ ...q.whatsappTicket(ticket.id), enabled: ticket.channel === "whatsapp" }).data;
}

/** When the window closes, or null when the customer never wrote to the ticket's number. */
export function whatsAppWindowEndsAt(state: WhatsAppTicketState): number | null {
  if (!state.window_closes_at) return null;
  const at = Date.parse(state.window_closes_at);
  return Number.isFinite(at) ? at : null;
}

/** Whether a free-form reply may go out right now: the number is connected and the window open. */
export function whatsAppWindowOpen(state: WhatsAppTicketState): boolean {
  const ends = whatsAppWindowEndsAt(state);
  return !!state.connection_id && ends !== null && Date.now() < ends;
}

/** The window's state above the composer, with the way to a template either way. */
export function WhatsAppWindow({ state, onTemplates }: { state: WhatsAppTicketState; onTemplates: () => void }) {
  const { t } = useTranslation("inbox");
  const ends = whatsAppWindowEndsAt(state);
  const connected = !!state.connection_id;
  // Only the countdown needs the clock; a closed window stands still.
  const now = useNow(connected && ends !== null && Date.now() < ends);
  const open = connected && ends !== null && now < ends;
  const left = ends === null ? 0 : Math.max(0, ends - now);
  return (
    <div className={cn("mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-[12.5px]", open ? "bg-sunken" : tone.amber.soft)}>
      <MessageCircle className={cn("size-3.5 shrink-0", open ? tone.green.text : tone.amber.text)} />
      <span className="min-w-0 flex-1 text-fg-2">
        {!connected
          ? t("composer.whatsappDisconnected")
          : open
            ? t("composer.whatsappWindowOpen", { left: minutes(Math.ceil(left / 60_000)) })
            : t("composer.whatsappWindowClosed")}
      </span>
      {connected && (
        <Button size="xs" variant="secondary" icon={<Send className={cn("size-3", tone.green.text)} />} onClick={onTemplates}>
          {t("composer.whatsappTemplate")}
        </Button>
      )}
    </div>
  );
}

const placeholderPattern = () => /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The distinct placeholders of a template body, in the order they appear (what Meta expects). */
function orderedPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(placeholderPattern())) {
    if (!m[1] || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/** A header this picker can fill: text (a variable or fixed), or one of Meta's media files. */
type HeaderMediaKind = "IMAGE" | "VIDEO" | "DOCUMENT";

const HEADER_MEDIA: Record<HeaderMediaKind, { accept: string; maxBytes: number }> = {
  IMAGE: { accept: "image/*", maxBytes: 5 * 1024 * 1024 },
  VIDEO: { accept: "video/*", maxBytes: 16 * 1024 * 1024 },
  DOCUMENT: { accept: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt", maxBytes: 25 * 1024 * 1024 },
};

const HEADER_KINDS = new Set(["TEXT", "IMAGE", "VIDEO", "DOCUMENT"]);

/** The labels' keys for the three media headers. */
const HEADER_KIND_LABEL: Record<HeaderMediaKind, "image" | "video" | "document"> = {
  IMAGE: "image",
  VIDEO: "video",
  DOCUMENT: "document",
};

function headerType(x: WhatsAppTemplate): string {
  return (x.header_type ?? "").trim().toUpperCase();
}

function headerMediaKind(x: WhatsAppTemplate): HeaderMediaKind | null {
  const kind = headerType(x);
  return kind === "IMAGE" || kind === "VIDEO" || kind === "DOCUMENT" ? kind : null;
}

/** A header this picker cannot fill (a location header) is left out: the API refuses it too. */
function sendable(x: WhatsAppTemplate): boolean {
  const kind = headerType(x);
  return kind === "" || HEADER_KINDS.has(kind);
}

/** A template's buttons: the synced row holds them as an array, an older one as JSON text. */
function templateButtons(x: WhatsAppTemplate): WhatsAppTemplateButton[] {
  const raw: unknown = x.buttons;
  if (Array.isArray(raw)) return raw as WhatsAppTemplateButton[];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as WhatsAppTemplateButton[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type UrlButton = {
  /** The button's place in the template's buttons array: the key Meta expects. */
  index: number;
  text: string;
  url: string;
  /** Whether the button's URL has a placeholder the agent fills in. */
  variable: boolean;
};

/** A template's URL buttons, static ones (shown as text) and those that need a value. */
function urlButtons(x: WhatsAppTemplate): UrlButton[] {
  const out: UrlButton[] = [];
  templateButtons(x).forEach((b, index) => {
    if ((b.type ?? "").trim().toUpperCase() !== "URL") return;
    const url = b.url ?? "";
    out.push({ index, text: b.text ?? "", url, variable: /\{\{/.test(url) });
  });
  return out;
}

/** The body with the agent's values filled in, for the preview. */
function filled(body: string, params: Record<string, string>): string {
  return body.replace(placeholderPattern(), (match, key: string) => params[key]?.trim() || match);
}

type HeaderMedia = { file: File; status: "uploading" | "done"; attachmentId?: string };

/** Pick an approved template, fill its placeholders and send it, in the window or outside it. */
export function WhatsAppTemplateDialog({ ticket, connectionId, onClose }: { ticket: Ticket; connectionId: string; onClose: () => void }) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(q.whatsappTemplates(connectionId));
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<WhatsAppTemplate | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [headerValue, setHeaderValue] = useState("");
  const [buttonValues, setButtonValues] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<HeaderMedia | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const approved = useMemo(() => (data ?? []).filter((x) => x.status.toUpperCase() === "APPROVED" && sendable(x)), [data]);
  const matches = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return approved;
    return approved.filter((x) => x.name.toLowerCase().includes(q) || x.language.toLowerCase().includes(q) || x.category.toLowerCase().includes(q));
  }, [approved, term]);
  const placeholders = useMemo(() => orderedPlaceholders(picked?.body_content ?? ""), [picked]);
  const headerKind = useMemo(() => (picked ? headerMediaKind(picked) : null), [picked]);
  const headerVariable = useMemo(() => (picked && headerType(picked) === "TEXT" ? orderedPlaceholders(picked.header_content ?? "")[0] : undefined), [picked]);
  const buttons = useMemo(() => (picked ? urlButtons(picked) : []), [picked]);
  const valueButtons = buttons.filter((b) => b.variable);
  const uploading = media?.status === "uploading";
  const ready =
    !!picked &&
    !uploading &&
    (!headerKind || (media?.status === "done" && !!media.attachmentId)) &&
    (!headerVariable || !!headerValue.trim()) &&
    placeholders.every((p) => !!params[p]?.trim()) &&
    valueButtons.every((b) => !!buttonValues[String(b.index)]?.trim());

  /** Starting another template starts its form empty: its header may be a different kind. */
  const choose = (x: WhatsAppTemplate) => {
    setPicked(x);
    setParams({});
    setHeaderValue("");
    setButtonValues({});
    setMedia(null);
  };

  const pickMedia = (kind: HeaderMediaKind, file: File | undefined) => {
    if (!file) return;
    const limit = HEADER_MEDIA[kind].maxBytes;
    if (file.size > limit) {
      toast.error(t("whatsappTemplate.headerTooLarge", { name: file.name, size: bytes(limit) }));
      return;
    }
    setMedia({ file, status: "uploading" });
    api.attachments
      .upload(file)
      .then((attachment) => setMedia((cur) => (cur && cur.file === file ? { file, status: "done", attachmentId: attachment.id } : cur)))
      .catch((e) => {
        setMedia((cur) => (cur && cur.file === file ? null : cur));
        toast.error(e, t("whatsappTemplate.headerUploadFailed", { name: file.name }));
      });
  };

  const send = useMutation({
    mutationFn: () => {
      if (!picked) throw new Error("no template picked");
      const body: WhatsAppTemplateSendBody = { template_id: picked.id };
      if (placeholders.length) body.params = Object.fromEntries(placeholders.map((p) => [p, params[p]?.trim() ?? ""]));
      if (headerVariable) body.header_text = headerValue.trim();
      if (headerKind && media?.attachmentId) body.header_media_id = media.attachmentId;
      if (valueButtons.length) body.button_urls = Object.fromEntries(valueButtons.map((b) => [String(b.index), buttonValues[String(b.index)]?.trim() ?? ""]));
      return api.whatsapp.sendTemplate(ticket.id, body);
    },
    onSuccess: () => {
      toast.success(t("whatsappTemplate.sent"));
      void qc.invalidateQueries({ queryKey: qk.messages(ticket.id), exact: true });
      void qc.invalidateQueries({ queryKey: qk.ticket(ticket.id) });
      void qc.invalidateQueries({ queryKey: qk.whatsappTicket(ticket.id), exact: true });
      onClose();
    },
    onError: (e) => toast.error(e, t("whatsappTemplate.error")),
  });

  const footer = picked ? (
    <>
      <Button icon={<ArrowLeft />} onClick={() => setPicked(null)}>
        {t("whatsappTemplate.back")}
      </Button>
      <span className="flex-1" />
      <Button onClick={onClose}>{t("whatsappTemplate.cancel")}</Button>
      <Button variant="primary" icon={<Check />} disabled={!ready} loading={send.isPending} onClick={() => send.mutate()}>
        {t("whatsappTemplate.send")}
      </Button>
    </>
  ) : (
    <Button onClick={onClose}>{t("whatsappTemplate.cancel")}</Button>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("whatsappTemplate.title")} description={t("whatsappTemplate.description")} footer={footer}>
      {picked ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{picked.name}</span>
            <span className="mono text-[11.5px] text-fg-3">{picked.language}</span>
            {picked.category && <span className="text-[11.5px] text-fg-4">{picked.category}</span>}
          </div>
          <div>
            <p className="mb-1.5 text-[11.5px] font-medium text-fg-3">{t("whatsappTemplate.preview")}</p>
            {headerType(picked) === "TEXT" && picked.header_content && (
              <p className="mb-1.5 text-[12.5px] font-medium text-fg-2">
                {filled(picked.header_content, headerVariable ? { [headerVariable]: headerValue } : {})}
              </p>
            )}
            <pre className="ph-no-capture max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken px-3 py-2.5 text-[12.5px] leading-[19px] text-fg-2">
              {filled(picked.body_content, params)}
            </pre>
            {picked.footer_content && <p className="mt-1.5 text-[11.5px] text-fg-4">{picked.footer_content}</p>}
          </div>
          {headerKind ? (
            <Field
              label={t("whatsappTemplate.headerMedia", { kind: t(`whatsappTemplate.kind.${HEADER_KIND_LABEL[headerKind]}`) })}
              hint={t("whatsappTemplate.headerFileHint", { size: bytes(HEADER_MEDIA[headerKind].maxBytes) })}
            >
              {({ id }) => (
                <>
                  <input
                    ref={mediaInput}
                    id={id}
                    type="file"
                    accept={HEADER_MEDIA[headerKind].accept}
                    hidden
                    onChange={(e) => {
                      pickMedia(headerKind, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  {media ? (
                    <span className="flex h-8 max-w-[280px] items-center gap-2 rounded-md border border-line bg-surface pl-1 pr-1">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-hover">
                        <Paperclip className="size-3 text-fg-3" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[11.5px]">{media.file.name}</span>
                        <span className="mono block text-[10px] text-fg-4">
                          {uploading ? t("whatsappTemplate.headerUploading") : bytes(media.file.size)}
                        </span>
                      </span>
                      {uploading ? (
                        <Spinner className="size-3.5 shrink-0" />
                      ) : (
                        <button
                          type="button"
                          aria-label={t("whatsappTemplate.headerRemove")}
                          onClick={() => setMedia(null)}
                          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-4 hover:bg-hover hover:text-fg"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </span>
                  ) : (
                    <Button icon={<Paperclip />} onClick={() => mediaInput.current?.click()}>
                      {t("whatsappTemplate.headerChoose")}
                    </Button>
                  )}
                </>
              )}
            </Field>
          ) : headerVariable ? (
            <Field
              label={<span className="mono">{t("whatsappTemplate.headerValue", { name: `{{${headerVariable}}}` })}</span>}
              hint={t("whatsappTemplate.headerValueHint")}
            >
              {(props) => <TextInput {...props} autoComplete="off" maxLength={60} value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />}
            </Field>
          ) : headerType(picked) === "TEXT" && picked.header_content ? (
            <div>
              <p className="mb-1.5 text-[11.5px] font-medium text-fg-3">{t("whatsappTemplate.header")}</p>
              <p className="text-[12.5px] text-fg-2">{picked.header_content}</p>
            </div>
          ) : null}
          {placeholders.length > 0 && (
            <div className="flex flex-col gap-3">
              <p className="text-[11.5px] font-medium text-fg-3">{t("whatsappTemplate.params")}</p>
              {placeholders.map((p) => (
                <Field key={p} label={<span className="mono">{`{{${p}}}`}</span>} hint={t("whatsappTemplate.paramHint")}>
                  {(props) => (
                    <TextInput
                      {...props}
                      autoComplete="off"
                      value={params[p] ?? ""}
                      onChange={(e) => setParams((old) => ({ ...old, [p]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          )}
          {buttons.length > 0 && (
            <div className="flex flex-col gap-3">
              <p className="text-[11.5px] font-medium text-fg-3">{t("whatsappTemplate.buttons")}</p>
              {buttons.map((b) =>
                b.variable ? (
                  <Field
                    key={b.index}
                    label={t("whatsappTemplate.buttonValue", { text: b.text || t("whatsappTemplate.buttonNumber", { number: b.index + 1 }) })}
                    hint={t("whatsappTemplate.buttonHint")}
                  >
                    {(props) => (
                      <TextInput
                        {...props}
                        autoComplete="off"
                        value={buttonValues[String(b.index)] ?? ""}
                        onChange={(e) => setButtonValues((old) => ({ ...old, [String(b.index)]: e.target.value }))}
                      />
                    )}
                  </Field>
                ) : (
                  <p key={b.index} className="text-[12px] text-fg-3">
                    {b.text || b.url}
                  </p>
                ),
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
            <TextInput
              aria-label={t("whatsappTemplate.search")}
              placeholder={t("whatsappTemplate.search")}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              className="pl-8"
            />
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-[12.5px] text-fg-3">
              <Spinner className="size-3.5" /> {t("whatsappTemplate.loading")}
            </div>
          ) : !matches.length ? (
            <p className="py-6 text-center text-[12.5px] text-fg-3">{term.trim() ? t("whatsappTemplate.emptySearch") : t("whatsappTemplate.noTemplates")}</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto rounded-md border border-line">
              {matches.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => choose(x)}
                  className="flex w-full items-center gap-2.5 border-b border-line-soft px-3 py-2.5 text-left last:border-0 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{x.name}</span>
                  <span className="mono shrink-0 text-[11.5px] text-fg-3">{x.language}</span>
                  {x.category && <span className="shrink-0 text-[11.5px] text-fg-4">{x.category}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
