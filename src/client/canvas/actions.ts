// Canvas actions shared by the toolbar, context menus and keyboard shortcuts.
import type { ReactFlowInstance } from "@xyflow/react";
import { BLOCK_SIZES, displayName, type BlockType } from "../../shared/blocks";
import type { CanvasView, ViewList } from "../../shared/canvas";
import type { Drawing } from "../../shared/drawing";
import { fileUrl, preloadImage, uploadImage } from "../lib/api";
import { act, currentSlug, layout } from "../lib/project";
import { setMode, setSidePanelOpen, useBoard } from "../lib/store";
import { useSettings } from "../lib/settings";
import { isPhone, matches, NARROW } from "../lib/device";
import { toast } from "../lib/toasts";
import { useCanvasUi, type PageChoice } from "./ui-state";
import { pushCamera } from "./camera";
import { forget, record, topStep, undo, type Outcome } from "./undo";

let rf: ReactFlowInstance | null = null;

/** Fit padding that clears the floating top bar and the bottom controls. */
export const FIT_PADDING = { top: "84px", bottom: "72px", left: "48px", right: "48px" } as const;

export function setFlowInstance(instance: ReactFlowInstance | null): void {
  rf = instance;
}

export function flow(): ReactFlowInstance | null {
  return rf;
}

/** Where a new block goes: under the pointer if it's over the canvas, else the middle of the view. */
export function placementPoint(): { x: number; y: number } {
  const p = useCanvasUi.getState().pointer;
  if (p) return p;
  if (!rf) return { x: 0, y: 0 };
  const el = document.querySelector(".react-flow") as HTMLElement | null;
  const r = el?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
}

function lockedGuard(): boolean {
  if (useBoard.getState().timeTravel) {
    toast.info("You're looking at the canvas's history — press Esc to return to the live canvas.");
    return true;
  }
  if (useBoard.getState().lock.locked) {
    toast.info("The agent is working — editing resumes when it finishes.");
    return true;
  }
  return false;
}

export async function createBlock(type: Exclude<BlockType, "image">, at?: { x: number; y: number }): Promise<void> {
  if (lockedGuard()) return;
  const p = at ?? placementPoint();
  const size = BLOCK_SIZES[type];
  const r = await act<{ name: string }>({ type: "block.create", blockType: type, x: p.x - size.width / 2, y: p.y - 40 });
  if (!r) return;
  recordCreate(r.name);
  const mode = useSettings.getState().newBlockMode;
  setMode(r.name, mode);
  if (mode === "raw") useBoard.setState({ focusRequest: r.name });
  select([r.name]);
}

export async function createImage(file: File | Blob, at?: { x: number; y: number }): Promise<void> {
  if (lockedGuard()) return;
  const slug = currentSlug();
  if (!slug) return;
  const p = at ?? placementPoint();
  const key = `u${Math.random().toString(36).slice(2, 8)}`;
  const box = { x: p.x - 160, y: p.y - 120, width: 320, height: 240 };
  const setUpload = (progress: number | null) =>
    useCanvasUi.setState((s) => {
      const uploads = { ...s.uploads };
      if (progress === null) delete uploads[key];
      else uploads[key] = { ...box, progress };
      return { uploads };
    });
  setUpload(0);
  try {
    const r = await uploadImage(slug, file, { x: box.x, y: box.y, onProgress: setUpload });
    // The upload answers over HTTP; the block itself arrives over the socket.
    await waitForBlock(r.name);
    recordCreate(r.name);
    toast.success(`Added image ${displayName(r.name)}`);
    select([r.name]);
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    setUpload(null);
  }
}

/**
 * A new page for an image block: a photo, or a colour (a blank page to draw
 * on). A drawing on it is not dropped silently: keep it (it moves onto the new
 * page, in the drawing editor, where undo can take it back) or start fresh —
 * History keeps both either way.
 */
