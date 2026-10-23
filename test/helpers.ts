// Test harness: a throwaway ROOT with its own config, the real prompt
// templates, a scripted fake ACP agent as the provider, and one open runtime.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoginManager } from "../src/server/agent/login.js";
import { ConfigStore, resolvePaths, type Paths } from "../src/server/config.js";
import { MermaidValidator } from "../src/server/mermaid.js";
import { ProjectStore } from "../src/server/projects.js";
import { ProjectRuntime, type ClientConn } from "../src/server/runtime.js";
import { Templates } from "../src/server/templates.js";
import { silentLogger } from "../src/server/util.js";
import type { ServerMessage } from "../src/shared/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, "..");

export interface Harness {
  root: string;
  dir: string;
  paths: Paths;
  store: ProjectStore;
  config: ConfigStore;
  runtime: ProjectRuntime;
  client: ClientConn;
  messages: ServerMessage[];
  prompts: () => Promise<string[][]>;
  /** The shell commands the fake agent ran (`run:` lines), with their output. */
  runs: () => Promise<{ run: string; code: number | null; out: string; err: string }[]>;
  waitIdle: () => Promise<void>;
  close: () => Promise<void>;
}

export async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 15000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function makeHarness(opts: { maxAttempts?: number; fakeEnv?: Record<string, string>; providerExtra?: Record<string, unknown>; secondProvider?: boolean } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "think-test-"));
  const appDir = path.join(root, "app");
  await fs.mkdir(path.join(appDir, "config"), { recursive: true });
  await fs.cp(path.join(APP_DIR, "prompts"), path.join(appDir, "prompts"), { recursive: true });
  await fs.copyFile(path.join(APP_DIR, "config", "names.txt"), path.join(appDir, "config", "names.txt"));
  await fs.cp(path.join(APP_DIR, "bin"), path.join(appDir, "bin"), { recursive: true }); // the `think` command, on the agent's PATH
  await fs.cp(path.join(APP_DIR, "skills"), path.join(appDir, "skills"), { recursive: true });
  const log = path.join(root, "agent-prompts.jsonl");
  await fs.writeFile(
    path.join(appDir, "config", "think.json"),
    JSON.stringify({
      gridSize: 20,
      validation: { maxAttempts: opts.maxAttempts ?? 2 },
      git: { defaultAutosaveSeconds: 0 },
      agent: { idleShutdownSeconds: 3600, defaultProvider: "fake" },
    }),
  );
  const fake = {
    label: "Fake agent",
    command: process.execPath,
    args: [path.join(APP_DIR, "test", "fixtures", "fake-agent.mjs")],
    env: { FAKE_AGENT_LOG: log, NODE_PATH: path.join(APP_DIR, "node_modules"), ...(opts.fakeEnv ?? {}) },
    auth: "login",
    instructionsFile: "AGENTS.md",
    instructionsTemplate: "project-agents.md",
    ...(opts.providerExtra ?? {}),
  };
  await fs.writeFile(
    path.join(appDir, "config", "providers.json"),
    JSON.stringify({
      fake,
      // The same fake agent under another name, for switching a canvas between providers.
      ...(opts.secondProvider ? { other: { ...fake, label: "Other agent" } } : {}),
    }),
  );
  const paths = resolvePaths({ THINK_ROOT: root, THINK_APP_DIR: appDir });
  const config = new ConfigStore(paths);
  const store = new ProjectStore(paths, config);
  const templates = new Templates(paths.promptsDir);
  const mermaid = new MermaidValidator();
  const created = await store.create("Test canvas", "fake");
  const runtime = new ProjectRuntime({
    slug: created.slug,
    paths,
    store,
    config,
    templates,
    mermaid,
    logins: new LoginManager(paths),
    log: silentLogger,
  });
  await runtime.open();
  const messages: ServerMessage[] = [];
  const client: ClientConn = { id: "test-client", send: (m) => messages.push(m) };
  runtime.attach(client);
  await waitFor(() => runtime.agentState === "ready", "the fake agent to be ready");
  return {
    root,
    dir: store.dir(created.slug),
    paths,
    store,
    config,
    runtime,
    client,
    messages,
    prompts: async () => {
      try {
        const text = await fs.readFile(log, "utf8");
        return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.blocks).map((l) => l.blocks as string[]);
      } catch {
        return [];
      }
    },
    runs: async () => {
      try {
        const text = await fs.readFile(log, "utf8");
        return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.run);
      } catch {
        return [];
      }
    },
    waitIdle: () => waitFor(() => !runtime.working, "the turn to finish", 20000),
    close: async () => {
      await runtime.close();
      await mermaid.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
