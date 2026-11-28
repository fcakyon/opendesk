// Routing rules (contracts/teams.md "Routing"): the fields a condition can
// look at, the operators each takes, the value input each needs, and a
// one-line summary of a rule's conditions.

import { useQuery } from "@tanstack/react-query";
import { AtSign, Building2, FileText, Globe, Hash, Inbox, Link2, ListTree, Mail, MessageCircle, Radio, Sparkles, Type, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TextInput } from "@/components/ui/input";
import type { PickerItem } from "@/components/ui/picker";
import { Select } from "@/components/ui/select";
import type { Brand, CustomField, Mailbox, RoutingCondition, RoutingField, RoutingOp, Widget } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { SinglePick } from "./pickers";
import { BrandMark, brandItems, mailboxItems, useBrands } from "./teams";

type Kind = "text" | "address" | "mailbox" | "brand" | "widget" | "channel" | "topic" | "number" | "ai";

const TEXT_OPS: RoutingOp[] = ["contains", "not_contains", "equals", "not_equals", "starts_with"];
const ID_OPS: RoutingOp[] = ["equals", "not_equals"];

export const FIELD_META: Record<Exclude<RoutingField, `contact.field.${string}`>, { kind: Kind; icon: ReactNode; ops: RoutingOp[]; group: "where" | "who" | "what" | "ai" }> = {
  received_at: { kind: "address", icon: <AtSign />, ops: ["equals", "not_equals", "contains", "starts_with"], group: "where" },
  mailbox_id: { kind: "mailbox", icon: <Inbox />, ops: ID_OPS, group: "where" },
  brand_id: { kind: "brand", icon: <Building2 />, ops: ID_OPS, group: "where" },
  widget_id: { kind: "widget", icon: <MessageCircle />, ops: ID_OPS, group: "where" },
  channel: { kind: "channel", icon: <Radio />, ops: ID_OPS, group: "where" },
  page_url: { kind: "text", icon: <Link2 />, ops: TEXT_OPS, group: "where" },
  topic: { kind: "topic", icon: <ListTree />, ops: ID_OPS, group: "where" },
  from_email: { kind: "text", icon: <Mail />, ops: TEXT_OPS, group: "who" },
  from_domain: { kind: "text", icon: <Globe />, ops: ["equals", "not_equals", "contains"], group: "who" },
  subject: { kind: "text", icon: <Type />, ops: TEXT_OPS, group: "what" },
  body: { kind: "text", icon: <FileText />, ops: ["contains", "not_contains"], group: "what" },
  ai_decide: { kind: "ai", icon: <Sparkles />, ops: ["gt", "lt"], group: "ai" },
};

const isContact = (f: string): f is `contact.field.${string}` => f.startsWith("contact.field.");

export function fieldMeta(f: RoutingField, fields: CustomField[]) {
  if (isContact(f)) {
    const cf = fields.find((x) => x.key === f.slice("contact.field.".length));
    const numeric = cf?.type === "number";
    return { kind: (numeric ? "number" : "text") as Kind, icon: <UserRound />, ops: numeric ? (["equals", "not_equals", "gt", "lt"] as RoutingOp[]) : TEXT_OPS, group: "who" as const, cf };
  }
  return { ...FIELD_META[f], cf: undefined };
}

export function newCondition(field: RoutingField, fields: CustomField[]): RoutingCondition {
  const m = fieldMeta(field, fields);
  if (field === "ai_decide") return { field, op: "gt", value: "0.8", question: "" };
  return { field, op: m.ops[0], value: field === "channel" ? "email" : "" };
}

/** Every topic of every widget, as "Topic (Widget)". */
export function topicItems(widgets: Widget[]): PickerItem[] {
  return widgets.flatMap((w) => w.settings.topics.map((t) => ({ value: t.id, label: t.label, hint: w.name, group: w.name })));
}

export function useRoutingData() {
  const { brands, multi } = useBrands();
  const { data: mailboxes } = useQuery(q.mailboxes());
  const { data: widgets } = useQuery(q.widgets());
  const { data: fields } = useQuery(q.customFields());
  return { brands, multiBrand: multi, mailboxes: mailboxes ?? [], widgets: widgets ?? [], contactFields: (fields ?? []).filter((f) => f.entity === "contact" && !f.archived) };
}

export function useFieldLabel() {
  const { t } = useTranslation("settingsTeams");
  return (f: RoutingField, fields: CustomField[]) => {
    if (isContact(f)) {
      const key = f.slice("contact.field.".length);
      return t("routing.fields.contactField", { name: fields.find((x) => x.key === key)?.name ?? key });
    }
    return t(`routing.fields.${f}`);
  };
}

