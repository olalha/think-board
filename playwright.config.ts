import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3095", viewport: { width: 1400, height: 900 } },
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://127.0.0.1:3095/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
