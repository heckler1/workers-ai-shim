/** Every route that takes a model requires a Cloudflare-hosted one. Each segment starts with a word char, so "." / ".." can never walk the upstream path. */
export const MODEL_RE = /^@cf\/\w[\w.-]*\/\w[\w.-]*$/;
