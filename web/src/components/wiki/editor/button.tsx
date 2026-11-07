// The button block's view (blocks.ts ButtonBlock): a button that does one thing when pressed,
// as Notion's: puts a template's blocks or a to-do under itself, opens a link, or adds a row
// to a database with values set. People who may edit set it up from the gear beside it; a
// new button opens its settings at once.

import type { Editor } from "@tiptap/core";
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Database as DatabaseIcon, LayoutTemplate, ListTodo, MousePointerClick, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label, TextInput } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { DbProperty, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q, qk } from "@/lib/queries";
import { useTitle, useWikiTree } from "../hooks";
import { buttonReady, cleanLabel, cleanPresets, MAX_LABEL, presettable, storePresets, type ButtonAction, type ButtonAttrs } from "./buttons";
import { stripComments } from "./comment";

const ICONS: Record<ButtonAction, ReactNode> = {
  template: <LayoutTemplate />,
  todo: <ListTodo />,
  link: <ArrowUpRight />,
  row: <DatabaseIcon />,
};

/**
 * A copy of blocks from elsewhere fit to go into this page: no comment marks or reminders
 * of the original, no subpage blocks, new block ids (UniqueID gives them) and new footnote
 * ids, so pressing a button twice makes two copies that don't share anything.
 */
export function freshCopy(slice: Slice): Fragment {
  const notes = new Map<string, string>();
  const note = (id: string) => (id ? (notes.get(id) ?? notes.set(id, crypto.randomUUID()).get(id)!) : id);
  const clean = (frag: Fragment): Fragment => {
    const out: PMNode[] = [];
    frag.forEach((n) => {
      if (n.isText) return out.push(n);
      // A template's subpages are not copied: a link to one would point into the template.
      if (n.type.name === "subpage") return;
      const attrs: Record<string, unknown> = { ...n.attrs };
      if ("block-id" in attrs) attrs["block-id"] = null;
      if (n.type.name === "footnoteRef" || n.type.name === "footnote") attrs.note = note(attrs.note as string);
      out.push(n.type.create(attrs, clean(n.content), n.marks));
    });
    return Fragment.from(out);
  };
  return clean(stripComments(slice).content);
}

function insertBelow(editor: Editor, at: number, content: Fragment | PMNode) {
  const tr = editor.state.tr.insert(at, content);
  editor.view.dispatch(tr.scrollIntoView());
}

