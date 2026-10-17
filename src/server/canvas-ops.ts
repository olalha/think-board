// Layout operations behind the `think` command (think add, move, link, frame…):
// pure functions from a canvas to a new canvas, so they can be tested alone.
// commands.ts decides who may do what; the runtime writes the result through
// the same path as every other layout change (reconciled, grid-snapped,
// written atomically).

import { BLOCK_SIZES, displayName, parseBlockFile, toBlockName, type BlockType } from "../shared/blocks.js";
import { EDGE_STYLES, groupMembers, type Canvas, type CanvasEdge, type CanvasNode, type CanvasView, type EdgeStyle, type FileNode, type GroupNode } from "../shared/canvas.js";
import { findFreeSlot, GROUP_MIN, snap, snapSize } from "./canvas-model.js";

/** A refusal or a mistake in a command, told to the caller as it is. */
export class OpError extends Error {}

export type PlaceSide = "right" | "left" | "below" | "above";
export const PLACE_SIDES: PlaceSide[] = ["right", "left", "below", "above"];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room kept between blocks placed next to each other: two grid steps, as the app's own placement. */
const gapOf = (grid: number) => grid * 2;

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

const isFile = (n: CanvasNode): n is FileNode => n.type === "file";
const isGroup = (n: CanvasNode): n is GroupNode => n.type === "group";

export function frameTitle(g: GroupNode): string {
  return g.label?.trim() || "Untitled frame";
}

export function nodeTitle(n: CanvasNode): string {
  return isGroup(n) ? `the frame “${frameTitle(n)}”` : `“${displayName(n.id)}”`;
}

/**
 * Find a block or frame by what an agent would type: its id (`tea-notes`,
 * `grp-drinks`), a block's file name (`tea-notes.md`), a block's display name
 * (`Tea notes`) or a frame's label (`Drinks`), ignoring case.
 */
