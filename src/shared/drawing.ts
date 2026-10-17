// Drawings on image blocks (and sketches: drawings on a plain background).
//
// A drawing is data — a base (an image kept safe in the canvas's .drawings/
// folder, or a colour) plus shapes on top, all in the base's pixel
// coordinates, with an optional crop and rotation. drawingToSvg() turns it into
// an SVG; the editor shows exactly that SVG and the server renders exactly that
// SVG into the block's image file, so what you draw is what gets saved and
// what the agent sees.

import { getStroke } from "perfect-freehand";

export const DRAWING_FORMAT = 1;
/** The flattened image is at most this many pixels on its long side. */
export const MAX_OUTPUT = 2048;
export const FONT_FAMILY = "Inter, 'Inter Variable', -apple-system, 'Segoe UI', Roboto, sans-serif";

export type Rotation = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rub-out drawn over a shape: it hides that shape's ink along its path (and moves with it). */
export interface Erase {
  /** x, y pairs. */
  points: number[];
  size: number;
}

interface ShapeBase {
  id: string;
  color: string;
  erase?: Erase[];
}

export type Shape =
  | (ShapeBase & { type: "pen" | "highlighter"; /** x, y, pressure triples */ points: number[]; size: number })
  | (ShapeBase & { type: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; size: number })
  | (ShapeBase & { type: "rect" | "ellipse"; x: number; y: number; width: number; height: number; size: number })
  | (ShapeBase & { type: "text"; x: number; y: number; text: string; fontSize: number });

export type Base = { kind: "image"; file: string; width: number; height: number } | { kind: "color"; color: string; width: number; height: number };

export interface Drawing {
  format: number;
  base: Base;
  /** In base coordinates; absent = the whole base. */
  crop?: Rect;
  rotate?: Rotation;
  shapes: Shape[];
  /** Hash of the image file this drawing last produced (to notice when something else replaced it). */
  output?: string;
}

export const COLORS = ["#1f1f1f", "#ffffff", "#e5484d", "#f5a524", "#ffd60a", "#30a46c", "#3e63dd", "#8e4ec6"];
export const SIZES = { S: 4, M: 8, L: 16 } as const;
export const BACKGROUNDS = ["#ffffff", "#fbf8f1", "#f1f5f9", "#1f1f1d", "#0f172a"];
/** The page colours with names, for menus and screen readers. */
export const PAGES = [
  { color: "#ffffff", name: "White" },
  { color: "#fbf8f1", name: "Paper" },
  { color: "#f1f5f9", name: "Mist" },
  { color: "#1f1f1d", name: "Charcoal" },
  { color: "#0f172a", name: "Night" },
];

// ------------------------------------------------------------------ geometry

export function cropOf(d: Drawing): Rect {
  return d.crop ?? { x: 0, y: 0, width: d.base.width, height: d.base.height };
}

/** The output's size in pixels before any scaling (crop, then rotation). */
export function outputSize(d: Drawing): { width: number; height: number } {
  const c = cropOf(d);
  return (d.rotate ?? 0) % 180 ? { width: c.height, height: c.width } : { width: c.width, height: c.height };
}

/** Base coordinates → output coordinates: the transform on the content group. */
export function contentTransform(d: Drawing): string {
  const c = cropOf(d);
  const r = d.rotate ?? 0;
  const rot = r === 90 ? `translate(${c.height} 0) rotate(90)` : r === 180 ? `translate(${c.width} ${c.height}) rotate(180)` : r === 270 ? `translate(0 ${c.width}) rotate(270)` : "";
  return `${rot} translate(${-c.x} ${-c.y})`.trim();
}

/** Base coordinates → output coordinates, as a point mapping (crop, then rotation). */
export function toOutput(d: Drawing): (x: number, y: number) => [number, number] {
  const c = cropOf(d);
  const r = d.rotate ?? 0;
  return (x, y) => {
    const u = x - c.x;
    const v = y - c.y;
    return r === 90 ? [c.height - v, u] : r === 180 ? [c.width - u, c.height - v] : r === 270 ? [v, c.width - u] : [u, v];
  };
}

/**
 * The drawing on a new page (another colour, a photo, or a blank page instead
 * of a photo). `keep` carries the shapes across: as they looked (crop and
 * rotation applied), scaled to fit the new page and centred on it. Otherwise
 * the new page starts empty.
 */
