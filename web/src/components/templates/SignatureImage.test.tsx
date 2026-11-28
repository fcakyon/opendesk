// A picture in a signature from the editor's own picture button, uploaded to a public
// address as it goes in (not when it is picked), inserted at a signature size with a
// description, and kept in the visual editor while it is a plain sized picture.
// Through the app's own query and HTTP clients: only fetch is replaced.
import type { Editor } from "@tiptap/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { WorkspaceQueryClient } from "@/lib/queryClient";
import { useSession } from "@/lib/session";
import { altFromFileName, defaultWidth, signatureImageHtml, widthChoices } from "./SignatureImage";
import { SignatureEditor } from "./SignatureEditor";
import { hasHtmlImage, htmlReasons, needsHtml } from "./TemplateEditor";

const URL_ = "https://api.example.test/v1/images/6f1d3c1e-58b2-4f7a-9d55-0d0b7b0c4c11";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root | null = null;
let uploads: FormData[];
let upload: () => Response;
let drawn: HTMLCanvasElement[];
let objectUrls: { mock: { calls: unknown[] } };

// ProseMirror scrolls the selection into view after an insert; jsdom has no layout.
const rect = () => ({ height: 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = rect;
document.elementFromPoint = () => null;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  uploads = [];
  upload = () => json({ url: URL_, width: 600, height: 150 }, 201);
  // The preview of a picture chosen is drawn from the file's pixels (jsdom decodes no pictures
  // and draws nothing): a 600 x 150 logo, and nothing for a file that is not a picture.
  drawn = [];
  vi.stubGlobal("createImageBitmap", (f: File) =>
    f.type.startsWith("image/") ? Promise.resolve({ width: 600, height: 150, close() {} }) : Promise.reject(new DOMException("not a picture", "InvalidStateError")),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: () => drawn.push(this) } as never;
  });
  // No address is ever made from the file chosen.
  objectUrls = vi.spyOn(URL, "createObjectURL");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/signature-images") && init?.method === "POST") {
      uploads.push(init.body as FormData);
      return Promise.resolve(upload());
    }
    if (url.includes("/v1/templates/variables")) return Promise.resolve(json({ variables: [], slots: [], filters: [] }));
    return Promise.resolve(json({ title: "Not found" }, 404));
  });
  useSession.setState({ user: { id: "u9", name: "Lea", email: "lea@margin.test" } as never,
    memberships: [{ workspace: { id: "w" }, role: "agent" }] as never, workspaceId: "w" });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  useSession.setState({ memberships: [], workspaceId: null, user: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(ok: () => boolean) {
  for (let i = 0; i < 60 && !ok(); i++) await wait(25);
}

/** The personal signature editor, as Profile → Signature mounts it, with what it saves. */
async function mount(initial: string, opts: { disabled?: boolean } = {}) {
  const saved: string[] = [];
  function Host() {
    const [v, setV] = useState(initial);
    return (
      <SignatureEditor
        kind="personal_signature"
        value={v}
        onChange={(h) => {
          saved.push(h);
          setV(h);
        }}
        ariaLabel="Signature"
        disabled={opts.disabled}
      />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new WorkspaceQueryClient()}>
        <TooltipProvider>
          <ConfirmProvider>
            <Host />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  const editor = () => (host.querySelector(".tiptap") as (HTMLElement & { editor?: Editor }) | null)?.editor ?? null;
  return { host, saved, editor };
}

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byText = (sel: string, text: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text) ?? null;
const htmlArea = () => byLabel("Signature (HTML)");
const setInput = async (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
async function pick(name: string, type = "image/png") {
  const input = byLabel("Picture file") as HTMLInputElement;
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await until(() => !!document.querySelector(`[role="dialog"] canvas`) || !type.startsWith("image/"));
}

describe("a sized picture stays in the visual editor", () => {
  it("is not a reason for HTML", () => {
    const sig = `<p>Kind regards</p><img src="${URL_}" alt="Acme" width="200" height="50">`;
    expect(needsHtml(sig)).toBe(false);
    expect(htmlReasons(sig)).toEqual([]);
    // What the visual editor cannot keep still opens as HTML.
    expect(needsHtml(`<table><tr><td>x</td></tr></table>`)).toBe(true);
    expect(needsHtml(`<p style="color:red">x</p>`)).toBe(true);
    expect(needsHtml(`<p>x</p><img src='${URL_}' alt="A > B" title="Acme" width=120 height="30" />`)).toBe(false);
  });

  it("does not with anything more than a source, a description, a title and a size in pixels", () => {
    for (const extra of [`border="0"`, `align="left"`, `hspace="8"`, `vspace="4"`, `class="logo"`, `usemap="#m"`, `ismap`, `BORDER=0`, `width="50%"`, `height="auto"`]) {
      const sig = `<p>Kind regards</p><img src="${URL_}" alt="Acme" width="200" ${extra}>`;
      expect(hasHtmlImage(sig), extra).toBe(true);
      expect(needsHtml(sig), extra).toBe(true);
      expect(htmlReasons(sig), extra).toEqual(["pictures with HTML attributes"]);
    }
    // Only an <img> counts: the same words elsewhere do not.
    expect(needsHtml(`<p>align="left" class="x"</p><img src="${URL_}" alt="class=logo">`)).toBe(false);
  });

  it("opens in the HTML mode with what the visual editor would drop, and stays there", async () => {
    await mount(`<p>Kind regards</p><img src="${URL_}" alt="Acme" width="200" height="50" border="0" align="left" hspace="8">`);
    expect(htmlArea()).not.toBeNull();
    expect(document.body.textContent).toContain("pictures with HTML attributes");
    expect((htmlArea() as HTMLTextAreaElement).value).toContain(`border="0" align="left" hspace="8"`);
  });

  it("opens in the visual editor with its size and description", async () => {
    const { editor } = await mount(`<p>Kind regards</p><img src="${URL_}" alt="Acme" width="200" height="50">`);
    expect(htmlArea()).toBeNull();
    const img = document.querySelector<HTMLImageElement>(".tiptap img")!;
    expect(img.getAttribute("width")).toBe("200");
    expect(img.getAttribute("height")).toBe("50");
    expect(img.getAttribute("alt")).toBe("Acme");
    expect(editor()!.getHTML()).toContain(`width="200" height="50"`);
  });
});

describe("the picture button", () => {
  it("shows in the signature's compact toolbar, not when it cannot be changed", async () => {
    await mount("<p>Lea</p>");
    expect(byLabel("Image")).not.toBeNull();
    // Inline formatting only: no headings in a signature.
    expect(byLabel("Heading")).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await mount("<p>Lea</p>", { disabled: true });
    expect(byLabel("Image")).toBeNull();
  });

  it("uploads a picture and inserts it at a signature size with a description, still visual", async () => {
    const { saved } = await mount("<p>Lea</p>");
    await act(async () => byLabel("Image")!.click());
    expect(byText("h2", "Add a picture")).not.toBeNull();
    const insert = byText('[role="dialog"] button', "Insert") as HTMLButtonElement;
    expect(insert.disabled).toBe(true);

    await pick("acme-logo_2x.png");
    // Drawn from the device's file, not loaded from an address: nothing is uploaded until it goes in.
    const preview = document.querySelector<HTMLCanvasElement>('[role="dialog"] canvas')!;
    expect(drawn).toEqual([preview]);
    expect([preview.width, preview.height]).toEqual([600, 150]);
    expect(preview.style.width).toBe("200px");
    expect(preview.getAttribute("aria-label")).toBe("acme logo 2x");
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
    expect(objectUrls.mock.calls).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    // Medium by default; the description starts from the file name.
    expect(byText('[role="radio"]', "Medium · 200 px")!.getAttribute("aria-checked")).toBe("true");
    const alt = document.querySelector<HTMLInputElement>('[role="dialog"] input:not([type="file"])')!;
    expect(alt.value).toBe("acme logo 2x");

    // Without a description it cannot go in.
    await setInput(alt, "  ");
    expect((byText('[role="dialog"] button', "Insert") as HTMLButtonElement).disabled).toBe(true);
    await setInput(alt, "Acme logo");
    await act(async () => byText('[role="radio"]', "Small · 120 px")!.click());
    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !document.querySelector('[role="dialog"]'));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(uploads).toHaveLength(1);
    expect((uploads[0].get("file") as File).name).toBe("acme-logo_2x.png");
    const last = saved[saved.length - 1];
    expect(last).toContain(`<img src="${URL_}" alt="Acme logo" width="120" height="30">`);
    expect(needsHtml(last)).toBe(false);
    await wait(30);
    expect(htmlArea()).toBeNull();
  });

  it("uploads nothing for a picture replaced or a dialog cancelled, only the one that goes in", async () => {
    const { saved } = await mount("<p>Lea</p>");
    await act(async () => byLabel("Image")!.click());
    await pick("first.png");
    await pick("second.png");
    await act(async () => (byText('[role="dialog"] button', "Cancel") as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(saved).toEqual([]);

    await act(async () => byLabel("Image")!.click());
    await pick("third.png");
    await pick("fourth.png");
    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !document.querySelector('[role="dialog"]'));
    expect(uploads.map((f) => (f.get("file") as File).name)).toEqual(["fourth.png"]);
    // The description kept from the first file chosen.
    expect(saved[saved.length - 1]).toContain(`<img src="${URL_}" alt="third" width="200" height="50">`);
  });

  it("says why an upload failed and inserts nothing", async () => {
    upload = () => json({ status: 422, title: "Unprocessable Entity", detail: "Use a PNG, JPEG, GIF or WebP picture.", code: "unsupported_image" }, 422);
    const { saved } = await mount("<p>Lea</p>");
    await act(async () => byLabel("Image")!.click());
    await pick("notes.pdf", "application/pdf");
    // Not a picture: nothing drawn, and the server says why.
    expect(document.querySelector('[role="dialog"] canvas')).toBeNull();
    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !!document.querySelector('[role="dialog"] [role="alert"]'));
    expect(document.querySelector('[role="dialog"] [role="alert"]')!.textContent).toContain("Use a PNG, JPEG, GIF or WebP picture.");
    // Still open, to choose another picture.
    expect(byText('[role="dialog"] button', "Replace the picture")).not.toBeNull();
    expect(saved).toEqual([]);
  });

  it("changes the size and description of the picture selected", async () => {
    const { saved, editor } = await mount(`<p>Lea</p><img src="${URL_}" alt="Logo" width="200" height="50">`);
    let pos = -1;
    editor()!.state.doc.descendants((n, p) => {
      if (n.type.name === "image") pos = p;
    });
    await act(async () => editor()!.commands.setNodeSelection(pos));
    await act(async () => byLabel("Image")!.click());
    expect(byText("h2", "Picture")).not.toBeNull();
    const alt = document.querySelector<HTMLInputElement>('[role="dialog"] input:not([type="file"])')!;
    expect(alt.value).toBe("Logo");
    await setInput(alt, "Acme");
    await act(async () => byText('[role="radio"]', "Large · 300 px")!.click());
    await act(async () => (byText('[role="dialog"] button', "Apply") as HTMLButtonElement).click());
    expect(uploads).toHaveLength(0);
    const last = saved[saved.length - 1];
    expect(last).toContain(`alt="Acme" width="300" height="75"`);
    expect(last.match(/<img/g)).toHaveLength(1);
  });

  it("goes in at the caret in the HTML mode too", async () => {
    const { saved } = await mount(`<table><tr><td>Lea</td></tr></table>`);
    expect(htmlArea()).not.toBeNull();
    await act(async () => byLabel("Image")!.click());
    await pick("logo.png");
    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !document.querySelector('[role="dialog"]'));
    expect(saved[saved.length - 1]).toContain(`<img src="${URL_}" alt="logo" width="200" height="50">`);
  });

  it("never turns a file name or a description with <, \" or & into markup", async () => {
    const { saved } = await mount(`<table><tr><td>Lea</td></tr></table>`);
    await act(async () => byLabel("Image")!.click());
    await pick(`<img src=x onerror=alert(1)>&"logo".png`);
    const dialog = document.querySelector('[role="dialog"]')!;
    const alt = dialog.querySelector<HTMLInputElement>('input:not([type="file"])')!;
    expect(alt.value).toBe("img src=x onerror=alert(1)&logo");
    // The preview is drawn, with the description as its plain-text label.
    expect(dialog.querySelectorAll("img")).toHaveLength(0);
    const text = `"Hi" <b>you</b> & <img src=x onerror=alert(1)>`;
    await setInput(alt, text);
    expect(dialog.querySelector("canvas")!.getAttribute("aria-label")).toBe(text);
    expect(dialog.querySelectorAll("b, img")).toHaveLength(0);
    expect(objectUrls.mock.calls).toHaveLength(0);

    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !document.querySelector('[role="dialog"]'));
    // In the HTML it goes in as one attribute value, escaped.
    const last = saved[saved.length - 1];
    expect(last).toContain(`<img src="${URL_}" alt="&quot;Hi&quot; &lt;b>you&lt;/b> &amp; &lt;img src=x onerror=alert(1)>" width="200" height="50">`);
    expect(last.match(/<img/g)).toHaveLength(1);
    expect(last).not.toContain("<b>");
  });

  it("keeps a description with <, \" or & as text in the visual editor", async () => {
    const { saved, editor } = await mount("<p>Lea</p>");
    await act(async () => byLabel("Image")!.click());
    await pick("logo.png");
    const text = `"Hi" <b>you</b> & co`;
    await setInput(document.querySelector<HTMLInputElement>('[role="dialog"] input:not([type="file"])')!, text);
    await act(async () => (byText('[role="dialog"] button', "Insert") as HTMLButtonElement).click());
    await until(() => !document.querySelector('[role="dialog"]'));
    const imgs = document.querySelectorAll<HTMLImageElement>(".tiptap img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("alt")).toBe(text);
    expect(document.querySelectorAll(".tiptap b")).toHaveLength(0);
    expect(editor()!.getHTML()).toContain(`alt="&quot;Hi&quot; &lt;b&gt;you&lt;/b&gt; &amp; co"`);
    expect(saved[saved.length - 1]).not.toContain("<b>");
  });
});

describe("helpers", () => {
  it("offers no size larger than the picture", () => {
    expect(widthChoices(600)).toEqual([120, 200, 300]);
    expect(widthChoices(250)).toEqual([120, 200]);
    expect(widthChoices(90)).toEqual([90]);
    expect(defaultWidth(600)).toBe(200);
    expect(defaultWidth(150)).toBe(120);
    expect(defaultWidth(90)).toBe(90);
  });

  it("writes a safe tag and a readable first description", () => {
    expect(altFromFileName("acme-logo_2x.png")).toBe("acme logo 2x");
    expect(altFromFileName('<b>"x".jpg')).toBe("bx");
    expect(signatureImageHtml({ src: "https://x.test/a?b=1&c=2", alt: `"Hi" <you>`, width: 120 })).toBe(
      `<img src="https://x.test/a?b=1&amp;c=2" alt="&quot;Hi&quot; &lt;you>" width="120">`,
    );
  });
});
