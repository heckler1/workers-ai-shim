import { errorResponse, normalizeUpstreamError } from "./errors";
import type { Env } from "./index";
import { MODEL_RE } from "./models";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"];

export interface Upstream {
  base: string;
  cfAigToken?: string;
  /** Native calls (images, speech, transcriptions) go straight to api.cloudflare.com, with no cf-aig header. */
  direct: boolean;
  nativeUrl(model: string): string;
}

export function makeUpstream(env: Env): Upstream {
  // IMAGE_UPSTREAM is the legacy name of NATIVE_UPSTREAM.
  const direct = (env.NATIVE_UPSTREAM || env.IMAGE_UPSTREAM || "direct") !== "gateway";
  const base = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/workers-ai`;
  return {
    base,
    cfAigToken: env.CF_AIG_TOKEN,
    direct,
    nativeUrl: (model) => (direct ? `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run/${model}` : `${base}/${model}`),
  };
}

/** Caller's headers minus hop-by-hop/Host, plus the gateway token (unless going direct). Authorization is forwarded as-is. */
export function upstreamHeaders(incoming: Headers, up: Upstream, direct = false): Headers {
  const h = new Headers(incoming);
  for (const n of HOP_BY_HOP) h.delete(n);
  h.delete("cf-aig-authorization");
  if (!direct && up.cfAigToken) h.set("cf-aig-authorization", `Bearer ${up.cfAigToken}`);
  return h;
}

/** Forward the original body text unchanged (only `model` is read, to insist on a Cloudflare-hosted one); the response streams. */
export async function passthrough(req: Request, path: string, up: Upstream): Promise<Response> {
  const text = await req.text();
  let model: unknown;
  try {
    model = (JSON.parse(text) as { model?: unknown } | null)?.model;
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    return errorResponse(400, "`model` is required and must be a Cloudflare-hosted model (@cf/<author>/<name>).");
  }
  const res = await fetch(`${up.base}${path}`, { method: "POST", headers: upstreamHeaders(req.headers, up), body: text });
  if (res.status >= 400) return normalizeUpstreamError(res);
  const headers = new Headers(res.headers);
  for (const n of HOP_BY_HOP) headers.delete(n);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
