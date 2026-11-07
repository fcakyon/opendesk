// "Publish to help center" (contracts/api.md POST /v1/kb/articles/from-wiki): a draft
// article copied from the page, in a collection and for a brand picked here as the article
// editor picks them. Nothing stays linked: later edits of the page don't reach the article.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Folder } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KbBrandPick } from "@/components/kb/brand";
import { SinglePick } from "@/components/settings2/pickers";
import { useBrands } from "@/components/settings2/teams";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextInput } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import { q, qk } from "@/lib/queries";

const NONE = "__none";

export function PublishDialog({
  pageId,
  pageTitle,
  open,
  onOpenChange,
  beforePublish,
}: {
  pageId: string;
  pageTitle: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Saves what was typed, so the article copies the page as it reads now. */
  beforePublish: () => Promise<unknown>;
}) {
  const { t } = useTranslation("wiki");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title={t("publish.title")} description={t("publish.description")}>
      {open && <PublishForm pageId={pageId} pageTitle={pageTitle} onDone={() => onOpenChange(false)} beforePublish={beforePublish} />}
    </Dialog>
  );
}

function PublishForm({ pageId, pageTitle, onDone, beforePublish }: { pageId: string; pageTitle: string; onDone: () => void; beforePublish: () => Promise<unknown> }) {
  const { t } = useTranslation("wiki");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const collections = useQuery(q.kbCollections());
  const { multi: multiBrand } = useBrands();
  const [title, setTitle] = useState(pageTitle.trim());
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const collection = collections.data?.find((c) => c.id === collectionId);
  // An article in a collection with a brand is the collection's brand's (as the article editor says).
  const fixedBrand = collection?.brand_id ?? null;

  const publish = useMutation({
    mutationFn: async () => {
      await beforePublish();
      return api.kb.articles.fromWiki({
        page_id: pageId,
        title: title.trim(),
        ...(collectionId ? { collection_id: collectionId } : {}),
        ...(multiBrand && !fixedBrand ? { brand_id: brandId } : {}),
      });
    },
    onSuccess: ({ article, left_out }) => {
      void qc.invalidateQueries({ queryKey: qk.of("kb") });
      onDone();
      toast.success(t("publish.created"), {
        description: left_out > 0 ? t("publish.leftOut", { count: left_out }) : undefined,
        action: { label: t("publish.open"), onClick: () => void navigate({ to: "/kb/articles/$articleId", params: { articleId: article.id } }) },
      });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError(t("publish.titleRequired"));
    publish.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-fg-2">
        {t("publish.articleTitle")}
        <TextInput autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} invalid={!!error && !title.trim()} />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-fg-2">{t("publish.collection")}</span>
        <SinglePick
          items={[{ value: NONE, label: t("publish.noCollection") }, ...(collections.data ?? []).map((c) => ({ value: c.id, label: c.name, icon: <Folder /> }))]}
          value={collectionId ?? NONE}
          onChange={(v) => setCollectionId(v === NONE ? null : v)}
          placeholder={t("publish.noCollection")}
          searchPlaceholder={t("publish.searchCollections")}
        />
      </div>
      {multiBrand && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-fg-2">{t("publish.brand")}</span>
          <KbBrandPick value={fixedBrand ?? brandId} onChange={setBrandId} disabled={!!fixedBrand} />
          {fixedBrand && collection && <p className="text-xs leading-[18px] text-fg-3">{t("publish.brandFromCollection", { name: collection.name })}</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12.5px] text-tone-red">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("publish.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={publish.isPending}>
          {t("publish.submit")}
        </Button>
      </div>
    </form>
  );
}
