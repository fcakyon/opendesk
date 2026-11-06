// Code blocks: highlighted as typed (lowlight's common languages), with the language picked
// from a searchable list and a copy button. The HTML keeps `<pre><code class="language-x">`.

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { common, createLowlight } from "lowlight";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
export const LANGUAGES = Object.keys(NAMES).filter((k) => k === "plaintext" || lowlight.registered(k));

function CodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const lang = (node.attrs.language as string | null) || "plaintext";
  const found = LANGUAGES.filter((l) => !q.trim() || NAMES[l].toLowerCase().includes(q.trim().toLowerCase()) || l.includes(q.trim().toLowerCase()));
  return (
    <NodeViewWrapper className="wiki-code group/code relative">
      <div contentEditable={false} className="absolute right-2 top-1.5 z-[1] flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/code:opacity-100">
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
      <pre>
        <NodeViewContent<"code"> as="code" className={lang !== "plaintext" ? `language-${lang}` : undefined} />
      </pre>
    </NodeViewWrapper>
  );
}

export const WikiCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true });
