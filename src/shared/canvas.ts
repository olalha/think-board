// canvas.json — based on JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/).
//
// Node types used: "file" (a block; its id is the block name) and "group" (a
// labelled frame that blocks sit inside). Extensions beyond the spec, which
// other JSON Canvas tools simply ignore:
//   - file nodes: `protected` — the agent may read the block but not change,
//     move, rename or delete it;
//   - edges: `style` — "solid" (default), "dashed" or "dotted";
//   - top level: `views` — saved viewpoints, as areas of the canvas.

export type Side = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";
export type EdgeStyle = "solid" | "dashed" | "dotted";

export interface FileNode {
  id: string;
  type: "file";
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  protected?: boolean;
}

export interface GroupNode {
  id: string;
  type: "group";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
}

export type CanvasNode = FileNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: Side;
  toEnd?: EdgeEnd;
  label?: string;
  color?: string;
  style?: EdgeStyle;
}

/** A saved viewpoint: an area of the canvas, so it fits any screen size. */
export interface CanvasView {
  id: string;
  name: string;
  /** The area it shows (for a view with a target: where the target last was). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A block or group the view is about: going to it flies to that node, wherever it is now, and selects it. */
  target?: string;
  /** The name follows the target's name (until the view is renamed by hand). */
  followName?: boolean;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Saved viewpoints for getting around (1–9). */
  views?: CanvasView[];
  /** The presentation: slides in order, kept apart from the views. */
  slides?: CanvasView[];
}

/** The two lists of viewpoints a canvas keeps. */
export type ViewList = "views" | "slides";

export const SIDES: Side[] = ["top", "right", "bottom", "left"];
export const EDGE_STYLES: EdgeStyle[] = ["solid", "dashed", "dotted"];

/** JSON Canvas defaults: no marker at the start, an arrow at the end. */
export function edgeEnds(edge: CanvasEdge): { fromEnd: EdgeEnd; toEnd: EdgeEnd } {
  return { fromEnd: edge.fromEnd ?? "none", toEnd: edge.toEnd ?? "arrow" };
}

export function emptyCanvas(): Canvas {
  return { nodes: [], edges: [] };
}

export function isFileNode(n: CanvasNode): n is FileNode {
  return n.type === "file";
}

export function isGroupNode(n: CanvasNode): n is GroupNode {
  return n.type === "group";
}

export function fileNodes(canvas: Canvas): FileNode[] {
  return canvas.nodes.filter(isFileNode);
}

export function groupNodes(canvas: Canvas): GroupNode[] {
  return canvas.nodes.filter(isGroupNode);
}

/** True when rect `inner` lies entirely inside `outer`. */
export function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/** The blocks (and smaller groups) a group holds: everything lying fully inside it. */
export function groupMembers(canvas: Canvas, groupId: string): CanvasNode[] {
  const g = canvas.nodes.find((n) => n.id === groupId);
  if (!g) return [];
  return canvas.nodes.filter((n) => n.id !== groupId && contains(g, n) && !(isGroupNode(n) && n.width * n.height >= g.width * g.height));
}

/** Stable serialisation: the on-disk form of a canvas, and what hashes are taken of. */
export function serializeCanvas(canvas: Canvas): string {
  const nodes = canvas.nodes.map((n) => {
    if (n.type === "group") {
      const out: GroupNode = { id: n.id, type: "group", x: n.x, y: n.y, width: n.width, height: n.height };
      if (n.label !== undefined && n.label !== "") out.label = n.label;
      if (n.color !== undefined) out.color = n.color;
      return out;
    }
    const out: FileNode = { id: n.id, type: "file", file: n.file, x: n.x, y: n.y, width: n.width, height: n.height };
    if (n.color !== undefined) out.color = n.color;
    if (n.protected) out.protected = true;
    return out;
  });
  const edges = canvas.edges.map((e) => {
    const out: CanvasEdge = { id: e.id, fromNode: e.fromNode } as CanvasEdge;
    if (e.fromSide !== undefined) out.fromSide = e.fromSide;
    if (e.fromEnd !== undefined) out.fromEnd = e.fromEnd;
    out.toNode = e.toNode;
    if (e.toSide !== undefined) out.toSide = e.toSide;
    if (e.toEnd !== undefined) out.toEnd = e.toEnd;
    if (e.label !== undefined && e.label !== "") out.label = e.label;
    if (e.color !== undefined) out.color = e.color;
    if (e.style !== undefined && e.style !== "solid") out.style = e.style;
    return out;
  });
  const doc: Canvas = { nodes, edges };
  const viewOut = (v: CanvasView): CanvasView => {
    const out: CanvasView = { id: v.id, name: v.name, x: v.x, y: v.y, width: v.width, height: v.height };
    if (v.target) out.target = v.target;
    if (v.target && v.followName) out.followName = true;
    return out;
  };
  if (canvas.views?.length) doc.views = canvas.views.map(viewOut);
  if (canvas.slides?.length) doc.slides = canvas.slides.map(viewOut);
  return JSON.stringify(doc, null, 2) + "\n";
}