export function findNode(canvas: Canvas, ref: string, want: "block" | "frame" | "any" = "any"): CanvasNode {
  const r = ref.trim().replace(/^\.\//, "");
  const ok = (n: CanvasNode) => want === "any" || (want === "block" ? isFile(n) : isGroup(n));
  const pool = canvas.nodes.filter(ok);
  const exact = pool.find((n) => n.id === r);
  if (exact) return exact;
  const file = parseBlockFile(r);
  if (file) {
    const n = pool.find((x) => x.id === file.name && isFile(x));
    if (n) return n;
  }
  const low = r.toLowerCase();
  const byLabel = pool.filter((n) => (isGroup(n) ? frameTitle(n).toLowerCase() === low : displayName(n.id).toLowerCase() === low || n.id === toBlockName(r)));
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new OpError(`“${r}” matches more than one frame (${byLabel.map((n) => n.id).join(", ")}) — use the id.`);
  const what = want === "frame" ? "frame" : want === "block" ? "block" : "block or frame";
  throw new OpError(`There is no ${what} “${r}” on the canvas (think read lists them).`);
}

/** The frames a node lies in (smallest first). */
export function framesOf(canvas: Canvas, id: string): GroupNode[] {
  return canvas.nodes
    .filter(isGroup)
    .filter((g) => g.id !== id && groupMembers(canvas, g.id).some((m) => m.id === id))
    .sort((a, b) => a.width * a.height - b.width * b.height);
}

/** The blocks a frame holds. */
export function frameBlocks(canvas: Canvas, frameId: string): FileNode[] {
  return groupMembers(canvas, frameId).filter(isFile);
}

/**
 * Where a rect of `size` goes next to `anchor`. With a side: right beside it
 * on that side — or a little further along it, as long as it still sits
 * beside the anchor; when that side is full, the nearest free spot around
 * the anchor instead (`sideTaken` says so). Without a side: the nearest free spot
 * around it (right, below, left, above, then further out). `exclude`: nodes
 * that do not count as in the way (the one being placed).
 */
export function placeBeside(canvas: Canvas, anchor: Rect, size: { width: number; height: number }, side: PlaceSide | undefined, grid: number, exclude: ReadonlySet<string> = new Set()): { x: number; y: number; sideTaken?: boolean } {
  const occupied = canvas.nodes.filter((n) => isFile(n) && !exclude.has(n.id));
  if (!side) return findFreeSlot(anchor, size, occupied, grid);
  const gap = gapOf(grid);
  // Snapped away from the anchor, so rounding never pulls the spot back onto it.
  const up = (v: number) => Math.ceil(v / grid) * grid;
  const down = (v: number) => Math.floor(v / grid) * grid;
  const x0 = side === "right" ? up(anchor.x + anchor.width + gap) : side === "left" ? down(anchor.x - gap - size.width) : snap(anchor.x, grid);
  const y0 = side === "below" ? up(anchor.y + anchor.height + gap) : side === "above" ? down(anchor.y - gap - size.height) : snap(anchor.y, grid);
  let x = x0 + 0; // (+0: never -0)
  let y = y0 + 0;
  // Taken: slide along the side (down for right/left, right for below/above)
  // past whatever is in the way — but only while still beside the anchor.
  const along = side === "right" || side === "left";
  const limit = (along ? anchor.y + anchor.height : anchor.x + anchor.width) + gap;
  for (let i = 0; i < 50 && (along ? y : x) <= limit; i++) {
    const blocker = occupied.find((o) => overlaps({ x, y, ...size }, o, gap - 1));
    if (!blocker) return { x, y };
    if (along) y = up(blocker.y + blocker.height + gap);
    else x = up(blocker.x + blocker.width + gap);
  }
  return { ...findFreeSlot(anchor, size, occupied, grid), sideTaken: true };
}

/** A frame's rectangle around these rects: the app's own padding, with room for the label on top. */
export function frameAround(rects: Rect[], grid: number): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  const pad = grid * 2;
  return { x: x0 - pad, y: y0 - pad * 2, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 3 };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function snapRect(r: Rect, grid: number): Rect {
  // Outward, so what it was drawn around stays inside.
  const x = Math.floor(r.x / grid) * grid;
  const y = Math.floor(r.y / grid) * grid;
  return {
    x,
    y,
    width: snapSize(Math.ceil((r.x + r.width - x) / grid) * grid, GROUP_MIN.width, grid),
    height: snapSize(Math.ceil((r.y + r.height - y) / grid) * grid, GROUP_MIN.height, grid),
  };
}

/**
 * Where a rect of `size` goes inside a frame: beside one of its blocks (right
 * or below), wherever the frame has to grow least; the top left of an empty
 * frame.
 */
export function placeInFrame(canvas: Canvas, frame: GroupNode, size: { width: number; height: number }, grid: number, exclude: ReadonlySet<string> = new Set()): { x: number; y: number } {
  const members = frameBlocks(canvas, frame.id).filter((m) => !exclude.has(m.id));
  if (!members.length) return { x: snap(frame.x + grid * 2, grid), y: snap(frame.y + grid * 4, grid) };
  let best: { x: number; y: number; cost: number } | null = null;
  const order = [...members].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const m of order) {
    for (const side of ["right", "below"] as const) {
      const p = placeBeside(canvas, m, size, side, grid, exclude);
      if (p.sideTaken) continue;
      const grown = union(frame, frameAround([{ ...p, ...size }], grid));
      const cost = grown.width * grown.height - frame.width * frame.height;
      if (!best || cost < best.cost) best = { ...p, cost };
    }
  }
  // Every spot beside its blocks is taken: below the whole frame's contents.
  if (!best) return placeBeside(canvas, { x: frame.x + grid * 2, y: Math.max(...members.map((m) => m.y + m.height)), width: size.width, height: 0 }, size, "below", grid, exclude);
  return { x: best.x, y: best.y };
}

/** A node with a new rect, snapped; blocks keep their type's minimum size. */
function withRect(n: CanvasNode, r: Partial<Rect>, grid: number, type?: BlockType): CanvasNode {
  const min = isGroup(n) ? { minWidth: GROUP_MIN.width, minHeight: GROUP_MIN.height } : BLOCK_SIZES[type ?? "markdown"];
  return {
    ...n,
    x: snap(r.x ?? n.x, grid),
    y: snap(r.y ?? n.y, grid),
    width: snapSize(r.width ?? n.width, min.minWidth, grid),
    height: snapSize(r.height ?? n.height, min.minHeight, grid),
  };
}

export function replaceNodes(canvas: Canvas, next: CanvasNode[]): Canvas {
  const byId = new Map(next.map((n) => [n.id, n]));
  return { ...canvas, nodes: canvas.nodes.map((n) => byId.get(n.id) ?? n) };
}

