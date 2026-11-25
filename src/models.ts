/** Every route that takes a model requires a Cloudflare-hosted one. Each segment starts with a word char, so "." / ".." can never walk the upstream path. */
export const MODEL_RE = /^@cf\/\w[\w.-]*\/\w[\w.-]*$/;

/** Models only the audio routes can serve; the text routes refuse them with a pointer to the right route. */
export const SPEECH_MODELS = ["@cf/deepgram/aura-2-en", "@cf/deepgram/aura-2-es", "@cf/deepgram/aura-1"];
export const TRANSCRIPTION_MODELS = ["@cf/openai/whisper", "@cf/openai/whisper-large-v3-turbo", "@cf/deepgram/nova-3"];

/** The route a non-text model belongs on, or null for a model the text routes may forward. */
export function audioRouteFor(model: string): string | null {
  if (SPEECH_MODELS.includes(model)) return "/v1/audio/speech";
  if (TRANSCRIPTION_MODELS.includes(model)) return "/v1/audio/transcriptions";
  return null;
}
