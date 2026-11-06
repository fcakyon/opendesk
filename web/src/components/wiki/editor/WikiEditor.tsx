// The wiki's block editor: the page body as Notion and Obsidian write it. "/" for any
// block, "[[" to link a page, "@" for people, pages and dates, ":" for emoji, a handle
// beside each block to drag it or open its menu, and a toolbar over selected text. It
// keeps RichEditor's handle (focus, setHtml) so the page's saver works with either.

import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import "katex/dist/katex.min.css";
import { toast } from "@/components/ui/toast";
import type { RichEditorHandle } from "@/components/editor/RichEditor";
import type { Member, WikiNode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { useWikiTree } from "../hooks";
import { BubbleToolbar } from "./bubble";
import { WikiEditorContext, type WikiEditorEnv } from "./context";
import { wikiExtensions } from "./extensions";
import { BlockHandle } from "./handle";
import { WikiMenuPopup } from "./menu";
import "./wiki-editor.css";

export type WikiEditorProps = {
  value: string;
  onChange?: (html: string) => void;
  editable: boolean;
  placeholder: string;
  ariaLabel: string;
  env: WikiEditorEnv;
  /** Makes a subpage of this page ("/page", "[[new"), resolving to its id. */
  createSubpage: (title?: string) => Promise<string | null>;
  /** "Copy link to block": the page saves first, so the block's id is kept. */
  onCopyBlockLink: (blockId: string) => void;
  className?: string;
  contentClassName?: string;
  onReady?: (editor: Editor) => void;
};

export const WikiEditor = forwardRef<RichEditorHandle, WikiEditorProps>(function WikiEditor(props, ref) {
  const { t } = useTranslation("wiki");
  const { tree } = useWikiTree();
  const members = useQuery(q.members());

  // The menus read these when they open, so they never go stale.
  const live = useRef({ props, pages: [] as WikiNode[], members: [] as Member[] });
  live.current = { props, pages: [...tree.byId.values()], members: members.data ?? [] };

  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);

  const extensions = useMemo(
    () =>
      wikiExtensions({
        placeholder: () => live.current.props.placeholder,
        sources: {
          t,
          untitled: t("untitled"),
          pages: () => live.current.pages,
          members: () => live.current.members,
          pageId: () => live.current.props.env.pageId,
          createSubpage: (title) => live.current.props.createSubpage(title),
          pickImage: () => fileRef.current?.click(),
        },
      }),
    // The extension set is made once per editor; everything it reads is in `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: props.value,
    editable: props.editable,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: cn("tiptap prose-od wiki-prose min-h-[280px] px-0", props.contentClassName),
        "aria-label": props.ariaLabel,
        "data-ph-mask": "true",
      },
      handleDrop: (_view, event, _slice, moved) => {
        // Files dropped from the desktop: images inline, anything else as a file block.
        const files = event.dataTransfer?.files;
        if (moved || !files?.length || !live.current.props.editable) return false;
        event.preventDefault();
        void uploadFiles([...files]);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !live.current.props.editable) return false;
        void uploadFiles(files);
        return true;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      // Ids added to blocks as a page loads (UniqueID) are not an edit: nothing is saved
      // until someone writes. Their next save carries the ids.
      if (transaction.getMeta("addToHistory") === false || transaction.getMeta("__uniqueIDTransaction")) return;
      live.current.props.onChange?.(editor.isEmpty ? "" : editor.getHTML());
    },
  });
  editorRef.current = editor;

  async function uploadFiles(files: File[]) {
    const ed = editorRef.current;
    if (!ed) return;
    for (const f of files.slice(0, 10)) {
      try {
        const a = await live.current.props.env.upload(f);
        if (a.content_type.startsWith("image/")) ed.chain().focus().setImage({ src: a.url, alt: f.name.replace(/\.[^.]+$/, "") }).run();
        else if (a.content_type.startsWith("video/")) ed.chain().focus().insertContent({ type: "video", attrs: { src: a.url, name: a.filename } }).run();
        else if (a.content_type.startsWith("audio/")) ed.chain().focus().insertContent({ type: "audio", attrs: { src: a.url, name: a.filename } }).run();
        else ed.chain().focus().insertContent({ type: "file", attrs: { src: a.url, name: a.filename, size: a.size_bytes, mime: a.content_type } }).run();
      } catch (e) {
        toast.error(e, t("page.uploadFailed"));
      }
    }
  }

  useEffect(() => {
    if (editor) props.onReady?.(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(props.editable, false);
  }, [props.editable, editor]);

  useImperativeHandle(
    ref,
    () => ({
      editor,
      focus: () => editor?.commands.focus("end"),
      clear: () => editor?.commands.clearContent(true),
      insertHtml: (html) => editor?.chain().focus().insertContent(html).run(),
      setHtml: (html, opts) => editor?.commands.setContent(html, { emitUpdate: !opts?.silent }),
      isEmpty: () => editor?.isEmpty ?? true,
    }),
    [editor],
  );

  return (
    <WikiEditorContext.Provider value={props.env}>
      <div className={cn("wiki-editor relative", props.className)}>
        <EditorContent editor={editor} />
        {editor && props.editable && (
          <>
            <BlockHandle editor={editor} onCopyLink={props.onCopyBlockLink} />
            <BubbleToolbar editor={editor} />
          </>
        )}
        <WikiMenuPopup />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          multiple
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void uploadFiles(files);
          }}
        />
      </div>
    </WikiEditorContext.Provider>
  );
});
