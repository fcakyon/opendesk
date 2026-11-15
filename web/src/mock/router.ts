// Request routing for the mock transport.

import { db, userFromToken, wsById, type WsData } from "./db";
import { isRecord } from "./util";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const invalid = (detail: string) => new HttpError(422, "validation_failed", detail);
export const forbidden = (detail = "You don't have permission to do that") => new HttpError(403, "forbidden", detail);

export type Ctx = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  form: FormData | null;
  headers: Headers;
  /** The workspace named by OD-Workspace (or the first one). */
  ws: WsData;
};

export type Result = { status?: number; body?: unknown; headers?: Record<string, string> } | unknown;

export type Handler = (ctx: Ctx) => Result | Promise<Result>;

type Route = { method: string; parts: string[]; handler: Handler };

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler) {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
}

export const get = (p: string, h: Handler) => route("GET", p, h);
export const post = (p: string, h: Handler) => route("POST", p, h);
export const patch = (p: string, h: Handler) => route("PATCH", p, h);
export const put = (p: string, h: Handler) => route("PUT", p, h);
export const del = (p: string, h: Handler) => route("DELETE", p, h);

/** Mark a handler result as an explicit response. */
export function respond(status: number, body?: unknown, headers?: Record<string, string>) {
  return { __response: true, status, body, headers };
}

function isResponseSpec(v: unknown): v is { __response: true; status: number; body?: unknown; headers?: Record<string, string> } {
  return isRecord(v) && v.__response === true;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}, contentType = "application/json") {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType, "x-request-id": `req_mock_${Math.random().toString(36).slice(2, 10)}`, ...extra },
  });
}

function problem(e: HttpError) {
  const titles: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests" };
  return json(e.status, { status: e.status, title: titles[e.status] ?? "Error", detail: e.detail, code: e.code, ...e.extra }, {}, "application/problem+json");
}

function match(r: Route, method: string, parts: string[]): Record<string, string> | null {
  if (r.method !== method || r.parts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = r.parts[i];
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
    else if (p !== parts[i]) return null;
  }
  return params;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dispatch(input: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const i = input.indexOf("/v1/");
  const rel = i >= 0 ? input.slice(i) : input;
  const [pathPart, qs = ""] = rel.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const headers = new Headers(init.headers);

  let body: Record<string, unknown> = {};
  let form: FormData | null = null;
  if (init.body instanceof FormData) form = init.body;
  else if (typeof init.body === "string" && init.body) {
    try {
      const parsed: unknown = JSON.parse(init.body);
      body = isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      return problem(new HttpError(400, "validation_failed", "Body is not valid JSON"));
    }
  }

  // The demo answers after a network-like pause; tests answer at once.
  if (import.meta.env.MODE !== "test") await sleep(60 + Math.random() * 120);

  // Most-specific first: static segments beat params.
  const candidates = routes
    .map((r) => ({ r, params: match(r, method, parts) }))
    .filter((x): x is { r: Route; params: Record<string, string> } => x.params !== null)
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);
  const hit = candidates[0];
  if (!hit) return problem(new HttpError(404, "not_found", `No mock route for ${method} ${pathPart}`));

  // Each request runs as the account its access token names (several can be signed in).
  const asUser = userFromToken(headers.get("Authorization"));
  if (asUser) db.meId = asUser;

  const wid = headers.get("OD-Workspace");
  const ws = wsById(wid) ?? db.workspaces[0];

  try {
    const out = await hit.r.handler({ method, path: pathPart, params: hit.params, query: new URLSearchParams(qs), body, form, headers, ws });
    if (out instanceof Response) return out;
    if (isResponseSpec(out)) {
      if (out.status === 204 || out.body === undefined) return new Response(null, { status: out.status === 200 ? 204 : out.status, headers: out.headers });
      return json(out.status, out.body, out.headers);
    }
    if (out === undefined) return new Response(null, { status: 204 });
    return json(method === "POST" && !pathPart.includes("/auth/") ? 201 : 200, out);
  } catch (e) {
    if (e instanceof HttpError) return problem(e);
    console.error("[mock] handler crashed", e);
    return problem(new HttpError(500, "server_error", "Internal error in mock handler"));
  }
}

// Body helpers.
export function s(ctx: Ctx, key: string): string | undefined {
  const v = ctx.body[key];
  return typeof v === "string" ? v : undefined;
}
export function required(ctx: Ctx, key: string): string {
  const v = s(ctx, key)?.trim();
  if (!v) throw invalid(`${key} is required`);
  return v;
}
export function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/** Cursor pagination over an in-memory array; the cursor is an offset. */
export function paginate<T>(ctx: Ctx, items: T[], defaultLimit = 50) {
  const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? defaultLimit) || defaultLimit, 1), 100);
  const offset = Number(ctx.query.get("cursor") ?? 0) || 0;
  const data = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { data, next_cursor: next };
}

/**
 * A text/event-stream answer like the AI endpoints send with
 * `Accept: text/event-stream`: `delta` {text} chunks, then `done` with `final`.
 * Without that Accept header, the final JSON is returned directly.
 */
export function sse(ctx: Ctx, chunks: string[], final: unknown, delayMs = 35): Response | unknown {
  if (!(ctx.headers.get("Accept") ?? "").includes("text/event-stream")) return final;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const text of chunks) {
        controller.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
        await sleep(delayMs);
      }
      controller.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify(final)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export type Emit = (event: string, data: unknown) => void;

/** True when the caller asked for text/event-stream. */
export function wantsStream(ctx: Ctx): boolean {
  return (ctx.headers.get("Accept") ?? "").includes("text/event-stream");
}

/**
 * A text/event-stream with any events, in order. A failure after the stream
 * started is sent as `event: error` with the problem object, then it ends.
 */
export function eventStream(run: (emit: Emit, wait: (ms: number) => Promise<unknown>) => Promise<void>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        await run(emit, sleep);
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError(500, "server_error", "Internal error in mock handler");
        emit("error", { status: err.status, code: err.code, detail: err.detail });
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Split text into word-ish chunks for streaming. */
export function chunk(text: string, size = 3): string[] {
  const words = text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size * 2) out.push(words.slice(i, i + size * 2).join(""));
  return out;
}
