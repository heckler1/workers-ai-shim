# workers-ai-shim

An OpenAI-compatible front for Cloudflare Workers AI, routed through an authenticated AI Gateway.
It exists for clients (e.g. Norish with `@ai-sdk/openai-compatible`) that can only set a base URL and a Bearer key:

- adds the `cf-aig-authorization` header the client cannot send;
- adds `POST /v1/images/generations`, `POST /v1/audio/speech`, `GET /v1/audio/voices` and `POST /v1/audio/transcriptions`, which Workers AI's OpenAI-compatible API lacks.

Cloudflare-hosted models only: every route that takes a model requires an `@cf/<author>/<name>` id (400 otherwise, before any upstream call).

| Route | Behaviour |
| --- | --- |
| `POST /v1/chat/completions`, `/v1/embeddings`, `/v1/responses` | streamed passthrough to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/v1/...` |
| `POST /v1/images/generations` | translated to a Workers AI image run; returns `{created, data:[{b64_json}]}` |
| `POST /v1/audio/speech` | Deepgram Aura TTS (`@cf/deepgram/aura-1`, `aura-2-en`, `aura-2-es`). `{model, input, voice?, response_format?}`; `voice` becomes Aura's `speaker`; `speed`/`instructions` are ignored. Formats: `mp3` (default), `opus` (Ogg), `flac`, `wav` (24 kHz 16-bit mono), `pcm` (24 kHz). Streams the audio with the right content-type |
| `GET /v1/audio/voices[?model=]` | `{voices:[{id,name,language,locale}]}` for one Aura model, or all three deduped by id. No upstream call beyond token verification |
| `POST /v1/audio/transcriptions` | OpenAI multipart (`file` max 25 MB, `model`, `language`, `prompt`, `response_format` json/text/srt/vtt/verbose_json, `timestamp_granularities[]`) for `@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo`, `@cf/deepgram/nova-3`. Extra nova-3 fields: `diarize=true`, `smart_format` (default true) |
| `GET /v1/models` | Workers AI model search mapped to an OpenAI model list: text generation, embeddings, image, then only the TTS and transcription models above |
| `GET /health` | `ok`, no auth |

Errors are always `{ "error": { "message", "type", "code" } }`.

## Config

- `ACCOUNT_ID` (required): set it in the Cloudflare dashboard under the Worker's Settings → Variables, or in `.dev.vars` locally. It is not in `wrangler.jsonc`; `keep_vars: true` keeps `wrangler deploy` from removing the dashboard value. The Workers runtime exposes no account ID of its own. Without it every API route answers 500.
- `wrangler.jsonc` vars: `GATEWAY_ID`, optional `NATIVE_UPSTREAM` (`direct` default, or `gateway`): where images, speech and transcriptions go. `IMAGE_UPSTREAM` is still read as an alias when `NATIVE_UPSTREAM` is unset.

Optional secret: the AI Gateway authentication token, only for an authenticated gateway.

```sh
wrangler secret put CF_AIG_TOKEN        # production
cp .dev.vars.example .dev.vars          # local `pnpm dev`
```

## Deploy

```sh
pnpm install
pnpm test && pnpm typecheck
wrangler login        # once
wrangler secret put CF_AIG_TOKEN
pnpm deploy
SHIM_URL=https://workers-ai-shim.<you>.workers.dev CF_API_TOKEN=... scripts/smoke.sh
```

## Norish

- Endpoint: `https://<worker>.workers.dev/v1`
- API key: a Cloudflare API token with Workers AI read/run permission on the account.

## bookorbit (text to speech)

- Base URL: `https://<worker>.workers.dev/v1`
- API key: a Cloudflare API token with Workers AI read/run permission.
- Default model: `@cf/deepgram/aura-2-en` (voices from `GET /v1/audio/voices?model=...`).

## Security notes

- The caller's token is verified (`GET /accounts/<id>/ai/models/search?per_page=1`) before every upstream call on every route. AI Gateway can serve cached responses before Workers AI checks the token, so without this a revoked or foreign token could read cached answers.
- Successful verifications are cached per isolate for 5 minutes, keyed by SHA-256 of the token (max 1000 entries, oldest evicted). A revoked token can therefore keep working for up to 5 minutes. Raw tokens are never logged or stored.
- The caller's `Authorization` header is forwarded unchanged; `CF_AIG_TOKEN` (optional) is only ever sent to the gateway.

## Verified against a live account (2026-11-25)

1. **FLUX.2 multipart fields.** `@cf/black-forest-labs/flux-2-klein-9b` on `/ai/run` takes `multipart/form-data` with `prompt`, `width`, `height` and honours the size (1280x720 in, 1280x720 JPEG out, as base64 `result.image`, ~20 s).
2. **Gateway routes.** The gateway's OpenAI-compatible route (`.../workers-ai/v1/chat/completions`) works. Its native per-model route (`.../workers-ai/@cf/<model>`) answered 401 `Authentication error` for every request with a token that works on `/ai/run` directly. So images, speech and transcriptions go `direct` (`NATIVE_UPSTREAM: "direct"`, the default): no gateway logging or caching for them. Set `"gateway"` only after confirming that route accepts your token.
3. **Unauthenticated gateways.** Leave `CF_AIG_TOKEN` unset and the shim sends no `cf-aig-authorization` header.
4. **Aura TTS.** The upstream content-type is always `audio/mpeg`, whatever the format, so the shim sets its own. `encoding: "aac"` returns HTTP 200 with an empty body, so `aac` is rejected with 400. An unknown speaker is a 400 listing the valid voices.
5. **Transcription.** whisper takes raw bytes (no language/prompt); whisper-large-v3-turbo takes JSON with base64 `audio`; nova-3 takes raw bytes with options as query params (a base64 JSON body is rejected). whisper and nova-3 have no segments, so the shim groups words (sentence end, gap over 1 s, or 12 s). Turbo's `task: "translate"` does not translate, so `/v1/audio/translations` is not provided. `@cf/deepgram/flux` is websocket-only and not served.
