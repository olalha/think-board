// Starts the server for the e2e smoke test: a throwaway ROOT whose default
// provider is the scripted fake ACP agent, the real prompt templates, and the
// built client, on port 3095.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "think-e2e-"));
// Where tests find it, to run the `think` command against this server.
export const ROOT_FILE = path.join(os.tmpdir(), "think-e2e-3095.root");
fs.writeFileSync(ROOT_FILE, root);
const appDir = path.join(root, "app");
fs.mkdirSync(path.join(appDir, "config"), { recursive: true });
fs.cpSync(path.join(app, "prompts"), path.join(appDir, "prompts"), { recursive: true });
fs.cpSync(path.join(app, "bin"), path.join(appDir, "bin"), { recursive: true }); // the `think` command, as in a checkout
fs.copyFileSync(path.join(app, "config", "names.txt"), path.join(appDir, "config", "names.txt"));
fs.writeFileSync(path.join(appDir, "config", "think.json"), JSON.stringify({ git: { defaultAutosaveSeconds: 0 }, agent: { defaultProvider: "fake", idleShutdownSeconds: 5 } }));
fs.writeFileSync(
  path.join(appDir, "config", "providers.json"),
  JSON.stringify({
    fake: {
      label: "Fake agent",
      command: process.execPath,
      args: [path.join(app, "test", "fixtures", "fake-agent.mjs")],
      env: { FAKE_AGENT_LOG: path.join(root, "prompts.jsonl") },
      auth: "login",
      instructionsFile: "AGENTS.md",
      instructionsTemplate: "project-agents.md",
    },
  }),
);
const child = spawn(process.execPath, ["--import", "tsx", path.join(app, "src", "server", "index.ts")], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, THINK_ROOT: root, THINK_APP_DIR: appDir, THINK_CLIENT_DIR: path.join(app, "dist", "client"), THINK_PORT: "3095", THINK_HOST: "127.0.0.1" },
});
const stop = () => {
  child.kill("SIGTERM");
  setTimeout(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ROOT_FILE, { force: true });
  }, 1500);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
