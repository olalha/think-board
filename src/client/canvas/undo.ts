// Canvas undo / redo (⌘Z, ⌘⇧Z or Ctrl+Y) for the user's own actions in this
// tab: layout (move, resize, connect, groups, views, protect), creating,
// deleting and renaming blocks, and each visit to a block's editor.
//
// A step is undone only while what it touched is still exactly as the step
// left it. If the agent, an outside agent or another tab changed it since,
// their change wins: the step is dropped with a note instead of overwriting
// their work. Per tab, per canvas; not kept across reloads.
import type { Canvas } from "../../shared/canvas";
import { displayName } from "../../shared/blocks";
import type { LayoutOp } from "../../shared/protocol";
import { useBoard } from "../lib/store";
import { toast } from "../lib/toasts";

export type Outcome = "ok" | "stale" | "failed";

export interface Step {
  id: number;
  /** What it did, for the toast: "Move", "Delete Tom", "Edit Tom". */
  label: string;
  undo(): Promise<Outcome>;
  redo(): Promise<Outcome>;
}

const LIMIT = 100;
let past: Step[] = [];
let future: Step[] = [];
let slug: string | null = null;
let seq = 0;
let busy = false;

/** A new canvas (or a reload of it): start with an empty history. */
export function resetUndo(forSlug: string | null): void {
  if (forSlug === slug) return;
  slug = forSlug;
  past = [];
  future = [];
}

export function record(step: Omit<Step, "id">): Step {
  const s = { ...step, id: ++seq };
  past.push(s);
  if (past.length > LIMIT) past.shift();
  future = [];
  return s;
}

/** The newest step, e.g. so a toast's Undo only undoes its own action. */
export function topStep(): Step | undefined {
  return past[past.length - 1];
}

/** Drop a step that was undone some other way (e.g. a toast's own Undo button). */
export function forget(step: Step): void {
  past = past.filter((s) => s !== step);
  future = future.filter((s) => s !== step);
}

function blocked(): boolean {
  const s = useBoard.getState();
  if (s.timeTravel) {
    toast.info("You're looking at the canvas's history — press Esc to return first.");
    return true;
  }
  if (s.lock.locked) {
    toast.info(s.lock.reason === "guest" ? `${s.lock.by} is working — undo waits until they finish.` : "The agent is working — undo waits until it finishes.");
    return true;
  }
  return false;
}

async function walk(from: Step[], to: Step[], dir: "undo" | "redo"): Promise<void> {
  if (busy || blocked()) return;
  const step = from.pop();
  if (!step) {
    toast.status("undo", dir === "undo" ? "Nothing to undo" : "Nothing to redo");
    return;
  }
  busy = true;
  try {
    const r = await step[dir]();
    if (r === "ok") {
      to.push(step);
      toast.status("undo", `${dir === "undo" ? "Undid" : "Redid"}: ${step.label}`);
    } else if (r === "stale") {
      toast.status("undo", `Can't ${dir} “${step.label}” — it has changed since (by the agent or elsewhere).`, 4500);
    }
    // "failed": the server said why (act shows the message).
  } finally {
    busy = false;
  }
}

export const undo = () => walk(past, future, "undo");
export const redo = () => walk(future, past, "redo");

// ------------------------------------------------------------------ layout ops

type Snap = Map<string, string>;

function entity(canvas: Canvas, key: string): string {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "node") return JSON.stringify(canvas.nodes.find((n) => n.id === id) ?? null);
  if (kind === "edge") return JSON.stringify(canvas.edges.find((e) => e.id === id) ?? null);
  if (kind === "views" || kind === "slides") {
    const views = canvas[kind] ?? [];
    const i = views.findIndex((v) => v.id === id);
    return i === -1 ? "null" : JSON.stringify({ ...views[i], index: i });
  }
  return "";
}

function snapshot(canvas: Canvas, keys: Iterable<string>): Snap {
  return new Map([...keys].map((k) => [k, entity(canvas, k)]));
}

