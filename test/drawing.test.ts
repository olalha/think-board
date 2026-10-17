// Drawings: undo patches, and the SVG both the editor and the server render.
import { describe, expect, it } from "vitest";
import { changePage, contentTransform, drawingToSvg, mapShape, outputSize, shapeTouchesRect, toOutput, type Drawing, type Shape } from "../src/shared/drawing.js";
import { apply, diff } from "../src/client/drawing/history.js";

const base: Drawing = { format: 1, base: { kind: "color", color: "#ffffff", width: 400, height: 200 }, shapes: [] };
const rect = (id: string, x = 10): Shape => ({ id, type: "rect", color: "#e5484d", x, y: 10, width: 50, height: 40, size: 4 });

describe("drawing history", () => {
  it("undoes and redoes additions, changes, removals and page settings", () => {
    const a: Drawing = { ...base, shapes: [rect("a"), rect("b")] };
    const b: Drawing = { ...a, shapes: [rect("a", 99), rect("c")], crop: { x: 0, y: 0, width: 200, height: 100 }, rotate: 90 };
    const p = diff(a, b)!;
    expect(apply(b, p, "undo")).toEqual(a);
    expect(apply(a, p, "redo")).toEqual(b);
    expect(diff(a, a)).toBeNull();
  });

  it("puts removed shapes back in their place in the stack", () => {
    const a: Drawing = { ...base, shapes: [rect("a"), rect("b"), rect("c")] };
    const b: Drawing = { ...a, shapes: [a.shapes[0], a.shapes[2]] };
    expect(apply(b, diff(a, b)!, "undo").shapes.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("changing the page", () => {
  it("maps base coordinates to the output as the SVG transform does", () => {
    const d: Drawing = { ...base, crop: { x: 100, y: 0, width: 300, height: 200 }, rotate: 90 };
    // translate(200 0) rotate(90) translate(-100 0): (120, 20) → (20, 120) → (-120, 20)… plus 200 on x.
    expect(toOutput(d)(120, 20)).toEqual([180, 20]);
    expect(toOutput({ ...d, rotate: 180 })(120, 20)).toEqual([280, 180]);
    expect(toOutput({ ...d, rotate: 270 })(120, 20)).toEqual([20, 280]);
  });

  it("keeps the drawing, scaled to fit and centred, or starts fresh", () => {
    const d: Drawing = { ...base, shapes: [rect("a")] }; // a 400×200 page
    const photo = { kind: "image" as const, file: "base-0123456789ab.png", width: 800, height: 800 };
    const kept = changePage(d, photo, true);
    expect(kept.base).toEqual(photo);
    // ×2, centred vertically: (800 - 400) / 2 = 200 down.
    expect(kept.shapes[0]).toMatchObject({ id: "a", x: 20, y: 220, width: 100, height: 80, size: 8 });
    expect(changePage(d, photo, false).shapes).toEqual([]);
    expect(changePage({ ...d, crop: { x: 0, y: 0, width: 100, height: 100 } }, photo, true).crop).toBeUndefined();
  });

  it("undoes a change of page, photo and all", () => {
    const d: Drawing = { ...base, shapes: [rect("a")] };
    const next = changePage(d, { kind: "image", file: "base-0123456789ab.png", width: 800, height: 400 }, true);
    expect(apply(next, diff(d, next)!, "undo")).toEqual(d);
  });
});

describe("drawing SVG", () => {
  it("crops and rotates the output, and escapes text", () => {
    const d: Drawing = { ...base, crop: { x: 100, y: 0, width: 300, height: 200 }, rotate: 90, shapes: [{ id: "t", type: "text", color: "#1f1f1f", x: 120, y: 20, text: "<b>&", fontSize: 20 }] };
    expect(outputSize(d)).toEqual({ width: 200, height: 300 });
    expect(contentTransform(d)).toBe("translate(200 0) rotate(90) translate(-100 0)");
    const svg = drawingToSvg(d);
    expect(svg).toContain('viewBox="0 0 200 300"');
    expect(svg).toContain("&lt;b&gt;&amp;");
    expect(svg).not.toContain("<b>");
  });

  it("gives a rubbed-out shape its own mask, which moves with it", () => {
    const s: Shape = { ...rect("r"), erase: [{ points: [20, 10, 20, 50], size: 6 }] };
    expect(drawingToSvg({ ...base, shapes: [s] })).toMatch(/<mask id="m-r"[\s\S]*<g mask="url\(#m-r\)">/);
    const moved = mapShape(s, (x, y) => [x + 5, y + 7]);
    expect(moved.erase![0].points).toEqual([25, 17, 25, 57]);
  });

  it("never lets a colour or a base href break out of its attribute", () => {
    const svg = drawingToSvg({ ...base, shapes: [{ ...rect("x"), color: '"/><script>' }] }, { baseHref: 'x"><script>' });
    expect(svg).not.toContain("<script>");
  });
});

describe("selecting with a box", () => {
  const box = { x: 100, y: 100, width: 100, height: 100 };
  const c = { color: "#000", size: 4 };
  it("picks what its ink touches, not what its bounding box does", () => {
    // A scribble passing through the box, one fully inside, one outside.
    expect(shapeTouchesRect({ ...c, id: "a", type: "pen", points: [0, 150, 0.5, 300, 150, 0.5] }, box)).toBe(true);
    expect(shapeTouchesRect({ ...c, id: "b", type: "pen", points: [120, 120, 0.5, 130, 130, 0.5] }, box)).toBe(true);
    expect(shapeTouchesRect({ ...c, id: "c", type: "pen", points: [0, 0, 0.5, 50, 50, 0.5] }, box)).toBe(false);
    // A line crossing the box with both ends outside.
    expect(shapeTouchesRect({ ...c, id: "d", type: "line", x1: 0, y1: 0, x2: 300, y2: 300 }, box)).toBe(true);
    expect(shapeTouchesRect({ ...c, id: "e", type: "arrow", x1: 0, y1: 300, x2: 90, y2: 0 }, box)).toBe(false);
  });
  it("treats rectangles and ellipses as outlines: a box inside one doesn't pick it", () => {
    expect(shapeTouchesRect({ ...c, id: "f", type: "rect", x: 0, y: 0, width: 400, height: 400 }, box)).toBe(false);
    expect(shapeTouchesRect({ ...c, id: "g", type: "rect", x: 150, y: 150, width: 200, height: 200 }, box)).toBe(true);
    expect(shapeTouchesRect({ ...c, id: "h", type: "rect", x: 350, y: 350, width: -200, height: -200 }, box)).toBe(true);
    expect(shapeTouchesRect({ ...c, id: "i", type: "ellipse", x: -200, y: -200, width: 700, height: 700 }, box)).toBe(false);
    expect(shapeTouchesRect({ ...c, id: "j", type: "ellipse", x: 180, y: 0, width: 200, height: 300 }, box)).toBe(true);
  });
  it("picks text when the box overlaps it", () => {
    expect(shapeTouchesRect({ id: "k", type: "text", color: "#000", x: 190, y: 190, text: "Hello", fontSize: 20 }, box)).toBe(true);
    expect(shapeTouchesRect({ id: "l", type: "text", color: "#000", x: 400, y: 400, text: "Hello", fontSize: 20 }, box)).toBe(false);
  });
});
