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
const M = { model: "@cf/meta/llama-3.1-8b-instruct" };
const GATEWAY = { NATIVE_UPSTREAM: "gateway" } as Partial<Env>;
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
    const res = await post("/v1/chat/completions", M);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("502 on unexpected status or network error, and does not cache", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));
    expect((await post("/v1/chat/completions", M)).status).toBe(502);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect((await post("/v1/chat/completions", M)).status).toBe(502);
    const ok = await post("/v1/chat/completions", M);
    expect(ok.status).toBe(200);
    expect(calls.filter((c) => c.url === VERIFY)).toHaveLength(1); // earlier failures bypassed the spy impl
  });

  it("verifies with the caller's token and caches success", async () => {
    await post("/v1/chat/completions", M);
    await post("/v1/chat/completions", M);
    const verifies = calls.filter((c) => c.url === VERIFY);
    expect(verifies).toHaveLength(1);
    expect(hdr(verifies[0], "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(upstreamCalls()).toHaveLength(2);
  });

  it("re-verifies after the TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await post("/v1/embeddings", M);
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await post("/v1/embeddings", M);
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
      expect(await new Response(init.body as BodyInit).text()).toBe('{"model":"@cf/a/b","stream":true}');
      return new Response("data: hi\n\n", { status: 201, headers: { "content-type": "text/event-stream", "x-up": "1", connection: "close" } });
    };
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: '{"model":"@cf/a/b","stream":true}',
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

  it("rejects a missing or non-@cf model with 400 and no upstream call", async () => {
    for (const body of [{}, { model: "gpt-4o" }, { model: 5 }, { model: "@cf/a/../b" }]) {
      const res = await post("/v1/chat/completions", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as any).error.type).toBe("invalid_request_error");
    }
    const bad = await call("/v1/embeddings", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("forwards the original body text byte-identical", async () => {
    const raw = '{ "messages":[],  "model" : "@cf/a/b" }\n';
    await call("/v1/chat/completions", { method: "POST", body: raw });
    expect(upstreamCalls()[0].init.body).toBe(raw);
  });

  it("covers embeddings and responses paths", async () => {
    await post("/v1/embeddings", M);
    await post("/v1/responses", M);
    expect(upstreamCalls().map((c) => c.url)).toEqual([`${GW}/v1/embeddings`, `${GW}/v1/responses`]);
  });

  it("leaves OpenAI-shaped upstream errors alone", async () => {
    const body = '{"error":{"message":"nope","type":"x","code":"y"}}';
    handler = () => new Response(body, { status: 429, headers: { "content-type": "application/json" } });
    const res = await post("/v1/chat/completions", M);
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
    const res = await post("/v1/chat/completions", M);
    expect(res.status).toBe(500);
    const e = ((await res.json()) as any).error;
    expect(e.message).toBe(expected);
    expect(e.type).toBeTruthy();
    expect(e.code).toBeTruthy();
  });
});

it("keeps retry-after on a normalized rate limit", async () => {
  handler = () => new Response('{"errors":[{"message":"slow down"}]}', { status: 429, headers: { "retry-after": "7" } });
  const res = await post("/v1/chat/completions", M);
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("7");
  expect(((await res.json()) as any).error.message).toBe("slow down");
});

it("sends no cf-aig header when CF_AIG_TOKEN is unset", async () => {
  await post("/v1/chat/completions", M, mockEnv({ CF_AIG_TOKEN: undefined }));
  expect(hdr(upstreamCalls()[0], "cf-aig-authorization")).toBeNull();
});

it("500 with a clear message and no upstream call when ACCOUNT_ID is unset", async () => {
  const res = await post("/v1/chat/completions", M, mockEnv({ ACCOUNT_ID: "" }));
  expect(res.status).toBe(500);
  expect(((await res.json()) as any).error.message).toMatch(/ACCOUNT_ID/);
  expect(calls).toHaveLength(0);
});

describe("images", () => {
  const FLUX2 = "@cf/black-forest-labs/flux-2-klein-9b";

  it("flux-2 sends multipart with prompt/width/height, JSON response -> b64", async () => {
    handler = () => Response.json({ result: { image: "QUJD" }, success: true });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "a cat", size: "512x768", n: 4, quality: "hd" }, mockEnv(GATEWAY));
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
    const res = await post("/v1/images/generations", { model: "@cf/stabilityai/stable-diffusion-xl-base-1.0", prompt: "dog" }, mockEnv(GATEWAY));
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

  it.each([
    [{}, true],
    [{ NATIVE_UPSTREAM: "direct" }, true],
    [{ IMAGE_UPSTREAM: "gateway" }, false], // legacy alias
    [{ IMAGE_UPSTREAM: "gateway", NATIVE_UPSTREAM: "direct" }, true], // NATIVE_UPSTREAM wins
  ])("upstream %j: direct=%s", async (extra, direct) => {
    handler = () => Response.json({ result: { image: "QQ==" } });
    const res = await post("/v1/images/generations", { model: FLUX2, prompt: "x" }, mockEnv(extra));
    if (!direct) {
      expect(upstreamCalls()[0].url).toBe(`${GW}/${FLUX2}`);
      return;
    }
    expect(res.status).toBe(200);
    const [c] = upstreamCalls();
    expect(c.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${FLUX2}`);
    expect(hdr(c, "cf-aig-authorization")).toBeNull();
    expect(hdr(c, "authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("models", () => {
  it("lists only served tasks, text generation first", async () => {
    handler = (url) => {
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?per_page=1000");
      return Response.json({
        result: [
          { name: "@cf/deepgram/nova-3", task: { name: "Automatic Speech Recognition" } },
          { name: "@cf/black-forest-labs/flux-2-klein-9b", task: { name: "Text-to-Image" } },
          { name: "@cf/baai/bge-m3", task: { name: "Text Embeddings" } },
          { name: "@cf/zai-org/glm-4.7-flash", task: { name: "Text Generation" } },
          { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", task: { name: "Text Generation" } },
          { name: "@cf/myshell-ai/melotts", task: { name: "Text-to-Speech" } },
          { name: "@cf/deepgram/aura-2-en", task: { name: "Text-to-Speech" } },
          { name: "@cf/deepgram/aura-1", task: { name: "Text-to-Speech" } },
          { name: "@cf/openai/whisper", task: { name: "Automatic Speech Recognition" } },
          { name: "@cf/deepgram/flux", task: { name: "Automatic Speech Recognition" } },
          { name: "@cf/meta/m2m100-1.2b", task: { name: "Translation" } },
          { name: "gpt-4o", task: { name: "Text Generation" } },
          { name: "@cf/no/task" },
        ],
      });
    };
    const res = await call("/v1/models");
    const m = (id: string) => ({ id, object: "model", owned_by: "cloudflare", created: 0 });
    expect(await res.json()).toEqual({
      object: "list",
      data: [
        m("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        m("@cf/zai-org/glm-4.7-flash"),
        m("@cf/baai/bge-m3"),
        m("@cf/black-forest-labs/flux-2-klein-9b"),
        m("@cf/deepgram/aura-1"),
        m("@cf/deepgram/aura-2-en"),
        m("@cf/deepgram/nova-3"),
        m("@cf/openai/whisper"),
      ],
    });
    expect(hdr(upstreamCalls()[0], "authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

const DIRECT = "https://api.cloudflare.com/client/v4/accounts/acct/ai/run";
const bytesOf = (c: { init: RequestInit }) => new Response(c.init.body as BodyInit).bytes();

describe("speech", () => {
  const AURA2 = "@cf/deepgram/aura-2-en";
  const speak = (body: Record<string, unknown>, e?: Env) => post("/v1/audio/speech", { model: AURA2, input: "hello", ...body }, e);

  it.each([
    ["mp3", { encoding: "mp3" }, "audio/mpeg"],
    ["opus", { encoding: "opus", container: "ogg" }, "audio/ogg"],
    ["flac", { encoding: "flac" }, "audio/flac"],
    ["wav", { encoding: "linear16", container: "wav" }, "audio/wav"],
    ["pcm", { encoding: "linear16", container: "none", sample_rate: 24000 }, "audio/pcm"],
  ])("%s maps to the Aura body and sets the content-type", async (fmt, aura, type) => {
    handler = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    const res = await speak({ response_format: fmt, voice: "luna", speed: 2, instructions: "x" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const [c] = upstreamCalls();
    expect(c.url).toBe(`${DIRECT}/${AURA2}`);
    expect(JSON.parse(c.init.body as string)).toEqual({ text: "hello", speaker: "luna", ...aura });
    expect(hdr(c, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(hdr(c, "cf-aig-authorization")).toBeNull();
  });

  it("defaults to mp3 without a speaker", async () => {
    await speak({});
    expect(JSON.parse(upstreamCalls()[0].init.body as string)).toEqual({ text: "hello", encoding: "mp3" });
  });

  it("goes through the gateway when NATIVE_UPSTREAM=gateway", async () => {
    await speak({}, mockEnv(GATEWAY));
    expect(upstreamCalls()[0].url).toBe(`${GW}/${AURA2}`);
    expect(hdr(upstreamCalls()[0], "cf-aig-authorization")).toBe("Bearer aig-secret");
  });

  it("validates input with no upstream call", async () => {
    for (const body of [
      { response_format: "aac" },
      { response_format: "ogg" },
      { model: "@cf/myshell-ai/melotts" },
      { model: undefined },
      { input: "" },
      { input: undefined },
      { voice: 3 },
    ]) {
      const res = await speak(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const aac = await speak({ response_format: "aac" });
    expect(((await aac.json()) as any).error.message).toContain("mp3, opus, flac, wav, pcm");
    const model = await speak({ model: "x" });
    expect(((await model.json()) as any).error.message).toContain("@cf/deepgram/aura-1");
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("normalizes upstream errors", async () => {
    handler = () => new Response('{"errors":[{"message":"unknown speaker; valid: angus, ..."}]}', { status: 400 });
    const res = await speak({ voice: "nobody" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatchObject({ message: "unknown speaker; valid: angus, ...", code: "upstream_error" });
  });
});

describe("voices", () => {
  it("lists one model's voices", async () => {
    const res = await call("/v1/audio/voices?model=@cf/deepgram/aura-2-es");
    const { voices } = (await res.json()) as any;
    expect(voices).toHaveLength(10);
    expect(voices[0]).toEqual({ id: "sirio", name: "Sirio", language: "es", locale: "es" });
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("lists all three models deduped by id", async () => {
    const { voices } = (await (await call("/v1/audio/voices")).json()) as any;
    const ids = voices.map((v: any) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(40 + 10 + 4); // aura-1 only adds angus, perseus, helios, stella
    expect(voices.find((v: any) => v.id === "angus")).toEqual({ id: "angus", name: "Angus", language: "en", locale: "en-US" });
    expect(voices.find((v: any) => v.id === "celeste").locale).toBe("es");
  });

  it("400 for a non-Aura model, 401 without a token, 405 for POST", async () => {
    expect((await call("/v1/audio/voices?model=@cf/openai/whisper")).status).toBe(400);
    expect((await call("/v1/audio/voices", {}, null)).status).toBe(401);
    expect((await post("/v1/audio/voices", {})).status).toBe(405);
  });
});

describe("transcriptions", () => {
  const NOVA = "@cf/deepgram/nova-3";
  const TURBO = "@cf/openai/whisper-large-v3-turbo";
  const WHISPER = "@cf/openai/whisper";
  const AUDIO = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const transcribe = (fields: Record<string, string | string[]>, e?: Env, file: Blob | null = new File([AUDIO], "a.mp3", { type: "audio/mpeg" })) => {
    const f = new FormData();
    if (file) f.set("file", file);
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
    return call("/v1/audio/transcriptions", { method: "POST", body: f }, TOKEN, e);
  };
  const words = [
    { word: "Hello", start: 0, end: 0.5 },
    { word: "there.", start: 0.5, end: 1 },
    { word: "Again", start: 1.2, end: 1.6 },
    { word: "after", start: 1.6, end: 2 },
    { word: "gap", start: 4, end: 4.5 },
  ];
  const whisperOut = { text: " Hello there. Again after gap", word_count: 5, words, vtt: "WEBVTT\n\nupstream" };
  const novaOut = {
    results: { channels: [{ alternatives: [{ transcript: "Hello there. Again after gap", confidence: 1, words: words.map((w, i) => ({ ...w, confidence: 1, punctuated_word: ["Hello", "there.", "Again", "after", "gap"][i], speaker: 1 })) }] }] },
  };
  const turboOut = {
    text: " Hi there",
    vtt: "WEBVTT\n\nturbo",
    transcription_info: { language: "en", language_probability: 1, duration: 3.5, duration_after_vad: 3 },
    segments: [{ start: 0, end: 3.2, text: " Hi there", temperature: 0.1, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01, words: [{ word: "Hi", start: 0, end: 1 }, { word: "there", start: 1, end: 2 }] }],
  };

  it("whisper: raw bytes with the file's content-type, language/prompt ignored", async () => {
    handler = () => Response.json({ result: whisperOut });
    const res = await transcribe({ model: WHISPER, language: "en", prompt: "p" });
    expect(await res.json()).toEqual({ text: "Hello there. Again after gap" });
    const [c] = upstreamCalls();
    expect(c.url).toBe(`${DIRECT}/${WHISPER}`);
    expect(hdr(c, "content-type")).toBe("audio/mpeg");
    expect(await bytesOf(c)).toEqual(AUDIO);
  });

  it("turbo: base64 JSON with language and initial_prompt", async () => {
    handler = () => Response.json({ result: turboOut });
    const res = await transcribe({ model: TURBO, language: "en", prompt: "names" });
    expect(await res.json()).toEqual({ text: "Hi there" });
    const [c] = upstreamCalls();
    expect(hdr(c, "content-type")).toBe("application/json");
    expect(JSON.parse(c.init.body as string)).toEqual({ audio: btoa(String.fromCharCode(...AUDIO)), language: "en", initial_prompt: "names" });
  });

  it("nova-3: raw bytes, options as query params, long prompt ignored", async () => {
    handler = () => Response.json(novaOut);
    await transcribe({ model: NOVA, language: "en", diarize: "true", prompt: "Acme" });
    let [c] = upstreamCalls();
    const u = new URL(c.url);
    expect(u.origin + u.pathname).toBe(`${DIRECT}/${NOVA}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ smart_format: "true", language: "en", diarize: "true", keyterm: "Acme" });
    expect(hdr(c, "content-type")).toBe("audio/mpeg");
    expect(await bytesOf(c)).toEqual(AUDIO);
    calls = [];
    await transcribe({ model: NOVA, smart_format: "false", prompt: "x".repeat(101) });
    [c] = upstreamCalls();
    expect(Object.fromEntries(new URL(c.url).searchParams)).toEqual({ smart_format: "false" });
  });

  it("renders json, text, vtt, srt per model", async () => {
    handler = () => Response.json({ result: whisperOut });
    const text = await transcribe({ model: WHISPER, response_format: "text" });
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe("Hello there. Again after gap");
    expect(await (await transcribe({ model: WHISPER, response_format: "vtt" })).text()).toBe("WEBVTT\n\nupstream");
    const srt = await transcribe({ model: WHISPER, response_format: "srt" });
    expect(await srt.text()).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\nHello there.\n\n2\n00:00:01,200 --> 00:00:02,000\nAgain after\n\n3\n00:00:04,000 --> 00:00:04,500\ngap\n",
    );
    handler = () => Response.json(novaOut);
    const vtt = await (await transcribe({ model: NOVA, response_format: "vtt" })).text();
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there.\n\n00:00:01.200 --> 00:00:02.000\nAgain after\n\n00:00:04.000 --> 00:00:04.500\ngap\n");
    handler = () => Response.json(turboOut);
    expect(await (await transcribe({ model: TURBO, response_format: "vtt" })).text()).toBe("WEBVTT\n\nturbo");
  });

  it("groups words on punctuation, gaps over 1 s and 12 s", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 0.9 }));
    handler = () => Response.json({ result: { text: "t", words: long } });
    const j = (await (await transcribe({ model: WHISPER, response_format: "verbose_json" })).json()) as any;
    expect(j.segments.map((s: any) => [s.start, s.end])).toEqual([[0, 11.9], [12, 23.9], [24, 29.9]]);
  });

  it("verbose_json: turbo uses real values; words only when requested; nova keeps speakers", async () => {
    handler = () => Response.json({ result: turboOut });
    const j = (await (await transcribe({ model: TURBO, response_format: "verbose_json" })).json()) as any;
    expect(j).toEqual({
      task: "transcribe", language: "en", duration: 3.5, text: "Hi there",
      segments: [{ id: 0, seek: 0, start: 0, end: 3.2, text: "Hi there", tokens: [], temperature: 0.1, avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 }],
    });
    const w = (await (await transcribe({ model: TURBO, response_format: "verbose_json", "timestamp_granularities[]": ["word", "segment"] })).json()) as any;
    expect(w.words).toEqual([{ word: "Hi", start: 0, end: 1 }, { word: "there", start: 1, end: 2 }]);
    handler = () => Response.json(novaOut);
    const n = (await (await transcribe({ model: NOVA, response_format: "verbose_json", "timestamp_granularities[]": "word", language: "en" })).json()) as any;
    expect(n.duration).toBe(4.5);
    expect(n.language).toBe("en");
    expect(n.words[0]).toEqual({ word: "Hello", start: 0, end: 0.5, speaker: 1 });
    expect(n.segments[0]).toMatchObject({ id: 0, text: "Hello there.", tokens: [], temperature: 0 });
  });

  it("validates: 413, missing fields, unknown model and format; no upstream call", async () => {
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "a.mp3");
    expect((await transcribe({ model: WHISPER }, undefined, big)).status).toBe(413);
    expect((await transcribe({ model: WHISPER }, undefined, null)).status).toBe(400);
    expect((await transcribe({})).status).toBe(400);
    expect((await transcribe({ model: "@cf/openai/whisper-tiny-en" })).status).toBe(400);
    expect((await transcribe({ model: "whisper-1" })).status).toBe(400);
    expect((await transcribe({ model: WHISPER, response_format: "ass" })).status).toBe(400);
    expect((await call("/v1/audio/transcriptions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("normalizes upstream errors; 405 on GET", async () => {
    handler = () => new Response('{"errors":[{"message":"bad audio"}]}', { status: 400 });
    const res = await transcribe({ model: NOVA });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toBe("bad audio");
    expect((await call("/v1/audio/transcriptions")).status).toBe(405);
  });
});