function unchanged(expected: Snap): boolean {
  const canvas = useBoard.getState().canvas;
  for (const [k, v] of expected) if (entity(canvas, k) !== v) return false;
  return true;
}

/**
 * The ops that take `canvas` back from `ops` — in reverse order — and the
 * entities they touch. Returns null when an op cannot be inverted (it then is
 * simply not undoable).
 */
export function invertLayout(ops: LayoutOp[], canvas: Canvas): { inverse: LayoutOp[]; keys: Set<string> } | null {
  const inverse: LayoutOp[] = [];
  const keys = new Set<string>();
  const node = (id: string) => canvas.nodes.find((n) => n.id === id);
  for (const op of ops) {
    const list = "list" in op && op.list === "slides" ? "slides" : "views";
    const views = canvas[list] ?? [];
    const withList = <T extends LayoutOp>(o: T): T => (list === "slides" ? { ...o, list } : o);
    switch (op.op) {
      case "node.move": {
        const n = node(op.id);
        if (!n) return null;
        inverse.push({ op: "node.move", id: n.id, x: n.x, y: n.y });
        keys.add(`node:${n.id}`);
        break;
      }
      case "node.resize": {
        const n = node(op.id);
        if (!n) return null;
        inverse.push({ op: "node.resize", id: n.id, x: n.x, y: n.y, width: n.width, height: n.height });
        keys.add(`node:${n.id}`);
        break;
      }
      case "node.protect": {
        const n = node(op.id);
        if (!n || n.type !== "file") return null;
        inverse.push({ op: "node.protect", id: n.id, protected: !!n.protected });
        keys.add(`node:${n.id}`);
        break;
      }
      case "edge.add":
        inverse.push({ op: "edge.delete", id: op.edge.id });
        keys.add(`edge:${op.edge.id}`);
        break;
      case "edge.update": {
        const e = canvas.edges.find((x) => x.id === op.id);
        if (!e) return null;
        // Absent means the default: put that back explicitly.
        const defaults: Record<string, unknown> = { label: "", style: "solid", fromEnd: "none", toEnd: "arrow", color: null, fromSide: null, toSide: null };
        const back: Record<string, unknown> = {};
        for (const k of Object.keys(op.patch)) back[k] = (e as unknown as Record<string, unknown>)[k] ?? defaults[k] ?? null;
        inverse.push({ op: "edge.update", id: e.id, patch: back as Extract<LayoutOp, { op: "edge.update" }>["patch"] });
        keys.add(`edge:${e.id}`);
        break;
      }
      case "edge.delete": {
        const e = canvas.edges.find((x) => x.id === op.id);
        if (!e) return null;
        inverse.push({ op: "edge.add", edge: e });
        keys.add(`edge:${e.id}`);
        break;
      }
      case "group.add":
        inverse.push({ op: "group.delete", id: op.group.id });
        keys.add(`node:${op.group.id}`);
        break;
      case "group.update": {
        const g = node(op.id);
        if (!g || g.type !== "group") return null;
        const back: { label?: string; color?: string | null } = {};
        if ("label" in op.patch) back.label = g.label ?? "";
        if ("color" in op.patch) back.color = g.color ?? null;
        inverse.push({ op: "group.update", id: g.id, patch: back });
        keys.add(`node:${g.id}`);
        break;
      }
      case "group.delete": {
        const g = node(op.id);
        if (!g || g.type !== "group") return null;
        // Deleting a frame drops its connections too: bring both back.
        const edges = canvas.edges.filter((e) => e.fromNode === g.id || e.toNode === g.id);
        inverse.push(...edges.map((e) => ({ op: "edge.add" as const, edge: e })));
        inverse.push({ op: "group.add", group: g });
        keys.add(`node:${g.id}`);
        for (const e of edges) keys.add(`edge:${e.id}`);
        break;
      }
      case "view.add":
        inverse.push(withList({ op: "view.delete", id: op.view.id }));
        keys.add(`${list}:${op.view.id}`);
        break;
      case "view.update": {
        const i = views.findIndex((v) => v.id === op.id);
        if (i === -1) return null;
        const v = views[i];
        inverse.push(withList({ op: "view.update", id: v.id, patch: { name: v.name, x: v.x, y: v.y, width: v.width, height: v.height, target: v.target ?? null, followName: !!v.followName } }));
        keys.add(`${list}:${v.id}`);
        break;
      }
      case "view.delete": {
        const i = views.findIndex((v) => v.id === op.id);
        if (i === -1) return null;
        // Applied in reverse: re-add, then put it back in its place.
        inverse.push(withList({ op: "view.move", id: views[i].id, index: i }), withList({ op: "view.add", view: views[i] }));
        keys.add(`${list}:${views[i].id}`);
        break;
      }
      case "view.move": {
        const i = views.findIndex((v) => v.id === op.id);
        if (i === -1) return null;
        inverse.push(withList({ op: "view.move", id: op.id, index: i }));
        for (const v of views) keys.add(`${list}:${v.id}`); // every index shifts
        break;
      }
    }
  }
  return { inverse: inverse.reverse(), keys };
}

