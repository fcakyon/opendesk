// #tags in a page's text, as Obsidian shows them: drawn as a tag where they are typed (a
// decoration, the text stays plain), and opening the tag's pages on a click when reading or
// on Mod+click when writing. The API reads the same pattern from the saved text.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TAG } from "@/lib/wiki/links";

function decorate(doc: PMNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || !node.text || node.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
    if (parent?.type.name === "codeBlock") return;
    for (const m of node.text.matchAll(TAG)) {
      const start = pos + (m.index ?? 0) + m[0].indexOf("#");
      const tag = m[1].toLowerCase().replace(/^[/-]+|[/-]+$/g, "");
      out.push(Decoration.inline(start, start + 1 + m[1].length, { class: "wiki-tag", "data-tag": tag }));
    }
  });
  return DecorationSet.create(doc, out);
}

export const TagMarks = Extension.create<{ onOpen: (tag: string) => void }>({
  name: "wikiTags",
  addOptions: () => ({ onOpen: () => {} }),
  addProseMirrorPlugins() {
    const open = (tag: string) => this.options.onOpen(tag);
    return [
      new Plugin({
        key: new PluginKey("wiki-tags"),
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest?.(".wiki-tag");
            const tag = el?.getAttribute("data-tag");
            if (!tag || (view.editable && !(event.metaKey || event.ctrlKey))) return false;
            event.preventDefault();
            open(tag);
            return true;
          },
        },
      }),
    ];
  },
});