export async function replaceImage(name: string, choice: PageChoice): Promise<void> {
  if (lockedGuard()) return;
  const ui = useCanvasUi.getState();
  // Drawing on it right now: the editor changes its page, asking against what is drawn there.
  if (ui.drawing === name) return void useCanvasUi.setState({ drawingPage: { name, choice, mode: "ask" } });
  const inEditor = (mode: "keep" | "fresh") => {
    useCanvasUi.setState({ drawingPage: { name, choice, mode } });
    startDrawing(name);
  };
  const r = await act<{ drawing: Drawing; saved: boolean }>({ type: "drawing.open", name });
  if (!r) return;
  const drawn = r.saved && r.drawing.shapes.length > 0;
  if (!drawn) return choice.kind === "photo" ? uploadReplacement(name, choice.file) : inEditor("fresh");
  const fresh = () => (choice.kind === "photo" ? void uploadReplacement(name, choice.file) : inEditor("fresh"));
  const title = choice.kind === "photo" ? `Replace the picture of ${displayName(name)}?` : `Make ${displayName(name)} a blank page?`;
  if (isPhone()) {
    // Keeping the drawing happens in the drawing editor: a tablet or computer.
    if (choice.kind === "color") return void toast.info("Drawing needs a bigger screen — open this canvas on a tablet or computer.");
    return ui.askConfirm({ title, body: "The drawing on it goes (History keeps it). To keep it on the new picture, replace the picture on a tablet or computer.", action: "Replace", danger: true, run: fresh });
  }
  ui.askConfirm({
    title,
    body: `There is a drawing on it. Keep the drawing on the new ${choice.kind === "photo" ? "picture" : "page"}, or start fresh without it? History keeps both either way.`,
    action: "Keep drawing",
    run: () => inEditor("keep"),
    alt: { action: "Start fresh", danger: true, run: fresh },
  });
}

/** The block's next content hash after `before` (undefined after a few seconds without one). */
function blockChange(name: string, before: string | undefined, ms = 6000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const now = useBoard.getState().blocks[name]?.hash;
    if (now && now !== before) return resolve(now);
    const done = (h: string | undefined) => {
      clearTimeout(timer);
      unsub();
      resolve(h);
    };
    const timer = setTimeout(() => done(undefined), ms);
    const unsub = useBoard.subscribe((s) => {
      const h = s.blocks[name]?.hash;
      if (h && h !== before) done(h);
    });
  });
}

async function uploadReplacement(name: string, file: File | Blob): Promise<void> {
  if (lockedGuard()) return;
  const slug = currentSlug();
  if (!slug) return;
  const n = useBoard.getState().canvas.nodes.find((x) => x.id === name);
  const key = `u${Math.random().toString(36).slice(2, 8)}`;
  const setUpload = (progress: number | null) =>
    useCanvasUi.setState((s) => {
      const uploads = { ...s.uploads };
      if (progress === null || !n) delete uploads[key];
      else uploads[key] = { x: n.x, y: n.y, width: n.width, height: n.height, progress };
      return { uploads };
    });
  setUpload(0);
  const before = useBoard.getState().blocks[name]?.hash;
  try {
    await uploadImage(slug, file, { replace: name, onProgress: setUpload });
    // Hold the placeholder until the new picture is there to show, not just uploaded.
    setUpload(1);
    const hash = await blockChange(name, before);
    const b = useBoard.getState().blocks[name];
    if (hash && b) await preloadImage(fileUrl(slug, b.file, hash));
    toast.success(`Replaced ${displayName(name)}`);
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    setUpload(null);
  }
}

/** Open the OS file picker for an image. */
export function pickImage(onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  };
  input.click();
}

export function select(names: string[]): void {
  if (!rf) return;
  const want = new Set(names);
  // Selection is applied after the new node arrives from the server.
  setTimeout(() => {
    rf?.setNodes((ns) => ns.map((n) => ({ ...n, selected: want.has(n.id) })));
  }, 60);
}

