// Drawing on an image block (or a sketch) — its edit mode. Loaded on demand.
//
// Three layers, all in the same SVG coordinates (shared/drawing.ts): the base
// (image or colour — redrawn only when the page changes), the ink (the shapes,
// redrawn as they change), and an interactive overlay for what is being drawn,
// the selection and the crop. Every change is one undo step; the drawing is
// saved a second after the last change, when editing ends, before the agent is
// asked anything, and (small drawings) as the tab closes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Check,
  Circle,
  Crop,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  RotateCcw,
  RotateCw,
  Square,
  Type,
  Undo2,
} from "lucide-react";
import {
  changePage,
  COLORS,
  contentTransform,
  cropOf,
  distanceToShape,
  drawingToSvg,
  mapShape,
  outputSize,
  PAGES,
  shapeBounds,
  shapeTouchesRect,
  shapeSvg,
  strokePath,
  type Base,
  type Drawing,
  type Rect,
  type Rotation,
  type Shape,
} from "../../shared/drawing";
import { displayName } from "../../shared/blocks";
import { preloadImage, uploadDrawingBase } from "../lib/api";
import { modLabel } from "../lib/keys";
import { act, currentSlug, registerFlusher } from "../lib/project";
import { useBoard } from "../lib/store";
import { toast } from "../lib/toasts";
import { pickImage } from "../canvas/actions";
import { useCanvasUi, type PageChoice } from "../canvas/ui-state";
import { apply, diff, emptyHistory, LIMIT, loadHistory, type History } from "./history";

type Tool = "select" | "pen" | "highlighter" | "line" | "arrow" | "rect" | "ellipse" | "text" | "eraser" | "crop";
type SizeKey = "S" | "M" | "L";

/** Stroke and text sizes relative to the picture, so they look the same on any image. */
const STROKE: Record<SizeKey, number> = { S: 0.0035, M: 0.007, L: 0.014 };
const TEXT: Record<SizeKey, number> = { S: 0.024, M: 0.034, L: 0.052 };
const TOOLS: { id: Tool; label: string; key: string; icon: typeof PenLine }[] = [
  { id: "select", label: "Select and move", key: "V", icon: MousePointer2 },
  { id: "pen", label: "Pen", key: "P", icon: PenLine },
  { id: "highlighter", label: "Highlighter", key: "H", icon: Highlighter },
  { id: "arrow", label: "Arrow", key: "A", icon: ArrowUpRight },
  { id: "line", label: "Line", key: "L", icon: Minus },
  { id: "rect", label: "Rectangle", key: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { id: "text", label: "Text", key: "T", icon: Type },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "crop", label: "Crop", key: "C", icon: Crop },
];

/** What the page can become: a colour, or a photo from a file. */

const uid = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const round = (n: number) => Math.round(n * 10) / 10;

