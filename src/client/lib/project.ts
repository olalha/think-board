// The open project's connection, autosave, and the actions the UI calls.
// Module-level on purpose: exactly one project is open per tab.
import type { BlockInfo, ClientMessage, LayoutOp } from "../../shared/protocol";
import { invertLayout, recordLayout, resetUndo } from "../canvas/undo";
import { ConnectionError, ProjectConnection } from "./connection";
import { applyServerMessage, resetBoard, setSaveState, useBoard } from "./store";
import { toast } from "./toasts";

let conn: ProjectConnection | null = null;
let slug: string | null = null;

/** Editors register here to receive external content changes for their block. */
type ContentListener = (block: BlockInfo) => void;
const contentListeners = new Map<string, Set<ContentListener>>();

export function onBlockContent(name: string, fn: ContentListener): () => void {
  let set = contentListeners.get(name);
  if (!set) contentListeners.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function openProject(s: string): void {
  if (slug === s && conn) return;
  closeProject();
  slug = s;
  resetBoard(s);
  resetUndo(s);
  conn = new ProjectConnection(
    s,
    (msg) => {
      applyServerMessage(msg, (block) => contentListeners.get(block.name)?.forEach((fn) => fn(block)));
      if (msg.type === "error") toast.error(msg.message);
      if (msg.type === "project.snapshot") resendPending();
    },
    (state, detail) => useBoard.setState({ conn: state, connDetail: detail }),
  );
}

export function closeProject(): void {
  flushBeacon();
  conn?.close();
  conn = null;
  slug = null;
}

export function currentSlug(): string | null {
  return slug;
}

export function send(msg: Parameters<ProjectConnection["send"]>[0]): void {
  conn?.send(msg);
}

export async function request<T = unknown>(msg: Parameters<ProjectConnection["request"]>[0]): Promise<T> {
  if (!conn) throw new Error("No project open.");
  return conn.request<T>(msg);
}

/** Request, and show the server's refusal as a toast. Resolves to null on failure. */
export async function act<T = unknown>(msg: Parameters<ProjectConnection["request"]>[0]): Promise<T | null> {
  try {
    return await request<T>(msg);
  } catch (err) {
    toast.error((err as Error).message);
    return null;
  }
}

export function nudgeConnection(): void {
  conn?.nudge();
}

// ------------------------------------------------------------------ autosave

const DEBOUNCE_MS = 500;
const pending = new Map<string, { content: string; timer: number }>();
const inflight = new Map<string, Promise<void>>();

/** Raw editors call this on every change; saves ~500ms after typing stops. */
export function queueEdit(name: string, content: string): void {
  // Optimistic: the server does not echo our own edits back to this tab, so the
  // store (and the rendered view) must reflect the typed content right away.
  const blocks = useBoard.getState().blocks;
  const b = blocks[name];
  if (b && b.content !== content) useBoard.setState({ blocks: { ...blocks, [name]: { ...b, content } } });
  const prev = pending.get(name);
  if (prev) clearTimeout(prev.timer);
  const timer = window.setTimeout(() => void saveNow(name), DEBOUNCE_MS);
  pending.set(name, { content, timer });
  setSaveState(name, "pending");
}

export function hasPendingEdit(name: string): boolean {
  return pending.has(name) || inflight.has(name);
}

async function saveNow(name: string): Promise<void> {
  const p = pending.get(name);
  if (!p) return inflight.get(name);
  clearTimeout(p.timer);
  pending.delete(name);
  setSaveState(name, "saving");
  const job = (async () => {
    try {
      await request({ type: "user.edit", name, content: p.content });
      if (!pending.has(name)) setSaveState(name, null);
    } catch (err) {
      if (err instanceof ConnectionError) {
        // Offline: keep the edit (unless a newer one is queued); it is sent
        // again when the connection is back (resendPending).
        if (!pending.has(name)) pending.set(name, { content: p.content, timer: 0 });
        setSaveState(name, "pending");
      } else {
        setSaveState(name, "error");
        toast.error(`Couldn't save ${name}: ${(err as Error).message}`);
      }
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, job);
  return job;
}

/** Other editors with unsaved work (the drawing editor) flush through here too. */
const flushers = new Set<() => Promise<void>>();
export function registerFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => void flushers.delete(fn);
}

/** Flush every pending edit now and wait for the server to accept them. */
export async function flushEdits(): Promise<void> {
  await Promise.all([...pending.keys()].map((name) => saveNow(name)));
  await Promise.all([...inflight.values(), ...[...flushers].map((f) => f())]);
}

/**
 * After a reconnect, anything still pending is sent again — and shown again:
 * the fresh snapshot carries the server's older copy of those blocks.
 */
function resendPending(): void {
  if (!pending.size) return;
  const blocks = { ...useBoard.getState().blocks };
  for (const [name, p] of pending) if (blocks[name]) blocks[name] = { ...blocks[name], content: p.content };
  useBoard.setState({ blocks });
  for (const name of [...pending.keys()]) void saveNow(name);
}

/** Tab closing: hand unsaved edits to sendBeacon, which survives page unload. */
export function flushBeacon(): void {
  if (!slug || pending.size === 0) return;
  const edits = [...pending].map(([name, p]) => {
    clearTimeout(p.timer);
    return { name, content: p.content };
  });
  pending.clear();
  try {
    navigator.sendBeacon(`/api/projects/${slug}/beacon`, new Blob([JSON.stringify({ edits })], { type: "text/plain" }));
  } catch {
    /* nothing more we can do while unloading */
  }
}

window.addEventListener("pagehide", flushBeacon);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushEdits();
  else nudgeConnection();
});

// ------------------------------------------------------------------ actions

/** Save now (⌘S): send pending edits, then make them a point in History. */
export async function saveCanvas(): Promise<void> {
  if (!conn?.isOpen) {
    toast.info("Offline — your edits are kept and saved when the connection is back.");
    return;
  }
  await flushEdits();
  const r = await act<{ saved: boolean; note?: string }>({ type: "canvas.save" });
  if (r) toast.success(r.note ?? (r.saved ? "Saved to History" : "Everything is already saved"));
}

/**
 * Change the layout. Recorded for ⌘Z unless `undoable: false` (undo itself);
 * `coalesce` merges a quick run of the same change (arrow nudges) into one step.
 * Resolves to whether the server applied it.
 */
export function layout(ops: LayoutOp[], opts: { undoable?: boolean; label?: string; coalesce?: string } = {}): Promise<boolean> {
  if (!ops.length) return Promise.resolve(true);
  const before = useBoard.getState().canvas;
  const inv = opts.undoable === false ? null : invertLayout(ops, before);
  return act({ type: "user.layout", ops }).then((r) => {
    if (r === null) return false;
    if (inv) recordLayout(ops, before, inv, (o) => layout(o, { undoable: false }), { label: opts.label, coalesce: opts.coalesce });
    return true;
  });
}

export async function sendPrompt(text: string): Promise<boolean> {
  // 1. Flush this tab's pending edits so they are part of the user commit.
  await flushEdits();
  const r = await act({ type: "agent.prompt", text });
  return r !== null || false;
}

export type ProjectMessage = ClientMessage;
