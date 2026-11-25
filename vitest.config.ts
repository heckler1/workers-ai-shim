import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-09-01",
        bindings: { ACCOUNT_ID: "acct", GATEWAY_ID: "gw", CF_AIG_TOKEN: "aig-secret" },
      },
    }),
  ],
});
