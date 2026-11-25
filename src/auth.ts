import { errorResponse } from "./errors";
import type { Env } from "./index";

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

/** SHA-256(token) hex -> expiry. Module-level, so it lives as long as the isolate. The raw token is never stored. */
const verified = new Map<string, number>();

export function clearAuthCache(): void {
  verified.clear();
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AuthResult = { ok: true; authorization: string; token: string } | { ok: false; response: Response };

/**
 * Verify the caller's Cloudflare API token by asking Cloudflare itself (cheap read on the account).
 * Must run before every upstream call: AI Gateway may serve cached answers before Workers AI checks the token.
 */
export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = /^Bearer\s+(\S+)\s*$/i.exec(authorization)?.[1];
  if (!token) {
    return { ok: false, response: errorResponse(401, "Missing bearer token (use a Cloudflare API token).", "missing_api_key") };
  }

  const key = await sha256Hex(token);
  const now = Date.now();
  const exp = verified.get(key);
  if (exp !== undefined && exp > now) return { ok: true, authorization, token };
  verified.delete(key);

  let status: number;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/models/search?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    status = res.status;
  } catch {
    return { ok: false, response: errorResponse(502, "Could not verify token with Cloudflare.", "auth_unavailable") };
  }

  if (status === 401 || status === 403) {
    return { ok: false, response: errorResponse(401, "Invalid Cloudflare API token.", "invalid_api_key") };
  }
  if (status !== 200) {
    return { ok: false, response: errorResponse(502, `Token verification failed upstream (status ${status}).`, "auth_unavailable") };
  }

  verified.set(key, now + TTL_MS);
  while (verified.size > MAX_ENTRIES) verified.delete(verified.keys().next().value as string);
  return { ok: true, authorization, token };
}
