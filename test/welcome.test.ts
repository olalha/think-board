// The welcome canvas: made once, on a first start, from the app's examples/welcome —
// and the template itself is a valid canvas.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBlockFile } from "../src/shared/blocks.js";
import { lintCanvas, parseCanvas, type BlockEntry } from "../src/server/canvas-model.js";
import { parseComments } from "../src/server/comments.js";
import { ConfigStore, resolvePaths } from "../src/server/config.js";
import { git } from "../src/server/git.js";
import { MermaidValidator } from "../src/server/mermaid.js";
import { ProjectStore } from "../src/server/projects.js";
import { APP_DIR } from "./helpers.js";

const TEMPLATE = path.join(APP_DIR, "examples", "welcome");
let root: string | null = null;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = null;
});

async function setup(think: Record<string, unknown> = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "think-welcome-"));
  const appDir = path.join(root, "app");
  await fs.cp(path.join(APP_DIR, "config"), path.join(appDir, "config"), { recursive: true });
  await fs.cp(TEMPLATE, path.join(appDir, "examples", "welcome"), { recursive: true });
  await fs.writeFile(path.join(appDir, "config", "think.json"), JSON.stringify({ agent: { defaultProvider: "claude-code" }, ...think }));
  const paths = resolvePaths({ THINK_ROOT: root, THINK_APP_DIR: appDir });
  return { paths, store: new ProjectStore(paths, new ConfigStore(paths)) };
}

describe("the welcome canvas", () => {
  it("is a valid canvas: every block placed, links and views sound, comments readable, the diagram parses", async () => {
    const files = await fs.readdir(TEMPLATE);
    const blocks = new Map<string, BlockEntry>();
    for (const f of files) {
      const b = parseBlockFile(f);
      if (b && f !== "README.md") blocks.set(b.name, { file: f, type: b.type });
    }
    expect([...blocks.keys()].sort()).toEqual(["first-sketch", "how-it-works", "weigh-your-options", "welcome"]);
    expect(new Set([...blocks.values()].map((b) => b.type))).toEqual(new Set(["markdown", "mermaid", "html", "image"]));

    const parsed = parseCanvas(await fs.readFile(path.join(TEMPLATE, "canvas.json"), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(lintCanvas(parsed.canvas, blocks)).toEqual([]);
    expect(parsed.canvas.nodes.filter((n) => n.type === "file")).toHaveLength(blocks.size);
    expect(parsed.canvas.views?.length).toBeGreaterThan(0);

    const comments = parseComments(await fs.readFile(path.join(TEMPLATE, "comments.json"), "utf8"));
    expect(comments.ok && comments.comments.every((c) => c.on === null || blocks.has(c.on))).toBe(true);

    const mermaid = new MermaidValidator();
    try {
      expect(await mermaid.validate(await fs.readFile(path.join(TEMPLATE, "how-it-works.mmd"), "utf8"))).toBeNull();
    } finally {
      await mermaid.close();
    }
  });

  it("is made on a first start, committed, and only once", async () => {
    const { paths, store } = await setup();
    expect(await store.ensureWelcome()).toBe("welcome-to-think");
    const [canvas] = await store.list();
    expect(canvas).toMatchObject({ slug: "welcome-to-think", name: "Welcome to think", blocks: 4 });
    const dir = store.dir("welcome-to-think");
    expect(await git(dir, ["status", "--porcelain"])).toBe("");
    // One commit, the canvas's first: History shows it as think creating the canvas.
    expect((await git(dir, ["log", "--format=%an|%s"])).trim()).toBe('agent|init: create project "Welcome to think"');
    // Its comment is dated now, not when the template was written.
    const { comments } = JSON.parse(await fs.readFile(path.join(dir, "comments.json"), "utf8"));
    expect(Date.now() - Date.parse(comments[0].at)).toBeLessThan(60_000);

    // Deleting it does not bring it back.
    await fs.rm(dir, { recursive: true, force: true });
    expect(await store.ensureWelcome()).toBeNull();
    expect(await store.list()).toEqual([]);
    await expect(fs.access(path.join(paths.dataDir, ".welcomed"))).resolves.toBeUndefined();
  });

  it("is not made where canvases already exist, or when switched off", async () => {
    const existing = await setup();
    await existing.store.create("My plans", "claude-code");
    expect(await existing.store.ensureWelcome()).toBeNull();
    expect((await existing.store.list()).map((c) => c.slug)).toEqual(["my-plans"]);
    await fs.rm(root!, { recursive: true, force: true });

    const off = await setup({ welcomeCanvas: false });
    expect(await off.store.ensureWelcome()).toBeNull();
    expect(await off.store.list()).toEqual([]);
  });
});
