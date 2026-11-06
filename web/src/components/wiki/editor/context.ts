// What the wiki editor's blocks need from the page around them: who may edit, where the
// page is, and the two network calls blocks make (uploading a file, reading a link's card).

import { createContext, useContext } from "react";
import type { Attachment } from "@/lib/api/types";

export type LinkCard = { title: string; description: string; image: string; site: string };

export type WikiEditorEnv = {
  pageId: string;
  canEdit: boolean;
  upload: (file: File) => Promise<Attachment>;
  unfurl: (url: string) => Promise<LinkCard>;
};

export const WikiEditorContext = createContext<WikiEditorEnv>({
  pageId: "",
  canEdit: false,
  upload: () => Promise.reject(new Error("no upload")),
  unfurl: () => Promise.reject(new Error("no unfurl")),
});

export const useWikiEditorEnv = () => useContext(WikiEditorContext);
