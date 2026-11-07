// The way back up from a page, in its header: the area's home, then the page's parents.
// A deep path keeps its first and last parents and folds the ones between into a menu; on a
// phone only the parent shows, as a back link, so the way up is always one tap.

import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import type { WikiArea } from "@/lib/api/types";
import { areaHome, pageTo } from "@/lib/wiki/area";
import { useTitle } from "./hooks";

/** A parent in the path: what the tree or the page's own breadcrumbs say. */
export type PathPage = { id: string; title: string; icon?: string };

const crumbLink = "flex min-w-0 max-w-[180px] items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg";

/** Parents shown in full before the middle ones fold. */
const KEEP = 3;

export function PageCrumbs({ area, isPrivate, parents }: { area: WikiArea; isPrivate: boolean; parents: PathPage[] }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const navigate = useNavigate();
  const home = area === "pages" ? t("pages.title") : t("title");
  const parent = parents[parents.length - 1];
  const folded = parents.length > KEEP ? parents.slice(1, -1) : [];
  const shown = folded.length ? [parents[0], null, parents[parents.length - 1]] : parents;
  return (
    <>
      {/* On a phone: the parent, or the area's home, as a back link. */}
      {parent ? (
        <Link {...pageTo({ id: parent.id, area })} className={`${crumbLink} -ml-1 sm:hidden`} aria-label={t("page.backTo", { title: title(parent.title) })}>
          <ChevronLeft className="size-3.5 shrink-0" />
          <span className="truncate">{title(parent.title)}</span>
        </Link>
      ) : (
        <Link to={areaHome(area)} className={`${crumbLink} -ml-1 sm:hidden`} aria-label={t("page.backTo", { title: home })}>
          <ChevronLeft className="size-3.5 shrink-0" />
          <span className="truncate">{home}</span>
        </Link>
      )}
      <Link to={areaHome(area)} className="hidden shrink-0 rounded-md px-1.5 py-0.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg sm:inline">
        {home}
      </Link>
      {isPrivate && (
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          <span className="text-fg-4">/</span>
          <span className="flex items-center gap-1 px-1.5 text-fg-3">
            <Lock className="size-3" />
            {t("sidebar.private")}
          </span>
        </span>
      )}
      {shown.map((c, i) =>
        c ? (
          <span key={c.id} className="hidden min-w-0 items-center gap-1 sm:flex">
            <span className="text-fg-4">/</span>
            <Link {...pageTo({ id: c.id, area })} className={crumbLink}>
              {c.icon && <span aria-hidden>{c.icon}</span>}
              <span className="truncate">{title(c.title)}</span>
            </Link>
          </span>
        ) : (
          <span key={`fold-${i}`} className="hidden shrink-0 items-center gap-1 sm:flex">
            <span className="text-fg-4">/</span>
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label={t("page.morePath", { count: folded.length })} className="rounded-md px-1.5 py-0.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                  …
                </button>
              </MenuTrigger>
              <MenuContent align="start">
                {folded.map((f) => (
                  <MenuItem key={f.id} icon={f.icon ? <span aria-hidden>{f.icon}</span> : undefined} onSelect={() => void navigate(pageTo({ id: f.id, area }))}>
                    {title(f.title)}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </span>
        ),
      )}
    </>
  );
}
