// What changed between two commits, in words — for the agent's change note
// and for History. Content changes come from git (renames detected); layout
// changes come from comparing the two canvas.json files by meaning, so
// "moved 4 blocks" replaces dozens of changed x/y numbers.

import { displayName, parseBlockFile } from "../shared/blocks.js";
import { groupMembers, type Canvas, type CanvasEdge, type FileNode, type GroupNode } from "../shared/canvas.js";
import { parseCanvas } from "./canvas-model.js";
import { changedPaths, changesBetween, commitStaged, git, head, showFile, type PathChange } from "./git.js";
import { COMMENTS_FILE, describeCommentChanges, parseComments } from "./comments.js";
import type { Comment } from "../shared/protocol.js";
import type { ChangeSummary } from "../shared/protocol.js";

export type { ChangeSummary };

export function emptySummary(): ChangeSummary {
  return { added: [], edited: [], removed: [], renamed: [], readme: false, work: 0, other: [], layout: [] };
}

export function isEmptySummary(s: ChangeSummary): boolean {
  return !s.added.length && !s.edited.length && !s.removed.length && !s.renamed.length && !s.readme && !s.work && !s.other.length && !s.layout.length && !s.comments?.length && !s.drawn?.length;
}

const name = (file: string) => parseBlockFile(file)?.name;
const quote = (s: string) => `“${s}”`;

/** How block names read: the agent works with file names, people with display names. */
let label: (name: string) => string = displayName;

function edgeText(e: CanvasEdge): string {
  return `${label(e.fromNode)} → ${label(e.toNode)}`;
}

