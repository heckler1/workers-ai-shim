import { errorResponse, normalizeUpstreamError } from "./errors";
import { SPEECH_MODELS } from "./models";
import { upstreamHeaders, type Upstream } from "./proxy";

interface Aura {
  language: string;
  locale: string;
  voices: string[];
}

/** Voices from Cloudflare's schemas. Order matters for /v1/audio/voices dedupe: the first model listing an id wins. */
export const AURA: Record<string, Aura> = {
  "@cf/deepgram/aura-2-en": {
    language: "en",
    locale: "en-US",
    voices: "amalthea andromeda apollo arcas aries asteria athena atlas aurora callista cora cordelia delia draco electra harmonia helena hera hermes hyperion iris janus juno jupiter luna mars minerva neptune odysseus ophelia orion orpheus pandora phoebe pluto saturn thalia theia vesta zeus".split(" "),
  },
  "@cf/deepgram/aura-2-es": {
    language: "es",
    locale: "es",
    voices: "sirio nestor carina celeste alvaro diana aquila selena estrella javier".split(" "),
  },
  "@cf/deepgram/aura-1": {
    language: "en",
    locale: "en-US",
    voices: "angus asteria arcas orion orpheus athena luna zeus perseus helios hera stella".split(" "),
  },
};
export { SPEECH_MODELS };

/**
 * Verified live: the upstream content-type is always audio/mpeg whatever the encoding, so the shim sets it.
 * aac is rejected because Aura answers 200 with an empty body for it.
 */
const FORMATS: Record<string, { aura: Record<string, unknown>; type: string }> = {
  mp3: { aura: { encoding: "mp3" }, type: "audio/mpeg" },
  opus: { aura: { encoding: "opus", container: "ogg" }, type: "audio/ogg" },
  flac: { aura: { encoding: "flac" }, type: "audio/flac" },
  wav: { aura: { encoding: "linear16", container: "wav" }, type: "audio/wav" },
  pcm: { aura: { encoding: "linear16", container: "none", sample_rate: 24000 }, type: "audio/pcm" },
};

interface SpeechRequest {
  model?: unknown;
  input?: unknown;
  voice?: unknown;
  response_format?: unknown;
}

export async function createSpeech(req: Request, up: Upstream): Promise<Response> {
  let input: SpeechRequest;
  try {
    input = (await req.json()) as SpeechRequest;
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }
  const { model, input: text, voice, response_format = "mp3" } = input ?? {};
  if (typeof model !== "string" || !SPEECH_MODELS.includes(model)) {
    return errorResponse(400, `\`model\` must be one of: ${SPEECH_MODELS.join(", ")}.`);
  }
  if (typeof text !== "string" || !text.trim()) return errorResponse(400, "`input` is required.");
  const format = typeof response_format === "string" ? FORMATS[response_format] : undefined;
  if (!format) return errorResponse(400, `Unsupported \`response_format\`; supported: ${Object.keys(FORMATS).join(", ")}.`);
  if (voice !== undefined && voice !== null && (typeof voice !== "string" || !voice)) return errorResponse(400, "`voice` must be a string.");

  const body = { text, ...(voice ? { speaker: voice } : {}), ...format.aura };
  const h = upstreamHeaders(req.headers, up, up.direct);
  h.delete("content-length");
  h.set("content-type", "application/json");
  const res = await fetch(up.nativeUrl(model), { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!res.ok) return normalizeUpstreamError(res);
  return new Response(res.body, { headers: { "content-type": format.type } });
}

/** bookorbit's voice list format. Without `model`, all Aura voices deduped by id (first listed model wins). */
export function listVoices(model: string | null): Response {
  if (model !== null && !AURA[model]) return errorResponse(400, `\`model\` must be one of: ${SPEECH_MODELS.join(", ")}.`);
  const seen = new Set<string>();
  const voices = [];
  for (const m of model !== null ? [model] : SPEECH_MODELS) {
    const { language, locale, voices: ids } = AURA[m];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      voices.push({ id, name: id[0].toUpperCase() + id.slice(1), language, locale });
    }
  }
  return Response.json({ voices });
}
