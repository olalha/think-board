// Config: the app's files, with overrides from the data folder merged over them.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, resolvePaths } from "../src/server/config.js";
import { Templates } from "../src/server/templates.js";
import { APP_DIR } from "./helpers.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = null;
});

async function setup() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "think-config-"));
  const appDir = path.join(root, "app");
  await fs.cp(path.join(APP_DIR, "config"), path.join(appDir, "config"), { recursive: true });
  await fs.cp(path.join(APP_DIR, "prompts"), path.join(appDir, "prompts"), { recursive: true });
  const paths = resolvePaths({ THINK_ROOT: root, THINK_APP_DIR: appDir });
  return { paths, config: new ConfigStore(paths) };
}

describe("config", () => {
  it("ships Claude Code and Codex, with Codex's own sign-in and full access in its container", async () => {
    const { paths, config } = await setup();
    const codex = config.provider("codex")!;
    expect(codex.command).toBe(path.join(paths.appDir, "node_modules/.bin/codex-acp"));
    expect(codex.loginMethods).toEqual([
      expect.objectContaining({ id: "think:chatgpt", command: path.join(paths.appDir, "node_modules/.bin/codex"), args: ["login", "--device-auth"] }),
    ]);
    expect(codex).toMatchObject({ permissionMode: "agent-full-access", apiKeyEnv: "OPENAI_API_KEY", apiKeyMethod: "api-key", instructionsFile: "AGENTS.md" });
    expect(codex.commands).not.toContain("init");
    expect(config.provider("claude-code")?.label).toBe("Claude Code");
  });

  it("merges ROOT/config over the app's config, key by key (null removes)", async () => {
    const { paths, config } = await setup();
    await fs.mkdir(paths.userConfigDir, { recursive: true });
    await fs.writeFile(path.join(paths.userConfigDir, "think.json"), JSON.stringify({ git: { defaultAutosaveSeconds: 120 } }));
    await fs.writeFile(path.join(paths.userConfigDir, "providers.json"), JSON.stringify({ codex: null, "claude-code": { label: "Claude" } }));
    expect(config.get()).toMatchObject({ defaultAutosaveSeconds: 120, gridSize: 20 });
    expect(config.provider("codex")).toBeUndefined();
    expect(config.provider("claude-code")).toMatchObject({ label: "Claude", permissionMode: "bypassPermissions" });
  });

  it("uses a prompt from ROOT/prompts when there is one", async () => {
    const { paths } = await setup();
    const templates = new Templates(paths.promptsDir, () => {}, paths.userPromptsDir);
    expect(await templates.render("turn-suffix.md", { protected_note: "" })).toContain("Reminder");
    await fs.mkdir(paths.userPromptsDir, { recursive: true });
    await fs.writeFile(path.join(paths.userPromptsDir, "turn-suffix.md"), "Mine.");
    expect(await templates.render("turn-suffix.md", { protected_note: "" })).toBe("Mine.");
  });

  it("switches a provider to its API key and back in ROOT/config/providers.json, keeping the rest", async () => {
    const { paths, config } = await setup();
    const file = path.join(paths.userConfigDir, "providers.json");
    await config.setProviderAuth("codex", "api-key"); // no overrides yet: the file is created
    expect(config.provider("codex")!.auth).toBe("api-key");
    expect(config.provider("claude-code")!.auth).toBe("login");

    await fs.writeFile(file, JSON.stringify({ format: 1, "claude-code": { label: "Claude" }, codex: { auth: "api-key", args: ["-v"] } }));
    await config.setProviderAuth("codex", "login");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ format: 1, "claude-code": { label: "Claude" }, codex: { auth: "login", args: ["-v"] } });
    expect(config.provider("claude-code")!.label).toBe("Claude");

    await fs.writeFile(file, "{ not json");
    await expect(config.setProviderAuth("codex", "api-key")).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(file, "utf8")).toBe("{ not json"); // left alone
  });
});
