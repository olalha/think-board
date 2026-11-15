// The canvas's files/ folder: reference material that is not a block —
// spreadsheets, archives, documents, data. The user uploads to it from the
// side panel's Files tab; the agent reads it and may add exports there. It is
// committed with the rest of the canvas.
//
// Every path that comes from a request goes through `resolveFilePath`, which
// keeps it inside files/: no "..", no absolute paths, no hidden segments, and
// no symlinks anywhere on the way (a link could point out of the folder).

import fs from "node:fs/promises";
import path from "node:path";
import { MAX_REFERENCE_FILE_BYTES, type ReferenceFile } from "../shared/protocol.js";
import { UserError } from "./projects.js";

export { MAX_REFERENCE_FILE_BYTES };

/** The folder's name, at the top level of the canvas. */
export const FILES_DIR = "files";
/** How deep the listing goes, and how many entries it reports at most. */
const MAX_DEPTH = 8;
const MAX_LISTED = 2000;
const MAX_PATH = 400;
const MAX_SEGMENT = 160;

/**
 * A request's path, checked and normalised: "a/b.csv" style, relative to
 * files/. Throws a UserError for anything that could leave the folder or that
 * the folder should not hold.
 */
export function cleanFilePath(rel: unknown): string {
  if (typeof rel !== "string") throw new UserError("A file path is needed.");
  const p = rel.trim().replace(/\/+$/, "");
  if (!p) throw new UserError("A file path is needed.");
  if (p.length > MAX_PATH) throw new UserError("That file path is too long.");
  if (p.includes("\0") || p.includes("\\")) throw new UserError("A file path can't contain backslashes or control characters.");
  if (p.startsWith("/") || path.isAbsolute(p)) throw new UserError("A file path is relative to the files/ folder.");
  const parts = p.split("/");
  for (const s of parts) {
    if (!s) throw new UserError("A file path can't have empty parts (//).");
    if (s === "." || s === "..") throw new UserError('A file path can\'t contain "." or "..".');
    if (s.startsWith(".")) throw new UserError("Hidden files (names starting with a dot) aren't kept in files/.");
    if (s.length > MAX_SEGMENT) throw new UserError("A file name in that path is too long.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new UserError("A file path can't contain control characters.");
  }
  if (parts.length > MAX_DEPTH) throw new UserError("That folder is nested too deeply.");
  return parts.join("/");
}

/** Throws unless `p` is not a symlink (a missing path is fine). */
async function assertNoLink(p: string): Promise<"file" | "dir" | "missing" | "other"> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) throw new UserError("That path goes through a link, which files/ doesn't follow.");
  return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
}

/**
 * The absolute path of `rel` inside `<canvas>/files/`, after checking every
 * existing component (files/ itself included) is a real directory or file,
 * not a symlink. `rel` must already be clean (`cleanFilePath`).
 */
export async function resolveFilePath(canvasDir: string, rel: string): Promise<{ full: string; kind: "file" | "dir" | "missing" | "other" }> {
  const clean = cleanFilePath(rel);
  const root = path.join(canvasDir, FILES_DIR);
  const full = path.join(root, clean);
  // Belt and braces: the joined path is inside the folder.
  if (!full.startsWith(root + path.sep)) throw new UserError("That path is outside files/.");
  let kind = await assertNoLink(root);
  if (kind !== "dir" && kind !== "missing") throw new UserError("files/ is not a folder.");
  const segments = clean.split("/");
  let at = root;
  for (let i = 0; i < segments.length && kind !== "missing"; i++) {
    if (kind !== "dir") throw new UserError(`"${segments.slice(0, i).join("/")}" is a file, not a folder.`);
    at = path.join(at, segments[i]);
    kind = await assertNoLink(at);
  }
  return { full, kind };
}

/** Every regular file under files/ (no hidden ones, no links), sorted by path. */
export async function listReferenceFiles(canvasDir: string): Promise<ReferenceFile[]> {
  const root = path.join(canvasDir, FILES_DIR);
  try {
    const st = await fs.lstat(root);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: ReferenceFile[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_LISTED) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || out.length >= MAX_LISTED) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile()) {
        try {
          const st = await fs.lstat(path.join(dir, e.name));
          out.push({ path: r, size: st.size, mtime: Math.round(st.mtimeMs) });
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  await walk(root, "", 1);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `report.pdf` → `report (2).pdf`, `report (3).pdf`… until one is free. */
export async function freeFilePath(canvasDir: string, rel: string): Promise<string> {
  const clean = cleanFilePath(rel);
  if ((await resolveFilePath(canvasDir, clean)).kind === "missing") return clean;
  const slash = clean.lastIndexOf("/");
  const folder = slash >= 0 ? clean.slice(0, slash + 1) : "";
  const base = clean.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  for (let i = 2; i < 1000; i++) {
    const candidate = `${folder}${stem} (${i})${ext}`;
    if ((await resolveFilePath(canvasDir, candidate)).kind === "missing") return candidate;
  }
  throw new UserError("Too many files with that name.");
}

/** Remove the now-empty folders above `full`, up to (not including) files/ itself. */
export async function pruneEmptyDirs(canvasDir: string, full: string): Promise<void> {
  const root = path.join(canvasDir, FILES_DIR);
  let dir = path.dirname(full);
  while (dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir); // fails unless empty
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** A Content-Disposition header for a download, safe for any file name. */
export function contentDisposition(kind: "attachment" | "inline", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** What a browser may be told a file is, for inline previews. Anything else is octet-stream. */
const PREVIEW_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  tsv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

export function previewMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEW_MIME[ext] ?? "application/octet-stream";
}
