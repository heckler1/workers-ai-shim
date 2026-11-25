import { authenticate } from "./auth";
import { errorResponse, normalizeUpstreamError } from "./errors";
import { generateImage } from "./images";
import { MODEL_RE } from "./models";
import { makeUpstream, passthrough } from "./proxy";
import { createSpeech, listVoices, SPEECH_MODELS } from "./speech";
import { TRANSCRIPTION_MODELS, transcribe } from "./transcribe";

export interface Env {
  ACCOUNT_ID: string;
  GATEWAY_ID: string;
  /** Only for an authenticated gateway; unset sends no cf-aig-authorization header. */
  CF_AIG_TOKEN?: string;
  /** Images, speech, transcriptions: "direct" (default; api.cloudflare.com/.../ai/run, no cf-aig header) or "gateway". */
  NATIVE_UPSTREAM?: string;
  /** Legacy alias of NATIVE_UPSTREAM, read only when that is unset. */
  IMAGE_UPSTREAM?: string;
}

/** Workers AI tasks the shim serves, in the order /v1/models lists them; audio tasks only list models their routes support. */
const SERVED_TASKS: [task: string, only?: string[]][] = [
  ["Text Generation"],
  ["Text Embeddings"],
  ["Text-to-Image"],
  ["Text-to-Speech", SPEECH_MODELS],
  ["Automatic Speech Recognition", TRANSCRIPTION_MODELS],
];

const ROUTES: Record<string, "GET" | "POST"> = {
  "/v1/models": "GET",
  "/v1/audio/voices": "GET",
  "/v1/chat/completions": "POST",
  "/v1/embeddings": "POST",
  "/v1/responses": "POST",
  "/v1/images/generations": "POST",
  "/v1/audio/speech": "POST",
  "/v1/audio/transcriptions": "POST",
};
const PASSTHROUGH = new Set(["/v1/chat/completions", "/v1/embeddings", "/v1/responses"]);

async function listModels(authorization: string, env: Env): Promise<Response> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?per_page=1000`, {
    headers: { Authorization: authorization },
  });
  if (!res.ok) return normalizeUpstreamError(res);
  const body = (await res.json()) as { result?: { name: string; task?: { name?: string } }[] };
  // Only what the shim's routes can serve, text generation first: clients that pick
  // "the first text model" by name otherwise land on speech or audio models.
  const data = (body.result ?? [])
    .map((m) => ({ name: m.name, rank: SERVED_TASKS.findIndex(([task, only]) => task === m.task?.name && (!only || only.includes(m.name))) }))
    .filter((m) => m.rank >= 0 && MODEL_RE.test(m.name))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((m) => ({ id: m.name, object: "model", owned_by: "cloudflare", created: 0 }));
  return Response.json({ object: "list", data });
}

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") return req.method === "GET" ? new Response("ok") : errorResponse(405, "Method not allowed.", undefined, { Allow: "GET" });
  if (!env.ACCOUNT_ID) return errorResponse(500, "ACCOUNT_ID is not configured on the shim.", "misconfigured");

  const allowed = ROUTES[pathname];
  if (!allowed) return errorResponse(404, `Unknown route ${pathname}.`);
  if (req.method !== allowed) return errorResponse(405, `Use ${allowed} for ${pathname}.`, undefined, { Allow: allowed });

  // Always verify the caller before touching any upstream (gateway caching can bypass Workers AI's token check).
  const auth = await authenticate(req, env);
  if (!auth.ok) return auth.response;

  if (pathname === "/v1/models") return listModels(auth.authorization, env);
  const up = makeUpstream(env);
  if (PASSTHROUGH.has(pathname)) return passthrough(req, pathname, up);
  if (pathname === "/v1/images/generations") return generateImage(req, up);
  if (pathname === "/v1/audio/speech") return createSpeech(req, up);
  if (pathname === "/v1/audio/transcriptions") return transcribe(req, up);
  return listVoices(new URL(req.url).searchParams.get("model"));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch {
      return errorResponse(502, "Upstream request failed.", "upstream_error");
    }
  },
} satisfies ExportedHandler<Env>;
