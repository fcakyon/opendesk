/** @jsxImportSource preact */
/**
 * opendesk chat widget.
 *
 *   <script src="https://app.opendesk.sh/widget/v1.js" data-key="wk_..." async></script>
 *
 * Attributes: data-key (required), data-lang (force a language, e.g. "fr"),
 * data-api (API origin). Without data-api the
 * hosted script (app.opendesk.sh) talks to api.opendesk.sh, and a self-hosted
 * script talks to its own origin, which serves the API too.
 *
 * JavaScript API (calls made before the script loads are queued):
 *
 *   window.opendesk = window.opendesk || function () { (opendesk.q = opendesk.q || []).push(arguments) };
 *   opendesk("identify", { user_id, user_hash, email, name }); // user_hash = hex HMAC-SHA256(widget secret, user_id)
 *   opendesk("update", { user_id, user_hash, company: { id }, fields: { widget_plan: "pro" } }); // again, with new values
 *   opendesk("open" | "close" | "toggle");
 *   opendesk("locale", "fr");            // force a language (BCP 47)
 *   opendesk("shutdown");                 // forget the visitor and remove the widget
 *   opendesk("on", "message" | "open" | "close", callback);
 */

import { render } from "preact";
import { Controller, type EventName } from "./controller";
import { applyHostVars, DEFAULT_Z_INDEX } from "./config";
import { phoenixFactory } from "./realtime";
import { browserLanguages, matchLocale, pickLocale, setLocale } from "./i18n";
import { css } from "./styles";
import { App } from "./ui";
import type { SessionIdentity } from "./types";

type Cmd = (cmd: string, ...args: unknown[]) => void;
type Stub = Cmd & { q?: ArrayLike<unknown>[]; loaded?: boolean };

declare global {
  interface Window {
    opendesk?: Stub;
  }
}

const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[data-key][src*="widget/v1.js"]') ?? document.querySelector<HTMLScriptElement>("script[data-key]");

/** Hosted serves the app and the API on separate hosts; self-host uses one. */
function apiFor(origin: string) {
  return origin === "https://app.opendesk.sh" ? "https://api.opendesk.sh" : origin;
}

function boot() {
  if (!script || window.opendesk?.loaded) return;
  const key = script.dataset.key;
  if (!key) return;
  const base = (script.dataset.api || apiFor(new URL(script.src || location.href, location.href).origin)).replace(/\/+$/, "");

  if (__OD_WIDGET_MOCK__ && (script.dataset.mock === "1" || new URLSearchParams(location.search).has("od_mock"))) {
    void import("./mock").then((m) => {
      start(key, base, m.mockFetch, m.mockSocket);
      // Lets a proof flow play the team taking back its latest reply.
      window.addEventListener("opendesk-mock:take-back", () => m.mockTakeBack());
    });
    return;
  }
  start(key, base, (url, init) => fetch(url, init), phoenixFactory);
}

function start(key: string, base: string, fetcher: (u: string, i: RequestInit) => Promise<Response>, socketFactory: typeof phoenixFactory) {
  const c = new Controller({ base, key, fetcher, socketFactory });
  const get = () => c.store.get();
  const set = (p: Parameters<typeof c.store.set>[0]) => c.store.set(p);
  const queued = Array.from(window.opendesk?.q ?? []);

  // Language: data-lang or opendesk("locale") first, then the workspace's fixed
  // language, then the browser, then the workspace default (both known once the
  // config arrives), then English.
  const scriptUrl = script?.src || location.href;
  const queuedLocale = queued.filter((a) => a[0] === "locale").map((a) => String(a[1] ?? "")).pop();
  let explicit: string | null = matchLocale(queuedLocale) ?? matchLocale(script?.dataset.lang);
  const applyLocale = (workspace?: string | null) =>
    setLocale(pickLocale({ explicit, browser: browserLanguages(), workspace }), scriptUrl).then(() => set({ lang: pickLocale({ explicit, browser: browserLanguages(), workspace }) }));
  const firstLocale = applyLocale().catch(() => {});

  const host = document.createElement("div");
  host.setAttribute("data-opendesk-widget", "");
  host.style.cssText = `position:fixed;right:0;bottom:0;width:0;height:0;z-index:var(--oz,${DEFAULT_Z_INDEX});`;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  root.appendChild(style);
  const mount = document.createElement("div");
  root.appendChild(mount);
  document.body.appendChild(host);

  // Colour, corners, offsets and stacking order follow the config as CSS variables on the host.
  let applied: unknown = null;
  c.store.subscribe(() => {
    const cfg = get().config;
    if (cfg && cfg !== applied) {
      applied = cfg;
      applyHostVars(host, cfg);
    }
  });

  // Wait briefly for the catalog so the first paint is already translated.
  void Promise.race([firstLocale, new Promise((r) => setTimeout(r, 1200))]).then(() => render(<App c={c} />, mount));

  const api: Stub = (cmd, ...args) => {
    switch (cmd) {
      case "locale": {
        const l = matchLocale(String(args[0] ?? ""));
        if (l) {
          explicit = l;
          void applyLocale(get().config?.locale);
        }
        break;
      }
      case "identify":
      case "update": // the same call again, with new values, for pages that change without reloading
        void c.identify((args[0] ?? {}) as SessionIdentity);
        break;
      case "open":
        c.open();
        break;
      case "close":
        c.close();
        break;
      case "toggle":
        c.toggle();
        break;
      case "on":
        if (typeof args[1] === "function") c.on(args[0] as EventName, args[1] as (p?: unknown) => void);
        break;
      case "shutdown":
        c.shutdown();
        render(null, mount);
        host.remove();
        window.opendesk = undefined;
        break;
    }
  };
  api.loaded = true;
  window.opendesk = api;
  // Identify before the first session so a known user never starts anonymous.
  for (const a of queued) if (a[0] === "identify" || a[0] === "update") api(...(Array.from(a) as [string, ...unknown[]]));
  void c.boot().then(() => {
    const cfg = get().config;
    const fixed = explicit ? null : matchLocale(cfg?.language);
    if (fixed) explicit = fixed;
    if (fixed || (!explicit && cfg?.locale)) void applyLocale(cfg?.locale);
    for (const a of queued) if (a[0] !== "identify" && a[0] !== "update" && a[0] !== "locale") api(...(Array.from(a) as [string, ...unknown[]]));
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
