// Plain `git` CLI — the same tool the agent uses, so there is one behaviour to
// reason about. Each project folder is its own repository whose configured
// identity is `agent`; user commits override only the author.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const USER_AUTHOR = "user <user@think>";
export const USER_EMAIL = "user@think";
export const AGENT_NAME = "agent";
export const AGENT_EMAIL = "agent@think";
/** Housekeeping the app does itself (adding a README, restoring protected blocks). */
export const APP_AUTHOR = "think <app@think>";
export const APP_EMAIL = "app@think";

// Never prompt, never read the server user's global/system config (whose
// hooks, signing or identity could differ between host and container).
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
};

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** A file's bytes at a revision, or null if it did not exist there. */
export async function showFile(cwd: string, rev: string, file: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run("git", ["show", `${rev}:${file}`], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

export interface PathChange {
  /** A added, M modified, D deleted, R renamed (T type change counts as M). */
  status: "A" | "M" | "D" | "R";
  path: string;
  /** Renames: the old path. */
  from?: string;
}

function parseNameStatus(out: string): PathChange[] {
  const parts = out.split("\0").filter(Boolean);
  const changes: PathChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i][0];
    if (code === "R" || code === "C") {
      changes.push({ status: code === "R" ? "R" : "A", from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      changes.push({ status: code === "A" ? "A" : code === "D" ? "D" : "M", path: parts[i + 1] });
      i += 1;
    }
  }
  return changes;
}

/** What changed between two commits (null `from` = the empty tree), renames detected. */
export async function changesBetween(cwd: string, from: string | null, to: string): Promise<PathChange[]> {
  const base = from ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the empty tree
  try {
    return parseNameStatus(await git(cwd, ["diff", "--name-status", "-M", "-z", base, to]));
  } catch {
    return [];
  }
}

/** `edited a.md, b.md · renamed c.md → d.md · deleted e.md` for a list of changes. */
export function describePathChanges(changes: PathChange[], max = 12): string {
  const edited = changes.filter((c) => c.status === "M" || c.status === "A").map((c) => c.path);
  const renamed = changes.filter((c) => c.status === "R").map((c) => `${c.from} → ${c.path}`);
  const deleted = changes.filter((c) => c.status === "D").map((c) => c.path);
  const list = (xs: string[]) => xs.slice(0, max).join(", ") + (xs.length > max ? ` (+${xs.length - max} more)` : "");
  const parts: string[] = [];
  if (edited.length) parts.push(`edited ${list(edited)}`);
  if (renamed.length) parts.push(`renamed ${list(renamed)}`);
  if (deleted.length) parts.push(`deleted ${list(deleted)}`);
  return parts.join(" · ") || "no changes";
}

/** Identity flags so commits work even if a repo lost its local config. */
const identity = ["-c", `user.name=${AGENT_NAME}`, "-c", `user.email=${AGENT_EMAIL}`];

export async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", AGENT_NAME]);
  await git(dir, ["config", "user.email", AGENT_EMAIL]);
}

export async function head(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** Paths with uncommitted changes (ignored files excluded), repo-relative. */
export async function changedPaths(dir: string): Promise<string[]> {
  const out = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // Renames and copies are followed by the original path.
    if (status[0] === "R" || status[0] === "C") i++;
  }
  return [...new Set(paths)].sort();
}

/** Stage everything (respecting .gitignore) and commit. Returns the new HEAD, or null if clean. */
export async function commitAll(dir: string, opts: { message: string; author?: string }): Promise<string | null> {
  const paths = await changedPaths(dir);
  if (paths.length === 0) return null;
  await git(dir, ["add", "-A"]);
  const args = [...identity, "commit", "-q", "--no-verify", "-m", opts.message];
  if (opts.author) args.push(`--author=${opts.author}`);
  await git(dir, args);
  return head(dir);
}

/** Commit what is staged (callers `git add` first). Returns the new HEAD. */
export async function commitStaged(dir: string, message: string, author?: string): Promise<string | null> {
  await git(dir, [...identity, "commit", "-q", "--no-verify", "-m", message, ...(author ? [`--author=${author}`] : [])]);
  return head(dir);
}

/**
 * Commit only these paths (as the app, by default), leaving every other
 * uncommitted change alone — the user's unsaved work is never swept in.
 * Returns the new HEAD, or null when the paths had nothing to commit.
 */
export async function commitPaths(dir: string, paths: string[], opts: { message: string; author?: string }): Promise<string | null> {
  if (!paths.length) return null;
  await git(dir, ["add", "-A", "--", ...paths]);
  const staged = (await git(dir, ["diff", "--cached", "--name-only", "--", ...paths])).trim();
  if (!staged) return null;
  await git(dir, [...identity, "commit", "-q", "--no-verify", "-m", opts.message, `--author=${opts.author ?? APP_AUTHOR}`, "--", ...paths]);
  return head(dir);
}

/** `user: edited harry.md, bob.mmd` — the list of changed files, capped. */
export function userCommitMessage(paths: string[]): string {
  const shown = paths.slice(0, 12);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
  return `user: edited ${shown.join(", ")}${more}`;
}

export async function commitUserChanges(dir: string, prefix = "user"): Promise<{ head: string; paths: string[] } | null> {
  const paths = await changedPaths(dir);
  if (paths.length === 0) return null;
  // Describe what is staged, so a rename reads as one ("renamed a.md → b.md").
  await git(dir, ["add", "-A"]);
  const staged = parseNameStatus(await git(dir, ["diff", "--cached", "--name-status", "-M", "-z"]));
  if (!staged.length) return null;
  await git(dir, [...identity, "commit", "-q", "--no-verify", "-m", `${prefix}: ${describePathChanges(staged)}`, `--author=${USER_AUTHOR}`]);
  const h = await head(dir);
  return h ? { head: h, paths } : null;
}

export interface CommitInfo {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Unix ms. */
  at: number;
  subject: string;
}

/** Commits reachable from HEAD but not from `base`, newest first (first-parent). */
export async function commitsSince(dir: string, base: string | null, opts: { head?: string; limit?: number } = {}): Promise<CommitInfo[]> {
  const tip = opts.head ?? "HEAD";
  const range = base ? [`${base}..${tip}`] : [tip];
  let out: string;
  try {
    out = await git(dir, ["log", "--first-parent", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s", ...(opts.limit ? [`-n${opts.limit}`] : []), ...range]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, authorName, authorEmail, at, subject] = line.split("\x1f");
      return { hash, authorName, authorEmail, at: Number(at) * 1000, subject };
    });
}

/** Files changed between two commits (either may be null for "the empty tree"). */
export async function filesChangedBetween(dir: string, from: string | null, to: string | null): Promise<string[]> {
  if (!to) return [];
  const args = from ? ["diff", "--name-only", "-z", from, to] : ["show", "--name-only", "-z", "--format=", to];
  try {
    return (await git(dir, args)).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export async function isAncestor(dir: string, maybeAncestor: string, of: string): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", maybeAncestor, of]);
    return true;
  } catch {
    return false;
  }
}
