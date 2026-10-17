// The `think` command's canvas commands — read, add, move, link, frame, view,
// comments, show… — the same for the canvas's own agent and for outside
// agents. Agents edit block files directly; everything else about the canvas
// goes through here, so it is validated, snapped to the grid, kept off
// protected blocks and written atomically by the server.
//
// Who may run what is checked by the caller of runCommand (the runtime): the
// canvas agent only during its turn, an outside agent once it has joined, and
// the commands that change something only while it holds the canvas lock.

import { displayName, parseBlockFile, type BlockType } from "../shared/blocks.js";
import type { Canvas, CanvasNode, EdgeStyle, GroupNode } from "../shared/canvas.js";
import type { Comment } from "../shared/protocol.js";
import { MAX_COMMENT } from "./comments.js";
import {
  findNode,
  frameBlocks,
  frameNodes,
  frameTitle,
  linkNodes,
  nodeTitle,
  OpError,
  outline,
  outlineText,
  PLACE_SIDES,
  placeNode,
  removeFrame,
  removeView,
  saveView,
  unlinkNodes,
  type Arrow,
  type PlaceOptions,
  type PlaceSide,
} from "./canvas-ops.js";
import { newId } from "./util.js";

export { OpError };

/** A request as the `think` command sends it: the command, its words, its --options. */
export interface CommandRequest {
  op: string;
  args: string[];
  opts: Record<string, string | boolean>;
}

export type Caller = { kind: "agent" } | { kind: "guest"; name: string };

/** Commands about the canvas itself, for both kinds of agent. */
export const CANVAS_COMMANDS = new Set(["read", "add", "move", "link", "unlink", "frame", "unframe", "rename", "remove", "view", "comments", "comment", "show", "summary"]);
/** Of those, the ones that change it: an outside agent needs the lock. */
export const CHANGING_COMMANDS = new Set(["add", "move", "link", "unlink", "frame", "unframe", "rename", "remove", "view", "comment"]);
/** Of those, the ones that write canvas.json (refused while it is broken on disk). */
export const LAYOUT_COMMANDS = new Set(["add", "move", "link", "unlink", "frame", "unframe", "view"]);

/** Commands only outside agents use (the canvas agent is refused, with why). */
export const GUEST_ONLY_COMMANDS = new Set(["join", "leave", "lock", "unlock", "say", "new", "chat", "url", "list"]);

/** A request as it arrives (JSON from the `think` command), checked; null when it is not one. */
export function toCommandRequest(raw: unknown): CommandRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { op?: unknown; args?: unknown; opts?: unknown };
  if (typeof r.op !== "string" || !/^[a-z]{2,20}$/.test(r.op)) return null;
  const args = r.args === undefined ? [] : r.args;
  if (!Array.isArray(args) || args.length > 100 || !args.every((a) => typeof a === "string" && a.length <= 20_000)) return null;
  const opts: Record<string, string | boolean> = {};
  if (r.opts !== undefined) {
    if (!r.opts || typeof r.opts !== "object" || Array.isArray(r.opts)) return null;
    for (const [k, v] of Object.entries(r.opts)) {
      if (!/^[a-z][a-z-]{0,20}$/.test(k) || !(typeof v === "string" || typeof v === "boolean") || (typeof v === "string" && v.length > 2000)) return null;
      opts[k] = v;
    }
  }
  return { op: r.op, args: args as string[], opts };
}

/** What a command needs from the open canvas (the runtime provides it). */
export interface CommandHost {
  meta: { name: string; slug: string; grid: number };
  /** The layout as it is now (every block file has a node). */
  view(): Canvas;
  blockType(name: string): BlockType | undefined;
  blockTypes(): Map<string, BlockType>;
  comments(): Promise<Comment[]>;
  /** Write a new layout; `touched` are the nodes the change was about (ringed in the tabs). */
  setLayout(next: Canvas, touched: string[]): Promise<void>;
  rename(name: string, to: string): Promise<void>;
  remove(names: string[]): Promise<void>;
  setComments(list: Comment[]): Promise<void>;
  highlight(names: string[]): void;
  setSummary(text: string): void;
}

