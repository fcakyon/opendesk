// Exporting from the wiki (contracts/wiki.md "Import and export"): a page as Markdown or HTML,
// with its subpages as a zip, and the whole wiki as a zip. Downloads go through the API client
// with the session's token, then the browser saves the file under the name the API gave it.

import { Download as DownloadIcon, FileCode, FileText, ListTree } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MenuCheckItem, MenuItem, MenuSeparator, MenuSub } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError, type Download } from "@/lib/api/client";
import type { WikiExportFormat, WikiKind } from "@/lib/api/types";
import { useArea } from "@/lib/wiki/area";
import { pageExportName, saveBlob, wikiExportName } from "@/lib/wiki/port";

/** Runs a download and saves it; a zip says it is being put together, since it can take a while. */
function useDownload() {
  const { t } = useTranslation("wiki");
  return async (run: () => Promise<Download>, fallbackName: string, zip: boolean) => {
    const note = zip ? toast.info(t("export.started")) : undefined;
    try {
      const { blob, filename } = await run();
      saveBlob(blob, filename ?? fallbackName);
    } catch (e) {
      toast.error(isApiError(e) && e.detail && e.code !== "network_error" ? e.detail : errorMessage(e, t("export.failed")));
    } finally {
      if (note !== undefined) toast.dismiss(note);
    }
  };
}

/** "Export" in a page's menu: Markdown or HTML, and its subpages too when it has some. */
export function ExportPageItems({ page, hasSubpages }: { page: { id: string; title: string; kind?: WikiKind }; hasSubpages: boolean }) {
  const { t } = useTranslation("wiki");
  const download = useDownload();
  const [subpages, setSubpages] = useState(false);
  const zip = hasSubpages && subpages;
  const run = (format: WikiExportFormat) => void download(() => api.wiki.exportPage(page.id, format, zip), pageExportName(page, format, zip), zip);
  return (
    <MenuSub icon={<DownloadIcon />} label={t("export.action")}>
      <MenuItem icon={<FileText />} onSelect={() => run("markdown")}>
        {t("export.markdown")}
      </MenuItem>
      <MenuItem icon={<FileCode />} onSelect={() => run("html")}>
        {t("export.html")}
      </MenuItem>
      {hasSubpages && (
        <>
          <MenuSeparator />
          <MenuCheckItem icon={<ListTree />} checked={subpages} onSelect={() => setSubpages(!subpages)}>
            {t("export.subpages")}
          </MenuCheckItem>
        </>
      )}
    </MenuSub>
  );
}

/** "Export the wiki" (or Pages, in Pages' area): every page of the area the person sees, as a zip. */
export function ExportWikiItems() {
  const { t } = useTranslation("wiki");
  const download = useDownload();
  const area = useArea();
  const run = (format: WikiExportFormat) => void download(() => api.wiki.exportAll(format, area), wikiExportName(new Date(), area), true);
  return (
    <MenuSub icon={<DownloadIcon />} label={area === "pages" ? t("export.pages") : t("export.wiki")}>
      <MenuItem icon={<FileText />} onSelect={() => run("markdown")}>
        {t("export.markdown")}
      </MenuItem>
      <MenuItem icon={<FileCode />} onSelect={() => run("html")}>
        {t("export.html")}
      </MenuItem>
    </MenuSub>
  );
}
