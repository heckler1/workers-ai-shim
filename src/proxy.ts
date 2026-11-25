import { normalizeUpstreamError } from "./errors";
import type { Env } from "./index";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"];

export interface Upstream {
  base: string;
  cfAigToken?: string;
  imageDirect: boolean;
  imageUrl(model: string): string;
}

export function makeUpstream(env: Env): Upstream {
  const direct = env.IMAGE_UPSTREAM === "direct";
  const base = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/workers-ai`;
  return {
    base,
    cfAigToken: env.CF_AIG_TOKEN,
    imageDirect: direct,
    imageUrl: (model) => (direct ? `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run/${model}` : `${base}/${model}`),
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

/** Stream request and response bodies through untouched. */
export async function passthrough(req: Request, path: string, up: Upstream): Promise<Response> {
  const res = await fetch(`${up.base}${path}`, { method: "POST", headers: upstreamHeaders(req.headers, up), body: req.body });
  if (res.status >= 400) return normalizeUpstreamError(res);
  const headers = new Headers(res.headers);
  for (const n of HOP_BY_HOP) headers.delete(n);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
