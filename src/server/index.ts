// Entry point: wire the pieces together and listen.
//
// Environment (all optional):
//   THINK_ROOT        default /projects — the data folder: canvases in ROOT/data
//   THINK_APP_DIR     default: this checkout — the app (the Docker image: /opt/think)
//   THINK_HOST        default 127.0.0.1 (0.0.0.0 inside the container)
//   THINK_PORT        default 3091
//   THINK_SERVE_CLIENT  "0" to skip serving dist/client (development with Vite)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { LoginManager } from "./agent/login.js";
import { ConfigStore, resolvePaths } from "./config.js";
import { GuestBridge, retireCli } from "./guests.js";
import { ProjectManager } from "./manager.js";
import { MermaidValidator } from "./mermaid.js";
import { ProjectStore } from "./projects.js";
import { Templates } from "./templates.js";
import { consoleLogger } from "./util.js";

const log = consoleLogger("server");
if (!process.env.THINK_ROOT && !fs.existsSync("/projects")) {
  console.error("think: set THINK_ROOT to the data folder, e.g. THINK_ROOT=/tmp/think-dev npm run dev:server (see docs/development.md)");
  process.exit(1);
}
const paths = resolvePaths();
const config = new ConfigStore(paths);
const store = new ProjectStore(paths, config);
const templates = new Templates(paths.promptsDir, (t, keys) => log.warn(`template ${t} has unknown placeholders`, { keys }), paths.userPromptsDir);
const mermaid = new MermaidValidator();
const logins = new LoginManager(paths);
const manager = new ProjectManager({ paths, store, config, templates, mermaid, logins });

const version = appVersion();

/**
 * "0.2.0 (1a2b3c4)": package.json's version (found by walking up from this
 * module, so it works from src/ and dist/ alike) plus the commit — from
 * THINK_COMMIT (a Docker build argument) or, in a checkout, from git.
 */
function appVersion(): string {
  let v = "dev";
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? v;
      break;
    } catch {
      dir = path.dirname(dir);
    }
  }
  let commit = process.env.THINK_COMMIT?.trim() || "";
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: paths.appDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      /* not a checkout */
    }
  }
  return commit ? `${v} (${commit.slice(0, 7)})` : v;
}

fs.mkdirSync(paths.dataDir, { recursive: true });
fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o700 });
// A first start opens with the welcome canvas (examples/welcome).
await store.ensureWelcome().catch((err) => log.warn("could not create the welcome canvas", { error: String(err) }));

const app = await buildApp({
  paths,
  config,
  store,
  manager,
  version,
  serveClient: process.env.THINK_SERVE_CLIENT !== "0",
});

// Outside agents (the `think` command) reach the server through ROOT/guests/.
// The host's `think` command must not live in the data folder (see retireCli).
if (await retireCli(paths).catch(() => false)) {
  log.warn("removed the think command from the data folder (ROOT/cli): install it again as docs/install.md describes");
}
const guests = new GuestBridge(paths, store, manager, config, consoleLogger("guests"), process.env.THINK_PUBLIC_URL?.trim() ?? "");
await guests.start().catch((err) => log.warn("guest requests disabled", { error: String(err) }));

const host = process.env.THINK_HOST ?? "127.0.0.1";
const port = Number(process.env.THINK_PORT ?? 3091);
await app.listen({ host, port });
log.info(`think ${version} listening on http://${host}:${port}`, { root: paths.root, appDir: paths.appDir });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  try {
    await app.close();
    await manager.closeAll();
    await mermaid.close();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
