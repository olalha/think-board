// The layout operations behind `think add/move/link/frame/view` — pure functions.
import { describe, expect, it } from "vitest";
import type { Canvas, FileNode, GroupNode } from "../src/shared/canvas.js";
import { briefSummary, emptySummary } from "../src/server/changes.js";
import {
  findNode,
  frameBlocks,
  frameNodes,
  linkNodes,
  OpError,
  outline,
  outlineText,
  placeBeside,
  placeNode,
  removeFrame,
  saveView,
  unlinkNodes,
} from "../src/server/canvas-ops.js";

const G = 20;
const block = (id: string, x: number, y: number, w = 360, h = 260, extra: Partial<FileNode> = {}): FileNode => ({ id, type: "file", file: `${id}.md`, x, y, width: w, height: h, ...extra });
const canvas = (...nodes: (FileNode | GroupNode)[]): Canvas => ({ nodes, edges: [] });

describe("finding blocks and frames", () => {
  it("by id, file name, display name or frame label — and says when there is none", () => {
    const c = canvas({ id: "grp-drinks", type: "group", label: "Drinks", x: -40, y: -80, width: 920, height: 440 }, block("tea-notes", 0, 0));
    expect(findNode(c, "tea-notes").id).toBe("tea-notes");
    expect(findNode(c, "tea-notes.md").id).toBe("tea-notes");
    expect(findNode(c, "./tea-notes.md").id).toBe("tea-notes");
    expect(findNode(c, "Tea notes").id).toBe("tea-notes");
    expect(findNode(c, "drinks", "frame").id).toBe("grp-drinks");
    expect(() => findNode(c, "Drinks", "block")).toThrow(OpError);
    expect(() => findNode(c, "coffee")).toThrow(/no block or frame “coffee”/);
  });
});

describe("placing", () => {
  it("puts a block beside another on the side asked, further along when that spot is taken, on the grid", () => {
    const c = canvas(block("a", 0, 0), block("b", 400, 0));
    // Right of a is taken by b: the next free spot down that side.
    expect(placeBeside(c, c.nodes[0], { width: 360, height: 260 }, "right", G)).toEqual({ x: 400, y: 300 });
    expect(placeBeside(c, c.nodes[0], { width: 360, height: 260 }, "below", G)).toEqual({ x: 0, y: 300 });
    expect(placeBeside(c, c.nodes[0], { width: 360, height: 260 }, "left", G)).toEqual({ x: -400, y: 0 });
    // A side that is full further along than the anchor reaches: the nearest free spot, and it says so.
    const busy = canvas(block("flow", 1300, 0, 420, 620), block("hello", 2180, 0, 360, 260), block("wide", 2120, 760, 680, 660));
    const p = placeBeside(busy, busy.nodes[0], { width: 440, height: 560 }, "right", G, new Set(["note"]));
    expect(p).toMatchObject({ sideTaken: true });
    expect(Math.abs(p.y - 0)).toBeLessThan(800); // not slid far down the canvas (it used to land at 1460)
    // Snapped: an anchor off the grid still yields a grid position.
    const odd = placeBeside(canvas(block("a", 3, 7)), block("a", 3, 7), { width: 360, height: 260 }, "below", G);
    expect(odd.x % G).toBe(0);
    expect(odd.y % G).toBe(0);
  });

  it("moves a block to a point, by an offset or into a frame (which grows), snapping sizes to the grid and minimum", () => {
    const f: GroupNode = { id: "grp-plan", type: "group", label: "Plan", x: -40, y: -80, width: 440, height: 380 };
    const c = canvas(f, block("a", 0, 0), block("b", 1000, 0));
    const at = placeNode(c, c.nodes[2], { at: { x: 513, y: 207 } }, G, "markdown");
    expect(at.canvas.nodes.find((n) => n.id === "b")).toMatchObject({ x: 520, y: 200 });
    const tiny = placeNode(c, c.nodes[2], { size: { width: 10, height: 10 } }, G, "markdown");
    expect(tiny.canvas.nodes.find((n) => n.id === "b")!.width).toBeGreaterThanOrEqual(160);
    const into = placeNode(c, c.nodes[2], { into: f }, G, "markdown");
    const b = into.canvas.nodes.find((n) => n.id === "b")!;
    expect(frameBlocks(into.canvas, "grp-plan").map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(b).toMatchObject({ x: 0, y: 300 }); // below a: the frame grows least that way
  });

  it("moves a frame with everything in it", () => {
    const f: GroupNode = { id: "grp-plan", type: "group", label: "Plan", x: -40, y: -80, width: 440, height: 380 };
    const c = canvas(f, block("a", 0, 0), block("far", 2000, 2000));
    const r = placeNode(c, f, { by: { x: 0, y: 200 } }, G);
    expect(r.moved.sort()).toEqual(["a", "grp-plan"]);
    expect(r.canvas.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 200 });
    expect(r.canvas.nodes.find((n) => n.id === "far")).toMatchObject({ x: 2000, y: 2000 });
  });
});

