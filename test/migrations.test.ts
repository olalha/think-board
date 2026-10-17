// Canvas format upgrades: a 0.2 canvas (no think.json) opens as format 2, and
// a canvas from a newer think is refused rather than damaged.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, resolvePaths } from "../src/server/config.js";
import { git } from "../src/server/git.js";
import { ProjectStore } from "../src/server/projects.js";
import { CANVAS_FORMAT, NewerFormatError } from "../src/server/think-file.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = null;
});

async function makeStore(): Promise<ProjectStore> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "think-mig-"));
  const appDir = path.join(root, "app");
  await fs.mkdir(path.join(appDir, "config"), { recursive: true });
  await fs.writeFile(path.join(appDir, "config", "think.json"), JSON.stringify({ git: { defaultAutosaveSeconds: 90 }, agent: { defaultProvider: "claude-code" } }));
  await fs.writeFile(path.join(appDir, "config", "providers.json"), JSON.stringify({ "claude-code": { label: "Claude", command: "true" } }));
  const paths = resolvePaths({ THINK_ROOT: root, THINK_APP_DIR: appDir });
  return new ProjectStore(paths, new ConfigStore(paths));
}

/** Turn a freshly created canvas back into the 0.2 layout. */
async function makeOld(store: ProjectStore, slug: string, name: string): Promise<string> {
  const dir = store.dir(slug);
  await git(dir, ["rm", "-q", "think.json"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "back to 0.2"]);
  await fs.writeFile(path.join(store.thinkDir(slug), "project.json"), JSON.stringify({ name, provider: "claude-code", createdAt: "2026-09-01T00:00:00.000Z" }));
  return dir;
}

describe("migrations", () => {
  it("upgrades a 0.2 canvas to the current format and commits it as the app", async () => {
    const store = await makeStore();
    const { slug } = await store.create("Old canvas", "claude-code");
    const dir = await makeOld(store, slug, "Old canvas (renamed)");
    expect((await store.meta(slug)).format).toBe(1);
    expect((await store.meta(slug)).name).toBe("Old canvas (renamed)");

    await store.migrate(slug);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "think.json"), "utf8"));
    expect(meta).toEqual({ format: CANVAS_FORMAT, name: "Old canvas (renamed)", provider: "claude-code", createdAt: "2026-09-01T00:00:00.000Z", settings: { autosaveSeconds: 90 } });
    expect((await git(dir, ["log", "-1", "--format=%an|%s"])).trim()).toBe(`think|think: upgraded the canvas to format ${CANVAS_FORMAT}`);
    await expect(fs.access(path.join(store.thinkDir(slug), "project.json"))).rejects.toThrow();
    // Idempotent: a second run changes nothing.
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);
    await store.migrate(slug);
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
  });

  it("leaves the user's unsaved work out of the upgrade commit", async () => {
    const store = await makeStore();
    const { slug } = await store.create("Busy", "claude-code");
    const dir = await makeOld(store, slug, "Busy");
    await fs.writeFile(path.join(dir, "notes.md"), "# unsaved\n");
    await store.migrate(slug);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("?? notes.md");
  });

  it("brings a 0.3 canvas (format 2) up to date, keeping its name and settings", async () => {
    const store = await makeStore();
    const { slug } = await store.create("Recent", "claude-code");
    const dir = store.dir(slug);
    const file = path.join(dir, "think.json");
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), format: 2, settings: { autosaveSeconds: 300 } }));
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "as 0.3 left it"]);
    await store.migrate(slug);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ format: CANVAS_FORMAT, name: "Recent", settings: { autosaveSeconds: 300 } });
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refuses a canvas from a newer think and flags it in the list", async () => {
    const store = await makeStore();
    const { slug } = await store.create("Future", "claude-code");
    const file = path.join(store.dir(slug), "think.json");
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), format: CANVAS_FORMAT + 1 }));
    await expect(store.migrate(slug)).rejects.toThrow(NewerFormatError);
    const listed = (await store.list()).find((p) => p.slug === slug);
    expect(listed?.problem).toMatch(/newer version of think/);
  });

  it("falls back to the committed think.json when the file is broken", async () => {
    const store = await makeStore();
    const { slug } = await store.create("Sturdy", "claude-code");
    await fs.writeFile(path.join(store.dir(slug), "think.json"), "{ broken");
    expect((await store.meta(slug)).name).toBe("Sturdy");
  });
});
