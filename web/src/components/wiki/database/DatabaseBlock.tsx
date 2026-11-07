// A database inside a page (the editor's database block): one of its views, picked per block,
// with the database's own controls. An empty block ("Linked view of a database") asks which
// database to show first.

import { useQuery } from "@tanstack/react-query";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Database as DatabaseIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Picker } from "@/components/ui/picker";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { PageIcon } from "../PageTree";
import { DatabaseView } from "./DatabaseView";

export function DatabaseBlockView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const id = node.attrs.id as string;
  const { data: nodes = [] } = useQuery(q.wikiTree());
  if (!id) {
    const databases = nodes.filter((n) => n.kind === "database");
    return (
      <NodeViewWrapper>
        <div contentEditable={false} className={cn("my-1", selected && "rounded-lg shadow-[0_0_0_2px_var(--focus)]")}>
          {editor.isEditable ? (
            <Picker
              items={databases.map((n) => ({ value: n.id, label: n.title.trim() || t("untitled"), icon: <PageIcon icon={n.icon} kind="database" /> }))}
              value={null}
              onSelect={(v) => updateAttributes({ id: v })}
              placeholder={t("db.pickDatabase")}
              emptyText={t("db.noDatabases")}
              width={300}
              trigger={
                <button type="button" className="flex h-11 w-full items-center gap-2.5 rounded-lg bg-hover px-3 text-left text-[13px] text-fg-3 transition-colors hover:bg-active hover:text-fg-2">
                  <DatabaseIcon className="size-4" />
                  {t("db.pickDatabase")}
                </button>
              }
            />
          ) : null}
        </div>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <div contentEditable={false} className={cn("wiki-db-block my-2 rounded-lg", selected && "shadow-[0_0_0_2px_var(--focus)]")} onKeyDown={(e) => e.stopPropagation()}>
        <DatabaseView databaseId={id} viewId={(node.attrs.view as string) || undefined} onViewChange={(v) => editor.isEditable && updateAttributes({ view: v })} inline />
      </div>
    </NodeViewWrapper>
  );
}