export default function DrawingSession({ name, onDone }: { name: string; onDone: () => void }) {
  const slug = currentSlug();
  const locked = useBoard((s) => s.lock.locked || !!s.timeTravel);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [saved, setSaved] = useState(false);
  const [tool, setToolState] = useState<Tool>("pen");
  // A highlighter in black or white is just grey: it starts in yellow.
  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    if (t === "highlighter") setColor((c) => (c === COLORS[0] || c === COLORS[1] ? COLORS[4] : c));
  }, []);
  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState<SizeKey>("M");
  const [eraser, setEraser] = useState<"stroke" | "pixel">("stroke");
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [, bump] = useState(0);
  const history = useRef<History>(emptyHistory());
  const current = useRef<Drawing | null>(null);
  current.current = drawing;
  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  // ---- load ------------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    void act<{ drawing: Drawing; history: unknown; saved: boolean }>({ type: "drawing.open", name }).then((r) => {
      if (!live) return;
      if (!r) return onDone();
      history.current = loadHistory(r.history);
      setSaved(r.saved);
      setDrawing(r.drawing);
      if (r.drawing.base.kind === "color") setColor(r.drawing.base.color === "#1f1f1d" || r.drawing.base.color === "#0f172a" ? COLORS[1] : COLORS[0]);
    });
    return () => {
      live = false;
    };
  }, [name, onDone]);

  // ---- save ------------------------------------------------------------------------
  const save = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (saving.current) await saving.current;
    const d = current.current;
    if (!dirty.current || !d || useBoard.getState().lock.locked) return;
    dirty.current = false;
    const job = act<{ hash: string }>({ type: "drawing.save", name, drawing: d, history: history.current }).then((r) => {
      if (r === null) dirty.current = true;
      else setSaved(true);
    });
    saving.current = job.finally(() => {
      saving.current = null;
    });
    await saving.current;
  }, [name]);

  const scheduleSave = useCallback(() => {
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 1000);
  }, [save]);

  // Before a message to the agent, the drawing is saved (the agent should see it).
  useEffect(() => registerFlusher(save), [save]);
  // The lock lifted with changes waiting: save them now.
  useEffect(() => {
    if (!locked && dirty.current) scheduleSave();
  }, [locked, scheduleSave]);
  // Closing the tab: hand a small drawing to sendBeacon (large ones were saved a second after drawing).
  useEffect(() => {
    const onHide = () => {
      const d = current.current;
      if (!dirty.current || !d || !slug) return;
      const body = JSON.stringify({ drawings: [{ name, drawing: d }] });
      if (body.length < 60_000) navigator.sendBeacon(`/api/projects/${slug}/beacon`, new Blob([body], { type: "text/plain" }));
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void save();
    };
  }, [name, slug, save]);

  // ---- changes and undo ------------------------------------------------------------
  const commit = useCallback(
    (next: Drawing, from?: Drawing) => {
      const prev = from ?? current.current;
      if (!prev) return;
      const patch = diff(prev, next);
      if (!patch) return;
      history.current.undo.push(patch);
      if (history.current.undo.length > LIMIT) history.current.undo.shift();
      history.current.redo = [];
      setDrawing(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  const step = useCallback(
    (dir: "undo" | "redo") => {
      const d = current.current;
      const from = dir === "undo" ? history.current.undo : history.current.redo;
      const to = dir === "undo" ? history.current.redo : history.current.undo;
      const p = from.pop();
      if (!d || !p) return;
      to.push(p);
      setDrawing(apply(d, p, dir));
      setSelected([]);
      scheduleSave();
      bump((n) => n + 1);
    },
    [scheduleSave],
  );

  const finish = useCallback(async () => {
    await save();
    onDone();
  }, [save, onDone]);

  // ---- the page: a colour or a photo -------------------------------------------------
  /** A photo on its way to becoming the page: upload progress (1 = loading it), or null. */
  const [pageBusy, setPageBusy] = useState<number | null>(null);
  /** Put the drawing on a new page — keeping the shapes (scaled to fit) or not. One undo step. */
  const setPage = useCallback(
    async (target: PageChoice, keep: boolean) => {
      const d = current.current;
      if (!d || !slug) return;
      let base: Base;
      if (target.kind === "color") {
        const o = outputSize(d);
        base = d.base.kind === "color" ? { ...d.base, color: target.color } : { kind: "color", color: target.color, width: Math.max(1, Math.round(o.width)), height: Math.max(1, Math.round(o.height)) };
      } else {
        setPageBusy(0);
        try {
          const r = await uploadDrawingBase(slug, name, target.file, (f) => setPageBusy(Math.min(f, 0.99)));
          setPageBusy(1);
          // Have the photo in hand before switching, so the page never shows empty.
          await preloadImage(`/api/projects/${slug}/drawings/${name}/base?file=${encodeURIComponent(r.file)}`);
          base = { kind: "image", file: r.file, width: r.width, height: r.height };
        } catch (err) {
          toast.error((err as Error).message);
          return;
        } finally {
          setPageBusy(null);
        }
      }
      const now = current.current ?? d;
      // Another colour for a blank page: the same page, repainted.
      commit(now.base.kind === "color" && base.kind === "color" ? { ...now, base } : changePage(now, base, keep), now);
      setSelected([]);
    },
    [slug, name, commit],
  );
  /** The page picker: with something drawn, a new page asks whether to keep it. */
  const choosePage = useCallback(
    (target: PageChoice) => {
      const d = current.current;
      if (!d) return;
      if (target.kind === "color" && d.base.kind === "color") {
        if (d.base.color !== target.color) void setPage(target, true);
        return;
      }
      if (!d.shapes.length) return void setPage(target, false);
      const toBlank = target.kind === "color";
      const undoKey = modLabel === "⌘" ? "⌘Z" : "Ctrl+Z";
      useCanvasUi.getState().askConfirm({
        title: toBlank ? "Swap the photo for a blank page?" : d.base.kind === "image" ? "Put a new photo under the drawing?" : "Draw on a photo instead?",
        body: `Keep the drawing on the ${toBlank ? "blank page" : "photo, scaled to fit"}, or start fresh without it? Undo (${undoKey}) goes back either way.`,
        action: "Keep drawing",
        run: () => void setPage(target, true),
        alt: { action: "Start fresh", danger: true, run: () => void setPage(target, false) },
      });
    },
    [setPage],
  );
  // Replace image (from the canvas): a new page, when the editor opens or while it is open.
  const loaded = drawing !== null;
  const intent = useCanvasUi((s) => (s.drawingPage?.name === name ? s.drawingPage : null));
  useEffect(() => {
    if (!loaded || !intent) return;
    useCanvasUi.setState({ drawingPage: null });
    if (intent.mode === "ask") choosePage(intent.choice);
    else void setPage(intent.choice, intent.mode === "keep");
  }, [loaded, intent, choosePage, setPage]);

  if (!drawing) {
    return (
      <div className="drawing-loading">
        <span className="spinner" /> Opening {displayName(name)}…
      </div>
    );
  }

  const props: SurfaceProps = {
    name,
    slug: slug ?? "",
    drawing,
    saved,
    tool,
    setTool,
    color,
    setColor,
    size,
    setSize,
    eraser,
    setEraser,
    selected,
    setSelected,
    commit,
    preview: setDrawing,
    step,
    canUndo: history.current.undo.length > 0,
    canRedo: history.current.redo.length > 0,
    locked,
    fullscreen,
    setFullscreen,
    finish,
    choosePage,
    pageBusy,
  };
  return fullscreen ? (
    <>
      <div className="drawing-fullscreen-placeholder">Drawing in full screen…</div>
      {createPortal(
        <div className="drawing-fullscreen" role="dialog" aria-label={`Drawing on ${displayName(name)}`}>
          <Surface {...props} />
        </div>,
        document.body,
      )}
    </>
  ) : (
    <Surface {...props} />
  );
}

interface SurfaceProps {
  name: string;
  slug: string;
  drawing: Drawing;
  saved: boolean;
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  size: SizeKey;
  setSize: (s: SizeKey) => void;
  eraser: "stroke" | "pixel";
  setEraser: (e: "stroke" | "pixel") => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  /** A finished change: one undo step (from `from`, when a preview was showing). */
  commit: (d: Drawing, from?: Drawing) => void;
  /** A change in progress (dragging): shown, not yet a step. */
  preview: (d: Drawing) => void;
  step: (dir: "undo" | "redo") => void;
  canUndo: boolean;
  canRedo: boolean;
  locked: boolean;
  fullscreen: boolean;
  setFullscreen: (f: boolean) => void;
  finish: () => void;
  /** A new page (colour or photo), asking first when that would affect the drawing. */
  choosePage: (target: PageChoice) => void;
  /** A photo for the page is on its way up. */
  pageBusy: number | null;
}

type Gesture =
  | { kind: "stroke"; shape: Shape & { type: "pen" | "highlighter" } }
  | { kind: "shape"; shape: Shape; x0: number; y0: number }
  | { kind: "erase"; points: number[]; removed: Set<string> }
  | { kind: "move"; start: Drawing; x0: number; y0: number }
  | { kind: "scale"; start: Drawing; anchor: [number, number]; from: [number, number] }
  | { kind: "crop"; rect: Rect; handle: string; x0: number; y0: number; start: Rect }
  /** Select by dragging a box over the page (Shift: add to what is selected). */
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; before: string[] };

function boxRect(g: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: Math.min(g.x0, g.x1), y: Math.min(g.y0, g.y1), width: Math.abs(g.x1 - g.x0), height: Math.abs(g.y1 - g.y0) };
}

