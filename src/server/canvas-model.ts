// canvas.json: parsing, linting and reconciliation against the files on disk.
//
// Three layers, deliberately separate:
//   parseCanvas     — is it JSON with the right shape? If not, the last valid
//                     layout is kept and the error is shown / fed to the agent.
//   lintCanvas      — shape is fine, but does it agree with the files? These
//                     become validation issues after an agent turn.
//   reconcileCanvas — mechanically make it agree: drop nodes without files,
//                     place files without nodes, snap everything to the grid.

import { z } from "zod";
import { BLOCK_SIZES, displayName, type BlockType } from "../shared/blocks.js";
import { serializeCanvas, type Canvas, type CanvasEdge, type CanvasNode, type CanvasView, type FileNode, type GroupNode } from "../shared/canvas.js";
import type { ValidationIssue } from "../shared/protocol.js";

const side = z.enum(["top", "right", "bottom", "left"]);
const end = z.enum(["none", "arrow"]);

const fileNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("file"),
  file: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: z.string().optional(),
  protected: z.boolean().optional(),
});

const groupNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("group"),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  label: z.string().optional(),
  color: z.string().optional(),
});

const nodeSchema = z.discriminatedUnion("type", [fileNodeSchema, groupNodeSchema], {
  error: 'only nodes with "type": "file" (blocks) or "type": "group" (frames) are supported',
});

const edgeSchema = z.object({
  id: z.string().min(1),
  fromNode: z.string().min(1),
  fromSide: side.optional(),
  fromEnd: end.optional(),
  toNode: z.string().min(1),
  toSide: side.optional(),
  toEnd: end.optional(),
  label: z.string().optional(),
  color: z.string().optional(),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
});

const viewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  target: z.string().min(1).optional(),
  followName: z.boolean().optional(),
});

const canvasSchema = z.object({
  nodes: z.array(nodeSchema).default([]),
  edges: z.array(edgeSchema).default([]),
  views: z.array(viewSchema).optional(),
  slides: z.array(viewSchema).optional(),
});

export type ParseResult = { ok: true; canvas: Canvas } | { ok: false; error: string };

export function parseCanvas(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `canvas.json is not valid JSON: ${(err as Error).message}` };
  }
  const result = canvasSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.slice(0, 10).map((i) => {
      const where = i.path.length ? i.path.join(".") : "(root)";
      return `${where}: ${i.message}`;
    });
    const more = result.error.issues.length > 10 ? ` (+${result.error.issues.length - 10} more)` : "";
    return { ok: false, error: `canvas.json does not match the schema: ${lines.join("; ")}${more}` };
  }
  return { ok: true, canvas: result.data as Canvas };
}

/** What reconciliation needs to know about one block file. */
export interface BlockEntry {
  file: string;
  type: BlockType;
  /** Natural pixel size, for images. */
  natural?: { width: number; height: number };
}

/** Disagreements between a (schema-valid) canvas and the files — reported to the agent. */
export function lintCanvas(canvas: Canvas, blocks: ReadonlyMap<string, BlockEntry>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  for (const n of canvas.nodes) {
    if (nodeIds.has(n.id)) issues.push({ file: "canvas.json", message: `duplicate node id "${n.id}"` });
    nodeIds.add(n.id);
    if (n.type === "group") {
      if (blocks.has(n.id)) {
        issues.push({ file: "canvas.json", message: `group "${n.id}" has the same id as the block "${n.id}"; give the group a different id (e.g. "grp-${n.id}")` });
      }
      continue;
    }
    const stem = n.file.replace(/\.[^.]+$/, "");
    if (stem !== n.id) {
      issues.push({
        file: "canvas.json",
        block: n.id,
        message: `node "${n.id}" points at file "${n.file}"; a node's id must equal its file's name without the extension`,
      });
    }
    const block = blocks.get(n.id);
    if (!block) {
      issues.push({ file: "canvas.json", message: `node "${n.id}" has no block file "${n.file}" in the project folder` });
    } else if (block.file !== n.file) {
      issues.push({ file: "canvas.json", block: n.id, message: `node "${n.id}" says file "${n.file}" but the block's file is "${block.file}"` });
    }
  }
  const edgeIds = new Set<string>();
  for (const e of canvas.edges) {
    if (edgeIds.has(e.id)) issues.push({ file: "canvas.json", message: `duplicate edge id "${e.id}"` });
    edgeIds.add(e.id);
    for (const end of [e.fromNode, e.toNode]) {
      if (!nodeIds.has(end)) issues.push({ file: "canvas.json", message: `edge "${e.id}" refers to node "${end}", which is not in "nodes"` });
    }
  }
  for (const [list, what] of [[canvas.views, "view"], [canvas.slides, "slide"]] as const) {
    const ids = new Set<string>();
    for (const v of list ?? []) {
      if (ids.has(v.id)) issues.push({ file: "canvas.json", message: `duplicate ${what} id "${v.id}"` });
      ids.add(v.id);
      if (!v.name.trim()) issues.push({ file: "canvas.json", message: `${what} "${v.id}" has an empty name` });
    }
  }
  return issues;
}

