// Mermaid diagrams for code blocks in Mermaid (code.tsx). The library is large, so it loads
// the first time a page has a diagram. It draws at securityLevel "strict" (its own sanitizing:
// no scripts, no click handlers, no HTML labels), in the light or dark theme the reader has.

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

/** The diagram as SVG. Draws one at a time: the theme is set for the whole library. */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const run = async () => {
    const mermaid = await (loading ??= import("mermaid").then((m) => m.default));
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: getComputedStyle(document.body).fontFamily, suppressErrorRendering: true });
    const id = `wiki-mermaid-${++seq}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      // A failed draw can leave its scratch element behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