export function deleteBlocks(names: string[], opts: { skipConfirm?: boolean } = {}): void {
  if (!names.length || lockedGuard()) return;
  const run = async () => {
    const r = await act<{ batch: string } | undefined>({ type: "block.delete", names });
    if (!r) return;
    const what = names.length === 1 ? displayName(names[0]) : `${names.length} blocks`;
    let batch = r.batch;
    const step = record({
      label: `Delete ${what}`,
      undo: async () => {
        const back = await act<{ restored: string[] }>({ type: "block.undoDelete", batch });
        return back ? "ok" : "failed";
      },
      redo: async () => {
        const present = names.filter((n) => useBoard.getState().blocks[n]);
        if (!present.length) return "stale";
        const again = await act<{ batch: string } | undefined>({ type: "block.delete", names: present });
        if (!again) return "failed";
        batch = again.batch;
        return "ok";
      },
    });
    toast.info(
      `Deleted ${what}`,
      {
        label: "Undo",
        run: () => {
          // The same as ⌘Z while this is the newest step; otherwise undo just this deletion.
          if (topStep() === step) return void undo();
          forget(step);
          void act({ type: "block.undoDelete", batch });
        },
      },
      7000,
    );
  };
  if (useSettings.getState().confirmDelete && !opts.skipConfirm) {
    useCanvasUi.getState().askConfirm({
      title: names.length === 1 ? `Delete ${displayName(names[0])}?` : `Delete ${names.length} blocks?`,
      body: "The files are removed from the project folder. You can undo right after, and git keeps the history.",
      action: "Delete",
      danger: true,
      run: () => void run(),
    });
  } else {
    void run();
  }
}

/** Rename a block (the F2 editor), recorded for ⌘Z. */
export async function renameBlock(name: string, to: string): Promise<boolean> {
  const r = await act<{ name: string }>({ type: "block.rename", name, to });
  if (!r) return false;
  const swap = async (from: string, into: string): Promise<Outcome> => {
    const blocks = useBoard.getState().blocks;
    if (!blocks[from] || blocks[into]) return "stale";
    return (await act({ type: "block.rename", name: from, to: into })) === null ? "failed" : "ok";
  };
  record({ label: `Rename ${displayName(name)}`, undo: () => swap(to, name), redo: () => swap(name, to) });
  return true;
}

/** A visit to a block's editor changed its text: one ⌘Z step. */
export function recordEdit(name: string, before: string, after: string): void {
  if (before === after) return;
  const put = async (expect: string, content: string): Promise<Outcome> => {
    const b = useBoard.getState().blocks[name];
    if (!b || b.content !== expect) return "stale";
    if ((await act({ type: "user.edit", name, content })) === null) return "failed";
    // The server does not echo a tab's own edits back to it.
    const blocks = useBoard.getState().blocks;
    if (blocks[name]) useBoard.setState({ blocks: { ...blocks, [name]: { ...blocks[name], content } } });
    return "ok";
  };
  record({ label: `Edit ${displayName(name)}`, undo: () => put(after, before), redo: () => put(before, after) });
}

/** A block this tab just created: undo deletes it (while nobody has changed it since), redo brings it back. */
function recordCreate(name: string): void {
  const created = useBoard.getState().blocks[name];
  if (!created) return;
  let batch: string | null = null;
  record({
    label: `Add ${displayName(name)}`,
    undo: async () => {
      const b = useBoard.getState().blocks[name];
      if (!b || b.hash !== created.hash) return "stale";
      const r = await act<{ batch: string } | undefined>({ type: "block.delete", names: [name] });
      if (!r) return "failed";
      batch = r.batch;
      return "ok";
    },
    redo: async () => {
      if (!batch || useBoard.getState().blocks[name]) return "stale";
      const r = await act<{ restored: string[] }>({ type: "block.undoDelete", batch });
      batch = null;
      return r?.restored.includes(name) ? "ok" : "failed";
    },
  });
}