export interface PlaceOptions {
  near?: CanvasNode;
  side?: PlaceSide;
  at?: { x: number; y: number };
  by?: { x: number; y: number };
  size?: { width: number; height: number };
  into?: GroupNode;
}

/**
 * Move (and/or resize) a block, or a frame with everything in it. Returns
 * the new canvas and the ids that moved. `blockType` gives a block its
 * minimum size.
 */
export function placeNode(canvas: Canvas, node: CanvasNode, opts: PlaceOptions, grid: number, blockType?: BlockType): { canvas: Canvas; moved: string[]; sideTaken?: boolean } {
  const size = opts.size ? { width: opts.size.width, height: opts.size.height } : { width: node.width, height: node.height };
  const sized = withRect(node, size, grid, blockType);
  const snappedSize = { width: sized.width, height: sized.height };
  const members = isGroup(node) ? groupMembers(canvas, node.id) : [];
  const exclude = new Set([node.id, ...members.map((m) => m.id)]);
  let pos: { x: number; y: number; sideTaken?: boolean } = { x: node.x, y: node.y };
  if (opts.at) pos = opts.at;
  else if (opts.by) pos = { x: node.x + opts.by.x, y: node.y + opts.by.y };
  else if (opts.into) pos = placeInFrame(canvas, opts.into, snappedSize, grid, exclude);
  else if (opts.near) pos = placeBeside(canvas, opts.near, snappedSize, opts.side, grid, exclude);
  const moved = withRect(node, { ...pos, ...snappedSize }, grid, blockType);
  const dx = moved.x - node.x;
  const dy = moved.y - node.y;
  // A frame takes its blocks (and smaller frames) along.
  const carried = members.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy }));
  let next = replaceNodes(canvas, [moved, ...carried]);
  if (opts.into && !isGroup(node)) next = growFrame(next, opts.into.id, [moved], grid);
  return { canvas: next, moved: [node.id, ...carried.map((m) => m.id)], ...(pos.sideTaken ? { sideTaken: true } : {}) };
}

/** Grow a frame so it holds these rects too (it never shrinks). */
export function growFrame(canvas: Canvas, frameId: string, rects: Rect[], grid: number): Canvas {
  const g = canvas.nodes.find((n) => n.id === frameId && isGroup(n));
  if (!g || !rects.length) return canvas;
  const r = snapRect(union(g, frameAround(rects, grid)), grid);
  return replaceNodes(canvas, [{ ...g, ...r }]);
}

/**
 * Put blocks in a frame: the frame called `label` (by label or id) grows to
 * hold them, or a new frame is drawn around them. Returns the frame's id.
 */
export function frameNodes(canvas: Canvas, label: string, nodes: CanvasNode[], grid: number): { canvas: Canvas; frame: GroupNode; created: boolean } {
  let existing: GroupNode | null = null;
  try {
    existing = findNode(canvas, label, "frame") as GroupNode;
  } catch {
    existing = null;
  }
  if (existing) {
    const next = growFrame(canvas, existing.id, nodes, grid);
    return { canvas: next, frame: next.nodes.find((n) => n.id === existing!.id) as GroupNode, created: false };
  }
  if (!nodes.length) throw new OpError(`There is no frame “${label}” yet — name the blocks to draw it around: think frame "${label}" <block…>`);
  const taken = new Set(canvas.nodes.map((n) => n.id));
  const base = `grp-${toBlockName(label) || "frame"}`.slice(0, 60);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  const clean = label.trim().slice(0, 120);
  const frame: GroupNode = { id, type: "group", ...snapRect(frameAround(nodes, grid), grid), ...(clean ? { label: clean } : {}) };
  // Frames go first: they are drawn behind blocks.
  return { canvas: { ...canvas, nodes: [frame, ...canvas.nodes] }, frame, created: true };
}

export function removeFrame(canvas: Canvas, frame: GroupNode): Canvas {
  return {
    ...canvas,
    nodes: canvas.nodes.filter((n) => n.id !== frame.id),
    edges: canvas.edges.filter((e) => e.fromNode !== frame.id && e.toNode !== frame.id),
  };
}

export type Arrow = "end" | "both" | "none";

export interface LinkOptions {
  label?: string;
  style?: EdgeStyle;
  arrow?: Arrow;
}

