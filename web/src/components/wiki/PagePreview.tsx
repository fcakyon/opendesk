// A page's preview, shown while the pointer rests on a link to it (Obsidian's page
// preview, Notion's link hover): its icon, title, where it sits and how it starts. The page
// is read only once someone hovers, and stays cached like any opened page.

import { useQuery } from "@tanstack/react-query";
import { HoverCard as H } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { floatingPanel } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { relLong } from "@/lib/format";
import { q } from "@/lib/queries";
import { useNow } from "@/lib/useNow";
import { coverStyle } from "./covers";
import { useTitle } from "./hooks";
import { PageIcon } from "./PageTree";

/** The first lines of a body as plain text. */
export function excerpt(html: string, max = 320): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("p, h1, h2, h3, li, blockquote, pre, td").forEach((el) => el.append(" "));
  const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s\S*$/, "")}…` : text;
}

export function PagePreview({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <H.Root openDelay={450} closeDelay={120} open={open} onOpenChange={setOpen}>
      <H.Trigger asChild>{children}</H.Trigger>
      <H.Portal>
        <H.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} className={cn(floatingPanel, "z-[70] w-[340px] overflow-hidden p-0")}>
          {open && <PreviewBody id={id} />}
        </H.Content>
      </H.Portal>
    </H.Root>
  );
}

function PreviewBody({ id }: { id: string }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const now = useNow();
  const { data: page, isLoading, isError } = useQuery({ ...q.wikiPage(id), staleTime: 30_000 });
  if (isLoading)
    return (
      <div className="p-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-5/6" />
      </div>
    );
  if (isError || !page) return <p className="p-4 text-[12.5px] text-fg-3">{t("editor.pageGone")}</p>;
  const cover = coverStyle(page.cover);
  const text = excerpt(page.body_html);
  return (
    <div>
      {cover && (
        <div className="wiki-cover-gradient h-14 w-full" style={cover.background ? { background: cover.background } : undefined}>
          {cover.image && <img src={cover.image} alt="" className="size-full object-cover" style={{ objectPosition: `center ${page.cover_y}%` }} referrerPolicy="no-referrer" />}
        </div>
      )}
      <div className="px-4 pb-3.5 pt-3">
        {page.breadcrumbs.length > 0 && <p className="mb-1 truncate text-[11px] text-fg-4">{page.breadcrumbs.map((b) => title(b.title)).join(" / ")}</p>}
        <p className="flex items-center gap-1.5 text-[14px] font-semibold tracking-[-0.01em] text-fg">
          <PageIcon icon={page.icon} className="size-5 text-[16px]" />
          <span className="truncate">{title(page.title)}</span>
        </p>
        <p className={cn("mt-1.5 line-clamp-5 text-[12.5px] leading-[19px]", text ? "text-fg-2" : "text-fg-4")}>{text || t("page.bodyEmpty")}</p>
        <p className="mt-2.5 text-[11px] text-fg-4">{page.updated_by ? t("page.editedBy", { name: page.updated_by.name, when: relLong(page.updated_at, now) }) : t("page.edited", { when: relLong(page.updated_at, now) })}</p>
      </div>
    </div>
  );
}