const callerName = (c: Caller) => (c.kind === "agent" ? "agent" : c.name);

function opt(req: CommandRequest, key: string): string | undefined {
  const v = req.opts[key];
  if (v === undefined || v === false) return undefined;
  if (v === true) throw new OpError(`--${key} needs a value.`);
  return v;
}

function flag(req: CommandRequest, key: string): boolean {
  return req.opts[key] === true || req.opts[key] === "true";
}

function point(v: string, what: string): { x: number; y: number } {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) throw new OpError(`${what} takes two numbers, like 40,-120.`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function sizeOf(v: string): { width: number; height: number } {
  const m = /^\s*(\d+)\s*[x×, ]\s*(\d+)\s*$/i.exec(v);
  if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) throw new OpError("--size takes a width and height in pixels, like 360x260.");
  if (Number(m[1]) > 20000 || Number(m[2]) > 20000) throw new OpError("--size: that is too large.");
  return { width: Number(m[1]), height: Number(m[2]) };
}

function onlyArgs(req: CommandRequest, n: number, usage: string): void {
  if (req.args.length > n) throw new OpError(`Too many words — ${usage} (quote text that has spaces).`);
}

function rectText(n: { x: number; y: number; width: number; height: number }): string {
  return `${n.x},${n.y} (${n.width}×${n.height})`;
}

function assertEditable(n: CanvasNode, doing: string): void {
  if (n.type === "file" && n.protected) throw new OpError(`“${displayName(n.id)}” is protected: the user keeps it as it is, so you cannot ${doing} it. Read it freely; put new work in a new block beside it.`);
}