/** The field picker: grouped, brand-only fields left out with a single brand. */
export function useFieldItems(multiBrand: boolean, fields: CustomField[]): PickerItem[] {
  const { t } = useTranslation("settingsTeams");
  const label = useFieldLabel();
  const base = (Object.keys(FIELD_META) as (keyof typeof FIELD_META)[])
    .filter((f) => multiBrand || f !== "brand_id")
    .map((f) => ({ value: f, label: label(f, fields), icon: FIELD_META[f].icon, group: t(`routing.groups.${FIELD_META[f].group}`) }));
  const contact = fields.map((f) => ({ value: `contact.field.${f.key}`, label: label(`contact.field.${f.key}`, fields), icon: <Hash />, group: t("routing.groups.who") }));
  const order = ["where", "who", "what", "ai"].map((g) => t(`routing.groups.${g}` as "routing.groups.where"));
  return [...base, ...contact].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** The value of one condition, in words (for summaries and the editor's pickers). */
export function valueLabel(c: RoutingCondition, d: { mailboxes: Mailbox[]; brands: Brand[]; widgets: Widget[] }, t: (k: string) => string): string {
  switch (c.field) {
    case "mailbox_id":
      return d.mailboxes.find((m) => m.id === c.value)?.email ?? c.value;
    case "brand_id":
      return d.brands.find((b) => b.id === c.value)?.name ?? c.value;
    case "widget_id":
      return d.widgets.find((w) => w.id === c.value)?.name ?? c.value;
    case "topic":
      return d.widgets.flatMap((w) => w.settings.topics).find((x) => x.id === c.value)?.label ?? c.value;
    case "channel":
      return t(`routing.channels.${c.value}`);
    case "ai_decide":
      return c.question ?? "";
    default:
      return c.value;
  }
}

/** "Subject contains invoice, or 2 more" for list rows. */
export function useRuleSummary() {
  const { t } = useTranslation("settingsTeams");
  const label = useFieldLabel();
  const d = useRoutingData();
  return (conds: RoutingCondition[], match: "all" | "any") => {
    if (!conds.length) return t("routing.noConditions");
    const one = (c: RoutingCondition) =>
      c.field === "ai_decide"
        ? t("routing.summaryAi", { question: c.question ?? "" })
        : `${label(c.field, d.contactFields)} ${t(`routing.ops.${c.op}`)} ${valueLabel(c, d, t as (k: string) => string)}`;
    const first = one(conds[0]);
    if (conds.length === 1) return first;
    return t(match === "all" ? "routing.summaryAll" : "routing.summaryAny", { first, count: conds.length - 1 });
  };
}

/** The value input a condition's field needs. */
export function ConditionValue({
  c,
  onChange,
  invalid,
  data,
}: {
  c: RoutingCondition;
  onChange: (p: Partial<RoutingCondition>) => void;
  invalid?: boolean;
  data: ReturnType<typeof useRoutingData>;
}) {
  const { t } = useTranslation("settingsTeams");
  const m = fieldMeta(c.field, data.contactFields);
  const pick = (items: PickerItem[], placeholder: string) => (
    <SinglePick className="w-full" items={items} value={c.value || null} onChange={(value) => onChange({ value })} placeholder={placeholder} invalid={invalid} />
  );
  switch (m.kind) {
    case "mailbox":
      return pick(mailboxItems(data.mailboxes, data.brands), t("routing.pickMailbox"));
    case "brand":
      return pick(brandItems(data.brands), t("routing.pickBrand"));
    case "widget":
      return pick(
        data.widgets.map((w) => {
          const b = data.brands.find((x) => x.id === w.brand_id);
          return { value: w.id, label: w.name, icon: b ? <BrandMark brand={b} size="xs" /> : undefined, hint: data.brands.length > 1 ? b?.name : undefined };
        }),
        t("routing.pickWidget"),
      );
    case "topic":
      return pick(topicItems(data.widgets), t("routing.pickTopic"));
    case "channel":
      return (
        <Select
          size="sm"
          className="w-full"
          aria-label={t("routing.value")}
          value={c.value || "email"}
          onChange={(value) => onChange({ value })}
          options={(["email", "chat", "api", "portal", "phone", "whatsapp"] as const).map((x) => ({ value: x, label: t(`routing.channels.${x}`) }))}
        />
      );
    case "address": {
      const all = data.mailboxes.flatMap((mb) => [mb.email, ...mb.aliases]);
      if (c.op === "equals" || c.op === "not_equals")
        return (
          <SinglePick
            className="w-full"
            items={all.map((a) => ({ value: a, label: a }))}
            value={c.value || null}
            onChange={(value) => onChange({ value })}
            onCreate={(value) => onChange({ value: value.trim().toLowerCase() })}
            placeholder={t("routing.pickAddress")}
            invalid={invalid}
          />
        );
      return <TextInput inputSize="sm" className="mono" aria-label={t("routing.value")} value={c.value} invalid={invalid} placeholder="legal@" onChange={(e) => onChange({ value: e.target.value })} />;
    }
    case "number":
      return <TextInput inputSize="sm" inputMode="decimal" aria-label={t("routing.value")} value={c.value} invalid={invalid} placeholder="100" onChange={(e) => onChange({ value: e.target.value.replace(/[^0-9.-]/g, "") })} />;
    case "ai":
      return (
        <Select
          size="sm"
          className="w-full"
          aria-label={t("routing.confidence")}
          value={c.value || "0.8"}
          onChange={(value) => onChange({ value })}
          options={["0.5", "0.6", "0.7", "0.8", "0.9", "0.95"].map((v) => ({ value: v, label: t("routing.percent", { n: Math.round(Number(v) * 100) }) }))}
        />
      );
    default:
      return (
        <TextInput
          inputSize="sm"
          aria-label={t("routing.value")}
          value={c.value}
          invalid={invalid}
          placeholder={c.field === "from_domain" ? "acme.com" : c.field === "page_url" ? "/pricing" : t("routing.textPlaceholder")}
          className={c.field === "from_domain" || c.field === "from_email" || c.field === "page_url" ? "mono" : undefined}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      );
  }
}
