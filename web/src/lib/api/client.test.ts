import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetClientForTests,
  ApiError,
  configureClient,
  dispositionName,
  download,
  http,
  onAccountSession,
  onPlanLimit,
  onSession,
  parseFrame,
  refreshSession,
  setAccessToken,
  setActiveAccount,
  setTransport,
  setWorkspaceId,
  stream,
} from "./client";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => __resetClientForTests());

describe("api client", () => {
  it("sends the bearer token and workspace header", async () => {
    const calls: RequestInit[] = [];
    setTransport(async (_u, init) => (calls.push(init), json(200, { ok: true })));
    configureClient({ baseUrl: "https://api.test" });
    setAccessToken("tok_a");
    setWorkspaceId("w1");
    await http.get("/v1/tickets");
    const h = calls[0].headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok_a");
    expect(h["OD-Workspace"]).toBe("w1");
  });

  it("refreshes once for concurrent 401s and retries each request", async () => {
    let refreshes = 0;
    setTransport(async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { access_token: "tok_new", expires_in: 900, user: { id: "u1" } });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer tok_new" ? json(200, { url }) : json(401, { code: "unauthorized" });
    });
    setAccessToken("tok_old");
    const seen: (string | null)[] = [];
    onSession((s) => seen.push(s?.access_token ?? null));
    const out = await Promise.all([http.get<{ url: string }>("/v1/a"), http.get<{ url: string }>("/v1/b"), http.get<{ url: string }>("/v1/c")]);
    expect(refreshes).toBe(1);
    expect(out.map((o) => o.url)).toEqual(["/v1/a", "/v1/b", "/v1/c"]);
    expect(seen).toEqual(["tok_new"]);
  });

  it("surfaces the 401 when the refresh fails and ends the session", async () => {
    setTransport(async (url) => (url.endsWith("/v1/auth/refresh") ? json(401, {}) : json(401, { code: "unauthorized", detail: "Sign in" })));
    setAccessToken("tok_old");
    const ended = vi.fn();
    onSession(ended);
    const err = await http.get("/v1/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("unauthorized");
    expect(ended).toHaveBeenCalledWith(null);
  });

  it("does not refresh on a failed login", async () => {
    let refreshes = 0;
    setTransport(async (url) => {
      if (url.endsWith("/v1/auth/refresh")) refreshes++;
      return json(401, { code: "invalid_credentials" });
    });
    const err = await http.post("/v1/auth/login", { email: "a@b.c" }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("invalid_credentials");
    expect(refreshes).toBe(0);
  });

  it("reuses the Idempotency-Key on the retry after refresh", async () => {
    const keys: string[] = [];
    setTransport(async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) return json(200, { access_token: "tok_new", expires_in: 900, user: { id: "u1" } });
      const h = init.headers as Record<string, string>;
      keys.push(h["Idempotency-Key"]);
      return h.Authorization === "Bearer tok_new" ? json(201, { id: "x" }) : json(401, {});
    });
    setAccessToken("tok_old");
    await http.create("/v1/tickets", { subject: "Hi" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("refreshes ahead of expiry", async () => {
    const order: string[] = [];
    setTransport(async (url) => {
      order.push(url);
      return url.endsWith("/v1/auth/refresh") ? json(200, { access_token: "tok_new", expires_in: 900, user: { id: "u1" } }) : json(200, {});
    });
    setAccessToken("tok_old", 5);
    await http.get("/v1/me");
    expect(order).toEqual(["/v1/auth/refresh", "/v1/me"]);
  });

  it("types errors by code and maps network failures", async () => {
    setTransport(async () => json(409, { code: "email_taken", detail: "That email is in use" }));
    const e1 = (await http.post("/v1/x").catch((e: unknown) => e)) as ApiError;
    expect(e1.code).toBe("email_taken");
    expect(e1.message).toBe("That email is in use");
    setTransport(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e2 = (await http.get("/v1/x").catch((e: unknown) => e)) as ApiError;
    expect(e2.code).toBe("network_error");
  });
});

describe("several accounts", () => {
  const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

  it("keeps each account's access token and refreshes only the one named", async () => {
    const refreshBodies: (string | undefined)[] = [];
    const sent: string[] = [];
    setTransport(async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) {
        refreshBodies.push(init.body as string | undefined);
        return json(200, { access_token: "tok_u2", expires_in: 900, user: { id: "u2" } });
      }
      sent.push(bearer(init));
      return json(200, {});
    });
    setActiveAccount("u1");
    setAccessToken("tok_u1");
    const active: (string | null)[] = [];
    onSession((r) => active.push(r?.access_token ?? null));
    await refreshSession("u2");
    expect(refreshBodies).toEqual([JSON.stringify({ user_id: "u2" })]);
    expect(active).toEqual([]);
    await http.get("/v1/me");
    await http.get("/v1/me", { as: "u2" });
    setActiveAccount("u2");
    await http.get("/v1/me");
    setActiveAccount("u1");
    await http.get("/v1/me");
    expect(sent).toEqual(["Bearer tok_u1", "Bearer tok_u2", "Bearer tok_u2", "Bearer tok_u1"]);
  });

  it("does not send the active workspace with another account's request", async () => {
    const calls: RequestInit[] = [];
    setTransport(async (_u, init) => (calls.push(init), json(200, {})));
    setActiveAccount("u1");
    setAccessToken("tok_u1");
    setWorkspaceId("w1");
    await http.get("/v1/me", { as: "u2" });
    expect((calls[0].headers as Record<string, string>)["OD-Workspace"]).toBeUndefined();
  });

  it("reports an account whose refresh failed without ending the active one", async () => {
    setTransport(async () => json(401, { code: "unauthenticated" }));
    setActiveAccount("u1");
    setAccessToken("tok_u1");
    const ended: (string | null)[] = [];
    const active = vi.fn();
    onAccountSession((uid, r) => !r && ended.push(uid));
    onSession(active);
    await refreshSession("u2");
    expect(ended).toEqual(["u2"]);
    expect(active).not.toHaveBeenCalled();
  });
});

describe("stream", () => {
  function sseResponse(frames: string[]) {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        // Split frames across chunk boundaries to exercise buffering.
        const all = frames.join("");
        for (let i = 0; i < all.length; i += 7) c.enqueue(enc.encode(all.slice(i, i + 7)));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("delivers deltas in order and resolves with done", async () => {
    setTransport(async (_u, init) => {
      expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
      return sseResponse([
        ": keep-alive\n\n",
        'event: delta\ndata: {"text":"Hi "}\n\n',
        'event: delta\r\ndata: {"text":"there"}\r\n\r\n',
        'event: done\ndata: {"body_html":"<p>Hi there</p>"}\n\n',
      ]);
    });
    const seen: string[] = [];
    const out = await stream<{ body_html: string }>("/v1/tickets/t/ai/draft", {}, { onDelta: (_t, so) => seen.push(so) });
    expect(seen).toEqual(["Hi ", "Hi there"]);
    expect(out.body_html).toBe("<p>Hi there</p>");
  });

  it("accepts a plain JSON answer", async () => {
    setTransport(async () => json(200, { html: "<p>x</p>" }));
    expect(await stream<{ html: string }>("/v1/ai/rewrite", {})).toEqual({ html: "<p>x</p>" });
  });

  it("announces 402 plan errors", async () => {
    setTransport(async () => json(402, { code: "ai_balance_empty", detail: "Your workspace's AI balance is too low for this. Add AI usage or upgrade." }));
    const heard: string[] = [];
    onPlanLimit((e) => heard.push(e.code));
    await expect(stream("/v1/ai/rewrite", {})).rejects.toBeInstanceOf(ApiError);
    await http.post("/v1/mailboxes").catch(() => {});
    expect(heard).toEqual(["ai_balance_empty", "ai_balance_empty"]);
  });
});

describe("parseFrame", () => {
  it("joins multi-line data and defaults the event name", () => {
    expect(parseFrame("data: a\ndata: b")).toEqual({ event: "message", data: "a\nb" });
    expect(parseFrame(": comment")).toBeNull();
  });
});

describe("uploads and downloads", () => {
  it("reports an upload's progress over XMLHttpRequest, with the same headers fetch would send", async () => {
    const sent: { method: string; url: string; headers: Record<string, string>; body: unknown; credentials: boolean } [] = [];
    class FakeXHR {
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      withCredentials = false;
      responseType = "";
      status = 0;
      statusText = "";
      response: unknown = null;
      private req = { method: "", url: "", headers: {} as Record<string, string> };
      open(method: string, url: string) {
        this.req = { method, url, headers: {} };
      }
      setRequestHeader(k: string, v: string) {
        this.req.headers[k] = v;
      }
      getAllResponseHeaders() {
        return "content-type: application/json\r\nx-request-id: r1\r\n";
      }
      abort() {}
      send(body: unknown) {
        sent.push({ ...this.req, body, credentials: this.withCredentials });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
        this.status = 201;
        this.response = JSON.stringify({ pages: 2 });
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    try {
      configureClient({ baseUrl: "https://api.test" });
      setAccessToken("tok_a");
      setWorkspaceId("w1");
      const fd = new FormData();
      const seen: number[] = [];
      const out = await http.post<{ pages: number }>("/v1/wiki/import", fd, { onUploadProgress: (p) => seen.push(p) });
      expect(out).toEqual({ pages: 2 });
      expect(seen).toEqual([0.5, 1, 1]);
      expect(sent[0]).toMatchObject({ method: "POST", url: "https://api.test/v1/wiki/import", body: fd, credentials: true });
      expect(sent[0].headers).toMatchObject({ Authorization: "Bearer tok_a", "OD-Workspace": "w1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("downloads with the token and reads the file's name", async () => {
    const calls: RequestInit[] = [];
    setTransport(async (_u, init) => {
      calls.push(init);
      return new Response("# Hi", { status: 200, headers: { "content-type": "text/markdown", "content-disposition": 'attachment; filename="Refunds.md"' } });
    });
    setAccessToken("tok_a");
    const d = await download("/v1/wiki/pages/p1/export", { query: { format: "markdown" } });
    expect(await d.blob.text()).toBe("# Hi");
    expect(d.filename).toBe("Refunds.md");
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer tok_a");
  });

  it("reads Content-Disposition's file name, RFC 5987's first", () => {
    expect(dispositionName('attachment; filename="Wiki 2026-11-07.zip"')).toBe("Wiki 2026-11-07.zip");
    expect(dispositionName("attachment; filename*=utf-8''Caf%C3%A9.md")).toBe("Café.md");
    expect(dispositionName("attachment; filename=\"fallback.md\"; filename*=UTF-8''%C3%A9t%C3%A9.md")).toBe("été.md");
    expect(dispositionName('attachment; filename="say \\"hi\\".md"')).toBe('say "hi".md');
    expect(dispositionName("attachment; filename=plain.md")).toBe("plain.md");
    expect(dispositionName("attachment")).toBeNull();
    expect(dispositionName(null)).toBeNull();
  });
});