/** The block a file argument names: `tea-notes.md`, `tea-notes`, `./tea-notes.md` or the file's full path. */
function blockRef(arg: string): string {
  const clean = arg.trim();
  if (/(^|\/)work\//.test(clean)) throw new OpError("work/ is scratch space and never shows on the canvas — write the block at the top level of the canvas folder.");
  return clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
}

function placement(req: CommandRequest, view: Canvas): PlaceOptions {
  const o: PlaceOptions = {};
  const near = opt(req, "near");
  const side = opt(req, "side");
  const at = opt(req, "at");
  const by = opt(req, "by");
  const into = opt(req, "in");
  const size = opt(req, "size");
  if ([near, at, by, into].filter(Boolean).length > 1) throw new OpError("Use one of --near, --at, --by and --in.");
  if (side && !near) throw new OpError("--side goes with --near: --near <block> --side right|left|below|above.");
  if (side && !PLACE_SIDES.includes(side as PlaceSide)) throw new OpError("--side is right, left, below or above.");
  if (near) o.near = findNode(view, near);
  if (side) o.side = side as PlaceSide;
  if (at) o.at = point(at, "--at");
  if (by) o.by = point(by, "--by");
  if (into) o.into = findNode(view, into, "frame") as GroupNode;
  if (size) o.size = sizeOf(size);
  return o;
}

function where(o: PlaceOptions): string {
  if (o.into) return ` in “${frameTitle(o.into)}”`;
  if (o.near) return o.side ? ` ${o.side === "right" || o.side === "left" ? `${o.side} of` : o.side} ${nodeTitle(o.near)}` : ` next to ${nodeTitle(o.near)}`;
  return "";
}

/** Run one canvas command. Returns what to tell the caller; throws OpError when refused. */
export async function runCommand(host: CommandHost, caller: Caller, req: CommandRequest): Promise<string> {
  const view = host.view();
  const grid = host.meta.grid;
  const a = req.args;
  switch (req.op) {
    case "read": {
      onlyArgs(req, 0, "think read [--json]");
      const list = await host.comments();
      const o = outline(view, host.meta, host.blockTypes(), { open: list.filter((c) => !c.done).length, done: list.filter((c) => c.done).length });
      return flag(req, "json") ? JSON.stringify(o, null, 2) : outlineText(o);
    }

    case "add":
    case "move": {
      const usage = req.op === "add" ? "think add <file> [--near <block> [--side right|left|below|above] | --at X,Y | --in <frame>] [--size WxH]" : "think move <block|frame> (--near <block> [--side …] | --at X,Y | --by DX,DY | --in <frame>) [--size WxH]";
      if (!a[0]) throw new OpError(`Which ${req.op === "add" ? "file" : "block"}? ${usage}`);
      onlyArgs(req, 1, usage);
      let node: CanvasNode;
      if (req.op === "add") {
        const ref = blockRef(a[0]);
        try {
          node = findNode(view, ref, "block");
        } catch {
          const parsed = parseBlockFile(ref);
          throw new OpError(
            parsed || !/\./.test(ref)
              ? `There is no block file “${ref}” in the canvas folder yet. Write the file first (at the top level of the folder), then run think add.`
              : `“${ref}” is not a block file: names are lowercase letters, digits and hyphens with .md, .mmd, .html or an image extension (like tea-notes.md).`,
          );
        }
      } else node = findNode(view, blockRef(a[0]));
      const o = placement(req, view);
      const hasPlace = !!(o.near || o.at || o.by || o.into);
      if (req.op === "move" && !hasPlace && !o.size) throw new OpError(`Where to? ${usage}`);
      if (req.op === "add" && o.by) throw new OpError("--by is for think move.");
      if (o.into && node.type === "group") throw new OpError("A frame cannot go inside another frame with --in; move it with --at or --by.");
      if (o.near?.id === node.id) throw new OpError(`${nodeTitle(node)} cannot be placed next to itself.`);
      if (hasPlace || o.size) {
        assertEditable(node, "move or resize");
        const locked = node.type === "group" && hasPlace ? frameBlocks(view, node.id).find((m) => m.protected) : undefined;
        if (locked) throw new OpError(`The frame “${frameTitle(node as GroupNode)}” holds the protected block “${displayName(locked.id)}”, which only the user may move. Resize the frame instead, or ask the user.`);
        const r = placeNode(view, node, o, grid, host.blockType(node.id));
        await host.setLayout(r.canvas, r.moved);
        const now = r.canvas.nodes.find((n) => n.id === node.id)!;
        if (node.type === "group") {
          const carried = r.moved.length - 1;
          return `Moved the frame “${frameTitle(node)}” to ${rectText(now)}${carried ? ` with its ${carried} ${carried === 1 ? "block" : "blocks"}` : ""}.`;
        }
        const taken = r.sideTaken && o.near ? ` — the spot ${o.side === "right" || o.side === "left" ? `${o.side} of` : o.side} ${nodeTitle(o.near)} was taken, so it went to the nearest free spot next to it` : where(o);
        return `${req.op === "add" ? "Added" : "Moved"} “${displayName(node.id)}” ${req.op === "add" ? "at" : "to"} ${rectText(now)}${taken}.`;
      }
      host.highlight([node.id]);
      return `“${displayName(node.id)}” is on the canvas at ${rectText(node)}, where think put it when its file appeared. To choose the place: --near, --at or --in (or think move later).`;
    }

    case "link": {
      const usage = `think link <from> <to> [--label "…"] [--style solid|dashed|dotted] [--arrow end|both|none]`;
      if (a.length !== 2) throw new OpError(`Link which two? ${usage}`);
      const from = findNode(view, blockRef(a[0]));
      const to = findNode(view, blockRef(a[1]));
      const style = opt(req, "style");
      const arrow = opt(req, "arrow");
      if (arrow && !["end", "both", "none"].includes(arrow)) throw new OpError("--arrow is end (the default), both or none.");
      const label = req.opts.label === true ? "" : opt(req, "label");
      const r = linkNodes(view, from, to, { label, style: style as EdgeStyle | undefined, arrow: arrow as Arrow | undefined });
      await host.setLayout(r.canvas, [from.id, to.id]);
      const bits = [r.edge.label ? `“${r.edge.label}”` : "", r.edge.style ?? "", r.edge.fromEnd === "arrow" ? "arrows both ends" : r.edge.toEnd === "none" ? "no arrow" : ""].filter(Boolean);
      return `${r.created ? "Linked" : "Updated the link"} ${nodeTitle(from)} → ${nodeTitle(to)}${bits.length ? ` (${bits.join(", ")})` : ""}.`;
    }

    case "unlink": {
      if (a.length !== 2) throw new OpError("Unlink which two? think unlink <block> <block>");
      const x = findNode(view, blockRef(a[0]));
      const y = findNode(view, blockRef(a[1]));
      const r = unlinkNodes(view, x, y);
      if (!r.removed.length) throw new OpError(`${nodeTitle(x)} and ${nodeTitle(y)} are not linked.`);
      await host.setLayout(r.canvas, [x.id, y.id]);
      return `Removed the ${r.removed.length === 1 ? "link" : `${r.removed.length} links`} between ${nodeTitle(x)} and ${nodeTitle(y)}.`;
    }

    case "frame": {
      const usage = `think frame "Label" <block…>`;
      if (!a[0]) throw new OpError(`Which frame? ${usage}`);
      const nodes = a.slice(1).map((r) => findNode(view, blockRef(r)));
      const r = frameNodes(view, a[0], nodes, grid);
      await host.setLayout(r.canvas, [r.frame.id, ...nodes.map((n) => n.id)]);
      const members = frameBlocks(r.canvas, r.frame.id).map((m) => m.id);
      const holds = members.length ? `holds ${members.join(", ")}` : "is empty";
      return r.created
        ? `Drew the frame “${frameTitle(r.frame)}” (${r.frame.id}) at ${rectText(r.frame)}; it ${holds}.`
        : `The frame “${frameTitle(r.frame)}” (${r.frame.id}) is now ${rectText(r.frame)} and ${holds}.`;
    }

    case "unframe": {
      if (a.length !== 1) throw new OpError(`Which frame? think unframe "Label"`);
      const f = findNode(view, a[0], "frame") as GroupNode;
      await host.setLayout(removeFrame(view, f), frameBlocks(view, f.id).map((m) => m.id));
      return `Removed the frame “${frameTitle(f)}”; its blocks stay where they are.`;
    }

    case "rename": {
      if (a.length !== 2) throw new OpError("think rename <block> <new-name>");
      const node = findNode(view, blockRef(a[0]), "block");
      assertEditable(node, "rename");
      const parsed = parseBlockFile(a[1].trim());
      const to = parsed ? parsed.name : a[1].trim();
      if (parsed && parsed.type !== host.blockType(node.id)) throw new OpError(`Renaming keeps the file type — give the new name without an extension (${to}).`);
      await host.rename(node.id, to);
      return `Renamed “${displayName(node.id)}” to ${to}: its file, place, links and comments followed.`;
    }

    case "remove": {
      if (!a.length) throw new OpError("Remove which block? think remove <block…>");
      const nodes = a.map((r) => findNode(view, blockRef(r)));
      for (const n of nodes) {
        if (n.type === "group") throw new OpError(`${nodeTitle(n)} is a frame — think unframe "${frameTitle(n)}" removes it.`);
        assertEditable(n, "remove");
      }
      await host.remove(nodes.map((n) => n.id));
      return `Removed ${nodes.map((n) => `“${displayName(n.id)}”`).join(", ")} (file${nodes.length === 1 ? "" : "s"} and links). History keeps ${nodes.length === 1 ? "it" : "them"}.`;
    }

    case "view": {
      const sub = a[0];
      if (sub === "add") {
        if (!a[1]) throw new OpError(`think view add "Name" <block|frame…>`);
        const nodes = a.slice(2).map((r) => findNode(view, blockRef(r)));
        const r = saveView(view, a[1], nodes, grid);
        await host.setLayout(r.canvas, []);
        return `${r.created ? "Saved the view" : "Updated the view"} “${r.view.name}” (${r.view.id}) — the user can jump to it from the views list.`;
      }
      if (sub === "remove") {
        if (a.length !== 2) throw new OpError(`think view remove "Name"`);
        const r = removeView(view, a[1]);
        await host.setLayout(r.canvas, []);
        return `Removed the view “${r.view.name}”.`;
      }
      throw new OpError(`think view add "Name" <block|frame…>  ·  think view remove "Name"  (think read lists the views)`);
    }

    case "comments": {
      onlyArgs(req, 0, "think comments [--open] [--json]");
      let list = await host.comments();
      if (flag(req, "open")) list = list.filter((c) => !c.done);
      if (flag(req, "json")) return JSON.stringify(list, null, 2);
      if (!list.length) return flag(req, "open") ? "No open comments." : "No comments.";
      const who = (b: string) => (b === "you" ? "the user" : b);
      const on = (id: string | null) => {
        if (id === null) return "on the canvas";
        const n = view.nodes.find((x) => x.id === id);
        return n ? `on ${n.type === "group" ? `the frame “${frameTitle(n)}”` : id}` : `on ${id} (gone)`;
      };
      return list
        .map((c) => {
          const head = `${c.id}  ${on(c.on)} · ${who(c.by)} · ${c.at.slice(0, 16).replace("T", " ")}${c.done ? ` · done by ${who(c.done.by)}${c.done.note ? `: ${c.done.note}` : ""}` : " · open"}`;
          return `${head}\n  ${c.text.replace(/\n/g, "\n  ")}`;
        })
        .join("\n\n");
    }

    case "comment": {
      const sub = a[0];
      const list = await host.comments();
      if (sub === "done") {
        if (!a[1] || a.length > 3) throw new OpError(`think comment done <id> ["what you did"]`);
        const c = list.find((x) => x.id === a[1]);
        if (!c) throw new OpError(`There is no comment ${a[1]} (think comments lists them).`);
        const note = (a[2] ?? "").trim().slice(0, 500);
        const done = { by: callerName(caller), at: new Date().toISOString(), ...(note ? { note } : {}) };
        await host.setComments(list.map((x) => (x === c ? { ...x, done } : x)));
        if (c.on) host.highlight([c.on]);
        return `Marked ${c.id} done${note ? `: ${note}` : ""}. The user checks and clears it.`;
      }
      if (sub === "add") {
        if (a.length !== 3) throw new OpError(`think comment add <block|frame|-> "text"   (- is the canvas as a whole; add comments only when the user asks)`);
        const target = a[1] === "-" ? null : findNode(view, blockRef(a[1]));
        const text = a[2].replace(/\r/g, "").trim().slice(0, MAX_COMMENT);
        if (!text) throw new OpError("A comment needs some text.");
        const id = newId("c-");
        await host.setComments([...list, { id, on: target?.id ?? null, by: callerName(caller), text, at: new Date().toISOString() }]);
        if (target) host.highlight([target.id]);
        return `Added comment ${id} ${target ? `on ${nodeTitle(target)}` : "on the canvas"}.`;
      }
      throw new OpError(`think comment done <id> ["what you did"]  ·  think comment add <block|frame|-> "text"`);
    }

    case "show": {
      if (!a.length) throw new OpError("Show which? think show <block|frame…>");
      const nodes = a.map((r) => findNode(view, blockRef(r)));
      host.highlight(nodes.map((n) => n.id));
      return `Pointed at ${nodes.map(nodeTitle).join(", ")} in every open tab.`;
    }

    case "summary": {
      const text = a.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!text) throw new OpError(`think summary "one line: what you did"`);
      host.setSummary(text);
      return caller.kind === "agent" ? "Noted: it heads this turn's commit." : "Noted: it heads the commit when you unlock (unless you give one there).";
    }

    default:
      throw new OpError(`Unknown command “${req.op}” (think help).`);
  }
}
