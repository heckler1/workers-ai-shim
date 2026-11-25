/** OpenAI-shaped error responses: { error: { message, type, code } }. */

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  404: "not_found_error",
  405: "invalid_request_error",
};

export function errorResponse(status: number, message: string, code?: string, extra?: HeadersInit): Response {
  const type = TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
  const body = { error: { message: message || `Error ${status}`, type, code: code ?? type } };
  return Response.json(body, { status, headers: extra });
}

/** True when the body already looks like { error: { message: string } }. */
function isOpenAiShaped(text: string): boolean {
  try {
    const e = (JSON.parse(text) as { error?: { message?: unknown } } | null)?.error;
    return typeof e === "object" && e !== null && typeof e.message === "string";
  } catch {
    return false;
  }
}

/**
 * Message from a Cloudflare `{errors:[{message}]}` body or a Workers AI `{name:"AiError", description, message}`
 * one (what the gateway's OpenAI-compatible route answers), else raw text (<=500 chars), else a generic one.
 */
export function upstreamMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as { errors?: { message?: unknown }[]; description?: unknown; message?: unknown } | null;
    const m = [j?.errors?.[0]?.message, j?.description, j?.message].find((x) => typeof x === "string" && x.trim());
    if (typeof m === "string") return m;
  } catch {
    /* not JSON: fall through to raw text */
  }
  const raw = text.trim().slice(0, 500);
  return raw || `Upstream returned ${status}`;
}

/** Turn a non-OK upstream response into an OpenAI-shaped one (already-shaped errors are returned untouched). */
export async function normalizeUpstreamError(res: Response): Promise<Response> {
  const text = await res.clone().text();
  if (isOpenAiShaped(text)) return res;
  // Keep retry-after so a client can wait out a rate limit.
  const retryAfter = res.headers.get("retry-after");
  return errorResponse(res.status, upstreamMessage(text, res.status), "upstream_error", retryAfter ? { "retry-after": retryAfter } : undefined);
}
