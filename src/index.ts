import { authenticate } from "./auth";
import { errorResponse, normalizeUpstreamError } from "./errors";
import { generateImage } from "./images";
import { makeUpstream, passthrough } from "./proxy";

export interface Env {
  ACCOUNT_ID: string;
  GATEWAY_ID: string;
  /** Only for an authenticated gateway; unset sends no cf-aig-authorization header. */
  CF_AIG_TOKEN?: string;
  /** "gateway" (default) or "direct" (api.cloudflare.com/.../ai/run, no cf-aig header). */
  IMAGE_UPSTREAM?: string;
}

const PASSTHROUGH = new Set(["/v1/chat/completions", "/v1/embeddings", "/v1/responses"]);

async function listModels(authorization: string, env: Env): Promise<Response> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?per_page=1000`, {
    headers: { Authorization: authorization },
  });
  if (!res.ok) return normalizeUpstreamError(res);
  const body = (await res.json()) as { result?: { name: string }[] };
  const data = (body.result ?? []).map((m) => ({ id: m.name, object: "model", owned_by: "cloudflare", created: 0 }));
  return Response.json({ object: "list", data });
}

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") return req.method === "GET" ? new Response("ok") : errorResponse(405, "Method not allowed.", undefined, { Allow: "GET" });
  if (!env.ACCOUNT_ID) return errorResponse(500, "ACCOUNT_ID is not configured on the shim.", "misconfigured");

  const allowed = pathname === "/v1/models" ? "GET" : PASSTHROUGH.has(pathname) || pathname === "/v1/images/generations" ? "POST" : null;
  if (!allowed) return errorResponse(404, `Unknown route ${pathname}.`);
  if (req.method !== allowed) return errorResponse(405, `Use ${allowed} for ${pathname}.`, undefined, { Allow: allowed });

  // Always verify the caller before touching any upstream (gateway caching can bypass Workers AI's token check).
  const auth = await authenticate(req, env);
  if (!auth.ok) return auth.response;

  if (pathname === "/v1/models") return listModels(auth.authorization, env);
  const up = makeUpstream(env);
  return pathname === "/v1/images/generations" ? generateImage(req, up) : passthrough(req, pathname, up);
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
