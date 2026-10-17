import { describe, expect, it } from "vitest";
import { findFreeSlot, lineSimilarity, lintCanvas, matchRenames, parseCanvas, reconcileCanvas, type BlockEntry } from "../src/server/canvas-model.js";
import { groupMembers, serializeCanvas } from "../src/shared/canvas.js";
import type { Canvas } from "../src/shared/canvas.js";

const G = 20;
const blocks = (entries: Record<string, BlockEntry>) => new Map(Object.entries(entries));
const md = (name: string): BlockEntry => ({ file: `${name}.md`, type: "markdown" });
const node = (id: string, x: number, y: number, w = 360, h = 260) => ({ id, type: "file" as const, file: `${id}.md`, x, y, width: w, height: h });

describe("parseCanvas", () => {
  it("accepts JSON Canvas with file nodes and typed edges", () => {
    const r = parseCanvas(JSON.stringify({ nodes: [node("harry", 0, 0)], edges: [{ id: "e1", fromNode: "harry", toNode: "harry", toEnd: "arrow", label: "x" }] }));
    expect(r.ok).toBe(true);
  });
  it("reports invalid JSON", () => {
    const r = parseCanvas("{ nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });
  it("reports schema errors with their path", () => {
    const r = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1 }], edges: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nodes\.0\.type/);
  });
  it("treats missing arrays as empty", () => {
    const r = parseCanvas("{}");
    expect(r.ok && r.canvas.nodes.length === 0 && r.canvas.edges.length === 0).toBe(true);
  });
});

describe("reconcileCanvas", () => {
  it("removes nodes whose file is gone, and their edges", () => {
    const c: Canvas = {
      nodes: [node("harry", 0, 0), node("bob", 400, 0)],
      edges: [{ id: "e1", fromNode: "harry", toNode: "bob" }],
    };
    const r = reconcileCanvas(c, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes.map((n) => n.id)).toEqual(["harry"]);
    expect(r.canvas.edges).toEqual([]);
    expect(r.removed).toEqual(["bob"]);
    expect(r.changed).toBe(true);
  });

  it("snaps positions and sizes to the grid and enforces the type's minimum size", () => {
    const c: Canvas = { nodes: [{ ...node("harry", 13, 27, 51, 9) }], edges: [] };
    const r = reconcileCanvas(c, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes[0]).toMatchObject({ x: 20, y: 20, width: 160, height: 100 });
  });

  it("fixes a node's file to the block's real file", () => {
    const c: Canvas = { nodes: [{ ...node("bob", 0, 0), file: "bob.md" }], edges: [] };
    const r = reconcileCanvas(c, blocks({ bob: { file: "bob.mmd", type: "mermaid" } }), { gridSize: G });
    expect(r.canvas.nodes[0].file).toBe("bob.mmd");
  });

  it("places a new file next to the most recently touched block", () => {
    const c: Canvas = { nodes: [node("harry", 0, 0), node("tom", 0, 1000)], edges: [] };
    const touched = new Map([
      ["tom", 1],
      ["harry", 2],
    ]);
    const r = reconcileCanvas(c, blocks({ harry: md("harry"), tom: md("tom"), bob: md("bob") }), { gridSize: G, touched });
    const bob = r.canvas.nodes.find((n) => n.id === "bob")!;
    expect(r.placed).toEqual(["bob"]);
    expect(bob.x).toBe(360 + 40); // right of harry, one double-grid gap
    expect(bob.y).toBe(0);
    expect(bob.x % G).toBe(0);
  });

  it("falls back to the centroid when nothing was touched, and never overlaps", () => {
    const c: Canvas = { nodes: [node("harry", 0, 0), node("tom", 800, 0)], edges: [] };
    const r = reconcileCanvas(c, blocks({ harry: md("harry"), tom: md("tom"), bob: md("bob") }), { gridSize: G });
    const bob = r.canvas.nodes.find((n) => n.id === "bob")!;
    for (const other of r.canvas.nodes.filter((n) => n.id !== "bob")) {
      const overlap = bob.x < other.x + other.width && other.x < bob.x + bob.width && bob.y < other.y + other.height && other.y < bob.y + bob.height;
      expect(overlap).toBe(false);
    }
  });

  it("places into an empty canvas at the origin", () => {
    const r = reconcileCanvas({ nodes: [], edges: [] }, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes[0]).toMatchObject({ id: "harry", x: 0, y: 0 });
  });

  it("drops duplicate node and edge ids (first wins) and is stable when nothing changes", () => {
    const c: Canvas = {
      nodes: [node("harry", 0, 0), node("harry", 500, 500)],
      edges: [
        { id: "e", fromNode: "harry", toNode: "harry" },
        { id: "e", fromNode: "harry", toNode: "harry", label: "dup" },
      ],
    };
    const r = reconcileCanvas(c, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes).toHaveLength(1);
    expect(r.canvas.edges).toHaveLength(1);
    const again = reconcileCanvas(r.canvas, blocks({ harry: md("harry") }), { gridSize: G });
    expect(again.changed).toBe(false);
  });
});

describe("findFreeSlot", () => {
  it("tries right, below, left, above — then searches outward", () => {
    const anchor = { x: 0, y: 0, width: 200, height: 100 };
    const size = { width: 200, height: 100 };
    expect(findFreeSlot(anchor, size, [anchor], G)).toEqual({ x: 240, y: 0 });
    const blockedRight = [anchor, { x: 240, y: 0, width: 200, height: 100 }];
    expect(findFreeSlot(anchor, size, blockedRight, G)).toEqual({ x: 0, y: 140 });
  });
});