function Surface(p: SurfaceProps) {
  const { drawing, tool, selected } = p;
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<SVGGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Gesture | null>(null);
  const [text, setText] = useState<{ id: string; x: number; y: number; value: string; fontSize: number; color: string; existing: boolean } | null>(null);
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  // Focus the text being typed once the click that placed it is over.
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => textInput.current?.focus({ preventScroll: true }), 30);
    return () => clearTimeout(t);
  }, [text?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const out = outputSize(drawing);
  const long = Math.max(out.width, out.height);
  const strokeSize = STROKE[p.size] * long;
  const cropping = tool === "crop";
  // While cropping, the whole picture shows (unrotated) with the crop box over it.
  const view: Drawing = cropping ? { ...drawing, crop: undefined, rotate: 0 } : drawing;
  const viewOut = outputSize(view);

  const blockFile = useBoard((s) => s.blocks[p.name]);
  // The page's photo, by name. Before the first save the first one is still the block's own file.
  const baseHref =
    drawing.base.kind === "image" && (p.saved || drawing.base.file !== `base.${drawing.base.file.split(".").pop()}`)
      ? `/api/projects/${p.slug}/drawings/${p.name}/base?file=${encodeURIComponent(drawing.base.file)}`
      : undefined;
  const href = baseHref ?? (blockFile && drawing.base.kind === "image" ? `/api/projects/${p.slug}/files/${blockFile.file}` : undefined);
  const pageKey = JSON.stringify([view.crop, view.rotate, view.base]);
  const baseSvg = useMemo(() => drawingToSvg({ ...view, shapes: [] }, { baseHref: href }), [pageKey, href]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = text?.existing ? text.id : null;
  const inkSvg = useMemo(
    () => drawingToSvg(view, { withBase: false, shapes: hidden ? view.shapes.filter((s) => s.id !== hidden) : view.shapes }),
    [view.shapes, pageKey, hidden], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- coordinates -----------------------------------------------------------------
  const toBase = (e: { clientX: number; clientY: number }): [number, number] => {
    const m = content.current?.getScreenCTM();
    if (!m) return [0, 0];
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [pt.x, pt.y];
  };
  /** Screen pixels per base unit (zoom × fit), for tolerances and handles. */
  const screenScale = () => {
    const m = content.current?.getScreenCTM();
    return m ? Math.hypot(m.a, m.b) || 1 : 1;
  };

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [p.fullscreen]);
  useEffect(() => {
    if (!cropping) setCropRect(null);
    else setCropRect(cropOf(drawing));
    if (tool !== "select") p.setSelected([]);
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (x: number, y: number): Shape | null => {
    const tol = 8 / screenScale();
    for (let i = drawing.shapes.length - 1; i >= 0; i--) {
      if (distanceToShape(drawing.shapes[i], x, y) <= tol) return drawing.shapes[i];
    }
    return null;
  };

  const selectionBounds = (): Rect | null => {
    const shapes = drawing.shapes.filter((s) => selected.includes(s.id));
    if (!shapes.length) return null;
    const bs = shapes.map(shapeBounds);
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
  };

  const commitText = (t: NonNullable<typeof text>) => {
    setText(null);
    const value = t.value.replace(/\s+$/, "");
    const shapes = drawing.shapes.filter((s) => s.id !== t.id);
    if (!value) return t.existing ? p.commit({ ...drawing, shapes }) : undefined;
    const shape: Shape = { id: t.id, type: "text", color: t.color, x: round(t.x), y: round(t.y), text: value, fontSize: t.fontSize };
    const i = drawing.shapes.findIndex((s) => s.id === t.id);
    p.commit({ ...drawing, shapes: i >= 0 ? drawing.shapes.map((s) => (s.id === t.id ? shape : s)) : [...drawing.shapes, shape] });
  };

  // ---- pointer ---------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (p.locked || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault(); // keep the focus here (not on the block), no text selection
    root.current?.focus({ preventScroll: true });
    if (text) commitText(text);
    const [x, y] = toBase(e);
    const target = e.currentTarget;
    const capture = () => target.setPointerCapture(e.pointerId);
    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0.5;
    let g: Gesture | null = null;
    if (cropping) {
      const handle = (e.target as Element).getAttribute("data-handle") ?? "move";
      const r = cropRect ?? cropOf(drawing);
      g = { kind: "crop", rect: r, handle, x0: x, y0: y, start: r };
    } else if (tool === "pen" || tool === "highlighter") {
      g = { kind: "stroke", shape: { id: uid(), type: tool, color: p.color, size: tool === "highlighter" ? strokeSize * 3.5 : strokeSize, points: [round(x), round(y), pressure] } };
    } else if (tool === "line" || tool === "arrow") {
      g = { kind: "shape", x0: x, y0: y, shape: { id: uid(), type: tool, color: p.color, size: strokeSize, x1: x, y1: y, x2: x, y2: y } };
    } else if (tool === "rect" || tool === "ellipse") {
      g = { kind: "shape", x0: x, y0: y, shape: { id: uid(), type: tool, color: p.color, size: strokeSize, x, y, width: 0, height: 0 } };
    } else if (tool === "text") {
      const hit = pick(x, y);
      if (hit?.type === "text") setText({ id: hit.id, x: hit.x, y: hit.y, value: hit.text, fontSize: hit.fontSize, color: hit.color, existing: true });
      else setText({ id: uid(), x, y: y - TEXT[p.size] * long * 0.6, value: "", fontSize: TEXT[p.size] * long, color: p.color, existing: false });
      return;
    } else if (tool === "eraser") {
      g = { kind: "erase", points: [round(x), round(y)], removed: new Set() };
      if (p.eraser === "stroke") {
        const hit = pick(x, y);
        if (hit) (g as { removed: Set<string> }).removed.add(hit.id);
      }
    } else if (tool === "select") {
      const handle = (e.target as Element).getAttribute("data-handle");
      const b = selectionBounds();
      if (handle && b) {
        const corners: Record<string, [number, number]> = { nw: [b.x, b.y], ne: [b.x + b.width, b.y], sw: [b.x, b.y + b.height], se: [b.x + b.width, b.y + b.height] };
        const opposite: Record<string, string> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };
        g = { kind: "scale", start: drawing, anchor: corners[opposite[handle]], from: corners[handle] };
      } else {
        const hit = pick(x, y);
        // Inside the selection's box (between its shapes) moves all of it.
        const inside = !hit && !e.shiftKey && b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
        if (hit) {
          const ids = e.shiftKey ? (selected.includes(hit.id) ? selected.filter((i) => i !== hit.id) : [...selected, hit.id]) : selected.includes(hit.id) ? selected : [hit.id];
          p.setSelected(ids);
          g = { kind: "move", start: drawing, x0: x, y0: y };
        } else if (inside) {
          g = { kind: "move", start: drawing, x0: x, y0: y };
        } else {
          if (!e.shiftKey) p.setSelected([]);
          g = { kind: "box", x0: x, y0: y, x1: x, y1: y, before: e.shiftKey ? selected : [] };
        }
      }
    }
    if (!g) return;
    capture();
    gesture.current = g;
    setLive(g);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const events = (e.nativeEvent.getCoalescedEvents?.() ?? []).length ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    const [x, y] = toBase(e);
    switch (g.kind) {
      case "stroke": {
        const pts = g.shape.points;
        for (const ev of events) {
          const [bx, by] = toBase(ev);
          const lx = pts[pts.length - 3];
          const ly = pts[pts.length - 2];
          if (Math.hypot(bx - lx, by - ly) * screenScale() < 1.2) continue;
          pts.push(round(bx), round(by), ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5);
        }
        break;
      }
      case "shape": {
        const s = g.shape;
        let dx = x - g.x0;
        let dy = y - g.y0;
        if (e.shiftKey) {
          if (s.type === "rect" || s.type === "ellipse") {
            const m = Math.max(Math.abs(dx), Math.abs(dy));
            dx = Math.sign(dx || 1) * m;
            dy = Math.sign(dy || 1) * m;
          } else {
            // Lines snap to 45°.
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            dx = Math.cos(a) * len;
            dy = Math.sin(a) * len;
          }
        }
        if (s.type === "line" || s.type === "arrow") g.shape = { ...s, x2: round(g.x0 + dx), y2: round(g.y0 + dy) };
        else if (s.type === "rect" || s.type === "ellipse")
          g.shape = { ...s, x: round(Math.min(g.x0, g.x0 + dx)), y: round(Math.min(g.y0, g.y0 + dy)), width: round(Math.abs(dx)), height: round(Math.abs(dy)) };
        break;
      }
      case "erase": {
        for (const ev of events) {
          const [bx, by] = toBase(ev);
          g.points.push(round(bx), round(by));
          if (p.eraser === "stroke") {
            const tol = Math.max(8 / screenScale(), strokeSize);
            for (const s of drawing.shapes) if (!g.removed.has(s.id) && distanceToShape(s, bx, by) <= tol) g.removed.add(s.id);
          }
        }
        break;
      }
      case "move": {
        const dx = x - g.x0;
        const dy = y - g.y0;
        p.preview({ ...g.start, shapes: g.start.shapes.map((s) => (selected.includes(s.id) ? mapShape(s, (px, py) => [round(px + dx), round(py + dy)]) : s)) });
        break;
      }
      case "scale": {
        const [ax, ay] = g.anchor;
        const sx = (x - ax) / (g.from[0] - ax || 1);
        const sy = (y - ay) / (g.from[1] - ay || 1);
        const uniform = e.shiftKey || selected.some((id) => ["pen", "highlighter", "text"].includes(g.start.shapes.find((s) => s.id === id)?.type ?? ""));
        const kx = uniform ? Math.sign(sx) * Math.max(Math.abs(sx), Math.abs(sy)) : sx;
        const ky = uniform ? Math.sign(sy) * Math.max(Math.abs(sx), Math.abs(sy)) : sy;
        if (!Number.isFinite(kx) || !Number.isFinite(ky) || Math.abs(kx) < 0.02 || Math.abs(ky) < 0.02) break;
        p.preview({
          ...g.start,
          shapes: g.start.shapes.map((s) => {
            if (!selected.includes(s.id)) return s;
            const inkScales = s.type === "pen" || s.type === "highlighter" || s.type === "text";
            return mapShape(s, (px, py) => [round(ax + (px - ax) * kx), round(ay + (py - ay) * ky)], inkScales ? (Math.abs(kx) + Math.abs(ky)) / 2 : 1);
          }),
        });
        break;
      }
      case "box": {
        g.x1 = x;
        g.y1 = y;
        const r = boxRect(g);
        const ids = drawing.shapes.filter((sh) => shapeTouchesRect(sh, r)).map((sh) => sh.id);
        const next = g.before.length ? [...new Set([...g.before, ...ids])] : ids;
        if (next.length !== selected.length || next.some((id, i) => id !== selected[i])) p.setSelected(next);
        break;
      }
      case "crop": {
        const b = view.base;
        const dx = x - g.x0;
        const dy = y - g.y0;
        let { x: rx, y: ry, width: rw, height: rh } = g.start;
        if (g.handle === "move") {
          rx = Math.max(0, Math.min(b.width - rw, rx + dx));
          ry = Math.max(0, Math.min(b.height - rh, ry + dy));
        } else {
          const min = 16 / screenScale();
          if (g.handle.includes("w")) {
            const nx = Math.max(0, Math.min(rx + rw - min, rx + dx));
            rw += rx - nx;
            rx = nx;
          }
          if (g.handle.includes("e")) rw = Math.max(min, Math.min(b.width - rx, rw + dx));
          if (g.handle.includes("n")) {
            const ny = Math.max(0, Math.min(ry + rh - min, ry + dy));
            rh += ry - ny;
            ry = ny;
          }
          if (g.handle.includes("s")) rh = Math.max(min, Math.min(b.height - ry, rh + dy));
        }
        g.rect = { x: Math.round(rx), y: Math.round(ry), width: Math.round(rw), height: Math.round(rh) };
        setCropRect(g.rect);
        break;
      }
    }
    setLive({ ...g });
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setLive(null);
    if (!g) return;
    switch (g.kind) {
      case "stroke":
        if (g.shape.points.length >= 3) p.commit({ ...drawing, shapes: [...drawing.shapes, g.shape] });
        break;
      case "shape": {
        const b = shapeBounds(g.shape);
        if (Math.max(b.width, b.height) * screenScale() > 6) p.commit({ ...drawing, shapes: [...drawing.shapes, g.shape] });
        break;
      }
      case "erase": {
        if (p.eraser === "stroke") {
          if (g.removed.size) p.commit({ ...drawing, shapes: drawing.shapes.filter((s) => !g.removed.has(s.id)) });
          break;
        }
        // Pixel eraser: the rub-out attaches to every shape it crosses.
        const size = strokeSize * 3;
        const hitShapes = new Set<string>();
        for (let i = 0; i < g.points.length; i += 2) {
          for (const s of drawing.shapes) if (!hitShapes.has(s.id) && distanceToShape(s, g.points[i], g.points[i + 1]) <= size / 2) hitShapes.add(s.id);
        }
        if (hitShapes.size) {
          p.commit({ ...drawing, shapes: drawing.shapes.map((s) => (hitShapes.has(s.id) ? { ...s, erase: [...(s.erase ?? []), { points: g.points, size }] } : s)) });
        }
        break;
      }
      case "move":
      case "scale":
        p.commit(drawing, g.start);
        break;
      case "crop":
      case "box":
        break;
    }
  };

  // ---- keyboard ----------------------------------------------------------------------
  // While drawing, the tools own the keyboard wherever the focus is (clicking
  // into a block can hand focus to the block itself) — except in a text field
  // elsewhere (the chat, a comment) and in the text being typed here.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  onKey.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable || target.closest?.(".cm-editor, .overlay, .comment-pop, .chat-panel")) return;
    if (document.querySelector(".overlay")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && ["k", "s"].includes(e.key.toLowerCase())) return; // quick jump and Save now stay available
    e.stopPropagation();
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      p.step(e.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      p.step("redo");
      return;
    }
    if (mod && e.key.toLowerCase() === "a" && !e.shiftKey) {
      e.preventDefault();
      if (!cropping) {
        p.setTool("select");
        p.setSelected(drawing.shapes.map((s) => s.id));
      }
      return;
    }
    if (mod || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
      e.preventDefault();
      p.commit({ ...drawing, shapes: drawing.shapes.filter((s) => !selected.includes(s.id)) });
      p.setSelected([]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (cropping) p.setTool("select");
      else if (selected.length) p.setSelected([]);
      else if (p.fullscreen) p.setFullscreen(false);
      else p.finish();
      return;
    }
    const t = TOOLS.find((x) => x.key === e.key.toUpperCase());
    if (t) {
      e.preventDefault();
      if (t.id === "eraser" && tool === "eraser") p.setEraser(p.eraser === "stroke" ? "pixel" : "stroke");
      p.setTool(t.id);
      return;
    }
    if (["1", "2", "3"].includes(e.key)) p.setSize((["S", "M", "L"] as const)[Number(e.key) - 1]);
  };

  // Colour and size apply to the selection too.
  const applyStyle = (patch: { color?: string; size?: SizeKey }) => {
    if (patch.color) p.setColor(patch.color);
    if (patch.size) p.setSize(patch.size);
    if (!selected.length) return;
    p.commit({
      ...drawing,
      shapes: drawing.shapes.map((s) => {
        if (!selected.includes(s.id)) return s;
        let n: Shape = patch.color ? { ...s, color: patch.color } : s;
        if (patch.size) {
          if (n.type === "text") n = { ...n, fontSize: TEXT[patch.size] * long };
          else if (n.type === "highlighter") n = { ...n, size: STROKE[patch.size] * long * 3.5 };
          else n = { ...n, size: STROKE[patch.size] * long };
        }
        return n;
      }),
    });
  };

  const rotate = (by: 90 | -90) => {
    const r = (((drawing.rotate ?? 0) + by + 360) % 360) as Rotation;
    const next: Drawing = { ...drawing, rotate: r };
    if (!r) delete next.rotate;
    p.commit(next);
  };

  const applyCrop = () => {
    const r = cropRect;
    const b = drawing.base;
    const next: Drawing = { ...drawing };
    if (!r || (r.x <= 0 && r.y <= 0 && r.width >= b.width && r.height >= b.height)) delete next.crop;
    else next.crop = r;
    p.commit(next);
    p.setTool("select");
  };

  // ---- the live overlay ------------------------------------------------------------------
  const s = screenScale();
  const handle = 9 / s;
  let overlay: React.ReactNode = null;
  if (live?.kind === "stroke") overlay = <path d={strokePath(live.shape.points, live.shape.size, live.shape.type === "highlighter")} fill={live.shape.color} fillOpacity={live.shape.type === "highlighter" ? 0.35 : 1} />;
  else if (live?.kind === "shape") overlay = <g dangerouslySetInnerHTML={{ __html: shapeSvg(live.shape) }} />;
  else if (live?.kind === "erase") {
    const pts = live.points;
    let d = `M${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
    overlay = (
      <>
        <path d={d} stroke="var(--accent)" strokeOpacity={0.35} strokeWidth={p.eraser === "pixel" ? strokeSize * 3 : Math.max(8 / s, strokeSize)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        {p.eraser === "stroke" &&
          drawing.shapes
            .filter((x) => live.removed.has(x.id))
            .map((x) => {
              const b = shapeBounds(x);
              return <rect key={x.id} x={b.x} y={b.y} width={b.width} height={b.height} fill="var(--danger)" fillOpacity={0.12} stroke="var(--danger)" strokeWidth={1.5 / s} />;
            })}
      </>
    );
  }
  if (live?.kind === "box") {
    const r = boxRect(live);
    overlay = <rect className="drawing-box" x={r.x} y={r.y} width={r.width} height={r.height} strokeWidth={1 / s} />;
  }
  const sel = tool === "select" ? selectionBounds() : null;
  const cr = cropping ? cropRect : null;

  // The text being typed sits where it will be drawn.
  const textStyle = (() => {
    if (!text || !content.current || !root.current) return undefined;
    const m = content.current.getScreenCTM();
    const box = root.current.querySelector(".drawing-stage")!.getBoundingClientRect();
    if (!m) return undefined;
    const pt = new DOMPoint(text.x, text.y).matrixTransform(m);
    return { left: pt.x - box.left, top: pt.y - box.top, fontSize: text.fontSize * s, color: text.color, lineHeight: 1.25 } as React.CSSProperties;
  })();

  return (
    <div ref={root} className={`drawing-editor nodrag nopan tool-${tool} ${p.locked ? "is-locked" : ""}`} tabIndex={0}>
      <div className="drawing-stage">
        <div className="drawing-layer" dangerouslySetInnerHTML={{ __html: baseSvg }} />
        <div className="drawing-layer" dangerouslySetInnerHTML={{ __html: inkSvg }} />
        {p.pageBusy !== null && (
          <div className="drawing-busy" role="status">
            <span className="spinner" />
            <span>{p.pageBusy >= 1 ? "Loading the photo…" : `Uploading the photo… ${Math.round(p.pageBusy * 100)}%`}</span>
            <span className="upload-bar">
              <i style={{ width: `${Math.round(p.pageBusy * 100)}%` }} />
            </span>
          </div>
        )}
        <svg
          className="drawing-overlay"
          viewBox={`0 0 ${viewOut.width} ${viewOut.height}`}
          onPointerDown={onPointerDown}
          // The browser moves focus on mousedown (not pointerdown): keep it here, off the block.
          onMouseDown={(e) => e.preventDefault()}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            if (tool !== "select") return;
            const [x, y] = toBase(e);
            const hit = pick(x, y);
            if (hit?.type === "text") {
              p.setTool("text");
              setText({ id: hit.id, x: hit.x, y: hit.y, value: hit.text, fontSize: hit.fontSize, color: hit.color, existing: true });
            }
          }}
        >
          <g ref={content} transform={contentTransform(view)}>
            {overlay}
            {sel && (
              <g className="drawing-selection">
                {/* With several selected, each one shows too. */}
                {selected.length > 1 &&
                  drawing.shapes
                    .filter((x) => selected.includes(x.id))
                    .map((x) => {
                      const b = shapeBounds(x);
                      return <rect key={x.id} x={b.x} y={b.y} width={b.width} height={b.height} fill="none" stroke="var(--accent)" strokeOpacity={0.45} strokeWidth={1 / s} />;
                    })}
                <rect x={sel.x} y={sel.y} width={sel.width} height={sel.height} fill="none" stroke="var(--accent)" strokeWidth={1.5 / s} strokeDasharray={`${5 / s} ${4 / s}`} />
                {(
                  [
                    ["nw", sel.x, sel.y],
                    ["ne", sel.x + sel.width, sel.y],
                    ["sw", sel.x, sel.y + sel.height],
                    ["se", sel.x + sel.width, sel.y + sel.height],
                  ] as const
                ).map(([h, hx, hy]) => (
                  <rect key={h} data-handle={h} className={`handle h-${h}`} x={hx - handle / 2} y={hy - handle / 2} width={handle} height={handle} rx={2 / s} fill="#fff" stroke="var(--accent)" strokeWidth={1.5 / s} />
                ))}
              </g>
            )}
            {cr && (
              <g className="drawing-crop">
                <path
                  d={`M0 0H${view.base.width}V${view.base.height}H0Z M${cr.x} ${cr.y}V${cr.y + cr.height}H${cr.x + cr.width}V${cr.y}Z`}
                  fill="rgba(0,0,0,0.45)"
                  fillRule="evenodd"
                  pointerEvents="none"
                />
                <rect data-handle="move" x={cr.x} y={cr.y} width={cr.width} height={cr.height} fill="transparent" stroke="#fff" strokeWidth={2 / s} />
                {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => {
                  const hx = cr.x + (h.includes("w") ? 0 : h.includes("e") ? cr.width : cr.width / 2);
                  const hy = cr.y + (h.includes("n") ? 0 : h.includes("s") ? cr.height : cr.height / 2);
                  return <rect key={h} data-handle={h} className={`handle h-${h}`} x={hx - handle / 2} y={hy - handle / 2} width={handle} height={handle} rx={2 / s} fill="#fff" stroke="var(--accent)" strokeWidth={1.5 / s} />;
                })}
              </g>
            )}
          </g>
        </svg>
        {text && textStyle && (
          <textarea
            ref={textInput}
            className="drawing-text-input"
            style={textStyle}
            value={text.value}
            placeholder="Type…"
            rows={Math.max(1, text.value.split("\n").length)}
            onChange={(e) => setText({ ...text, value: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                commitText(text);
                root.current?.focus({ preventScroll: true });
              }
            }}
            onBlur={(e) => {
              // Only a click elsewhere ends typing, not the moment before it is focused.
              if (e.relatedTarget || document.activeElement !== document.body) commitText(text);
            }}
          />
        )}
        {p.locked && <div className="drawing-locked">The agent is working — drawing resumes when it finishes.</div>}
      </div>
      <Toolbar {...p} applyStyle={applyStyle} rotate={rotate} cropping={cropping} applyCrop={applyCrop} />
    </div>
  );
}

function Toolbar(p: SurfaceProps & { applyStyle: (s: { color?: string; size?: SizeKey }) => void; rotate: (by: 90 | -90) => void; cropping: boolean; applyCrop: () => void }) {
  const [el] = useState(() => document.createElement("div"));
  const [pop, setPop] = useState<"color" | "page" | null>(null);
  useLayoutEffect(() => {
    // Inside the board, so it centres between the side panel and the chat.
    (document.querySelector(".board") ?? document.body).appendChild(el);
    return () => el.remove();
  }, [el]);
  const bar = (
    <div className={`drawing-toolbar ${p.fullscreen ? "over-all" : ""}`} role="toolbar" aria-label="Drawing tools" onPointerDown={(e) => e.stopPropagation()}>
      {p.cropping ? (
        <>
          <span className="drawing-hint">Drag the corners to crop. The original stays untouched.</span>
          <button className="icon-btn" data-tip="Rotate left" data-tip-pos="top" onClick={() => p.rotate(-90)} aria-label="Rotate left">
            <RotateCcw size={16} />
          </button>
          <button className="icon-btn" data-tip="Rotate right" data-tip-pos="top" onClick={() => p.rotate(90)} aria-label="Rotate right">
            <RotateCw size={16} />
          </button>
          <span className="drawing-sep" />
          <button className="btn small" onClick={() => p.setTool("select")}>Cancel</button>
          <button className="btn small primary" onClick={p.applyCrop}>Apply</button>
        </>
      ) : (
        <>
          <div className="drawing-tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`icon-btn ${p.tool === t.id ? "active" : ""}`}
                aria-label={t.label}
                aria-pressed={p.tool === t.id}
                data-tip={t.id === "eraser" ? `Eraser: ${p.eraser === "stroke" ? "whole strokes" : "rub out"} (E, again to switch)` : t.id === "select" ? "Select and move: click, or drag a box for several (V)" : `${t.label} (${t.key})`}
                data-tip-pos="top"
                onClick={() => {
                  if (t.id === "eraser" && p.tool === "eraser") p.setEraser(p.eraser === "stroke" ? "pixel" : "stroke");
                  p.setTool(t.id);
                }}
              >
                <t.icon size={16} />
                {t.id === "eraser" && <span className="eraser-mode">{p.eraser === "stroke" ? "" : "•"}</span>}
              </button>
            ))}
          </div>
          <span className="drawing-sep" />
          <div className="drawing-pop-anchor">
            <button className={`icon-btn color-btn ${pop === "color" ? "active" : ""}`} aria-label="Colour" aria-expanded={pop === "color"} data-tip="Colour" data-tip-pos="top" onClick={() => setPop(pop === "color" ? null : "color")}>
              <span className="swatch current" style={{ background: p.color }} />
            </button>
            {pop === "color" && (
              <div className="drawing-pop" role="listbox" aria-label="Colours">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    role="option"
                    aria-selected={p.color === c}
                    className={`swatch ${p.color === c ? "on" : ""}`}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    onClick={() => {
                      p.applyStyle({ color: c });
                      setPop(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="segmented small drawing-sizes" role="radiogroup" aria-label="Size">
            {(["S", "M", "L"] as const).map((k) => (
              <button key={k} role="radio" aria-checked={p.size === k} className={p.size === k ? "on" : ""} onClick={() => p.applyStyle({ size: k })}>
                <span className={`size-dot size-${k}`} />
              </button>
            ))}
          </div>
          <div className="drawing-pop-anchor">
            <button
              className={`icon-btn color-btn ${pop === "page" ? "active" : ""}`}
              aria-label="Page"
              aria-expanded={pop === "page"}
              data-tip="Page: a colour or a photo"
              data-tip-pos="top"
              disabled={p.pageBusy !== null}
              onClick={() => setPop(pop === "page" ? null : "page")}
            >
              {p.pageBusy !== null ? (
                <span className="spinner tiny" />
              ) : p.drawing.base.kind === "color" ? (
                <span className="swatch page current" style={{ background: p.drawing.base.color }} />
              ) : (
                <ImageIcon size={16} />
              )}
            </button>
            {pop === "page" && (
              <div className="drawing-pop" role="listbox" aria-label="Page">
                {PAGES.map(({ color, name }) => {
                  const on = p.drawing.base.kind === "color" && p.drawing.base.color === color;
                  return (
                    <button
                      key={color}
                      role="option"
                      aria-selected={on}
                      className={`swatch page ${on ? "on" : ""}`}
                      style={{ background: color }}
                      aria-label={`${name} page`}
                      data-tip={name}
                      data-tip-pos="top"
                      onClick={() => {
                        setPop(null);
                        p.choosePage({ kind: "color", color });
                      }}
                    />
                  );
                })}
                <span className="drawing-pop-sep" />
                <button
                  role="option"
                  aria-selected={p.drawing.base.kind === "image"}
                  className={`page-photo ${p.drawing.base.kind === "image" ? "on" : ""}`}
                  aria-label="A photo…"
                  data-tip={p.drawing.base.kind === "image" ? "Another photo…" : "A photo…"}
                  data-tip-pos="top"
                  onClick={() => {
                    setPop(null);
                    pickImage((f) => p.choosePage({ kind: "photo", file: f }));
                  }}
                >
                  <ImageIcon size={15} />
                </button>
              </div>
            )}
          </div>
          <span className="drawing-sep" />
          <button className="icon-btn" aria-label="Undo" data-tip="Undo (⌘Z)" data-tip-pos="top" disabled={!p.canUndo} onClick={() => p.step("undo")}>
            <Undo2 size={16} />
          </button>
          <button className="icon-btn" aria-label="Redo" data-tip="Redo (⇧⌘Z)" data-tip-pos="top" disabled={!p.canRedo} onClick={() => p.step("redo")}>
            <Redo2 size={16} />
          </button>
          <button className="icon-btn" aria-label={p.fullscreen ? "Back into the block" : "Full screen"} data-tip={p.fullscreen ? "Back into the block" : "Full screen"} data-tip-pos="top" onClick={() => p.setFullscreen(!p.fullscreen)}>
            {p.fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="btn small primary" onClick={() => p.finish()} data-tip="Done (Esc)" data-tip-pos="top">
            <Check size={14} /> Done
          </button>
        </>
      )}
    </div>
  );
  return createPortal(bar, el);
}
