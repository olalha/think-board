// Copy, cut, paste and duplicate blocks (⌘C ⌘X ⌘V ⌘D) — within a canvas and
// between canvases on this server. A copy carries the blocks' content (images by
// reference: the server copies the file), their sizes, the frames among them and
// the connections between them.
//
// The system clipboard gets plain text (the blocks' content, so pasting into
// another app works too) plus the full copy as a custom type. Browsers that drop
// custom types (Safari between tabs) fall back to a copy kept in localStorage,
// recognised by its text.
import { groupMembers, type CanvasEdge, type CanvasNode, type GroupNode } from "../../shared/canvas";
import { displayName, isTextType, toBlockName } from "../../shared/blocks";
import type { PasteBlock } from "../../shared/protocol";
import { act, currentSlug, layout } from "../lib/project";
import { loadLocal, saveLocal } from "../lib/settings";
import { useBoard } from "../lib/store";
import { toast } from "../lib/toasts";
import { deleteBlocks, flow, placementPoint, select } from "./actions";
import { record } from "./undo";

const MIME = "application/x-think-blocks";
const STORE_KEY = "think.clipboard";

export interface Clip {
  v: 1;
  canvas: string;
  blocks: PasteBlock[];
  groups: GroupNode[];
  edges: CanvasEdge[];
  /** What went on the clipboard as plain text (how a fallback copy is recognised). */
  text: string;
}

function locked(): boolean {
  const s = useBoard.getState();
  if (s.timeTravel) {
    toast.info("You're looking at the canvas's history — press Esc to return first.");
    return true;
  }
  if (s.lock.locked) {
    toast.info("The agent is working — editing resumes when it finishes.");
    return true;
  }
  return false;
}

/** The selection as a copy: selected frames bring what is inside them. */
export function selectionClip(): Clip | null {
  const rf = flow();
  const slug = currentSlug();
  if (!rf || !slug) return null;
  const { canvas, blocks } = useBoard.getState();
  const picked = new Set(rf.getNodes().filter((n) => n.selected).map((n) => n.id));
  if (!picked.size) return null;
  for (const id of [...picked]) {
    if (canvas.nodes.find((n) => n.id === id)?.type === "group") for (const m of groupMembers(canvas, id)) picked.add(m.id);
  }
  const nodes = canvas.nodes.filter((n) => picked.has(n.id));
  const out: PasteBlock[] = [];
  const texts: string[] = [];
  for (const n of nodes) {
    if (n.type !== "file") continue;
    const b = blocks[n.id];
    if (!b) continue;
    const base = { from: n.id, type: b.type, x: n.x, y: n.y, width: n.width, height: n.height };
    if (isTextType(b.type)) {
      out.push({ ...base, content: b.content ?? "" });
      texts.push(b.content ?? "");
    } else {
      out.push({ ...base, image: { canvas: slug, file: b.file } });
      texts.push(`[image: ${displayName(n.id)}]`);
    }
  }
  const groups = nodes.filter((n): n is GroupNode => n.type === "group");
  const ids = new Set(nodes.map((n) => n.id));
  const edges = canvas.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
  if (!out.length && !groups.length) return null;
  return { v: 1, canvas: slug, blocks: out, groups, edges, text: texts.join("\n\n") || groups.map((g) => g.label ?? "Group").join("\n") };
}

/** ⌘C / ⌘X on the canvas (not in an editor, no text selected). Returns whether it handled the event. */
export function copySelection(e: ClipboardEvent, cut: boolean): boolean {
  const clip = selectionClip();
  if (!clip || !e.clipboardData) return false;
  if (cut && locked()) return true;
  e.preventDefault();
  e.clipboardData.setData("text/plain", clip.text);
  try {
    e.clipboardData.setData(MIME, JSON.stringify(clip));
  } catch {
    /* custom types refused: the localStorage copy below covers it */
  }
  saveLocal(STORE_KEY, clip);
  const n = clip.blocks.length + clip.groups.length;
  const what = n === 1 ? displayName(clip.blocks[0]?.from ?? clip.groups[0]?.label ?? "frame") : `${n} items`;
  if (cut) {
    deleteBlocks(clip.blocks.map((b) => b.from), { skipConfirm: true });
    const groups = clip.groups.map((g) => ({ op: "group.delete" as const, id: g.id }));
    if (groups.length) void layout(groups);
  } else toast.status("clipboard", `Copied ${what}`);
  return true;
}