/** What a layout change is called in the undo toast. */
export function layoutLabel(ops: LayoutOp[]): string {
  const kinds = new Set(ops.map((o) => o.op));
  const one = (id: string) => displayName(id);
  if (kinds.size === 1) {
    const op = ops[0];
    switch (op.op) {
      case "node.move":
        return ops.length === 1 ? `Move ${one(op.id)}` : `Move ${ops.length} items`;
      case "node.resize":
        return `Resize ${one(op.id)}`;
      case "node.protect":
        return op.protected ? "Protect" : "Unprotect";
      case "edge.add":
        return "Connect";
      case "edge.update":
        return "Change connection";
      case "edge.delete":
        return ops.length === 1 ? "Delete connection" : `Delete ${ops.length} connections`;
      case "group.add":
        return "Group";
      case "group.update":
        return "Change group";
      case "group.delete":
        return "Remove group";
      case "view.add":
        return op.list === "slides" ? "Add slide" : `Save view “${op.view.name}”`;
      case "view.update":
        return op.list === "slides" ? "Update slide" : "Update view";
      case "view.delete":
        return op.list === "slides" ? "Delete slide" : "Delete view";
      case "view.move":
        return op.list === "slides" ? "Reorder slides" : "Reorder views";
    }
  }
  return "Change layout";
}

/**
 * Record a layout change the server has just applied. `before` is the canvas
 * from before it; the store already holds the one after.
 */
export function recordLayout(
  ops: LayoutOp[],
  before: Canvas,
  inv: { inverse: LayoutOp[]; keys: Set<string> },
  apply: (ops: LayoutOp[]) => Promise<boolean>,
  opts: { label?: string; coalesce?: string } = {},
): void {
  let was = snapshot(before, inv.keys);
  const now = snapshot(useBoard.getState().canvas, inv.keys);
  if ([...was].every(([k, v]) => now.get(k) === v)) return; // nothing actually changed
  let inverse = inv.inverse;
  // A run of the same small change (arrow-key nudges) is one step: keep the
  // first one's way back, and the latest ops.
  const top = past[past.length - 1];
  const prev = top && coalescing.get(top);
  if (opts.coalesce && prev && prev.key === opts.coalesce && Date.now() - prev.at < 1500 && sameKeys(prev.keys, inv.keys)) {
    was = prev.was;
    inverse = prev.inverse;
    past.pop();
  }
  const step = record({
    label: opts.label ?? layoutLabel(ops),
    undo: async () => (!unchanged(now) ? "stale" : (await apply(inverse)) ? "ok" : "failed"),
    redo: async () => (!unchanged(was) ? "stale" : (await apply(ops)) ? "ok" : "failed"),
  });
  if (opts.coalesce) coalescing.set(step, { key: opts.coalesce, at: Date.now(), keys: inv.keys, was, inverse });
}

const coalescing = new WeakMap<Step, { key: string; at: number; keys: Set<string>; was: Snap; inverse: LayoutOp[] }>();

function sameKeys(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}
