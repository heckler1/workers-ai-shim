import { errorResponse, normalizeUpstreamError } from "./errors";
import { upstreamHeaders, type Upstream } from "./proxy";

// Each segment starts with a word char, so "." / ".." can never walk the upstream path.
const MODEL_RE = /^@cf\/\w[\w.-]*\/\w[\w.-]*$/;

interface ImageRequest {
  model?: unknown;
  prompt?: unknown;
  size?: unknown;
}

/**
 * Field names / encoding for the Workers AI image models. FLUX.2 (verified on
 * flux-2-klein-9b via /ai/run, 2026-11-25) takes multipart/form-data with `prompt`, `width`, `height`
 * (all strings); older models take JSON `{ prompt, width, height }`. Change here only.
 */
function buildImageInput(model: string, prompt: string, width: number, height: number): { body: BodyInit; headers: Record<string, string> } {
  if (model.startsWith("@cf/black-forest-labs/flux-2")) {
    const form = new FormData();
    form.set("prompt", prompt);
    form.set("width", String(width));
    form.set("height", String(height));
    return { body: form, headers: {} }; // fetch adds the multipart boundary content-type
  }
  return { body: JSON.stringify({ prompt, width, height }), headers: { "content-type": "application/json" } };
}

function parseSize(size: unknown): [number, number] | null {
  if (size === undefined || size === null) return [1024, 1024];
  const m = typeof size === "string" ? /^(\d{1,5})x(\d{1,5})$/.exec(size) : null;
  if (!m || +m[1] < 1 || +m[2] < 1) return null;
  return [+m[1], +m[2]];
}

/** Chunked so large buffers don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function generateImage(req: Request, up: Upstream): Promise<Response> {
  let input: ImageRequest;
  try {
    input = (await req.json()) as ImageRequest;
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }
  const { model, prompt } = input ?? {};
  if (typeof model !== "string" || !model || typeof prompt !== "string" || !prompt) {
    return errorResponse(400, "`model` and `prompt` are required.");
  }
  if (!MODEL_RE.test(model)) return errorResponse(400, `Unsupported model id "${model}" (expected @cf/<author>/<name>).`);
  const size = parseSize(input.size);
  if (!size) return errorResponse(400, "`size` must look like 1024x1024.");

  const { body, headers } = buildImageInput(model, prompt, size[0], size[1]);
  const h = upstreamHeaders(req.headers, up, up.imageDirect);
  h.delete("content-length"); // the caller's JSON body is replaced by ours
  h.delete("content-type");
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const res = await fetch(up.imageUrl(model), { method: "POST", headers: h, body });
  if (!res.ok) return normalizeUpstreamError(res);

  let b64: string | undefined;
  if ((res.headers.get("content-type") ?? "").startsWith("image/")) {
    b64 = toBase64(new Uint8Array(await res.arrayBuffer()));
  } else {
    try {
      const j = (await res.json()) as { result?: { image?: unknown }; image?: unknown };
      const img = j?.result?.image ?? j?.image;
      if (typeof img === "string" && img) b64 = img;
    } catch {
      /* fall through to 502 */
    }
  }
  if (!b64) return errorResponse(502, "Upstream returned no image.", "upstream_error");
  return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
}