function edgeExtras(e: CanvasEdge): string {
  const bits: string[] = [];
  if (e.label) bits.push(quote(e.label));
  if (e.style && e.style !== "solid") bits.push(e.style);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function groupName(g: GroupNode): string {
  return g.label ? quote(g.label) : `(unnamed, id ${g.id})`;
}

function list(names: string[], max = 8): string {
  const shown = names.slice(0, max).map(label);
  return shown.join(", ") + (names.length > max ? ` and ${names.length - max} more` : "");
}

/** Layout differences between two canvases, as sentences. Blocks added/removed are left to the file list. */
export function describeCanvasChanges(a: Canvas, b: Canvas, renames: Map<string, string> = new Map(), names: "display" | "file" = "display"): string[] {
  label = names === "file" ? (n) => n : displayName;
  const lines: string[] = [];
  // Compare under the new names, so a rename is not "removed + added".
  const newName = (id: string) => renames.get(id) ?? id;
  const aFiles = new Map(a.nodes.filter((n): n is FileNode => n.type === "file").map((n) => [newName(n.id), n]));
  const bFiles = new Map(b.nodes.filter((n): n is FileNode => n.type === "file").map((n) => [n.id, n]));

  const moved: string[] = [];
  const resized: string[] = [];
  const protectedOn: string[] = [];
  const protectedOff: string[] = [];
  const recoloured: string[] = [];
  for (const [id, nb] of bFiles) {
    const na = aFiles.get(id);
    if (!na) continue;
    if (na.x !== nb.x || na.y !== nb.y) moved.push(id);
    else if (na.width !== nb.width || na.height !== nb.height) resized.push(id);
    if (!!na.protected !== !!nb.protected) (nb.protected ? protectedOn : protectedOff).push(id);
    if ((na.color ?? "") !== (nb.color ?? "")) recoloured.push(id);
  }
  if (moved.length) lines.push(`Moved ${list(moved)}.`);
  if (resized.length) lines.push(`Resized ${list(resized)}.`);
  if (protectedOn.length) lines.push(`Protected ${list(protectedOn)} — read-only for the agent from now on.`);
  if (protectedOff.length) lines.push(`No longer protected: ${list(protectedOff)}.`);
  if (recoloured.length) lines.push(`Changed the colour of ${list(recoloured)}.`);

  // Connections, keyed by id; a connection whose ends were renamed is the same one.
  const aEdges = new Map(a.edges.map((e) => [e.id, { ...e, fromNode: newName(e.fromNode), toNode: newName(e.toNode) }]));
  const bEdges = new Map(b.edges.map((e) => [e.id, e]));
  for (const [id, e] of bEdges) {
    const was = aEdges.get(id);
    if (!was) {
      lines.push(`Connected ${edgeText(e)}${edgeExtras(e)}.`);
      continue;
    }
    const what: string[] = [];
    if ((was.label ?? "") !== (e.label ?? "")) what.push(e.label ? `label ${quote(e.label)}` : "label removed");
    if ((was.style ?? "solid") !== (e.style ?? "solid")) what.push(`${e.style ?? "solid"} line`);
    if ((was.fromEnd ?? "none") !== (e.fromEnd ?? "none") || (was.toEnd ?? "arrow") !== (e.toEnd ?? "arrow")) what.push("arrowheads changed");
    if (was.fromNode !== e.fromNode || was.toNode !== e.toNode) what.push(`now ${edgeText(e)}`);
    if (what.length) lines.push(`Changed the connection ${edgeText(was)}: ${what.join(", ")}.`);
  }
  for (const [id, e] of aEdges) {
    if (!bEdges.has(id)) lines.push(`Removed the connection ${edgeText(e)}${edgeExtras(e)}.`);
  }

  // Groups.
  const aGroups = new Map(a.nodes.filter((n): n is GroupNode => n.type === "group").map((n) => [n.id, n]));
  const bGroups = new Map(b.nodes.filter((n): n is GroupNode => n.type === "group").map((n) => [n.id, n]));
  for (const [id, g] of bGroups) {
    const was = aGroups.get(id);
    const members = groupMembers(b, id).filter((n) => n.type === "file").map((n) => n.id);
    if (!was) {
      lines.push(`New group ${groupName(g)}${members.length ? ` around ${list(members)}` : ""}.`);
      continue;
    }
    if ((was.label ?? "") !== (g.label ?? "")) lines.push(`Renamed the group ${groupName(was)} to ${groupName(g)}.`);
    const before = new Set(groupMembers(a, id).filter((n) => n.type === "file").map((n) => newName(n.id)));
    const joined = members.filter((m) => !before.has(m));
    const left = [...before].filter((m) => !members.includes(m));
    if (joined.length) lines.push(`${list(joined)} ${joined.length === 1 ? "is" : "are"} now in the group ${groupName(g)}.`);
    if (left.length) lines.push(`${list(left)} left the group ${groupName(g)}.`);
  }
  for (const [id, g] of aGroups) if (!bGroups.has(id)) lines.push(`Removed the group ${groupName(g)} (its blocks stay).`);

  // Views.
  const aViews = new Map((a.views ?? []).map((v) => [v.id, v]));
  const bViews = new Map((b.views ?? []).map((v) => [v.id, v]));
  for (const [id, v] of bViews) {
    const was = aViews.get(id);
    if (!was) lines.push(`Saved a view ${quote(v.name)}.`);
    else if (was.name !== v.name) lines.push(`Renamed the view ${quote(was.name)} to ${quote(v.name)}.`);
    else if (was.x !== v.x || was.y !== v.y || was.width !== v.width || was.height !== v.height) lines.push(`Updated the view ${quote(v.name)}.`);
  }
  for (const [id, v] of aViews) if (!bViews.has(id)) lines.push(`Deleted the view ${quote(v.name)}.`);
  return lines;
}

async function canvasAt(dir: string, rev: string | null): Promise<Canvas> {
  if (!rev) return { nodes: [], edges: [] };
  const buf = await showFile(dir, rev, "canvas.json");
  if (!buf) return { nodes: [], edges: [] };
  const r = parseCanvas(buf.toString("utf8"));
  return r.ok ? r.canvas : { nodes: [], edges: [] };
}

/** Everything that changed from `base` to `head`, grouped for people and agents. */
export async function summarizeRange(dir: string, base: string | null, head: string, names: "display" | "file" = "display"): Promise<ChangeSummary> {
  const s = emptySummary();
  label = names === "file" ? (n) => n : displayName;
  const changes: PathChange[] = await changesBetween(dir, base, head);
  const renames = new Map<string, string>();
  for (const c of changes) {
    // canvas.json is compared by meaning below; think.json is the app's (name, settings).
    if (c.path === "canvas.json" || c.path === "think.json" || c.path === COMMENTS_FILE) continue;
    if (c.path === "README.md") {
      s.readme = true;
      continue;
    }
    if (c.path.startsWith("work/")) {
      s.work++;
      continue;
    }
    if (c.path.startsWith(".drawings/")) {
      const n = c.path.split("/")[1];
      if (n && !(s.drawn ??= []).includes(n)) s.drawn.push(n);
      continue;
    }
    if (c.path.includes("/") || c.path.startsWith(".")) continue;
    const n = name(c.path);
    if (!n) {
      if (c.path !== "AGENTS.md" && c.path !== "CLAUDE.md") s.other.push(c.path);
      continue;
    }
    if (c.status === "R" && c.from && name(c.from)) {
      s.renamed.push([name(c.from)!, n]);
      renames.set(name(c.from)!, n);
    } else if (c.status === "A") s.added.push(n);
    else if (c.status === "D") s.removed.push(n);
    else s.edited.push(n);
  }
  const [before, after] = changes.some((c) => c.path === "canvas.json" || c.path === COMMENTS_FILE) ? [await canvasAt(dir, base), await canvasAt(dir, head)] : [null, null];
  if (changes.some((c) => c.path === "canvas.json")) {
    s.layout = describeCanvasChanges(before!, after!, renames, names);
  }
  if (changes.some((c) => c.path === COMMENTS_FILE)) {
    const where = (on: string | null) => {
      if (on === null) return "on the canvas";
      const g = after!.nodes.find((n) => n.id === on && n.type === "group") ?? before!.nodes.find((n) => n.id === on && n.type === "group");
      return g?.type === "group" ? `on the frame ${quote(g.label || "Untitled group")}` : `on ${label(on)}`;
    };
    s.comments = describeCommentChanges(await commentsAt(dir, base), await commentsAt(dir, head), where);
  }
  return s;
}

async function commentsAt(dir: string, rev: string | null): Promise<Comment[]> {
  if (!rev) return [];
  const buf = await showFile(dir, rev, COMMENTS_FILE);
  const r = buf ? parseComments(buf.toString("utf8")) : null;
  return r?.ok ? r.comments : [];
}

/** The summary as Markdown bullet lines, for the agent's change note. */
export function summaryLines(s: ChangeSummary): string[] {
  const lines: string[] = [];
  if (s.added.length) lines.push(`- New blocks: ${s.added.join(", ")}`);
  if (s.edited.length) lines.push(`- Edited blocks: ${s.edited.join(", ")}`);
  if (s.drawn?.length) lines.push(`- Drawn on by the user (look at the image again): ${s.drawn.join(", ")}`);
  if (s.renamed.length) lines.push(`- Renamed: ${s.renamed.map(([a, b]) => `${a} → ${b}`).join(", ")}`);
  if (s.removed.length) lines.push(`- Deleted blocks: ${s.removed.join(", ")}`);
  if (s.readme) lines.push("- README.md changed");
  if (s.work) lines.push(`- ${s.work} file${s.work === 1 ? "" : "s"} changed in work/`);
  if (s.other.length) lines.push(`- Other files: ${s.other.join(", ")}`);
  for (const l of s.layout) lines.push(`- ${l}`);
  for (const l of s.comments ?? []) lines.push(l);
  return lines;
}

/**
 * The summary as one line, for chat lines and commit subjects: “added
 * Timeline; moved Budget; connected Timeline → Budget; marked 2 comments
 * done”. Empty when nothing changed. Block names read as people see them.
 */
export function briefSummary(s: ChangeSummary, max = 6): string {
  const names = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).map(displayName).join(", ")} and ${xs.length - 3} more` : xs.map(displayName).join(", "));
  const parts: string[] = [];
  if (s.added.length) parts.push(`added ${names(s.added)}`);
  if (s.edited.length) parts.push(`edited ${names(s.edited)}`);
  if (s.renamed.length) parts.push(`renamed ${s.renamed.map(([a, b]) => `${displayName(a)} → ${displayName(b)}`).join(", ")}`);
  if (s.removed.length) parts.push(`removed ${names(s.removed)}`);
  if (s.drawn?.length) parts.push(`drew on ${names(s.drawn)}`);
  for (const l of s.layout) parts.push(l.charAt(0).toLowerCase() + l.slice(1).replace(/\.$/, ""));
  const comments = s.comments ?? [];
  if (comments.length) {
    const count = (re: RegExp) => comments.filter((c) => re.test(c)).length;
    const plural = (n: number) => `${n} ${n === 1 ? "comment" : "comments"}`;
    const done = count(/marked done/);
    const added = count(/^- New comment/);
    const rest = comments.length - done - added;
    if (done) parts.push(`marked ${plural(done)} done`);
    if (added) parts.push(`added ${plural(added)}`);
    if (rest) parts.push(`changed ${plural(rest)}`);
  }
  if (s.readme) parts.push("updated the README");
  if (s.other.length) parts.push(`changed ${s.other.join(", ")}`);
  if (s.work) parts.push(`${s.work} ${s.work === 1 ? "file" : "files"} in work/`);
  if (parts.length <= max) return parts.join("; ");
  return `${parts.slice(0, max - 1).join("; ")}; and ${parts.length - max + 1} more changes`;
}

/**
 * Commit everything uncommitted (as `author`, the agent by default), with a
 * message think writes: a subject — from the summary of exactly what is being
 * committed — then that summary line by line. Agents never run git themselves.
 */
export async function commitWork(dir: string, opts: { subject: (s: ChangeSummary) => string; author?: string }): Promise<{ head: string; summary: ChangeSummary } | null> {
  if (!(await changedPaths(dir)).length) return null;
  await git(dir, ["add", "-A"]);
  const tree = (await git(dir, ["write-tree"])).trim();
  const base = await head(dir);
  if (base && (await git(dir, ["rev-parse", `${base}^{tree}`])).trim() === tree) return null;
  const s = await summarizeRange(dir, base, tree, "display");
  const body = summaryLines(s).join("\n");
  const done = await commitStaged(dir, opts.subject(s).replace(/\s+/g, " ").trim().slice(0, 200) + (body ? `\n\n${body}` : ""), opts.author);
  return done ? { head: done, summary: s } : null;
}
