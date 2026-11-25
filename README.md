# workers-ai-shim

An OpenAI-compatible front for Cloudflare Workers AI, routed through an authenticated AI Gateway.
It exists for clients (e.g. Norish with `@ai-sdk/openai-compatible`) that can only set a base URL and a Bearer key:

- adds the `cf-aig-authorization` header the client cannot send;
- adds `POST /v1/images/generations`, which Workers AI's OpenAI-compatible API lacks.

| Route | Behaviour |
| --- | --- |
| `POST /v1/chat/completions`, `/v1/embeddings`, `/v1/responses` | streamed passthrough to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/v1/...` |
| `POST /v1/images/generations` | translated to a Workers AI image run; returns `{created, data:[{b64_json}]}` |
| `GET /v1/models` | Workers AI model search mapped to an OpenAI model list |
| `GET /health` | `ok`, no auth |

Errors are always `{ "error": { "message", "type", "code" } }`.

## Config

- `ACCOUNT_ID` (required): set it in the Cloudflare dashboard under the Worker's Settings → Variables, or in `.dev.vars` locally. It is not in `wrangler.jsonc`; `keep_vars: true` keeps `wrangler deploy` from removing the dashboard value. The Workers runtime exposes no account ID of its own. Without it every API route answers 500.
- `wrangler.jsonc` vars: `GATEWAY_ID`, optional `IMAGE_UPSTREAM` (`gateway` default, or `direct`).

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

## Security notes

- The caller's token is verified (`GET /accounts/<id>/ai/models/search?per_page=1`) before every upstream call on every route. AI Gateway can serve cached responses before Workers AI checks the token, so without this a revoked or foreign token could read cached answers.
- Successful verifications are cached per isolate for 5 minutes, keyed by SHA-256 of the token (max 1000 entries, oldest evicted). A revoked token can therefore keep working for up to 5 minutes. Raw tokens are never logged or stored.
- The caller's `Authorization` header is forwarded unchanged; `CF_AIG_TOKEN` (optional) is only ever sent to the gateway.

## Verified against a live account (2026-11-25)

1. **FLUX.2 multipart fields.** `@cf/black-forest-labs/flux-2-klein-9b` on `/ai/run` takes `multipart/form-data` with `prompt`, `width`, `height` and honours the size (1280x720 in, 1280x720 JPEG out, as base64 `result.image`, ~20 s).
2. **Gateway routes.** The gateway's OpenAI-compatible route (`.../workers-ai/v1/chat/completions`) works. Its native per-model route (`.../workers-ai/@cf/<model>`) answered 401 `Authentication error` for every request, JSON or multipart, with a token that works on `/ai/run` directly. So images go `direct` (`IMAGE_UPSTREAM: "direct"` in `wrangler.jsonc`): no gateway logging or caching for images. Set it back to `"gateway"` only after confirming that route accepts your token.
3. **Unauthenticated gateways.** Leave `CF_AIG_TOKEN` unset and the shim sends no `cf-aig-authorization` header.