function waitForBlock(name: string, ms = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (useBoard.getState().blocks[name]) return resolve();
    const stop = useBoard.subscribe((s) => {
      if (!s.blocks[name]) return;
      stop();
      clearTimeout(t);
      resolve();
    });
    const t = setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

export function deleteEdges(ids: string[]): void {
  if (!ids.length || lockedGuard()) return;
  layout(ids.map((id) => ({ op: "edge.delete" as const, id })));
}

export function downloadBlock(name: string): void {
  const slug = currentSlug();
  const b = useBoard.getState().blocks[name];
  if (!slug || !b) return;
  const a = document.createElement("a");
  a.href = fileUrl(slug, b.file) + "?download";
  a.download = b.file;
  a.click();
}

export function fitAll(): void {
  if (!rf) return;
  pushCamera();
  void rf.fitView({ padding: FIT_PADDING, duration: 400, maxZoom: 1.2 });
}

/**
 * After jumping to something from the side panel: on a narrow screen the
 * panel would cover it, so it closes (a wide screen keeps it open).
 */
export function jumped(go: () => void): void {
  go();
  if (matches(NARROW)) setSidePanelOpen(false);
}

/** Fly to a block (or group), select it and flash it so the eye finds it. */
export function zoomToBlock(name: string, opts: { select?: boolean; history?: boolean } = {}): void {
  const n = rf?.getNode(name);
  if (!n || !rf) return;
  if (opts.history !== false) pushCamera();
  void rf.fitView({ nodes: [{ id: name }], padding: { ...FIT_PADDING, top: "110px", bottom: "100px" }, duration: 450, maxZoom: 1.25 });
  if (opts.select) {
    rf.setNodes((ns) => ns.map((x) => (x.selected === (x.id === name) ? x : { ...x, selected: x.id === name })));
    flash(name);
  }
}

/**
 * Draw on an image block: its edit mode. The camera frames the block the way
 * Z does (the drawing toolbar's full-screen button is there for more room),
 * and stays where it is when drawing ends.
 */
export function startDrawing(name: string): void {
  if (lockedGuard() || useCanvasUi.getState().drawing === name) return;
  if (isPhone()) return void toast.info("Drawing needs a bigger screen — open this canvas on a tablet or computer.");
  const b = useBoard.getState().blocks[name];
  if (!b || b.type !== "image") return;
  useCanvasUi.setState({ drawing: name });
  if (!rf?.getNode(name)) return;
  rf.setNodes((ns) => ns.map((x) => (x.selected === (x.id === name) ? x : { ...x, selected: x.id === name })));
  zoomToBlock(name);
}

export function stopDrawing(): void {
  if (!useCanvasUi.getState().drawing) return;
  useCanvasUi.setState({ drawing: null, drawingPage: null });
}

/** A blank page to draw on (an image block with a colour for a page), straight into drawing. */
export async function createSketch(at?: { x: number; y: number }, color?: string): Promise<void> {
  if (lockedGuard()) return;
  const p = at ?? placementPoint();
  const r = await act<{ name: string }>({ type: "sketch.create", x: p.x - 240, y: p.y - 150, background: color });
  if (!r) return;
  await waitForBlock(r.name);
  recordCreate(r.name);
  setTimeout(() => startDrawing(r.name), 80);
}

/** Fly to an area of the canvas (a saved view), fitting it to the screen. */
export function flyToRect(r: { x: number; y: number; width: number; height: number }): void {
  if (!rf) return;
  pushCamera();
  void rf.fitBounds(r, { padding: 0.04, duration: 500 });
}

/** Go to a saved view. One about a block or group flies to it — wherever it is now — and selects it. */
export function goToView(v: CanvasView): void {
  if (v.target && rf?.getNode(v.target)) return zoomToBlock(v.target, { select: true });
  flyToRect(v);
}

/**
 * What a view saved right now should hold: the one selected block or group
 * (the view is then about it and carries its name), several selected nodes
 * (framed together), or else what's on screen.
 */
export function captureView(): Pick<CanvasView, "x" | "y" | "width" | "height" | "target" | "followName"> & { name?: string } | null {
  if (!rf) return null;
  const sel = rf.getNodes().filter((n) => n.selected);
  if (sel.length === 1) {
    const n = sel[0];
    const w = n.measured?.width ?? n.width ?? 0;
    const h = n.measured?.height ?? n.height ?? 0;
    const node = useBoard.getState().canvas.nodes.find((x) => x.id === n.id);
    const label = node?.type === "group" ? node.label?.trim() || "Untitled group" : displayName(n.id);
    return { x: Math.round(n.position.x), y: Math.round(n.position.y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), target: n.id, followName: true, name: label };
  }
  if (sel.length > 1) {
    const pad = 40;
    const xs = sel.map((n) => n.position.x);
    const ys = sel.map((n) => n.position.y);
    const x2 = sel.map((n) => n.position.x + (n.measured?.width ?? n.width ?? 0));
    const y2 = sel.map((n) => n.position.y + (n.measured?.height ?? n.height ?? 0));
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...x2) + pad - x), height: Math.round(Math.max(...y2) + pad - y) };
  }
  return visibleRect();
}

