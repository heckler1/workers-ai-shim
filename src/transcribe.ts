import { errorResponse, normalizeUpstreamError } from "./errors";
import { toBase64 } from "./images";
import { upstreamHeaders, type Upstream } from "./proxy";

const WHISPER = "@cf/openai/whisper";
const TURBO = "@cf/openai/whisper-large-v3-turbo";
const NOVA = "@cf/deepgram/nova-3";
export const TRANSCRIPTION_MODELS = [WHISPER, TURBO, NOVA];

const MAX_BYTES = 25 * 1024 * 1024;
const FORMATS = ["json", "text", "srt", "vtt", "verbose_json"];
const KEYTERM_MAX = 100;
const GAP_S = 1.0;
const MAX_SEGMENT_S = 12;

interface Word {
  word: string;
  start: number;
  end: number;
  speaker?: number;
}
interface Segment {
  start: number;
  end: number;
  text: string;
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}
/** What every model's output is normalized to. `vtt` is the upstream's own, when it has one. */
interface Transcript {
  text: string;
  language?: string;
  duration?: number;
  segments: Segment[];
  words: Word[];
  vtt?: string;
}

type Raw = Record<string, any>; // upstream JSON; fields are checked where used

/** Group words into segments: break after sentence-ending punctuation, on a gap > 1 s, or at 12 s. */
function groupWords(words: Word[], punctuated: (w: Word, i: number) => string): Segment[] {
  const segments: Segment[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;
  const flush = () => {
    if (cur) segments.push({ start: cur.start, end: cur.end, text: cur.parts.join(" ") });
    cur = null;
  };
  words.forEach((w, i) => {
    if (cur && (w.start - cur.end > GAP_S || w.end - cur.start > MAX_SEGMENT_S)) flush();
    const text = punctuated(w, i);
    cur ??= { start: w.start, end: w.end, parts: [] };
    cur.parts.push(text);
    cur.end = w.end;
    if (/[.!?]["')\]]*$/.test(text)) flush();
  });
  flush();
  return segments;
}

const lastEnd = (xs: { end: number }[]) => xs.length ? xs[xs.length - 1].end : undefined;

function fromWords(text: string, words: Word[], punctuated: (w: Word, i: number) => string): Transcript {
  const segments = groupWords(words, punctuated);
  return { text, duration: lastEnd(words), segments: segments.length || !text ? segments : [{ start: 0, end: 0, text }], words };
}

function parseWords(list: unknown): Word[] {
  return Array.isArray(list)
    ? list.map((w: Raw) => ({ word: String(w.word ?? "").trim(), start: Number(w.start) || 0, end: Number(w.end) || 0, ...(w.speaker !== undefined ? { speaker: w.speaker } : {}) }))
    : [];
}

function normalize(model: string, raw: Raw): Transcript {
  if (model === TURBO) {
    const segs: Raw[] = Array.isArray(raw.segments) ? raw.segments : [];
    const segments = segs.map((s) => ({
      start: s.start, end: s.end, text: String(s.text ?? "").trim(),
      temperature: s.temperature, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio, no_speech_prob: s.no_speech_prob,
    }));
    const text = String(raw.text ?? "").trim();
    return {
      text, language: raw.transcription_info?.language, vtt: raw.vtt,
      duration: raw.transcription_info?.duration ?? lastEnd(segments),
      segments: segments.length || !text ? segments : [{ start: 0, end: 0, text }],
      words: segs.flatMap((s) => parseWords(s.words)),
    };
  }
  if (model === NOVA) {
    const alt = raw.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const words = parseWords(alt.words);
    const pw: Raw[] = Array.isArray(alt.words) ? alt.words : [];
    return fromWords(String(alt.transcript ?? "").trim(), words, (w, i) => String(pw[i]?.punctuated_word ?? w.word));
  }
  const t = fromWords(String(raw.text ?? "").trim(), parseWords(raw.words), (w) => w.word);
  return { ...t, vtt: raw.vtt };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(sec: number, sep: "." | ","): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
const cue = (s: Segment, sep: "." | ",") => `${stamp(s.start, sep)} --> ${stamp(s.end, sep)}\n${s.text}`;

function render(t: Transcript, format: string, withWords: boolean): Response {
  switch (format) {
    case "text":
      return new Response(t.text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    case "vtt":
      return new Response(t.vtt || `WEBVTT\n\n${t.segments.map((s) => cue(s, ".")).join("\n\n")}\n`, { headers: { "content-type": "text/vtt; charset=utf-8" } });
    case "srt":
      return new Response(t.segments.map((s, i) => `${i + 1}\n${cue(s, ",")}\n`).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    case "verbose_json":
      return Response.json({
        task: "transcribe",
        language: t.language ?? "unknown",
        duration: t.duration ?? lastEnd(t.segments) ?? 0,
        text: t.text,
        segments: t.segments.map((s, id) => ({
          id, seek: 0, start: s.start, end: s.end, text: s.text, tokens: [],
          temperature: s.temperature ?? 0, avg_logprob: s.avg_logprob ?? 0, compression_ratio: s.compression_ratio ?? 0, no_speech_prob: s.no_speech_prob ?? 0,
        })),
        ...(withWords ? { words: t.words } : {}),
      });
    default:
      return Response.json({ text: t.text });
  }
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" && v ? v : undefined;
};

export async function transcribe(req: Request, up: Upstream): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse(400, "Request body must be multipart/form-data.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return errorResponse(400, "`file` is required.");
  const model = field(form, "model");
  if (!model) return errorResponse(400, "`model` is required.");
  if (!TRANSCRIPTION_MODELS.includes(model)) return errorResponse(400, `\`model\` must be one of: ${TRANSCRIPTION_MODELS.join(", ")}.`);
  const format = field(form, "response_format") ?? "json";
  if (!FORMATS.includes(format)) return errorResponse(400, `Unsupported \`response_format\`; supported: ${FORMATS.join(", ")}.`);
  if (file.size > MAX_BYTES) return errorResponse(413, "`file` exceeds the 25 MB limit.");

  const language = field(form, "language");
  const prompt = field(form, "prompt");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const h = upstreamHeaders(req.headers, up, up.direct);
  h.delete("content-length");
  let url = up.nativeUrl(model);
  let body: BodyInit;
  if (model === TURBO) {
    h.set("content-type", "application/json");
    body = JSON.stringify({ audio: toBase64(bytes), ...(language ? { language } : {}), ...(prompt ? { initial_prompt: prompt } : {}) });
  } else {
    h.set("content-type", file.type || "application/octet-stream");
    body = bytes;
    if (model === NOVA) {
      const q = new URLSearchParams({ smart_format: field(form, "smart_format") === "false" ? "false" : "true" });
      if (language) q.set("language", language);
      if (field(form, "diarize") === "true") q.set("diarize", "true");
      if (prompt && prompt.length <= KEYTERM_MAX) q.set("keyterm", prompt);
      url += `?${q}`;
    }
  }

  const res = await fetch(url, { method: "POST", headers: h, body });
  if (!res.ok) return normalizeUpstreamError(res);
  let raw: Raw;
  try {
    const j = (await res.json()) as Raw;
    raw = j?.result ?? j;
  } catch {
    return errorResponse(502, "Upstream returned no transcription.", "upstream_error");
  }
  const t = normalize(model, raw);
  if (language && !t.language) t.language = language;
  const granularities = [...form.getAll("timestamp_granularities[]"), ...form.getAll("timestamp_granularities")];
  return render(t, format, granularities.includes("word"));
}