export function ButtonBlockView({ node, editor, getPos, updateAttributes, selected }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const attrs = node.attrs as ButtonAttrs;
  const ready = buttonReady(attrs);
  const editable = editor.isEditable;
  const [open, setOpen] = useState(() => editable && !attrs.action);
  const [busy, setBusy] = useState(false);
  // Changing the page (a template, a to-do, a row) needs edit rights; a link opens for anyone.
  const usable = ready && (editable || attrs.action === "link");

  const below = () => {
    const at = getPos();
    return typeof at === "number" ? at + node.nodeSize : null;
  };

  const run = async () => {
    if (!usable || busy) return;
    switch (attrs.action) {
      case "link":
        window.open(attrs.url, "_blank", "noopener,noreferrer");
        return;
      case "todo": {
        const at = below();
        if (at === null) return;
        const s = editor.schema;
        const text = attrs.title.trim();
        const item = s.nodes.taskItem.create({ checked: false }, s.nodes.paragraph.create(null, text ? s.text(text) : null));
        insertBelow(editor, at, s.nodes.taskList.create(null, item));
        // The cursor goes to the end of the new to-do's text: list, item, paragraph.
        editor.chain().focus().setTextSelection(at + 3 + text.length).run();
        return;
      }
      case "template": {
        setBusy(true);
        try {
          const page = await qc.fetchQuery({ ...q.wikiPage(attrs.template), staleTime: 30_000 });
          const at = below();
          if (at === null || !page.body_html.trim()) return;
          const body = new DOMParser().parseFromString(`<body>${page.body_html}</body>`, "text/html").body;
          const slice = PMDOMParser.fromSchema(editor.schema).parseSlice(body);
          insertBelow(editor, at, freshCopy(slice));
        } catch (e) {
          toast.error(e, t("editor.button.templateFailed"));
        } finally {
          setBusy(false);
        }
        return;
      }
      case "row": {
        setBusy(true);
        try {
          const db = await qc.fetchQuery({ ...q.wikiPage(attrs.database), staleTime: 30_000 });
          const props = cleanPresets(attrs.props, db.database?.properties ?? []);
          const row = await api.wiki.create({ parent_id: attrs.database, title: attrs.title.trim(), props });
          void qc.invalidateQueries({ queryKey: qk.wikiRows(attrs.database) });
          void qc.invalidateQueries({ queryKey: qk.wikiTree });
          toast.success(t("editor.button.rowAdded", { database: title(db.title) }), {
            action: { label: t("editor.button.openRow"), onClick: () => void navigate({ to: "/wiki/$pageId", params: { pageId: row.id } }) },
          });
        } catch (e) {
          toast.error(e, t("editor.button.rowFailed"));
        } finally {
          setBusy(false);
        }
        return;
      }
    }
  };

  const face = (
    <button
      type="button"
      onClick={() => void run()}
      onKeyDown={(e) => e.stopPropagation()}
      disabled={!usable || busy}
      className={cn(
        "wiki-button inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-fg shadow-xs transition-[background,border-color,transform] duration-150 hover:border-line-strong hover:bg-hover active:scale-[0.98] disabled:cursor-default disabled:opacity-60 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-3",
        selected && "shadow-[0_0_0_2px_var(--focus)]",
      )}
    >
      {busy ? <Spinner className="size-3.5" /> : attrs.action ? ICONS[attrs.action] : <MousePointerClick />}
      <span className="truncate">{attrs.label || t("editor.button.untitled")}</span>
    </button>
  );

  return (
    <NodeViewWrapper>
      <div contentEditable={false} data-print="hide" className="group/button my-1 flex items-center gap-1">
        {usable || !ready ? face : <Tooltip content={t("editor.button.readOnly")}>{face}</Tooltip>}
        {editable && (
          <Popover
            open={open}
            onOpenChange={setOpen}
            className="w-[300px] p-3"
            trigger={
              <button
                type="button"
                aria-label={t("editor.button.settings")}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-fg-4 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/button:opacity-100 [@media(hover:none)]:opacity-100 [&_svg]:size-3.5",
                  (open || !ready) && "opacity-100",
                )}
              >
                <Settings2 />
              </button>
            }
          >
            <ButtonSettings attrs={attrs} onChange={updateAttributes} onDone={() => setOpen(false)} />
          </Popover>
        )}
      </div>
    </NodeViewWrapper>
  );
}

function ButtonSettings({ attrs, onChange, onDone }: { attrs: ButtonAttrs; onChange: (a: Partial<ButtonAttrs>) => void; onDone: () => void }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree } = useWikiTree();
  const templates = useQuery(q.wikiTemplates());
  const databases = [...tree.byId.values()].filter((n) => n.kind === "database");
  const [url, setUrl] = useState(attrs.url);
  const field = "flex flex-col gap-1";
  return (
    <form
      className="flex flex-col gap-3"
      onKeyDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      <div className={field}>
        <Label htmlFor="wiki-button-label">{t("editor.button.label")}</Label>
        <TextInput id="wiki-button-label" inputSize="sm" autoFocus value={attrs.label} maxLength={MAX_LABEL} placeholder={t("editor.button.untitled")} onChange={(e) => onChange({ label: cleanLabel(e.target.value) })} />
      </div>
      <div className={field}>
        <Label>{t("editor.button.action")}</Label>
        <Select<ButtonAction>
          size="sm"
          aria-label={t("editor.button.action")}
          value={attrs.action || undefined}
          placeholder={t("editor.button.pickAction")}
          onChange={(action) => onChange({ action })}
          options={(["template", "todo", "link", "row"] as const).map((a) => ({ value: a, label: t(`editor.button.actions.${a}`), icon: ICONS[a] }))}
        />
      </div>
      {attrs.action === "template" && (
        <div className={field}>
          <Label>{t("editor.button.template")}</Label>
          <Select
            size="sm"
            aria-label={t("editor.button.template")}
            value={attrs.template || undefined}
            placeholder={templates.isLoading ? t("editor.button.loading") : t("editor.button.pickTemplate")}
            onChange={(template) => onChange({ template })}
            options={(templates.data ?? []).filter((n) => !n.parent_id).map((n) => ({ value: n.id, label: title(n.title), icon: n.icon ? <span className="text-[13px] leading-none">{n.icon}</span> : undefined }))}
          />
          {templates.data && !templates.data.some((n) => !n.parent_id) && <p className="text-[11.5px] text-fg-4">{t("editor.button.noTemplates")}</p>}
        </div>
      )}
      {attrs.action === "todo" && (
        <div className={field}>
          <Label htmlFor="wiki-button-todo" optional>
            {t("editor.button.todoText")}
          </Label>
          <TextInput id="wiki-button-todo" inputSize="sm" value={attrs.title} maxLength={500} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
      )}
      {attrs.action === "link" && (
        <div className={field}>
          <Label htmlFor="wiki-button-url">{t("editor.button.url")}</Label>
          <TextInput
            id="wiki-button-url"
            inputSize="sm"
            value={url}
            placeholder="https://"
            invalid={!!url.trim() && !buttonReady({ ...attrs, url: normalUrl(url) })}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => onChange({ url: buttonReady({ ...attrs, url: normalUrl(url) }) ? normalUrl(url) : "" })}
          />
        </div>
      )}
      {attrs.action === "row" && (
        <>
          <div className={field}>
            <Label>{t("editor.button.database")}</Label>
            <Select
              size="sm"
              aria-label={t("editor.button.database")}
              value={attrs.database || undefined}
              placeholder={t("editor.button.pickDatabase")}
              onChange={(database) => onChange({ database, props: "" })}
              options={databases.map((n) => ({ value: n.id, label: title(n.title) }))}
            />
            {databases.length === 0 && <p className="text-[11.5px] text-fg-4">{t("editor.button.noDatabases")}</p>}
          </div>
          {attrs.database && (
            <>
              <div className={field}>
                <Label htmlFor="wiki-button-row" optional>
                  {t("editor.button.rowTitle")}
                </Label>
                <TextInput id="wiki-button-row" inputSize="sm" value={attrs.title} maxLength={200} onChange={(e) => onChange({ title: e.target.value })} />
              </div>
              <Presets database={attrs.database} raw={attrs.props} onChange={(props) => onChange({ props })} />
            </>
          )}
        </>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary">
          {t("editor.button.done")}
        </Button>
      </div>
    </form>
  );
}