/** The copy a paste event carries, if it is ours. */
export function clipFromPaste(e: ClipboardEvent): Clip | null {
  const raw = e.clipboardData?.getData(MIME);
  if (raw) {
    try {
      const clip = JSON.parse(raw) as Clip;
      if (clip?.v === 1) return clip;
    } catch {
      /* not ours after all */
    }
  }
  const text = e.clipboardData?.getData("text/plain") ?? "";
  const stored = loadLocal<Clip | null>(STORE_KEY, null);
  return stored && text && stored.text === text ? stored : null;
}

/**
 * Paste a copy. By default its middle lands under the pointer (or the middle
 * of the screen); `offset` instead shifts it from where it was (duplicate).
 */
export async function pasteClip(clip: Clip, opts: { offset?: { x: number; y: number }; label?: string } = {}): Promise<void> {
  if (locked()) return;
  const items: { x: number; y: number; width: number; height: number }[] = [...clip.blocks, ...clip.groups];
  if (!items.length) return;
  let dx: number;
  let dy: number;
  if (opts.offset) {
    dx = opts.offset.x;
    dy = opts.offset.y;
  } else {
    const minX = Math.min(...items.map((i) => i.x));
    const minY = Math.min(...items.map((i) => i.y));
    const maxX = Math.max(...items.map((i) => i.x + i.width));
    const maxY = Math.max(...items.map((i) => i.y + i.height));
    const at = placementPoint();
    dx = at.x - (minX + maxX) / 2;
    dy = at.y - (minY + maxY) / 2;
  }
  const move = <T extends { x: number; y: number }>(i: T): T => ({ ...i, x: i.x + dx, y: i.y + dy });
  const r = await act<{ names: Record<string, string>; groups: Record<string, string> }>({
    type: "blocks.paste",
    blocks: clip.blocks.map(move),
    groups: clip.groups.map(move),
    edges: clip.edges,
  });
  if (!r) return;
  const names = Object.values(r.names);
  const groupIds = Object.values(r.groups);
  select([...names, ...groupIds]);
  recordPaste(names, groupIds, opts.label ?? `Paste ${names.length + groupIds.length === 1 ? displayName(names[0] ?? "frame") : `${names.length + groupIds.length} items`}`);
  const skipped = clip.blocks.length - names.length;
  if (skipped > 0) toast.info(`${skipped} of the copied blocks no longer exist${skipped === 1 ? "s" : ""} and ${skipped === 1 ? "was" : "were"} left out.`);
}

/** ⌘D: a copy of the selection, just below and to the right of it. */
export function duplicateSelection(): void {
  const clip = selectionClip();
  if (!clip) return;
  const grid = useBoard.getState().gridSize || 20;
  void pasteClip(clip, { offset: { x: grid * 2, y: grid * 2 }, label: "Duplicate" });
}

/** Text pasted onto the canvas becomes a Markdown block, named after its first line. */
export async function pasteText(text: string): Promise<void> {
  if (locked() || !text.trim()) return;
  const first = text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 40);
  const at = placementPoint();
  const clip: Clip = { v: 1, canvas: currentSlug() ?? "", groups: [], edges: [], text, blocks: [{ from: toBlockName(first) || "note", type: "markdown", content: text.endsWith("\n") ? text : `${text}\n`, x: at.x, y: at.y, width: 360, height: 260 }] };
  await pasteClip(clip, { label: "Paste text" });
}

function recordPaste(names: string[], groupIds: string[], label: string): void {
  const groups = (): CanvasNode[] => useBoard.getState().canvas.nodes.filter((n) => groupIds.includes(n.id));
  let saved = groups();
  let batch: string | null = null;
  record({
    label,
    undo: async () => {
      const present = names.filter((n) => useBoard.getState().blocks[n]);
      if (present.length !== names.length) return "stale";
      saved = groups();
      if (names.length) {
        const r = await act<{ batch: string } | undefined>({ type: "block.delete", names });
        if (!r) return "failed";
        batch = r.batch;
      }
      if (saved.length) await layout(saved.map((g) => ({ op: "group.delete" as const, id: g.id })), { undoable: false });
      return "ok";
    },
    redo: async () => {
      if (names.length) {
        if (!batch) return "stale";
        const r = await act<{ restored: string[] }>({ type: "block.undoDelete", batch });
        batch = null;
        if (!r) return "failed";
      }
      if (saved.length) await layout(saved.map((g) => ({ op: "group.add" as const, group: g as GroupNode })), { undoable: false });
      return "ok";
    },
  });
}
