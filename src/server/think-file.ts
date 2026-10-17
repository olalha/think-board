// think.json: a canvas's identity and settings. It is committed with the
// canvas, so a copied or cloned canvas folder keeps its name and settings.
// `format` says which canvas format the folder is in; migrations.ts brings
// older folders up to date, and a folder in a newer format than this build
// knows is refused rather than guessed at.
//
//   { "format": 3, "name": "Tea shop", "provider": "claude-code",
//     "createdAt": "…", "settings": { "autosaveSeconds": 60 } }

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CanvasSettings } from "../shared/protocol.js";

/**
 * The canvas format this build writes. 1 = before think.json existed (0.1–0.2);
 * 2 = think.json (0.3); 3 = a drawing may keep several originals (0.4).
 */
export const CANVAS_FORMAT = 3;
export const THINK_FILE = "think.json";

export interface ThinkFile {
  format: number;
  name: string;
  provider: string;
  createdAt: string;
  settings: CanvasSettings;
}

const settingsSchema = z.object({
  autosaveSeconds: z.number().int().min(0).max(86400),
});

const schema = z
  .object({
    format: z.number().int().min(1),
    name: z.string().trim().min(1).max(100),
    provider: z.string().min(1).max(64),
    createdAt: z.string().max(40).default(""),
    settings: settingsSchema.partial().default({}),
  })
  .passthrough();

export class NewerFormatError extends Error {
  constructor(readonly format: number) {
    super(`This canvas needs a newer version of think (canvas format ${format}; this one reads up to ${CANVAS_FORMAT}).`);
  }
}

export type ThinkFileRead = { ok: true; file: ThinkFile } | { ok: false; error: string } | { ok: false; missing: true };

/** Parse think.json text. Settings missing from the file take `defaults`. */
export function parseThinkFile(text: string, defaults: CanvasSettings): { ok: true; file: ThinkFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `think.json is not valid JSON: ${(err as Error).message}` };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, error: `think.json: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}` };
  return { ok: true, file: { ...r.data, settings: { ...defaults, ...r.data.settings } } };
}

export async function readThinkFile(dir: string, defaults: CanvasSettings): Promise<ThinkFileRead> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, THINK_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true };
    throw err;
  }
  return parseThinkFile(text, defaults);
}

export function serializeThinkFile(file: ThinkFile): string {
  const { format, name, provider, createdAt, settings, ...rest } = file;
  return JSON.stringify({ format, name, provider, createdAt, settings, ...rest }, null, 2) + "\n";
}

export function sameThinkFile(a: ThinkFile, b: ThinkFile): boolean {
  return serializeThinkFile(a) === serializeThinkFile(b);
}
