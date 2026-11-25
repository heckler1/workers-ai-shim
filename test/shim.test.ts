import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthCache } from "../src/auth";
import worker, { type Env } from "../src/index";

const TOKEN = "cf-token-123";
const GW = "https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai";
const VERIFY = "https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?per_page=1";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
let calls: { url: string; init: RequestInit }[];

const mockEnv = (extra: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), ...extra });

function call(path: string, init: RequestInit = {}, token: string | null = TOKEN, e: Env = mockEnv()) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return worker.fetch(new Request(`https://shim.test${path}`, { ...init, headers }), e);
}
const post = (path: string, body: unknown, e?: Env) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, TOKEN, e);
const upstreamCalls = () => calls.filter((c) => c.url !== VERIFY);
const hdr = (c: { init: RequestInit }, n: string) => new Headers(c.init.headers).get(n);

beforeEach(() => {
  clearAuthCache();
  calls = [];
  handler = () => new Response("{}", { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    if (url === VERIFY) return new Response("{}", { status: 200 });
    return handler(url, init ?? {});
  });
});
afterEach(() => vi.restoreAllMocks());

describe("auth", () => {
  it("401 without a token, before any fetch", async () => {
    const res = await call("/v1/chat/completions", { method: "POST", body: "{}" }, null);
    expect(res.status).toBe(401);
    expect((await res.json()) as any).toMatchObject({ error: { type: "authentication_error" } });
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid token with 401 and makes no upstream call", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      calls.push({ url: String(input), init: {} });
      return new Response("{}", { status: 403 });
    });
    const res = await post("/v1/chat/completions", {});
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("502 on unexpected status or network error, and does not cache", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));
    expect((await post("/v1/chat/completions", {})).status).toBe(502);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect((await post("/v1/chat/completions", {})).status).toBe(502);
    const ok = await post("/v1/chat/completions", {});
    expect(ok.status).toBe(200);
    expect(calls.filter((c) => c.url === VERIFY)).toHaveLength(1); // earlier failures bypassed the spy impl
  });

  it("verifies with the caller's token and caches success", async () => {
    await post("/v1/chat/completions", {});
    await post("/v1/chat/completions", {});
    const verifies = calls.filter((c) => c.url === VERIFY);
    expect(verifies).toHaveLength(1);
    expect(hdr(verifies[0], "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(upstreamCalls()).toHaveLength(2);
  });

  it("re-verifies after the TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await post("/v1/embeddings", {});
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await post("/v1/embeddings", {});
      expect(calls.filter((c) => c.url === VERIFY)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("routing", () => {
  it("health needs no auth; unknown 404; wrong method 405", async () => {
    const h = await call("/health", {}, null);
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("ok");
    const nf = await call("/nope");
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).error.message).toBeTruthy();
    expect((await call("/v1/chat/completions")).status).toBe(405);
    expect((await post("/v1/models", {})).status).toBe(405);
  });
});

describe("passthrough", () => {
  it("forwards body, auth and cf-aig header; preserves status and stream headers", async () => {
    handler = async (_u, init) => {
      expect(await new Response(init.body as BodyInit).text()).toBe('{"stream":true}');
      return new Response("data: hi\n\n", { status: 201, headers: { "content-type": "text/event-stream", "x-up": "1", connection: "close" } });
    };
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: '{"stream":true}',
      headers: { "content-type": "application/json", host: "evil.example" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-up")).toBe("1");
    expect(await res.text()).toBe("data: hi\n\n");
    const [c] = upstreamCalls();
    expect(c.url).toBe(`${GW}/v1/chat/completions`);
    expect(hdr(c, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(hdr(c, "cf-aig-authorization")).toBe("Bearer aig-secret");
    expect(hdr(c, "host")).toBeNull();
    expect(hdr(c, "content-type")).toBe("application/json");
  });

  it("covers embeddings and responses paths", async () => {
    await post("/v1/embeddings", {});
    await post("/v1/responses", {});
    expect(upstreamCalls().map((c) => c.url)).toEqual([`${GW}/v1/embeddings`, `${GW}/v1/responses`]);
  });

  it("leaves OpenAI-shaped upstream errors alone", async () => {
    const body = '{"error":{"message":"nope","type":"x","code":"y"}}';
    handler = () => new Response(body, { status: 429, headers: { "content-type": "application/json" } });
    const res = await post("/v1/chat/completions", {});
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(body);
  });
});

describe("error normalization", () => {
  it.each([
    ['{"errors":[{"code":1,"message":"bad thing"}]}', "bad thing"],
    ["plain failure", "plain failure"],
    ["", "Upstream returned 500"],
    ['{"errors":[]}', '{"errors":[]}'],
    ["x".repeat(900), "x".repeat(500)],
  ])("body %s", async (text, expected) => {
    handler = () => new Response(text, { status: 500 });
    const res = await post("/v1/chat/completions", {});
    expect(res.status).toBe(500);
    const e = ((await res.json()) as any).error;
    expect(e.message).toBe(expected);
    expect(e.type).toBeTruthy();
    expect(e.code).toBeTruthy();
  });
});

it("keeps retry-after on a normalized rate limit", async () => {
  handler = () => new Response('{"errors":[{"message":"slow down"}]}', { status: 429, headers: { "retry-after": "7" } });
  const res = await post("/v1/chat/completions", {});
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("7");
  expect(((await res.json()) as any).error.message).toBe("slow down");
});

it("sends no cf-aig header when CF_AIG_TOKEN is unset", async () => {
  await post("/v1/chat/completions", {}, mockEnv({ CF_AIG_TOKEN: undefined }));
  expect(hdr(upstreamCalls()[0], "cf-aig-authorization")).toBeNull();
});

it("500 with a clear message and no upstream call when ACCOUNT_ID is unset", async () => {
  const res = await post("/v1/chat/completions", {}, mockEnv({ ACCOUNT_ID: "" }));
  expect(res.status).toBe(500);
  expect(((await res.json()) as any).error.message).toMatch(/ACCOUNT_ID/);
  expect(calls).toHaveLength(0);
});

describe("images", () => {
  const FLUX2 = "@cf/black-forest-labs/flux-2-klein-9b";

  it("flux-2 sends multipart with prompt/width/height, JSON response -> b64", async () => {
    handler = () => Response.json({ result: { image: "QUJD" }, success: true });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "a cat", size: "512x768", n: 4, quality: "hd" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.data).toEqual([{ b64_json: "QUJD" }]);
    expect(j.created).toBeGreaterThan(1.7e9);
    const [c] = upstreamCalls();
    expect(c.url).toBe(`${GW}/${FLUX2}`);
    expect(c.init.body).toBeInstanceOf(FormData);
    const f = c.init.body as FormData;
    expect([f.get("prompt"), f.get("width"), f.get("height")]).toEqual(["a cat", "512", "768"]);
    expect(hdr(c, "content-type")).toBeNull(); // fetch derives the boundary
    expect(hdr(c, "cf-aig-authorization")).toBe("Bearer aig-secret");
    expect(hdr(c, "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("non-flux-2 sends JSON with default size; top-level image field accepted", async () => {
    handler = () => Response.json({ image: "WFla" });
    const res = await post("/v1/images/generations", { model: "@cf/stabilityai/stable-diffusion-xl-base-1.0", prompt: "dog" });
    expect(((await res.json()) as any).data[0].b64_json).toBe("WFla");
    const [c] = upstreamCalls();
    expect(hdr(c, "content-type")).toBe("application/json");
    expect(JSON.parse(c.init.body as string)).toEqual({ prompt: "dog", width: 1024, height: 1024 });
  });

  it("image/* binary response is base64-encoded (large buffers ok)", async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
    handler = () => new Response(bytes, { headers: { "content-type": "image/png" } });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "x" });
    const b64 = ((await res.json()) as any).data[0].b64_json as string;
    expect(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))).toEqual(bytes);
  });

  it("validates input", async () => {
    for (const body of [
      { prompt: "x" },
      { model: FLUX2 },
      { model: FLUX2, prompt: "x", size: "big" },
      { model: FLUX2, prompt: "x", size: "0x10" },
      { model: "gpt-image-1", prompt: "x" },
      { model: "@cf/a/b/../c", prompt: "x" },
      { model: "@cf/../..", prompt: "x" },
      { model: "@cf/x/..", prompt: "x" },
    ]) {
      const res = await post("/v1/images/generations", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as any).error.message).toBeTruthy();
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("502 when upstream has no image; upstream errors are normalized", async () => {
    handler = () => Response.json({ result: {} });
    expect((await post("/v1/images/generations", { model: FLUX2, prompt: "x" })).status).toBe(502);
    handler = () => new Response('{"errors":[{"message":"model gone"}]}', { status: 404 });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.message).toBe("model gone");
  });

  it("IMAGE_UPSTREAM=direct uses api.cloudflare.com/ai/run without cf-aig header", async () => {
    handler = () => Response.json({ result: { image: "QQ==" } });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "x" }, mockEnv({ IMAGE_UPSTREAM: "direct" }));
    expect(res.status).toBe(200);
    const [c] = upstreamCalls();
    expect(c.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${FLUX2}`);
    expect(hdr(c, "cf-aig-authorization")).toBeNull();
    expect(hdr(c, "authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("models", () => {
  it("maps the search result", async () => {
    handler = (url) => {
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?per_page=1000");
      return Response.json({ result: [{ name: "@cf/meta/llama-3.1-8b-instruct" }, { name: "@cf/baai/bge-m3" }] });
    };
    const res = await call("/v1/models");
    expect(await res.json()).toEqual({
      object: "list",
      data: [
        { id: "@cf/meta/llama-3.1-8b-instruct", object: "model", owned_by: "cloudflare", created: 0 },
        { id: "@cf/baai/bge-m3", object: "model", owned_by: "cloudflare", created: 0 },
      ],
    });
    expect(hdr(upstreamCalls()[0], "authorization")).toBe(`Bearer ${TOKEN}`);
  });
});
