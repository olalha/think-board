// History: the canvas's git log, grouped into moments people recognise.
//
//   - an agent turn: everything the agent committed while answering one
//     message (recorded in .think/turns.jsonl), shown with the message;
//   - a stretch of the user's own edits between turns (its individual
//     commits stay available as finer restore points);
//   - a restore, an outside agent's session (one commit each), or app housekeeping.
//
// Everything is read from git on demand; nothing is rewritten. Restoring
// (in the runtime) writes old content back and commits it as a new change.

import fs from "node:fs/promises";
import path from "node:path";
import { isTextType, parseBlockFile } from "../shared/blocks.js";
import type { Canvas, FileNode } from "../shared/canvas.js";
import type { BlockInfo, HistoryEntry, HistorySnapshot } from "../shared/protocol.js";
import { parseCanvas } from "./canvas-model.js";
import { summarizeRange, type ChangeSummary } from "./changes.js";
import { AGENT_EMAIL, APP_EMAIL, commitsSince, git, showFile, USER_EMAIL, type CommitInfo } from "./git.js";
import { hashOf } from "./util.js";

export interface TurnRecord {
  at: number;
  start: string | null;
  end: string | null;
  prompt: string;
  reply: string;
  command?: boolean;
}

export async function readTurns(file: string): Promise<TurnRecord[]> {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as TurnRecord;
        } catch {
          return null;
        }
      })
      .filter((t): t is TurnRecord => !!t && !!t.end);
  } catch {
    return [];
  }
}

/** Summaries are immutable per commit range: cache them. */
const summaryCache = new Map<string, ChangeSummary>();

async function parentOf(dir: string, hash: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "-q", `${hash}^`])).trim() || null;
  } catch {
    return null;
  }
}

async function summary(dir: string, base: string | null, head: string): Promise<ChangeSummary> {
  const key = `${dir}\0${base}\0${head}`;
  let s = summaryCache.get(key);
  if (!s) {
    s = await summarizeRange(dir, base, head, "display");
    if (summaryCache.size > 2000) summaryCache.clear();
    summaryCache.set(key, s);
  }
  return s;
}

type Kind = HistoryEntry["kind"];

function classify(c: CommitInfo): { kind: Kind; who: string } {
  if (c.subject.startsWith("restore:")) return { kind: "restore", who: "You" };
  if (c.subject.startsWith("init:") || c.authorEmail === APP_EMAIL) return { kind: "app", who: "think" };
  if (c.authorEmail === USER_EMAIL) return { kind: "user", who: "You" };
  if (c.authorEmail === AGENT_EMAIL) return { kind: "agent", who: "Agent" };
  return { kind: "guest", who: c.authorName };
}

/**
 * Newest moments first. `before`: continue after this entry id (paging).
 * Scans up to 600 commits per page.
 */