// ------------------------------------------------------------------ renames

/** What rename detection knows about a block: its type, content hash and (for text) content. */
export interface RenameCandidate {
  name: string;
  type: BlockType;
  hash: string;
  text?: string;
}

/** Share of distinct non-blank lines two texts have in common (Jaccard), 0–1. */
export function lineSimilarity(a: string, b: string): number {
  const lines = (t: string) => new Set(t.split("\n").map((l) => l.trim()).filter(Boolean));
  const A = lines(a);
  const B = lines(b);
  if (!A.size && !B.size) return 1;
  let common = 0;
  for (const l of A) if (B.has(l)) common++;
  return common / (A.size + B.size - common);
}

/**
 * Pair blocks that disappeared with blocks that appeared, when one looks like
 * the other renamed: same type and identical content, or (text) mostly the
 * same lines. Greedy, best match first; each block pairs at most once.
 * Returns new name → old name.
 */
export function matchRenames(gone: readonly RenameCandidate[], appeared: readonly RenameCandidate[], threshold = 0.5): Map<string, string> {
  const pairs: { from: string; to: string; score: number }[] = [];
  for (const g of gone) {
    for (const a of appeared) {
      if (g.type !== a.type || g.name === a.name) continue;
      let score = g.hash === a.hash ? 2 : 0;
      if (!score && g.text !== undefined && a.text !== undefined) {
        const sim = lineSimilarity(g.text, a.text);
        if (sim >= threshold) score = sim;
      }
      if (score) pairs.push({ from: g.name, to: a.name, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const p of pairs) {
    if (used.has(p.from) || used.has(`>${p.to}`)) continue;
    used.add(p.from);
    used.add(`>${p.to}`);
    out.set(p.to, p.from);
  }
  return out;
}

/** Rename a node everywhere it is referenced (node id and file, edge ends). */
export function renameInCanvas(canvas: Canvas, from: string, to: string, file: string): Canvas {
  const retarget = (v: CanvasView): CanvasView => (v.target === from ? { ...v, target: to, ...(v.followName ? { name: displayName(to) } : {}) } : v);
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => (n.id === from && n.type === "file" ? { ...n, id: to, file } : n)),
    edges: canvas.edges.map((e) => ({
      ...e,
      fromNode: e.fromNode === from ? to : e.fromNode,
      toNode: e.toNode === from ? to : e.toNode,
    })),
    ...(canvas.views ? { views: canvas.views.map(retarget) } : {}),
    ...(canvas.slides ? { slides: canvas.slides.map(retarget) } : {}),
  };
}

// ------------------------------------------------------------------ geometry

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const snap = (v: number, grid: number) => Math.round(v / grid) * grid;

/** Snap a size to the grid, never below the type's minimum (rounded up to the grid). */
export function snapSize(v: number, min: number, grid: number): number {
  const minSnapped = Math.ceil(min / grid) * grid;
  return Math.max(minSnapped, snap(v, grid));
}

export function snapNode(node: FileNode, type: BlockType, grid: number): FileNode {
  const s = BLOCK_SIZES[type];
  return {
    ...node,
    x: snap(node.x, grid),
    y: snap(node.y, grid),
    width: snapSize(node.width, s.minWidth, grid),
    height: snapSize(node.height, s.minHeight, grid),
  };
}

/** Smallest group (frame) size. */
export const GROUP_MIN = { width: 160, height: 100 };

export function snapGroup(node: GroupNode, grid: number): GroupNode {
  return {
    ...node,
    x: snap(node.x, grid),
    y: snap(node.y, grid),
    width: snapSize(node.width, GROUP_MIN.width, grid),
    height: snapSize(node.height, GROUP_MIN.height, grid),
  };
}

/** Default size for a new block; images keep their aspect ratio within 360×360. */
export function defaultSize(entry: BlockEntry, grid: number): { width: number; height: number } {
  const s = BLOCK_SIZES[entry.type];
  let { width, height } = s;
  if (entry.type === "image" && entry.natural && entry.natural.width > 0 && entry.natural.height > 0) {
    const scale = Math.min(1, 360 / entry.natural.width, 360 / entry.natural.height);
    width = entry.natural.width * scale;
    height = entry.natural.height * scale;
  }
  return { width: snapSize(width, s.minWidth, grid), height: snapSize(height, s.minHeight, grid) };
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * The nearest free grid position for a rect of `size` next to `anchor`.
 * Tries the four sides of the anchor first (right, below, left, above), then
 * searches outward in rings, nearest first. "Free" means at least one grid gap
 * of clearance around every existing rect.
 */
export function findFreeSlot(
  anchor: Rect,
  size: { width: number; height: number },
  occupied: readonly Rect[],
  grid: number,
): { x: number; y: number } {
  const gap = grid * 2;
  const fits = (x: number, y: number) => !occupied.some((o) => overlaps({ x, y, ...size }, o, gap - 1));
  const sides = [
    { x: anchor.x + anchor.width + gap, y: anchor.y },
    { x: anchor.x, y: anchor.y + anchor.height + gap },
    { x: anchor.x - gap - size.width, y: anchor.y },
    { x: anchor.x, y: anchor.y - gap - size.height },
  ].map((p) => ({ x: snap(p.x, grid), y: snap(p.y, grid) }));
  for (const p of sides) if (fits(p.x, p.y)) return p;

  const origin = sides[0];
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  const step = gap;
  for (let ring = 1; ring <= 200; ring++) {
    const candidates: { x: number; y: number; d: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const x = snap(origin.x + i * step, grid);
        const y = snap(origin.y + j * step, grid);
        const d = Math.hypot(x + size.width / 2 - cx, y + size.height / 2 - cy);
        candidates.push({ x, y, d });
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates) if (fits(c.x, c.y)) return { x: c.x, y: c.y };
  }
  return origin; // unreachable in practice: the search area is enormous
}

// ------------------------------------------------------------------ reconcile

export interface ReconcileOptions {
  gridSize: number;
  /** Block name → last time it was touched (in the current turn, typically). */
  touched?: ReadonlyMap<string, number>;
  /** Block name → when its file first appeared; decides placement order. */
  firstSeen?: ReadonlyMap<string, number>;
  /**
   * Blocks known to have been renamed (new name → old name). A node still
   * carrying the old name keeps its position, size and connections under the
   * new one instead of being dropped and re-placed.
   */
  renames?: ReadonlyMap<string, string>;
}

export interface ReconcileResult {
  canvas: Canvas;
  changed: boolean;
  placed: string[];
  removed: string[];
  /** Renames that were applied: new name → old name. */
  renamed: Map<string, string>;
}

export function reconcileCanvas(
  input: Canvas,
  blocks: ReadonlyMap<string, BlockEntry>,
  opts: ReconcileOptions,
): ReconcileResult {
  const grid = opts.gridSize;
  const removed: string[] = [];
  const placed: string[] = [];
  const renamed = new Map<string, string>();

  // 0. Follow renames: a node for a vanished file whose content now lives under
  //    a new name (that has no node yet) becomes that block's node.
  let source = input;
  if (opts.renames?.size) {
    const ids = new Set(source.nodes.map((n) => n.id));
    for (const [to, from] of opts.renames) {
      const block = blocks.get(to);
      if (!block || !ids.has(from) || blocks.has(from) || ids.has(to)) continue;
      source = renameInCanvas(source, from, to, block.file);
      ids.delete(from);
      ids.add(to);
      renamed.set(to, from);
    }
  }

  // 1. Nodes: one per id. Blocks only if their file exists, pointing at the
  //    real file; groups always. Everything snapped to the grid.
  const nodes: CanvasNode[] = [];
  const seen = new Set<string>();
  const groupIdRemap = new Map<string, string>();
  for (const n of source.nodes) {
    if (n.type === "group") {
      let id = n.id;
      if (seen.has(id) && !blocks.has(id)) continue;
      if (blocks.has(id)) {
        // A group may not share an id with a block; give it a fresh one.
        let i = 1;
        while (seen.has(`grp-${id}${i > 1 ? `-${i}` : ""}`) || blocks.has(`grp-${id}${i > 1 ? `-${i}` : ""}`)) i++;
        id = `grp-${id}${i > 1 ? `-${i}` : ""}`;
        groupIdRemap.set(n.id, id);
      }
      seen.add(id);
      nodes.push(snapGroup({ ...n, id }, grid));
      continue;
    }
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const block = blocks.get(n.id);
    if (!block) {
      removed.push(n.id);
      continue;
    }
    nodes.push(snapNode({ ...n, type: "file", file: block.file }, block.type, grid));
  }
  const fileNodes = () => nodes.filter((n): n is FileNode => n.type === "file");

  // 2. Files without a node: place each next to the most recently touched
  //    block that already has one, else near the centroid of everything.
  const present = new Set(nodes.map((n) => n.id));
  const newcomers = [...blocks.keys()].filter((name) => !present.has(name));
  const firstSeen = opts.firstSeen ?? new Map();
  newcomers.sort((a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0) || a.localeCompare(b));
  const touched = opts.touched ?? new Map();
  for (const name of newcomers) {
    const entry = blocks.get(name)!;
    const size = defaultSize(entry, grid);
    const blocksNow = fileNodes();
    let anchor: Rect | null = null;
    let best = -Infinity;
    for (const n of blocksNow) {
      const t = touched.get(n.id);
      if (t !== undefined && t > best) {
        best = t;
        anchor = n;
      }
    }
    if (!anchor) {
      if (blocksNow.length) {
        const cx = blocksNow.reduce((s, n) => s + n.x + n.width / 2, 0) / blocksNow.length;
        const cy = blocksNow.reduce((s, n) => s + n.y + n.height / 2, 0) / blocksNow.length;
        anchor = { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height };
        // Centre on the centroid when there is room, rather than beside it.
        const centred = { x: snap(anchor.x, grid), y: snap(anchor.y, grid) };
        const gap = grid * 2;
        if (!blocksNow.some((o) => overlaps({ ...centred, ...size }, o, gap - 1))) {
          nodes.push({ id: name, type: "file", file: entry.file, ...centred, ...size });
          placed.push(name);
          continue;
        }
      } else {
        nodes.push({ id: name, type: "file", file: entry.file, x: 0, y: 0, ...size });
        placed.push(name);
        continue;
      }
    }
    const pos = findFreeSlot(anchor, size, blocksNow, grid);
    nodes.push({ id: name, type: "file", file: entry.file, ...pos, ...size });
    placed.push(name);
  }

  // 3. Edges: unique ids, both ends present.
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const raw of source.edges) {
    const e = groupIdRemap.size
      ? { ...raw, fromNode: groupIdRemap.get(raw.fromNode) ?? raw.fromNode, toNode: groupIdRemap.get(raw.toNode) ?? raw.toNode }
      : raw;
    if (edgeIds.has(e.id)) continue;
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    edgeIds.add(e.id);
    edges.push(e);
  }

  // 4. Views and slides: unique ids, whole pixels, names in step with their targets.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const viewList = (list: CanvasView[] | undefined): CanvasView[] => {
    const out: CanvasView[] = [];
    const seen = new Set<string>();
    for (const raw of list ?? []) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const v: CanvasView = { ...raw, name: raw.name.trim() || "Untitled view", x: Math.round(raw.x), y: Math.round(raw.y), width: Math.round(raw.width), height: Math.round(raw.height) };
      if (v.target && groupIdRemap.has(v.target)) v.target = groupIdRemap.get(v.target)!;
      // A view about a node keeps its name in step with the node's (a missing
      // target is kept: the block may come back, e.g. an undone delete).
      const t = v.target ? byId.get(v.target) : undefined;
      if (t && v.followName) v.name = t.type === "group" ? t.label?.trim() || "Untitled group" : displayName(t.id);
      if (!v.target) delete v.followName;
      out.push(v);
    }
    return out;
  };
  const views = viewList(source.views);
  const slides = viewList(source.slides);

  // Groups first, so they render behind the blocks they hold.
  nodes.sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));
  const canvas: Canvas = { nodes, edges };
  if (views.length) canvas.views = views;
  if (slides.length) canvas.slides = slides;
  const changed = serializeCanvas(canvas) !== serializeCanvas(input);
  return { canvas, changed, placed, removed, renamed };
}
