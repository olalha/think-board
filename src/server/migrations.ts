// Canvas format migrations. A canvas folder records its format in think.json
// (no think.json = format 1, the 0.1–0.2 layout). Opening a canvas runs every
// step from its format up to CANVAS_FORMAT, in order, and commits the result as
// the app — History shows the upgrade, and git keeps the way back.
//
// A step must be safe to re-run after a crash halfway through, and ends by
// writing its `to` into think.json's format. Add a step here, bump
// CANVAS_FORMAT, and add a test (test/migrations.test.ts).

import fs from "node:fs/promises";
import path from "node:path";
import type { CanvasSettings } from "../shared/protocol.js";
import { readJson, writeAtomic } from "./fsutil.js";
import { CANVAS_FORMAT, serializeThinkFile, THINK_FILE, type ThinkFile } from "./think-file.js";

export interface MigrationContext {
  dir: string;
  thinkDir: string;
  slug: string;
  defaults: { provider: string; settings: CanvasSettings };
}

interface Migration {
  to: number;
  /** Run the step; returns the paths it changed (to be committed). */
  run(ctx: MigrationContext): Promise<string[]>;
}

const MIGRATIONS: Migration[] = [
  {
    // 1 → 2: the canvas's name and provider move from the git-ignored
    // .think/project.json into a committed think.json, with its settings.
    to: 2,
    async run(ctx) {
      const old = await readJson<{ name?: string; provider?: string; createdAt?: string }>(path.join(ctx.thinkDir, "project.json"), {});
      const file: ThinkFile = {
        format: 2,
        name: typeof old.name === "string" && old.name.trim() ? old.name.trim().slice(0, 100) : ctx.slug,
        provider: typeof old.provider === "string" && old.provider ? old.provider : ctx.defaults.provider,
        createdAt: typeof old.createdAt === "string" ? old.createdAt : "",
        settings: { ...ctx.defaults.settings },
      };
      await writeAtomic(path.join(ctx.dir, THINK_FILE), serializeThinkFile(file), ctx.thinkDir);
      await fs.rm(path.join(ctx.thinkDir, "project.json"), { force: true });
      return [THINK_FILE];
    },
  },
  {
    // 2 → 3: a drawing may keep more than one original image in .drawings/<name>/
    // (base-<hash>.<ext>, a photo chosen as its page later). Nothing to convert —
    // the new number only stops an older think from misreading such a drawing.
    to: 3,
    async run(ctx) {
      const file = path.join(ctx.dir, THINK_FILE);
      const current = await readJson<Record<string, unknown> | null>(file, null);
      if (!current) return [];
      await writeAtomic(file, serializeThinkFile({ ...(current as unknown as ThinkFile), format: 3 }), ctx.thinkDir);
      return [THINK_FILE];
    },
  },
];

if (MIGRATIONS.at(-1)?.to !== CANVAS_FORMAT) throw new Error("migrations.ts: the last migration must reach CANVAS_FORMAT");

/** Run the steps from `from` up to CANVAS_FORMAT. Returns the changed paths. */
export async function migrate(ctx: MigrationContext, from: number): Promise<string[]> {
  const touched = new Set<string>();
  for (const m of MIGRATIONS) {
    if (m.to <= from) continue;
    for (const p of await m.run(ctx)) touched.add(p);
  }
  return [...touched];
}