/** Connect two nodes (from → to), or update the connection they already have. */
export function linkNodes(canvas: Canvas, from: CanvasNode, to: CanvasNode, opts: LinkOptions): { canvas: Canvas; edge: CanvasEdge; created: boolean } {
  if (from.id === to.id) throw new OpError("A block cannot be connected to itself.");
  if (opts.style && !EDGE_STYLES.includes(opts.style)) throw new OpError(`--style is solid, dashed or dotted.`);
  const apply = (e: CanvasEdge): CanvasEdge => {
    const out = { ...e };
    if (opts.label !== undefined) {
      const l = opts.label.trim().slice(0, 200);
      if (l) out.label = l;
      else delete out.label;
    }
    if (opts.style) {
      if (opts.style === "solid") delete out.style;
      else out.style = opts.style;
    }
    if (opts.arrow) {
      if (opts.arrow === "both") out.fromEnd = "arrow";
      else delete out.fromEnd;
      if (opts.arrow === "none") out.toEnd = "none";
      else delete out.toEnd;
    }
    return out;
  };
  const existing = canvas.edges.find((e) => e.fromNode === from.id && e.toNode === to.id);
  if (existing) {
    const edge = apply(existing);
    return { canvas: { ...canvas, edges: canvas.edges.map((e) => (e === existing ? edge : e)) }, edge, created: false };
  }
  const ids = new Set(canvas.edges.map((e) => e.id));
  const base = `e-${from.id}-${to.id}`.slice(0, 60);
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  const edge = apply({ id, fromNode: from.id, toNode: to.id });
  return { canvas: { ...canvas, edges: [...canvas.edges, edge] }, edge, created: true };
}

/** Remove the connections between two nodes (either direction). */
export function unlinkNodes(canvas: Canvas, a: CanvasNode, b: CanvasNode): { canvas: Canvas; removed: CanvasEdge[] } {
  const between = (e: CanvasEdge) => (e.fromNode === a.id && e.toNode === b.id) || (e.fromNode === b.id && e.toNode === a.id);
  const removed = canvas.edges.filter(between);
  return { canvas: { ...canvas, edges: canvas.edges.filter((e) => !between(e)) }, removed };
}

/** Save a view (or update the one with that name) framing these nodes, with some margin. */
export function saveView(canvas: Canvas, name: string, nodes: CanvasNode[], grid: number): { canvas: Canvas; view: CanvasView; created: boolean } {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OpError("A view needs a name.");
  if (!nodes.length) throw new OpError(`Name the blocks or frames the view shows: think view add "${clean}" <block|frame…>`);
  const margin = grid * 4;
  const x0 = Math.min(...nodes.map((n) => n.x)) - margin;
  const y0 = Math.min(...nodes.map((n) => n.y)) - margin;
  const x1 = Math.max(...nodes.map((n) => n.x + n.width)) + margin;
  const y1 = Math.max(...nodes.map((n) => n.y + n.height)) + margin;
  const rect = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  const views = canvas.views ?? [];
  const existing = views.find((v) => v.name.toLowerCase() === clean.toLowerCase());
  const target = nodes.length === 1 ? { target: nodes[0].id } : {};
  if (existing) {
    const view: CanvasView = { id: existing.id, name: existing.name, ...rect, ...target };
    return { canvas: { ...canvas, views: views.map((v) => (v === existing ? view : v)) }, view, created: false };
  }
  const ids = new Set(views.map((v) => v.id));
  const base = `v-${toBlockName(clean) || "view"}`.slice(0, 60);
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  const view: CanvasView = { id, name: clean, ...rect, ...target };
  return { canvas: { ...canvas, views: [...views, view] }, view, created: true };
}

export function removeView(canvas: Canvas, ref: string): { canvas: Canvas; view: CanvasView } {
  const views = canvas.views ?? [];
  const low = ref.trim().toLowerCase();
  const view = views.find((v) => v.id === ref.trim()) ?? views.find((v) => v.name.toLowerCase() === low);
  if (!view) throw new OpError(`There is no view “${ref}” (think read lists them).`);
  const rest = views.filter((v) => v !== view);
  const next: Canvas = { ...canvas };
  if (rest.length) next.views = rest;
  else delete next.views;
  return { canvas: next, view };
}

// ------------------------------------------------------------------ reading

export interface OutlineBlock {
  name: string;
  file: string;
  type: BlockType;
  x: number;
  y: number;
  width: number;
  height: number;
  protected: boolean;
  frames: string[];
}

