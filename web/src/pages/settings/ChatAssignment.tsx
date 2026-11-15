// Settings > Assignment's "Live chats": live chats get their own rule (round robin or load
// balanced, among the members holding a skill), apart from the rules emails follow
// (contracts/api.md "Assignment").

import { useTranslation } from "react-i18next";
import { Row, Section } from "@/components/layout";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AssignMode, Assignment, Skill } from "@/lib/api/types";

const CHAT_MODES: AssignMode[] = ["none", "round_robin", "load_balanced"];
/** The Select's value for "anyone in the pool" (a skill id is never empty). */
const ANYONE = "anyone";

export function ChatAssignmentSection({
  a,
  skills,
  canEdit,
  onChange,
}: {
  a: Assignment | undefined;
  skills: Skill[] | undefined;
  canEdit: boolean;
  onChange: (b: Partial<Assignment>) => void;
}) {
  const { t } = useTranslation("settingsInbox");
  const mode = a?.chat_mode ?? "none";
  const skill = a?.chat_skill_id || null; // "" while clearing
  // An archived skill still shows when it is the one set, so it can be changed.
  const offered = (skills ?? []).filter((s) => !s.archived || s.id === skill);
  const name = (skills ?? []).find((s) => s.id === skill)?.name;
  return (
    <Section title={t("assignment.chat.title")} description={t("assignment.chat.hint")}>
      {!a ? (
        <div className="py-4">
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : (
        <>
          <Row label={t("assignment.chat.mode")} description={t(`assignment.chat.modes.${mode}`)}>
            <Select
              size="sm"
              className="w-[180px]"
              aria-label={t("assignment.chat.mode")}
              disabled={!canEdit}
              value={mode}
              onChange={(chat_mode) => onChange({ chat_mode })}
              options={CHAT_MODES.map((m) => ({ value: m, label: t(`assignment.modes.${m}.label`) }))}
            />
          </Row>
          {mode !== "none" && (
            <Row
              label={t("assignment.chat.skill")}
              description={skill ? t("assignment.chat.skillOn", { name: name ?? "…" }) : offered.length ? t("assignment.chat.skillOff") : t("assignment.chat.noSkills")}
            >
              {canEdit ? (
                <Select
                  size="sm"
                  className="w-[180px]"
                  aria-label={t("assignment.chat.skill")}
                  value={skill ?? ANYONE}
                  onChange={(v) => onChange({ chat_skill_id: v === ANYONE ? "" : v })}
                  options={[{ value: ANYONE, label: t("assignment.chat.anyone") }, ...offered.map((s) => ({ value: s.id, label: s.name }))]}
                />
              ) : (
                <span className="text-[12.5px] text-fg-2">{skill ? name : t("assignment.chat.anyone")}</span>
              )}
            </Row>
          )}
          {mode !== "none" && a.auto_away_minutes === 0 && <p className="pb-2 text-[12px] text-fg-3">{t("assignment.chat.awayTip")}</p>}
        </>
      )}
    </Section>
  );
}
