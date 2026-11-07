// Printing a wiki page, or saving it as a PDF from the print dialog: a copy of the page (its
// cover, icon, title and text) alone on paper, in the light theme, without the app around it
// or the editor's controls. Anything marked `data-print="hide"` stays off the paper.
//
// The page's menu calls `printWikiPage(root)` with the element holding the cover and the
// article (marked `data-wiki-print`); Mod+P in the editor finds it with printRootOf.

const BOX = "wiki-print";

/** The part of the page that prints: the closest `[data-wiki-print]`, else the article's parent. */
export function printRootOf(el: Element | null): HTMLElement | null {
  if (!el) return null;
  const marked = el.closest<HTMLElement>("[data-wiki-print]");
  if (marked) return marked;
  const article = el.closest("article");
  return article?.parentElement ?? (article as HTMLElement | null);
}

/** Readies the copy for paper: the title as text, no controls, no frames, nothing editable. */
export function paperCopy(root: HTMLElement): HTMLElement {
  const copy = root.cloneNode(true) as HTMLElement;
  // Text fields copy their value only as typed: take it from the page itself.
  const fields = root.querySelectorAll("textarea");
  copy.querySelectorAll("textarea").forEach((ta, i) => {
    const h = document.createElement("h1");
    h.className = "wiki-print-title";
    h.textContent = fields[i]?.value ?? ta.value;
    ta.replaceWith(h);
  });
  copy.querySelectorAll('[data-print="hide"], iframe, input, script, [role="toolbar"], .wiki-handle').forEach((el) => el.remove());
  copy.querySelectorAll("[contenteditable]").forEach((el) => el.setAttribute("contenteditable", "false"));
  // Folded toggles print open: paper can't unfold them.
  copy.querySelectorAll(".wiki-toggle").forEach((el) => el.classList.add("is-open"));
  return copy;
}

/**
 * Prints the page under root (printRootOf). `breakBeforeH1` starts each top heading on a new
 * sheet. The copy goes once the dialog closes.
 */
export function printWikiPage(root: HTMLElement | null, opts: { breakBeforeH1?: boolean } = {}) {
  if (!root) return window.print();
  document.getElementById(BOX)?.remove();
  const box = document.createElement("div");
  box.id = BOX;
  box.className = opts.breakBeforeH1 ? "wiki-print break-h1" : "wiki-print";
  box.setAttribute("aria-hidden", "true");
  box.append(paperCopy(root));
  document.body.append(box);
  const html = document.documentElement;
  const dark = html.classList.contains("dark");
  const scheme = html.style.colorScheme;
  // Paper is white: the light theme's tokens for the time the dialog is open.
  html.classList.remove("dark");
  html.style.colorScheme = "light";
  html.classList.add("wiki-printing");
  const done = () => {
    window.removeEventListener("afterprint", done);
    box.remove();
    html.classList.remove("wiki-printing");
    html.classList.toggle("dark", dark);
    html.style.colorScheme = scheme;
  };
  window.addEventListener("afterprint", done);
  window.print();
}