/** An address typed without its scheme is https; http becomes https. */
const normalUrl = (v: string) => {
  const s = v.trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s.replace(/^http:/i, "https:") : `https://${s}`;
};

/** The values a new row starts with, for the properties a button can set. */
function Presets({ database, raw, onChange }: { database: string; raw: string; onChange: (raw: string) => void }) {
  const { t } = useTranslation("wiki");
  const page = useQuery(q.wikiPage(database));
  const props = (page.data?.database?.properties ?? []).filter((p) => p.type !== "title" && presettable(p));
  const values = cleanPresets(raw, props);
  const set = (id: string, v: DbValue) => onChange(storePresets({ ...values, [id]: v }));
  if (page.isLoading) return <Spinner className="size-4 text-fg-4" />;
  if (!props.length) return null;
  return (
    <fieldset className="flex flex-col gap-2 border-t border-line pt-3">
      <legend className="label-caps mb-1">{t("editor.button.presets")}</legend>
      {props.slice(0, 12).map((p) => (
        <PresetField key={p.id} prop={p} value={values[p.id] ?? null} onChange={(v) => set(p.id, v)} />
      ))}
    </fieldset>
  );
}

function PresetField({ prop, value, onChange }: { prop: DbProperty; value: DbValue; onChange: (v: DbValue) => void }) {
  const { t } = useTranslation("wiki");
  const [text, setText] = useState(value === null ? "" : String(value));
  const row = "grid grid-cols-[110px_1fr] items-center gap-2";
  const name = <span className="truncate text-[12.5px] text-fg-2">{prop.name}</span>;
  if (prop.type === "checkbox")
    return (
      <label className={row}>
        {name}
        <Switch checked={value === true} onCheckedChange={(on) => onChange(on || null)} aria-label={prop.name} />
      </label>
    );
  if (prop.type === "select" || prop.type === "status")
    return (
      <div className={row}>
        {name}
        <Select
          size="sm"
          aria-label={prop.name}
          value={typeof value === "string" ? value : "__none"}
          onChange={(v) => onChange(v === "__none" ? null : v)}
          options={[{ value: "__none", label: t("editor.button.noValue") }, ...(prop.options ?? []).map((o) => ({ value: o.id, label: o.name }))]}
        />
      </div>
    );
  const number = prop.type === "number";
  return (
    <label className={row}>
      {name}
      <TextInput
        inputSize="sm"
        value={text}
        inputMode={number ? "decimal" : undefined}
        invalid={number && !!text.trim() && !Number.isFinite(Number(text))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const s = text.trim();
          if (!number) return onChange(s || null);
          const n = Number(s);
          onChange(s && Number.isFinite(n) ? n : null);
        }}
        aria-label={prop.name}
      />
    </label>
  );
}