export interface Outline {
  canvas: { name: string; slug: string; grid: number };
  blocks: OutlineBlock[];
  frames: { id: string; label: string; x: number; y: number; width: number; height: number; blocks: string[] }[];
  links: { id: string; from: string; to: string; label?: string; style: EdgeStyle; arrow: Arrow }[];
  views: { id: string; name: string; x: number; y: number; width: number; height: number; target?: string }[];
  comments: { open: number; done: number };
}

export function outline(canvas: Canvas, meta: { name: string; slug: string; grid: number }, types: ReadonlyMap<string, BlockType>, comments: { open: number; done: number }): Outline {
  const frames = canvas.nodes.filter(isGroup);
  const inFrames = new Map<string, string[]>();
  const frameList = frames.map((g) => {
    const blocks = frameBlocks(canvas, g.id).map((b) => b.id);
    for (const b of blocks) inFrames.set(b, [...(inFrames.get(b) ?? []), g.id]);
    return { id: g.id, label: frameTitle(g), x: g.x, y: g.y, width: g.width, height: g.height, blocks };
  });
  const blocks = canvas.nodes.filter(isFile).map((n) => ({
    name: n.id,
    file: n.file,
    type: types.get(n.id) ?? "markdown",
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    protected: !!n.protected,
    frames: inFrames.get(n.id) ?? [],
  }));
  const links = canvas.edges.map((e) => {
    const arrow: Arrow = e.fromEnd === "arrow" ? "both" : e.toEnd === "none" ? "none" : "end";
    return { id: e.id, from: e.fromNode, to: e.toNode, ...(e.label ? { label: e.label } : {}), style: e.style ?? "solid", arrow };
  });
  const views = (canvas.views ?? []).map((v) => ({ id: v.id, name: v.name, x: v.x, y: v.y, width: v.width, height: v.height, ...(v.target ? { target: v.target } : {}) }));
  return { canvas: meta, blocks, frames: frameList, links, views, comments };
}

/** The outline as a compact text an agent can read at a glance. */
export function outlineText(o: Outline): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const lines = [`“${o.canvas.name}” (${o.canvas.slug}) · ${n(o.blocks.length, "block")}, ${n(o.frames.length, "frame")}, ${n(o.links.length, "link")}, ${n(o.views.length, "view")} · grid ${o.canvas.grid} px`];
  const frameLabel = new Map(o.frames.map((f) => [f.id, f.label]));
  const pad = (s: string, w: number) => (s.length >= w ? s + " " : s + " ".repeat(w - s.length));
  if (o.blocks.length) {
    lines.push("", "blocks — name, type, x,y, width×height:");
    const w = Math.min(32, Math.max(...o.blocks.map((b) => b.name.length)) + 2);
    for (const b of [...o.blocks].sort((a, c) => a.y - c.y || a.x - c.x)) {
      const extra = [b.protected ? "protected" : "", b.frames.length ? `in ${b.frames.map((f) => `“${frameLabel.get(f)}”`).join(", ")}` : ""].filter(Boolean).join(" · ");
      lines.push(`  ${pad(b.name, w)}${pad(b.type, 10)}${pad(`${b.x},${b.y}`, 12)}${pad(`${b.width}×${b.height}`, 10)}${extra}`.trimEnd());
    }
  } else lines.push("", "no blocks yet");
  if (o.frames.length) {
    lines.push("", "frames:");
    for (const f of o.frames) lines.push(`  “${f.label}” (${f.id})  ${f.x},${f.y} ${f.width}×${f.height}${f.blocks.length ? ` — ${f.blocks.join(", ")}` : " — empty"}`);
  }
  if (o.links.length) {
    lines.push("", "links:");
    for (const l of o.links) {
      const bits = [l.label ? `“${l.label}”` : "", l.style !== "solid" ? l.style : "", l.arrow !== "end" ? (l.arrow === "both" ? "arrows both ends" : "no arrow") : ""].filter(Boolean).join(" · ");
      lines.push(`  ${l.from} → ${l.to}${bits ? `  ${bits}` : ""}`);
    }
  }
  if (o.views.length) {
    lines.push("", "views:");
    for (const v of o.views) lines.push(`  “${v.name}” (${v.id})  ${v.x},${v.y} ${v.width}×${v.height}${v.target ? ` · about ${v.target}` : ""}`);
  }
  const c = o.comments;
  lines.push("", c.open || c.done ? `comments: ${c.open} open, ${c.done} done — think comments` : "comments: none");
  return lines.join("\n");
}