describe("frames, links and views", () => {
  it("draws a frame around blocks with the app's padding, then grows it — never shrinks it", () => {
    const c = canvas(block("a", 0, 0), block("b", 400, 0), block("c", 0, 400));
    const made = frameNodes(c, "Plan", [c.nodes[0], c.nodes[1]], G);
    expect(made.created).toBe(true);
    expect(made.frame).toMatchObject({ id: "grp-plan", label: "Plan", x: -40, y: -80, width: 840, height: 380 });
    expect(made.canvas.nodes[0].id).toBe("grp-plan"); // frames first: drawn behind blocks
    const grown = frameNodes(made.canvas, "plan", [c.nodes[2]], G);
    expect(grown.created).toBe(false);
    expect(frameBlocks(grown.canvas, "grp-plan").map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(() => frameNodes(c, "Empty", [], G)).toThrow(/name the blocks/);
    expect(removeFrame(grown.canvas, grown.frame).nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("links two blocks, updates the same link instead of adding a second, and unlinks either way", () => {
    const c = canvas(block("a", 0, 0), block("b", 400, 0));
    const one = linkNodes(c, c.nodes[0], c.nodes[1], { label: "feeds", style: "dashed" });
    expect(one.edge).toMatchObject({ id: "e-a-b", fromNode: "a", toNode: "b", label: "feeds", style: "dashed" });
    const two = linkNodes(one.canvas, c.nodes[0], c.nodes[1], { style: "solid", arrow: "both", label: "" });
    expect(two.created).toBe(false);
    expect(two.canvas.edges).toHaveLength(1);
    expect(two.edge).toEqual({ id: "e-a-b", fromNode: "a", toNode: "b", fromEnd: "arrow" });
    expect(unlinkNodes(two.canvas, c.nodes[1], c.nodes[0]).removed).toHaveLength(1);
    expect(() => linkNodes(c, c.nodes[0], c.nodes[0], {})).toThrow(OpError);
  });

  it("saves a view around nodes (following one node), and updates it by name", () => {
    const c = canvas(block("a", 0, 0), block("b", 400, 0));
    const v = saveView(c, "Start", [c.nodes[0]], G);
    expect(v.view).toMatchObject({ id: "v-start", name: "Start", x: -80, y: -80, width: 520, height: 420, target: "a" });
    const again = saveView(v.canvas, "start", [c.nodes[0], c.nodes[1]], G);
    expect(again.created).toBe(false);
    expect(again.canvas.views).toHaveLength(1);
    expect(again.view.target).toBeUndefined();
  });

  it("outlines the canvas for an agent: blocks with their frames, links, views, comments", () => {
    const made = frameNodes(canvas(block("a", 0, 0), block("b", 400, 0, 360, 260, { protected: true })), "Plan", [block("a", 0, 0)], G);
    const linked = linkNodes(made.canvas, made.canvas.nodes[1], made.canvas.nodes[2], { label: "feeds" });
    const o = outline(linked.canvas, { name: "Launch", slug: "launch", grid: G }, new Map([["a", "markdown"], ["b", "mermaid"]]), { open: 1, done: 0 });
    expect(o.blocks.find((b) => b.name === "a")).toMatchObject({ frames: ["grp-plan"], protected: false });
    expect(o.blocks.find((b) => b.name === "b")).toMatchObject({ type: "mermaid", protected: true, frames: [] });
    const text = outlineText(o);
    expect(text).toContain("“Launch” (launch) · 2 blocks, 1 frame, 1 link, 0 views");
    expect(text).toMatch(/b +mermaid +400,0 +360×260 +protected/);
    expect(text).toContain("a → b  “feeds”");
    expect(text).toContain("comments: 1 open, 0 done");
  });
});

describe("the one-line summary", () => {
  it("covers layout, comments and renames — never empty when something changed", () => {
    const s = emptySummary();
    s.comments = ["- Comment on tea-notes marked done by planner: “ok”"];
    expect(briefSummary(s)).toBe("marked 1 comment done");
    s.renamed = [["cli-notes", "cli-guide"]];
    s.layout = ["Moved Budget.", "Connected Timeline → Budget (“feeds”)."];
    expect(briefSummary(s)).toBe("renamed CLI notes → CLI guide; moved Budget; connected Timeline → Budget (“feeds”); marked 1 comment done");
    expect(briefSummary(emptySummary())).toBe("");
    const many = { ...emptySummary(), layout: ["A.", "B.", "C.", "D.", "E.", "F.", "G."] };
    expect(briefSummary(many)).toBe("a; b; c; d; e; and 2 more changes");
  });
});
