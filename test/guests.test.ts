// The `think` command against a running guest bridge: starting a canvas and
// getting its link, through the real POSIX sh script and ROOT/guests/.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, resolvePaths } from "../src/server/config.js";
import { GuestBridge } from "../src/server/guests.js";
import type { ProjectManager } from "../src/server/manager.js";
import { ProjectStore } from "../src/server/projects.js";
import { silentLogger } from "../src/server/util.js";
import { APP_DIR } from "./helpers.js";

const run = promisify(execFile);
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function start(publicUrl: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "think-guests-"));
  const appDir = path.join(root, "app");
  await fs.mkdir(path.join(appDir, "config"), { recursive: true });
  await fs.writeFile(path.join(appDir, "config", "think.json"), JSON.stringify({ agent: { defaultProvider: "claude-code" } }));
  await fs.writeFile(path.join(appDir, "config", "providers.json"), JSON.stringify({ "claude-code": { label: "Claude", command: "true" } }));
  const paths = resolvePaths({ THINK_ROOT: root, THINK_APP_DIR: appDir });
  const config = new ConfigStore(paths);
  const store = new ProjectStore(paths, config);
  // create and url need no open canvas: no canvas is ever open here.
  const manager = { peek: () => undefined, openSlugs: () => [], get: () => Promise.reject(new Error("no canvases open in this test")) } as unknown as ProjectManager;
  const bridge = new GuestBridge(paths, store, manager, config, silentLogger, publicUrl);
  await bridge.start();
  cleanup = async () => {
    await bridge.stop();
    await fs.rm(root, { recursive: true, force: true });
  };
  const think = (...args: string[]) => run("sh", [path.join(APP_DIR, "bin", "think"), ...args], { env: { ...process.env, THINK_ROOT: root } });
  return { root, think };
}

describe("the think command", () => {
  it("starts a canvas and prints its folder and link; url prints the link", async () => {
    const { root, think } = await start("https://think.example.com/");
    const { stdout } = await think("new", "Launch plan", "Everything about the launch", "--as", "planner");
    expect(stdout).toBe(`canvas: launch-plan\nfolder: ${root}/data/launch-plan\nlink:   https://think.example.com/p/launch-plan\nnext:   think join launch-plan --as planner\n`);
    expect(await fs.readFile(path.join(root, "data", "launch-plan", "README.md"), "utf8")).toContain("Everything about the launch");
    expect((await think("url", "launch-plan")).stdout.trim()).toBe("https://think.example.com/p/launch-plan");
    expect((await think("list")).stdout).toMatch(/^launch-plan +Launch plan$/m);
    await expect(think("new", "Launch plan")).rejects.toMatchObject({ stderr: expect.stringContaining("already exists") });
  });

  it("says so when the app's address is not configured", async () => {
    const { think } = await start("");
    expect((await think("new", "Notes")).stdout).toContain("link:   (none: the app's address is not configured");
    await expect(think("url", "notes")).rejects.toMatchObject({ stderr: expect.stringContaining("THINK_PUBLIC_URL") });
  });
});

describe("think skill --install", () => {
  // A home of its own, and a PATH without any agent CLI: only folders say what is installed.
  async function home(dirs: string[], extraEnv: Record<string, string> = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "think-home-"));
    for (const d of dirs) await fs.mkdir(path.join(dir, d), { recursive: true });
    cleanup = () => fs.rm(dir, { recursive: true, force: true });
    const env = { HOME: dir, PATH: "/usr/bin:/bin", ...extraEnv };
    const install = (...args: string[]) => run("sh", [path.join(APP_DIR, "bin", "think"), "skill", "--install", ...args], { env });
    const exists = (p: string) => fs.stat(path.join(dir, p)).then(() => true, () => false);
    return { dir, install, exists };
  }
  const CLAUDE = ".claude/skills/think-canvas/SKILL.md";
  const CODEX = ".codex/skills/think-canvas/SKILL.md";

  it("installs the guide for every agent found: Claude Code and Codex", async () => {
    const h = await home([".claude", ".codex"]);
    const { stdout } = await h.install();
    expect(stdout).toContain(`installed for Claude Code: ${h.dir}/${CLAUDE}`);
    expect(stdout).toContain(`installed for Codex: ${h.dir}/${CODEX}`);
    const guide = await fs.readFile(path.join(h.dir, CODEX), "utf8");
    expect(guide).toMatch(/^---\nname: think-canvas\n/);
    expect(guide).toContain(path.join(APP_DIR, "bin", "think")); // {{THINK}} filled in
    expect(guide).not.toContain("{{THINK}}");
  });

  it("installs only for Codex when only Codex is there, and follows CODEX_HOME", async () => {
    const h = await home([".codex"]);
    await h.install();
    expect(await h.exists(CODEX)).toBe(true);
    expect(await h.exists(CLAUDE)).toBe(false);

    // CODEX_HOME set: Codex is there, and its skills live under it.
    const codexHome = path.join(h.dir, "codex-home");
    const { stdout } = await run("sh", [path.join(APP_DIR, "bin", "think"), "skill", "--install"], {
      env: { HOME: path.join(h.dir, "empty-home"), PATH: "/usr/bin:/bin", CODEX_HOME: codexHome },
    });
    expect(stdout.trim()).toBe(`installed for Codex: ${codexHome}/skills/think-canvas/SKILL.md`);
  });

  it("falls back to Claude Code when no agent is found, and installs only into DIR when given", async () => {
    const h = await home([]);
    expect((await h.install()).stdout.trim()).toBe(`installed for Claude Code: ${h.dir}/${CLAUDE}`);
    const target = path.join(h.dir, "somewhere");
    expect((await h.install(target)).stdout.trim()).toBe(`installed: ${target}/SKILL.md`);
    expect(await h.exists(CODEX)).toBe(false);
  });
});
