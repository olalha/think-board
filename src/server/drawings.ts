// Drawings on image blocks, on disk. For a block `photo`:
//
//   photo.png                       the finished picture: base + drawing, what
//                                   the preview and the agent see (≤ 2048 px)
//   .drawings/photo/drawing.json    the drawing: shapes, crop, rotation (committed)
//   .drawings/photo/base.jpg        the original image, kept safe (committed);
//                                   base-<hash>.png: a photo chosen as the page later
//   .think/drawings/photo.json      the editor's undo history (app-private)
//
// A sketch is the same without base.* (its base is a colour). The picture is
// rendered here, from the same SVG the editor shows (shared/drawing.ts).

import fs from "node:fs/promises";
import path from "node:path";
import { renderAsync } from "@resvg/resvg-js";
import { z } from "zod";
import { DRAWING_FORMAT, drawingToSvg, outputScale, outputSize, type Drawing } from "../shared/drawing.js";

export const DRAWINGS_DIR = ".drawings";
/**
 * An original image kept for a drawing: `base.<ext>` (the picture first drawn
 * on) or `base-<hash>.<ext>` (a photo chosen as the page later). Older ones
 * stay while the editor's undo history can still go back to them.
 */
export const BASE_FILE_RE = /^base(?:-[0-9a-f]{8,16})?\.(?:png|jpe?g|webp|gif)$/;

const finite = z.number().finite();
const color = z.string().regex(/^#[0-9a-f]{3,8}$/i);
const pts = z.array(finite).max(60_000);
const erase = z.array(z.object({ points: pts, size: finite.positive().max(2000) })).max(200).optional();
const common = { id: z.string().min(1).max(40), color, erase };
const size = finite.positive().max(2000);

const shapeSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.enum(["pen", "highlighter"]), points: pts, size }),
  z.object({ ...common, type: z.enum(["line", "arrow"]), x1: finite, y1: finite, x2: finite, y2: finite, size }),
  z.object({ ...common, type: z.enum(["rect", "ellipse"]), x: finite, y: finite, width: finite, height: finite, size }),
  z.object({ ...common, type: z.literal("text"), x: finite, y: finite, text: z.string().max(4000), fontSize: finite.positive().max(2000) }),
]);

const dim = z.number().int().positive().max(20_000);
export const drawingSchema = z.object({
  format: z.literal(DRAWING_FORMAT),
  base: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("image"), file: z.string().regex(BASE_FILE_RE), width: dim, height: dim }),
    z.object({ kind: z.literal("color"), color, width: dim, height: dim }),
  ]),
  crop: z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }).optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  shapes: z.array(shapeSchema).max(5000),
  output: z.string().max(80).optional(),
});

export function sidecarDir(canvasDir: string, name: string): string {
  return path.join(canvasDir, DRAWINGS_DIR, name);
}

export async function readDrawing(canvasDir: string, name: string): Promise<Drawing | null> {
  try {
    const r = drawingSchema.safeParse(JSON.parse(await fs.readFile(path.join(sidecarDir(canvasDir, name), "drawing.json"), "utf8")));
    return r.success ? (r.data as Drawing) : null;
  } catch {
    return null;
  }
}

const FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts"];

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Render a drawing (with its base image bytes, if any) into the finished PNG. */
export async function renderDrawing(d: Drawing, base: Buffer | null): Promise<Buffer> {
  const ext = d.base.kind === "image" ? d.base.file.split(".").pop()! : "";
  const href = base && d.base.kind === "image" ? `data:${MIME[ext] ?? "image/png"};base64,${base.toString("base64")}` : undefined;
  const scale = outputScale(d);
  const svg = drawingToSvg(d, { baseHref: href });
  const { width } = outputSize(d);
  const img = await renderAsync(svg, {
    fitTo: { mode: "width", value: Math.max(1, Math.round(width * scale)) },
    // The standard font folders explicitly: resvg's own system scan misses them in the image.
    font: { loadSystemFonts: true, fontDirs: FONT_DIRS, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
  return img.asPng();
}