export function changePage(d: Drawing, base: Base, keep: boolean): Drawing {
  const next: Drawing = { format: d.format, base, shapes: [] };
  if (!keep || !d.shapes.length) return next;
  const from = outputSize(d);
  const k = Math.min(base.width / from.width, base.height / from.height);
  const ox = (base.width - from.width * k) / 2;
  const oy = (base.height - from.height * k) / 2;
  const out = toOutput(d);
  next.shapes = d.shapes.map((s) => {
    const m = mapShape(
      s,
      (x, y) => {
        const [u, v] = out(x, y);
        return [ox + u * k, oy + v * k];
      },
      k,
    );
    // mapShape keeps outlines as they are (resizing a shape); a new page scales them too.
    return m.type === "line" || m.type === "arrow" || m.type === "rect" || m.type === "ellipse" ? { ...m, size: m.size * k } : m;
  });
  return next;
}

/** The bounding box of a shape, in base coordinates. */
export function shapeBounds(s: Shape): Rect {
  switch (s.type) {
    case "pen":
    case "highlighter": {
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (let i = 0; i < s.points.length; i += 3) {
        x1 = Math.min(x1, s.points[i]);
        y1 = Math.min(y1, s.points[i + 1]);
        x2 = Math.max(x2, s.points[i]);
        y2 = Math.max(y2, s.points[i + 1]);
      }
      const pad = s.size / 2;
      return { x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2 };
    }
    case "line":
    case "arrow": {
      const pad = s.size * (s.type === "arrow" ? 2.5 : 0.5);
      return { x: Math.min(s.x1, s.x2) - pad, y: Math.min(s.y1, s.y2) - pad, width: Math.abs(s.x2 - s.x1) + pad * 2, height: Math.abs(s.y2 - s.y1) + pad * 2 };
    }
    case "rect":
    case "ellipse": {
      const pad = s.size / 2;
      return { x: Math.min(s.x, s.x + s.width) - pad, y: Math.min(s.y, s.y + s.height) - pad, width: Math.abs(s.width) + pad * 2, height: Math.abs(s.height) + pad * 2 };
    }
    case "text": {
      const lines = s.text.split("\n");
      const w = Math.max(1, ...lines.map((l) => l.length)) * s.fontSize * 0.56;
      return { x: s.x, y: s.y, width: w, height: lines.length * s.fontSize * LINE_HEIGHT };
    }
  }
}

/** Move and/or scale a shape (and its rub-outs) with a point mapping; `scale` adjusts sizes. */
export function mapShape(s: Shape, f: (x: number, y: number) => [number, number], scale = 1): Shape {
  const mapPairs = (pts: number[], stride: number) => {
    const out = pts.slice();
    for (let i = 0; i < out.length; i += stride) [out[i], out[i + 1]] = f(out[i], out[i + 1]);
    return out;
  };
  const erase = s.erase?.map((e) => ({ points: mapPairs(e.points, 2), size: e.size * scale }));
  const common = erase ? { erase } : {};
  switch (s.type) {
    case "pen":
    case "highlighter":
      return { ...s, ...common, points: mapPairs(s.points, 3), size: s.size * scale };
    case "line":
    case "arrow": {
      const [x1, y1] = f(s.x1, s.y1);
      const [x2, y2] = f(s.x2, s.y2);
      return { ...s, ...common, x1, y1, x2, y2 };
    }
    case "rect":
    case "ellipse": {
      const [x1, y1] = f(s.x, s.y);
      const [x2, y2] = f(s.x + s.width, s.y + s.height);
      return { ...s, ...common, x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
    case "text": {
      const [x, y] = f(s.x, s.y);
      return { ...s, ...common, x, y, fontSize: Math.max(6, s.fontSize * scale) };
    }
  }
}

/** Distance from a point to a shape's ink (for picking and the stroke eraser). */
export function distanceToShape(s: Shape, x: number, y: number): number {
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  switch (s.type) {
    case "pen":
    case "highlighter": {
      let d = Infinity;
      const p = s.points;
      if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) - s.size / 2;
      for (let i = 3; i < p.length; i += 3) d = Math.min(d, seg(p[i - 3], p[i - 2], p[i], p[i + 1]));
      return d - s.size / 2;
    }
    case "line":
    case "arrow":
      return seg(s.x1, s.y1, s.x2, s.y2) - s.size / 2;
    case "rect": {
      const { x: rx, y: ry, width: w, height: h } = s;
      return Math.min(seg(rx, ry, rx + w, ry), seg(rx + w, ry, rx + w, ry + h), seg(rx + w, ry + h, rx, ry + h), seg(rx, ry + h, rx, ry)) - s.size / 2;
    }
    case "ellipse": {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const rx = Math.max(1, s.width / 2);
      const ry = Math.max(1, s.height / 2);
      const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(k - 1) * Math.min(rx, ry) - s.size / 2;
    }
    case "text": {
      const b = shapeBounds(s);
      const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
      return Math.hypot(dx, dy);
    }
  }
}

// ------------------------------------------------------------------ SVG

const LINE_HEIGHT = 1.25;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => String(Math.round(n * 100) / 100);
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : "#1f1f1f");

