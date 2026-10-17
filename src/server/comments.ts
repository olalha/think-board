// comments.json: notes on blocks, frames and the canvas as a whole, committed
// with the canvas. The user writes them in the app; agents read them, tick them
// done (with a short note), and write their own only when asked to.
//
//   { "format": 1, "comments": [
//     { "id": "c-3f9a1b", "on": "tea-flowchart", "by": "you", "text": "Shorter labels?",
//       "at": "2026-09-27T14:02:11.000Z",
//       "done": { "by": "agent", "at": "…", "note": "Shortened them" } } ] }
//
// `on` is a block name, a group id, or null for the canvas as a whole.

import { z } from "zod";
import type { Comment } from "../shared/protocol.js";

export const COMMENTS_FILE = "comments.json";
export const MAX_COMMENT = 4000;

const commentSchema = z.object({
  id: z.string().min(1).max(64),
  on: z.string().min(1).max(120).nullable(),
  by: z.string().min(1).max(80),
  text: z.string().max(MAX_COMMENT),
  at: z.string().max(40),
  edited: z.string().max(40).optional(),
  done: z
    .object({
      by: z.string().min(1).max(80),
      at: z.string().max(40),
      note: z.string().max(1000).optional(),
    })
    .optional(),
});

const fileSchema = z.object({
  format: z.literal(1).default(1),
  comments: z.array(commentSchema).default([]),
});

export function parseComments(text: string): { ok: true; comments: Comment[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `comments.json is not valid JSON: ${(err as Error).message}` };
  }
  const r = fileSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: `comments.json: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}` };
  const seen = new Set<string>();
  for (const c of r.data.comments) {
    if (seen.has(c.id)) return { ok: false, error: `comments.json: duplicate comment id "${c.id}"` };
    seen.add(c.id);
  }
  return { ok: true, comments: r.data.comments };
}

export function serializeComments(comments: Comment[]): string {
  const clean = comments.map((c) => {
    const out: Comment = { id: c.id, on: c.on, by: c.by, text: c.text, at: c.at };
    if (c.edited) out.edited = c.edited;
    if (c.done) out.done = { by: c.done.by, at: c.done.at, ...(c.done.note ? { note: c.done.note } : {}) };
    return out;
  });
  return JSON.stringify({ format: 1, comments: clean }, null, 2) + "\n";
}

/** "on tea-flowchart", "on the frame “Drinks”", "on the canvas" — for the agent's change note. */
export type Describe = (on: string | null) => string;

/** What changed between two versions of the comments, one line each (for change notes and History). */
export function describeCommentChanges(before: Comment[], after: Comment[], where: Describe): string[] {
  const old = new Map(before.map((c) => [c.id, c]));
  const now = new Map(after.map((c) => [c.id, c]));
  const quote = (t: string) => `“${t.length > 160 ? t.slice(0, 160) + "…" : t}”`;
  const lines: string[] = [];
  for (const c of after) {
    const was = old.get(c.id);
    if (!was) lines.push(`- New comment ${where(c.on)} by ${c.by}: ${quote(c.text)}${c.done ? " (already done)" : ""}`);
    else {
      if (was.text !== c.text) lines.push(`- Comment ${where(c.on)} edited: ${quote(c.text)}`);
      if (!was.done && c.done) lines.push(`- Comment ${where(c.on)} marked done by ${c.done.by}${c.done.note ? `: ${quote(c.done.note)}` : ""}`);
      if (was.done && !c.done) lines.push(`- Comment ${where(c.on)} reopened: ${quote(c.text)}`);
      if (was.on !== c.on) lines.push(`- Comment moved ${where(c.on)}`);
    }
  }
  for (const c of before) if (!now.has(c.id)) lines.push(`- Comment ${where(c.on)} removed: ${quote(c.text)}`);
  return lines;
}