describe("lintCanvas", () => {
  it("reports duplicate ids, id/file mismatches and dangling edges", () => {
    const c: Canvas = {
      nodes: [node("harry", 0, 0), node("harry", 0, 0), { ...node("bob", 0, 0), file: "harry.md" }],
      edges: [{ id: "e", fromNode: "harry", toNode: "ghost" }],
    };
    const issues = lintCanvas(c, blocks({ harry: md("harry"), bob: md("bob") })).map((i) => i.message);
    expect(issues.some((m) => m.includes('duplicate node id "harry"'))).toBe(true);
    expect(issues.some((m) => m.includes('node "bob" points at file "harry.md"'))).toBe(true);
    expect(issues.some((m) => m.includes('refers to node "ghost"'))).toBe(true);
  });
});

describe("groups, views and edge styles", () => {
  const group = (id: string, x: number, y: number, w: number, h: number, label?: string) => ({ id, type: "group" as const, x, y, width: w, height: h, ...(label ? { label } : {}) });

  it("parses group nodes, views, edge styles and protected blocks", () => {
    const r = parseCanvas(
      JSON.stringify({
        nodes: [group("grp-a", 0, 0, 800, 600, "Ideas"), { ...node("harry", 40, 80), protected: true }],
        edges: [{ id: "e1", fromNode: "harry", toNode: "grp-a", style: "dashed" }],
        views: [{ id: "v1", name: "Overview", x: 0, y: 0, width: 1200, height: 800 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canvas.views?.[0].name).toBe("Overview");
    expect(serializeCanvas(r.canvas)).toContain('"style": "dashed"');
    expect(serializeCanvas(r.canvas)).toContain('"protected": true');
  });

  it("rejects an unknown edge style", () => {
    const r = parseCanvas(JSON.stringify({ nodes: [], edges: [{ id: "e", fromNode: "a", toNode: "b", style: "wavy" }] }));
    expect(r.ok).toBe(false);
  });

  it("keeps groups (behind blocks), snaps them and drops only file nodes without files", () => {
    const c: Canvas = { nodes: [node("harry", 0, 0), group("grp-a", 3, 7, 91, 50)], edges: [] };
    const r = reconcileCanvas(c, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes.map((n) => n.id)).toEqual(["grp-a", "harry"]);
    expect(r.canvas.nodes[0]).toMatchObject({ x: 0, y: 0, width: 160, height: 100 });
  });

  it("gives a group that shares a block's name a fresh id, and follows its edges", () => {
    const c: Canvas = { nodes: [node("harry", 0, 0), group("harry", 0, 0, 800, 600)], edges: [{ id: "e", fromNode: "harry", toNode: "harry" }] };
    const lint = lintCanvas(c, blocks({ harry: md("harry") }));
    expect(lint.some((i) => /same id as the block/.test(i.message))).toBe(true);
    const r = reconcileCanvas(c, blocks({ harry: md("harry") }), { gridSize: G });
    expect(r.canvas.nodes.map((n) => n.id).sort()).toEqual(["grp-harry", "harry"]);
  });

  it("finds a group's members by containment", () => {
    const c: Canvas = { nodes: [group("g", 0, 0, 800, 600), node("in", 20, 40), node("out", 900, 0)], edges: [] };
    expect(groupMembers(c, "g").map((n) => n.id)).toEqual(["in"]);
  });

  it("keeps views, dropping duplicates", () => {
    const v = { id: "v", name: " ", x: 0.4, y: 0, width: 100, height: 100 };
    const r = reconcileCanvas({ nodes: [], edges: [], views: [v, { ...v, name: "dup" }] }, blocks({}), { gridSize: G });
    expect(r.canvas.views).toEqual([{ id: "v", name: "Untitled view", x: 0, y: 0, width: 100, height: 100 }]);
  });
});

describe("renames", () => {
  it("scores line overlap", () => {
    expect(lineSimilarity("a\nb\nc", "a\nb\nc")).toBe(1);
    expect(lineSimilarity("a\nb", "c\nd")).toBe(0);
    expect(lineSimilarity("a\nb\nc\nd", "a\nb\nc\nx")).toBeCloseTo(0.6);
  });

  it("pairs identical or mostly-identical blocks of the same type", () => {
    const m = matchRenames(
      [
        { name: "harry", type: "markdown", hash: "h1", text: "# Tea\n\nboil\nsteep\npour" },
        { name: "bob", type: "mermaid", hash: "h2", text: "flowchart TD\n A --> B" },
      ],
      [
        { name: "tea-guide", type: "markdown", hash: "h9", text: "# Tea guide\n\nboil\nsteep\npour" },
        { name: "flow", type: "mermaid", hash: "h2", text: "flowchart TD\n A --> B" },
        { name: "other", type: "markdown", hash: "h7", text: "unrelated" },
      ],
    );
    expect(Object.fromEntries(m)).toEqual({ "tea-guide": "harry", flow: "bob" });
  });

  it("keeps a renamed block's position and connections", () => {
    const c: Canvas = { nodes: [node("harry", 100, 100), node("bob", 600, 100)], edges: [{ id: "e", fromNode: "harry", toNode: "bob", label: "x" }] };
    const r = reconcileCanvas(c, blocks({ "tea-guide": md("tea-guide"), bob: md("bob") }), { gridSize: G, renames: new Map([["tea-guide", "harry"]]) });
    expect(r.canvas.nodes.find((n) => n.id === "tea-guide")).toMatchObject({ x: 100, y: 100, file: "tea-guide.md" });
    expect(r.canvas.edges).toEqual([{ id: "e", fromNode: "tea-guide", toNode: "bob", label: "x" }]);
    expect(r.renamed.get("tea-guide")).toBe("harry");
    expect(r.placed).toEqual([]);
  });
});
