import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write via a temp file + rename, so a crash never leaves a truncated file and
 * a reader (the agent, the watcher) never sees a half-written one. The temp
 * file lives in `tmpDir` — inside the project's ignored `.think/` — so the
 * watcher never reports it.
 */
export async function writeAtomic(file: string, data: string | Buffer, tmpDir: string): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `.tmp-${path.basename(file)}-${randomBytes(4).toString("hex")}`);
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeAtomic(file, JSON.stringify(value, null, 2) + "\n", path.dirname(file));
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