/** The outline of a freehand stroke (perfect-freehand), as SVG path data. */
/** Whether any part of the segment a→b lies in the rectangle (Liang–Barsky clipping). */
function segmentInRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x, r.x + r.width - ax, ay - r.y, r.y + r.height - ay];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return false;
      t1 = Math.min(t1, t);
    }
  }
  return true;
}

/**
 * Whether a box (select by dragging, in base coordinates) touches a shape: any
 * of its ink, not just its bounding box — a box inside a large empty ellipse
 * doesn't pick the ellipse; brushing over part of a scribble does.
 */
export function shapeTouchesRect(s: Shape, r: Rect): boolean {
  const b = shapeBounds(s);
  if (b.x > r.x + r.width || b.y > r.y + r.height || b.x + b.width < r.x || b.y + b.height < r.y) return false;
  if (b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height) return true;
  const path = (pts: number[], closed: boolean) => {
    if (pts.length === 2) return segmentInRect(pts[0], pts[1], pts[0], pts[1], r);
    for (let i = 2; i < pts.length; i += 2) if (segmentInRect(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], r)) return true;
    return closed && segmentInRect(pts[pts.length - 2], pts[pts.length - 1], pts[0], pts[1], r);
  };
  switch (s.type) {
    case "pen":
    case "highlighter": {
      const xy: number[] = [];
      for (let i = 0; i + 1 < s.points.length; i += 3) xy.push(s.points[i], s.points[i + 1]);
      return path(xy, false);
    }
    case "line":
    case "arrow":
      return segmentInRect(s.x1, s.y1, s.x2, s.y2, r);
    case "rect": {
      const x0 = Math.min(s.x, s.x + s.width);
      const y0 = Math.min(s.y, s.y + s.height);
      const x1 = Math.max(s.x, s.x + s.width);
      const y1 = Math.max(s.y, s.y + s.height);
      return path([x0, y0, x1, y0, x1, y1, x0, y1], true);
    }
    case "ellipse": {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const xy: number[] = [];
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        xy.push(cx + (Math.abs(s.width) / 2) * Math.cos(a), cy + (Math.abs(s.height) / 2) * Math.sin(a));
      }
      return path(xy, true);
    }
    case "text":
      return true; // its box overlaps (checked above): text is solid
  }
}

export function strokePath(points: number[], size: number, highlighter = false): string {
  const input: [number, number, number][] = [];
  for (let i = 0; i < points.length; i += 3) input.push([points[i], points[i + 1], points[i + 2] || 0.5]);
  const outline = getStroke(input, {
    size,
    thinning: highlighter ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: input.every((p) => p[2] === 0.5),
    last: true,
  });
  if (!outline.length) return "";
  const [first, ...rest] = outline;
  let d = `M${num(first[0])} ${num(first[1])}`;
  // Quadratic curves through the midpoints: smooth, and compact.
  for (let i = 0; i < rest.length; i++) {
    const [x, y] = rest[i];
    const [nx, ny] = rest[(i + 1) % rest.length];
    d += `Q${num(x)} ${num(y)} ${num((x + nx) / 2)} ${num((y + ny) / 2)}`;
  }
  return d + "Z";
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(10, size * 3.2);
  const w = 0.45;
  const p = (ang: number) => `${num(x2 - len * Math.cos(ang))} ${num(y2 - len * Math.sin(ang))}`;
  return `M${num(x2)} ${num(y2)}L${p(a - w)}L${p(a + w)}Z`;
}

