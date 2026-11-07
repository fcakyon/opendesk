// A new team, made in place: from Settings › Teams and from the sidebar's Teams "+"
// (contracts/teams.md). The caller decides where the new team opens.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, UsersRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ColorSwatchPicker } from "@/components/settings2/ColorSwatchPicker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { LabelColor, Team } from "@/lib/api/types";
import { qk, upsertInList } from "@/lib/queries";
import { useUser } from "@/lib/session";

/** A new team: its name, description, colour, privacy and whether the creator leads it. */
export function NewTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (team: Team) => void }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const me = useUser();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<LabelColor>("blue");
  const [priv, setPriv] = useState(false);
  const [join, setJoin] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.teams.create({
        name: name.trim(),
        description: description.trim(),
        color,
        private: priv,
        members: join ? [{ user_id: me.id, role: "lead" }] : [],
      }),
    onSuccess: (team) => {
      upsertInList(qc, qk.teams, team);
      toast.success(t("list.created", { name: team.name }));
      onClose();
      onCreated(team);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("list.new")}
      description={t("list.newHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-team" loading={create.isPending} icon={<UsersRound className="size-3.5" />}>
            {t("list.create")}
          </Button>
        </>
      }
    >
      <form
        id="new-team"
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("general.nameRequired"));
          create.mutate();
        }}
      >
        <Field label={t("general.name")} error={error}>
          {({ id, invalid }) => (
            <TextInput id={id} autoFocus invalid={invalid} value={name} maxLength={60} placeholder={t("general.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label={t("general.description")} optional>
          {({ id }) => (
            <Textarea id={id} rows={2} value={description} maxLength={280} placeholder={t("general.descriptionPlaceholder")} onChange={(e) => setDescription(e.target.value)} />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">{t("general.color")}</span>
          <ColorSwatchPicker value={color} onChange={(c) => setColor(c)} label={t("general.color")} size="sm" />
        </div>
        <div className="flex flex-col rounded-md border border-line">
          <label className="flex items-center justify-between gap-3 border-b border-line-soft px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium">{t("list.joinAsLead")}</span>
              <span className="block text-[12px] text-fg-3">{t("list.joinAsLeadHint")}</span>
            </span>
            <Switch checked={join} onCheckedChange={setJoin} aria-label={t("list.joinAsLead")} />
          </label>
          <label className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                <Lock className="size-3 text-fg-3" aria-hidden />
                {t("privacy.label")}
              </span>
              <span className="block text-[12px] text-fg-3">{t("list.privateHint")}</span>
            </span>
            <Switch checked={priv} onCheckedChange={setPriv} aria-label={t("privacy.label")} />
          </label>
        </div>
      </form>
    </Dialog>
  );
}