/**
 * Shift+1–9: save what captureView() sees into view slot n (1-based),
 * overwriting what was there — or, with `list: "slides"`, into slide n.
 */
export async function saveViewSlot(n: number, list: ViewList = "views"): Promise<void> {
  if (lockedGuard()) return;
  const cap = captureView();
  if (!cap) return;
  const what = list === "slides" ? "Slide" : "View";
  const items = useBoard.getState().canvas[list] ?? [];
  const { name, target, followName, ...rect } = cap;
  const existing = items[n - 1];
  const extra = list === "slides" ? { list } : {};
  if (existing) {
    const patch = { ...rect, target: target ?? null, followName: !!followName, ...(followName && name ? { name } : {}) };
    if (await layout([{ op: "view.update", id: existing.id, patch, ...extra }], { label: `Update ${what.toLowerCase()} ${n}` })) {
      toast.success(`${what} ${n} ${target ? `now shows ${name}` : "updated"}`, { label: "Undo", run: () => void undo() }, 5000);
    }
    return;
  }
  const slot = items.length + 1;
  const view: CanvasView = { id: `${list === "slides" ? "s" : "v"}-${Math.random().toString(36).slice(2, 8)}`, name: name ?? `${what} ${slot}`, ...rect };
  if (target) Object.assign(view, { target, followName: true });
  if (await layout([{ op: "view.add", view, ...extra }])) {
    toast.success(`Saved as ${what.toLowerCase()} ${slot}${slot !== n ? ` (the next free number)` : ""}`, { label: "Undo", run: () => void undo() }, 5000);
  }
}

/** Copy views into the presentation (as new slides, at the end). */
export function addViewsAsSlides(views: CanvasView[]): void {
  if (lockedGuard() || !views.length) return;
  void layout(
    views.map((v) => ({ op: "view.add" as const, list: "slides" as const, view: { ...v, id: `s-${Math.random().toString(36).slice(2, 8)}` } })),
    { label: views.length === 1 ? "Add slide" : `Add ${views.length} slides` },
  );
}

/** The canvas area visible right now (minus the floating bars), in canvas coordinates. */
export function visibleRect(): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector(".react-flow") as HTMLElement | null;
  if (!rf || !el) return null;
  const r = el.getBoundingClientRect();
  const a = rf.screenToFlowPosition({ x: r.left + 16, y: r.top + 64 });
  const b = rf.screenToFlowPosition({ x: r.right - 16, y: r.bottom - 56 });
  return { x: Math.round(a.x), y: Math.round(a.y), width: Math.max(1, Math.round(b.x - a.x)), height: Math.max(1, Math.round(b.y - a.y)) };
}

let flashTimer: number | null = null;
export function flash(name: string): void {
  if (flashTimer) clearTimeout(flashTimer);
  useCanvasUi.setState({ flash: name });
  flashTimer = window.setTimeout(() => useCanvasUi.setState({ flash: null }), 1400);
}

/**
 * Wrap the given blocks in a new group (a labelled frame), or — with nothing
 * selected — drop an empty frame at `at`. The frame's name is edited right away.
 */
export function groupSelection(ids: string[], at?: { x: number; y: number }): void {
  if (lockedGuard() || !rf) return;
  if (isPhone()) return void toast.info("Frames are made on a tablet or computer — on a phone you can read, chat and comment.");
  const { canvas, gridSize: grid } = useBoard.getState();
  const inside = canvas.nodes.filter((n) => ids.includes(n.id));
  let rect: { x: number; y: number; width: number; height: number };
  if (inside.length) {
    const x0 = Math.min(...inside.map((n) => n.x));
    const y0 = Math.min(...inside.map((n) => n.y));
    const x1 = Math.max(...inside.map((n) => n.x + n.width));
    const y1 = Math.max(...inside.map((n) => n.y + n.height));
    const pad = grid * 2;
    rect = { x: x0 - pad, y: y0 - pad * 2, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 3 };
  } else {
    const p = at ?? placementPoint();
    rect = { x: p.x - 240, y: p.y - 160, width: 480, height: 320 };
  }
  const id = `grp-${Math.random().toString(36).slice(2, 8)}`;
  layout([{ op: "group.add", group: { id, type: "group", ...rect } }]);
  window.setTimeout(() => useCanvasUi.setState({ renaming: id }), 180);
}
