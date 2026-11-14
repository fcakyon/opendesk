import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";

/** A row's tick inside its link: ticking selects the row and never opens it. */
export function RowCheck({ checked, onChange, name }: { checked: boolean; onChange: () => void; name: string }) {
  const { t } = useTranslation("contacts");
  return (
    <span
      className="flex size-6 items-center justify-center"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} aria-label={t("bulk.selectRow", { name })} />
    </span>
  );
}

/** The header's tick: every loaded row, or none. */
export function HeaderCheck({ checked, onChange }: { checked: boolean | "indeterminate"; onChange: () => void }) {
  const { t } = useTranslation("contacts");
  return <Checkbox checked={checked} onCheckedChange={onChange} aria-label={t("bulk.selectPage")} />;
}
