// Code blocks: highlighted as typed (lowlight's common languages), with the language picked
// from a searchable list and a copy button. The HTML keeps `<pre><code class="language-x">`.
// A block in Mermaid is drawn as its diagram, with its source a toggle away.

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Check, ChevronDown, Code2, Copy, Workflow } from "lucide-react";
import { common, createLowlight } from "lowlight";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import { renderMermaid } from "./mermaid";
import { Popover } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/input";
import { copyText } from "@/components/ui/copy-button";
import { cn } from "@/lib/cn";

export const lowlight = createLowlight(common);

/** The languages offered, by the names people know them by. */
const NAMES: Record<string, string> = {
  plaintext: "Plain text",
  bash: "Bash",
  shell: "Shell",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  markdown: "Markdown",
  mermaid: "Mermaid",
  objectivec: "Objective-C",
  perl: "Perl",
  php: "PHP",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  vbnet: "VB.NET",
  wasm: "WebAssembly",
  xml: "HTML / XML",
  yaml: "YAML",
};
export const LANGUAGES = Object.keys(NAMES).filter((k) => k === "plaintext" || k === "mermaid" || lowlight.registered(k));

function CodeView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const lang = (node.attrs.language as string | null) || "plaintext";
  const diagram = lang === "mermaid";
  // A diagram shows its source while it is empty, or while the cursor is in it.
  const [source, setSource] = useState(() => diagram && editor.isEditable && !node.textContent.trim());
  useEffect(() => {
    if (!diagram) return;
    const on = () => {
      const at = getPos();
      if (typeof at !== "number") return;
      const { from, to } = editor.state.selection;
      if (from > at && to < at + node.nodeSize) setSource(true);
    };
    editor.on("selectionUpdate", on);
    return () => {
      editor.off("selectionUpdate", on);
    };
  }, [diagram, editor, getPos, node.nodeSize]);
  const found = LANGUAGES.filter((l) => !q.trim() || NAMES[l].toLowerCase().includes(q.trim().toLowerCase()) || l.includes(q.trim().toLowerCase()));
  return (
    <NodeViewWrapper className="wiki-code group/code relative">
      <div contentEditable={false} data-print="hide" className="absolute right-2 top-1.5 z-[1] flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/code:opacity-100">
        {diagram && (
          <Tooltip content={source ? t("editor.mermaid.showDiagram") : t("editor.mermaid.editSource")}>
            <button
              type="button"
              aria-label={source ? t("editor.mermaid.showDiagram") : t("editor.mermaid.editSource")}
              aria-pressed={source}
              onClick={() => setSource((v) => !v)}
              className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg [&_svg]:size-3.5"
            >
              {source ? <Workflow /> : <Code2 />}
            </button>
          </Tooltip>
        )}
        {editor.isEditable ? (
          <Popover
            open={open}
            onOpenChange={(o) => (setOpen(o), o || setQ(""))}
            align="end"
            className="w-[220px] p-0"
            trigger={
              <button type="button" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">
                {NAMES[lang] ?? lang}
                <ChevronDown className="size-3" />
              </button>
            }
          >
            <div className="border-b border-line p-1.5">
              <SearchInput autoFocus value={q} onChange={setQ} placeholder={t("editor.codeLanguage")} onKeyDown={(e) => e.key === "Enter" && found[0] && (updateAttributes({ language: found[0] }), setOpen(false))} />
            </div>
            <div className="max-h-[240px] overflow-y-auto p-1">
              {found.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => (updateAttributes({ language: l === "plaintext" ? null : l }), setOpen(false), setQ(""))}
                  className={cn("flex h-7 w-full items-center rounded-md px-2 text-left text-[12.5px] hover:bg-hover", l === lang && "font-medium")}
                >
                  {NAMES[l]}
                </button>
              ))}
            </div>
          </Popover>
        ) : (
          <span className="px-1.5 text-[11.5px] text-fg-4">{NAMES[lang] ?? lang}</span>
        )}
        <button
          type="button"
          aria-label={t("editor.copyCode")}
          onClick={() => {
            void copyText(node.textContent);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg [&_svg]:size-3.5"
        >
          {copied ? <Check className="text-tone-green" /> : <Copy />}
        </button>
      </div>
      <pre className={cn(diagram && !source && "hidden")}>
        <NodeViewContent<"code"> as="code" className={lang !== "plaintext" ? `language-${lang}` : undefined} />
      </pre>
      {diagram && <MermaidDiagram source={node.textContent} onEdit={editor.isEditable ? () => setSource(true) : undefined} />}
    </NodeViewWrapper>
  );
}

export const WikiCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true });

/** How long typing must pause before a diagram is drawn again. */
const REDRAW_DELAY = 350;

/** A Mermaid source drawn as its diagram, in the reader's theme; what can't be drawn says why. */
function MermaidDiagram({ source, onEdit }: { source: string; onEdit?: () => void }) {
  const { t } = useTranslation("wiki");
  const { dark } = useTheme();
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    if (!source.trim()) return setOut(null);
    let live = true;
    const timer = setTimeout(() => {
      renderMermaid(source, dark).then(
        (svg) => live && setOut({ svg }),
        (e: unknown) => live && setOut({ error: e instanceof Error ? e.message.split("\n")[0] : "" }),
      );
    }, REDRAW_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, dark]);
  if (!source.trim()) return null;
  return (
    <div contentEditable={false} className="wiki-mermaid" onDoubleClick={onEdit}>
      {!out ? (
        <div className="h-24 w-full animate-pulse rounded-md bg-hover motion-reduce:animate-none" />
      ) : "svg" in out ? (
        // Mermaid's own output at securityLevel "strict": sanitized, no scripts or links that run.
        <div className="wiki-mermaid-svg" role="img" aria-label={t("editor.mermaid.label")} dangerouslySetInnerHTML={{ __html: out.svg }} />
      ) : (
        <p className="text-[12.5px] text-fg-3">
          <span className="font-medium text-tone-red">{t("editor.mermaid.error")}</span> {out.error}
        </p>
      )}
    </div>
  );
}