export async function listHistory(dir: string, thinkDir: string, opts: { before?: string; limit?: number } = {}): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  const limit = Math.min(100, opts.limit ?? 40);
  let tip = "HEAD";
  if (opts.before) {
    const p = await parentOf(dir, opts.before);
    if (!p) return { entries: [], more: false };
    tip = p;
  }
  const commits = await commitsSince(dir, null, { head: tip, limit: 600 });
  const turns = await readTurns(path.join(thinkDir, "turns.jsonl"));
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  // Commit → the turn it belongs to: from the turn's end back to (not
  // including) its start, on the first-parent line.
  const turnOf = new Map<string, TurnRecord>();
  for (const t of turns) {
    const from = t.end ? index.get(t.end) : undefined;
    if (from === undefined) continue;
    for (let i = from; i < commits.length && commits[i].hash !== t.start; i++) {
      if (turnOf.has(commits[i].hash)) break;
      turnOf.set(commits[i].hash, t);
    }
  }

  // Group consecutive commits into moments.
  const groups: { kind: Kind; who: string; turn?: TurnRecord; commits: CommitInfo[] }[] = [];
  for (const c of commits) {
    const turn = turnOf.get(c.hash);
    const { kind, who } = turn ? { kind: "agent" as Kind, who: "Agent" } : classify(c);
    const last = groups[groups.length - 1];
    // An outside agent's sessions stay apart: think commits each one once, when its lock ends.
    const same = last && (turn ? last.turn === turn : !last.turn && last.kind === kind && last.who === who && kind !== "restore" && kind !== "app" && kind !== "guest");
    if (same) last.commits.push(c);
    else groups.push({ kind, who, turn, commits: [c] });
    if (groups.length > limit) break;
  }
  const more = groups.length > limit || (commits.length === 600 && groups.length === limit);
  const page = groups.slice(0, limit);

  const entries: HistoryEntry[] = [];
  for (const g of page) {
    const newest = g.commits[0];
    const oldest = g.commits[g.commits.length - 1];
    const base = await parentOf(dir, oldest.hash);
    const s = await summary(dir, base, newest.hash);
    const title = g.turn
      ? g.turn.prompt
      : g.kind === "restore"
        ? newest.subject.replace(/^restore:\s*/, "Restored ")
        : g.kind === "app"
          ? newest.subject.startsWith("init:")
            ? "Canvas created"
            : newest.subject.replace(/^think:\s*/, "")
          : g.kind === "agent"
            ? newest.subject.replace(/^agent:\s*/, "")
            : g.kind === "guest"
              ? // An outside agent's sessions: their summaries, newest first.
                [...new Set(g.commits.map((c) => (c.subject.startsWith(`${g.who}: `) ? c.subject.slice(g.who.length + 2) : c.subject)))]
                  .slice(0, 3)
                  .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
                  .join(" · ")
              : "";
    entries.push({
      id: newest.hash,
      base,
      kind: g.kind,
      who: g.who,
      title,
      reply: g.turn?.reply || undefined,
      command: g.turn?.command || undefined,
      at: newest.at,
      start: oldest.at,
      commits: g.commits.map((c) => ({ hash: c.hash, at: c.at, subject: c.subject })),
      summary: s,
    });
  }
  return { entries, more };
}

async function canvasAt(dir: string, rev: string): Promise<Canvas> {
  const buf = await showFile(dir, rev, "canvas.json");
  const r = buf ? parseCanvas(buf.toString("utf8")) : null;
  return r?.ok ? r.canvas : { nodes: [], edges: [] };
}

async function blocksAt(dir: string, rev: string, only?: Set<string>): Promise<BlockInfo[]> {
  let names: string[];
  try {
    names = (await git(dir, ["ls-tree", "--name-only", rev])).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: BlockInfo[] = [];
  for (const file of names) {
    const p = parseBlockFile(file);
    if (!p || (only && !only.has(p.name))) continue;
    if (isTextType(p.type)) {
      const buf = await showFile(dir, rev, file);
      if (!buf) continue;
      const content = buf.toString("utf8");
      out.push({ name: p.name, file, type: p.type, hash: hashOf(content), size: buf.length, content });
    } else {
      // Images load from /files/<file>?rev=<commit>; the hash doubles as that revision.
      out.push({ name: p.name, file, type: p.type, hash: rev, size: 0 });
    }
  }
  return out;
}

/**
 * The canvas as it was at `rev`, plus — when `base` is given — "ghosts": the
 * blocks that moment removed, as they were just before, so a preview can show
 * what went away.
 */
export async function historySnapshot(dir: string, rev: string, base: string | null): Promise<HistorySnapshot> {
  const [canvas, blocks, readme] = await Promise.all([canvasAt(dir, rev), blocksAt(dir, rev), showFile(dir, rev, "README.md")]);
  let ghosts: HistorySnapshot["ghosts"] = [];
  if (base) {
    const present = new Set(blocks.map((b) => b.name));
    const baseCanvas = await canvasAt(dir, base);
    const gone = baseCanvas.nodes.filter((n): n is FileNode => n.type === "file" && !present.has(n.id));
    if (gone.length) {
      const goneBlocks = await blocksAt(dir, base, new Set(gone.map((n) => n.id)));
      ghosts = gone.map((node) => ({ node, block: goneBlocks.find((b) => b.name === node.id) ?? null }));
    }
  }
  return { rev, canvas, blocks, readme: readme?.toString("utf8") ?? null, ghosts };
}
