// The drawing editor's undo history, as patches: each step records, for the
// shapes it touched, what they were before and after (and the page settings,
// when those changed). Kept with the canvas (.think/drawings/<name>.json), so
// undo reaches back into earlier editing sessions.
import type { Base, Drawing, Rect, Rotation, Shape } from "../../shared/drawing";

export interface ShapeChange {
  id: string;
  before: Shape | null;
  after: Shape | null;
  /** Where the shape sits in the list (for putting it back in place). */
  index: number;
}

interface Page {
  crop?: Rect;
  rotate?: Rotation;
  /** The page itself: a colour or a photo (a change of either is one step). */
  base?: Base;
  /** Histories saved by 0.3 recorded only a sketch's colour. */
  color?: string;
}

export interface Patch {
  shapes: ShapeChange[];
  page?: { before: Page; after: Page };
}

export interface History {
  undo: Patch[];
  redo: Patch[];
}

export const LIMIT = 150;

export function emptyHistory(): History {
  return { undo: [], redo: [] };
}

/** Accept a stored history only if it looks like one. */
export function loadHistory(raw: unknown): History {
  const h = raw as History | null;
  return h && Array.isArray(h.undo) && Array.isArray(h.redo) ? { undo: h.undo.slice(-LIMIT), redo: h.redo.slice(-LIMIT) } : emptyHistory();
}

export function pageOf(d: Drawing): Page {
  return { crop: d.crop, rotate: d.rotate, base: d.base };
}

function withPage(d: Drawing, p: Page): Drawing {
  const out: Drawing = { ...d, crop: p.crop, rotate: p.rotate };
  if (!p.crop) delete out.crop;
  if (!p.rotate) delete out.rotate;
  if (p.base) out.base = p.base;
  else if (p.color && d.base.kind === "color") out.base = { ...d.base, color: p.color };
  return out;
}

/** The patch that turns `before` into `after` (shapes compared by id). */
export function diff(before: Drawing, after: Drawing): Patch | null {
  const was = new Map(before.shapes.map((s, i) => [s.id, { s, i }]));
  const now = new Map(after.shapes.map((s, i) => [s.id, { s, i }]));
  const shapes: ShapeChange[] = [];
  for (const [id, { s, i }] of now) {
    const old = was.get(id);
    if (!old) shapes.push({ id, before: null, after: s, index: i });
    else if (old.s !== s) shapes.push({ id, before: old.s, after: s, index: i });
  }
  for (const [id, { s, i }] of was) if (!now.has(id)) shapes.push({ id, before: s, after: null, index: i });
  const pb = pageOf(before);
  const pa = pageOf(after);
  const pageChanged = JSON.stringify(pb) !== JSON.stringify(pa);
  if (!shapes.length && !pageChanged) return null;
  return pageChanged ? { shapes, page: { before: pb, after: pa } } : { shapes };
}

/** Apply a patch forwards (`redo`) or backwards (`undo`). */
export function apply(d: Drawing, p: Patch, dir: "undo" | "redo"): Drawing {
  let shapes = d.shapes.slice();
  const changes = dir === "undo" ? p.shapes.slice().reverse() : p.shapes;
  // Removals first, then insertions in index order, then replacements.
  for (const c of changes) {
    const target = dir === "undo" ? c.before : c.after;
    if (target === null) shapes = shapes.filter((s) => s.id !== c.id);
  }
  const inserts = changes.filter((c) => (dir === "undo" ? c.after === null && c.before : c.before === null && c.after)).sort((a, b) => a.index - b.index);
  for (const c of inserts) shapes.splice(Math.min(c.index, shapes.length), 0, (dir === "undo" ? c.before : c.after)!);
  for (const c of changes) {
    const from = dir === "undo" ? c.after : c.before;
    const to = dir === "undo" ? c.before : c.after;
    if (from && to) shapes = shapes.map((s) => (s.id === c.id ? to : s));
  }
  const out = { ...d, shapes };
  return p.page ? withPage(out, dir === "undo" ? p.page.before : p.page.after) : out;
}
