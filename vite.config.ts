import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the client on port 3090 (THINK_WEB_PORT) and proxies the API
// and WebSocket to the Node server on 3091 (THINK_API_PORT; see docs/development.md).
const apiPort = Number(process.env.THINK_API_PORT ?? 3091);

export default defineConfig({
  root: "src/client",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.THINK_WEB_PORT ?? 3090),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