/** One shape's SVG (without its rub-outs). */
export function shapeSvg(s: Shape): string {
  const color = safeColor(s.color);
  switch (s.type) {
    case "pen":
      return `<path d="${strokePath(s.points, s.size)}" fill="${color}"/>`;
    case "highlighter":
      return `<path d="${strokePath(s.points, s.size, true)}" fill="${color}" fill-opacity="0.35"/>`;
    case "line":
    case "arrow": {
      // The line stops short of the tip, so the head's point stays sharp.
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1;
      const back = s.type === "arrow" ? Math.min(len, Math.max(10, s.size * 3.2) * 0.8) : 0;
      const ex = s.x2 - ((s.x2 - s.x1) / len) * back;
      const ey = s.y2 - ((s.y2 - s.y1) / len) * back;
      const line = `<path d="M${num(s.x1)} ${num(s.y1)}L${num(ex)} ${num(ey)}" stroke="${color}" stroke-width="${num(s.size)}" stroke-linecap="round" fill="none"/>`;
      return s.type === "arrow" ? line + `<path d="${arrowHead(s.x1, s.y1, s.x2, s.y2, s.size)}" fill="${color}" stroke="${color}" stroke-width="${num(s.size / 2)}" stroke-linejoin="round"/>` : line;
    }
    case "rect":
      return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}" rx="${num(Math.min(8, s.size))}" stroke="${color}" stroke-width="${num(s.size)}" fill="none"/>`;
    case "ellipse":
      return `<ellipse cx="${num(s.x + s.width / 2)}" cy="${num(s.y + s.height / 2)}" rx="${num(Math.abs(s.width / 2))}" ry="${num(Math.abs(s.height / 2))}" stroke="${color}" stroke-width="${num(s.size)}" fill="none"/>`;
    case "text": {
      const lines = s.text.split("\n");
      const tspans = lines.map((l, i) => `<tspan x="${num(s.x)}" y="${num(s.y + s.fontSize * (i * LINE_HEIGHT + 0.95))}">${esc(l) || " "}</tspan>`).join("");
      return `<text font-family="${esc(FONT_FAMILY)}" font-size="${num(s.fontSize)}" font-weight="600" fill="${color}" xml:space="preserve">${tspans}</text>`;
    }
  }
}

/** A shape with its rub-outs applied through a mask of its own. */
function shapeWithErase(s: Shape): { defs: string; body: string } {
  const body = shapeSvg(s);
  if (!s.erase?.length) return { defs: "", body };
  const b = shapeBounds(s);
  const pad = Math.max(...s.erase.map((e) => e.size)) + 4;
  const rubs = s.erase
    .map((e) => {
      const p = e.points;
      if (p.length < 2) return "";
      let d = `M${num(p[0])} ${num(p[1])}`;
      for (let i = 2; i < p.length; i += 2) d += `L${num(p[i])} ${num(p[i + 1])}`;
      if (p.length === 2) d += `L${num(p[0] + 0.01)} ${num(p[1])}`;
      return `<path d="${d}" stroke="#000" stroke-width="${num(e.size)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    })
    .join("");
  const id = `m-${s.id.replace(/[^\w-]/g, "")}`;
  const defs = `<mask id="${id}" maskUnits="userSpaceOnUse" x="${num(b.x - pad)}" y="${num(b.y - pad)}" width="${num(b.width + pad * 2)}" height="${num(b.height + pad * 2)}"><rect x="${num(b.x - pad)}" y="${num(b.y - pad)}" width="${num(b.width + pad * 2)}" height="${num(b.height + pad * 2)}" fill="#fff"/>${rubs}</mask>`;
  return { defs, body: `<g mask="url(#${id})">${body}</g>` };
}

/**
 * The drawing as a standalone SVG document. `baseHref` is where the base
 * image comes from (a URL in the browser, a data: URI on the server).
 * `scale` sets the output's pixel size (1 = the crop's own size).
 */
export function drawingToSvg(d: Drawing, opts: { baseHref?: string; scale?: number; shapes?: Shape[]; withBase?: boolean } = {}): string {
  const { width, height } = outputSize(d);
  const scale = opts.scale ?? 1;
  const base =
    opts.withBase === false
      ? ""
      : d.base.kind === "image"
      ? opts.baseHref
        ? `<image href="${esc(opts.baseHref)}" x="0" y="0" width="${d.base.width}" height="${d.base.height}" preserveAspectRatio="none"/>`
        : ""
      : `<rect x="0" y="0" width="${d.base.width}" height="${d.base.height}" fill="${safeColor(d.base.color)}"/>`;
  const parts = (opts.shapes ?? d.shapes).map(shapeWithErase);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width * scale)}" height="${num(height * scale)}">` +
    `<defs>${parts.map((p) => p.defs).join("")}</defs>` +
    `<g transform="${contentTransform(d)}">${base}${parts.map((p) => p.body).join("")}</g>` +
    `</svg>`
  );
}

/** Scale for the flattened image: the output size, capped at MAX_OUTPUT on its long side. */
export function outputScale(d: Drawing): number {
  const { width, height } = outputSize(d);
  return Math.min(1, MAX_OUTPUT / Math.max(width, height));
}
