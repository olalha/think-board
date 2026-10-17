// The canvas: React Flow wired to the board store.
//
// Server state (canvas.json) is the truth; React Flow keeps a local copy of
// the nodes so drags and resizes are smooth, and the copy is re-synced from
// the server whenever the canvas changes — except for nodes the user is
// moving right now. Layout changes go to the server as ops when a gesture ends.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnNodeDrag,
} from "@xyflow/react";
import {
  ArrowLeftRight,
  BoxSelect,
  Code2,
  Copy,
  Crosshair,
  Download,
  Eye,
  FileText,
  Frame,
  Globe,
  Image as ImageIcon,
  Maximize,
  Bot,
  MousePointer2,
  Pencil,
  Tag,
  Trash2,
  Undo2,
  Workflow,
  PenLine,
} from "lucide-react";
import type { CanvasNode, EdgeStyle, Side } from "../../shared/canvas";
import { edgeEnds, groupMembers } from "../../shared/canvas";
import { displayName } from "../../shared/blocks";
import { PAGES } from "../../shared/drawing";
import { act, layout } from "../lib/project";
import { modeOf, previewAll, setChatOpen, setMode, useBoard } from "../lib/store";
import { loadLocal, saveLocal, useSettings } from "../lib/settings";
import { toast } from "../lib/toasts";
import { Menu, type MenuEntry } from "../components/Menu";
import { BlockNode } from "./BlockNode";
import { GroupFrame } from "./GroupFrame";
import { BlockEdge } from "./BlockEdge";
import { cameraBack, cameraForward, resetCamera } from "./camera";
import {
  createBlock,
  createImage,
  createSketch,
  deleteBlocks,
  deleteEdges,
  downloadBlock,
  fitAll,
  FIT_PADDING,
  groupSelection,
  pickImage,
  replaceImage,
  setFlowInstance,
  startDrawing,
  stopDrawing,
  zoomToBlock,
} from "./actions";
import { useCanvasUi } from "./ui-state";
import { ZoomBar } from "./ZoomBar";
import { isMac, modKey } from "../lib/keys";
import { redo, undo } from "./undo";
import { isPhone, PHONE, TOUCH, useMedia } from "../lib/device";
import { clipFromPaste, copySelection, duplicateSelection, pasteClip, pasteText } from "./clipboard";

const nodeTypes = { block: BlockNode, group: GroupFrame };
const edgeTypes = { block: BlockEdge };

function autoSides(a: Node | undefined, b: Node | undefined): [Side, Side] {
  if (!a || !b) return ["right", "left"];
  const ax = a.position.x + (a.width ?? 0) / 2;
  const ay = a.position.y + (a.height ?? 0) / 2;
  const bx = b.position.x + (b.width ?? 0) / 2;
  const by = b.position.y + (b.height ?? 0) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/**
 * Mouse wheel or trackpad? Chromium and Safari report `wheelDeltaY` as exactly
 * −3 × deltaY for trackpads (pixel-precise scrolling) and ±120 per notch for a
 * wheel; Firefox reports wheels in lines (deltaMode 1). A gesture that just
 * looked like a trackpad stays one for a moment, so a fast flick never jolts
 * into zooming halfway through.
 */
let lastTrackpadAt = 0;
function isMouseWheel(e: WheelEvent): boolean {
  const now = performance.now();
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  let wheel: boolean;
  if (e.deltaMode !== 0) wheel = true;
  else if (legacy !== undefined && legacy !== 0) wheel = legacy !== -3 * e.deltaY && e.deltaX === 0;
  else wheel = false;
  if (!wheel) lastTrackpadAt = now;
  else if (now - lastTrackpadAt < 350) wheel = false;
  return wheel;
}

/**
 * Does anything between `from` and `boundary` (inclusive) have content to
 * scroll along the wheel's axis? At its end it still keeps the wheel: chaining
 * a scroll's momentum on into a canvas pan would be worse than stopping.
 */
function canScroll(from: HTMLElement, boundary: HTMLElement, e: WheelEvent): boolean {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
  for (let el: HTMLElement | null = from; el; el = el.parentElement) {
    const st = getComputedStyle(el);
    if (vertical ? /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1 : /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1) return true;
    if (el === boundary) break;
  }
  return false;
}

function isEditable(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  return e.isContentEditable || e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || !!e.closest?.(".cm-editor, .drawing-editor, .drawing-toolbar");
}

/** Where typing happens: an open editor, an input, a text box. */
function isTextField(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  return e.isContentEditable || e.tagName === "INPUT" || e.tagName === "TEXTAREA" || !!e.closest?.(".cm-editor");
}

export function BoardCanvas() {
  const rf = useReactFlow();
  const liveCanvas = useBoard((s) => s.canvas);
  const timeTravel = useBoard((s) => s.timeTravel);
  // History preview: the past canvas, plus ghosts of what that moment removed.
  const canvas = useMemo(
    () => (timeTravel ? { ...timeTravel.snap.canvas, nodes: [...timeTravel.snap.canvas.nodes, ...timeTravel.snap.ghosts.map((g) => g.node)] } : liveCanvas),
    [timeTravel, liveCanvas],
  );
  const loaded = useBoard((s) => s.loaded);
  const locked = useBoard((s) => s.lock.locked || !!s.timeTravel);
  const slug = useBoard((s) => s.slug)!;
  const gridSize = useBoard((s) => s.gridSize);
  const blockCount = useBoard((s) => Object.keys(s.blocks).length);
  const settings = useSettings();
  const menu = useCanvasUi((s) => s.menu);
  const closeMenu = useCanvasUi((s) => s.closeMenu);
  const openMenu = useCanvasUi((s) => s.openMenu);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const interacting = useRef(new Set<string>());
  const dragActive = useRef(false);
  const initialViewportDone = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFlowInstance(rf);
    return () => setFlowInstance(null);
  }, [rf]);

  // ---- server canvas → local nodes -------------------------------------------
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return canvas.nodes.map((cn) => {
        const p = prevById.get(cn.id);
        const type = cn.type === "group" ? "group" : "block";
        if (p && interacting.current.has(cn.id)) return p;
        if (p && p.type === type && p.position.x === cn.x && p.position.y === cn.y && p.width === cn.width && p.height === cn.height) return p;
        return {
          id: cn.id,
          type,
          position: { x: cn.x, y: cn.y },
          width: cn.width,
          height: cn.height,
          data: {},
          selected: p?.selected ?? false,
          // Frames sit behind blocks, even when selected.
          ...(type === "group" ? { zIndex: -1000 } : {}),
        } satisfies Node;
      });
    });
  }, [canvas]);

  useEffect(() => resetCamera, [slug]);

  // ---- first view: restore the saved viewport, else fit ----------------------
  useEffect(() => {
    if (!loaded || initialViewportDone.current) return;
    initialViewportDone.current = true;
    const saved = loadLocal<{ x: number; y: number; zoom: number } | null>(`think.viewport.${slug}`, null);
    requestAnimationFrame(() => {
      if (saved) void rf.setViewport(saved);
      else if (canvas.nodes.length) void rf.fitView({ padding: FIT_PADDING, maxZoom: 1 });
      else {
        const r = wrapper.current?.getBoundingClientRect();
        void rf.setViewport({ x: (r?.width ?? 800) / 2 - 180, y: (r?.height ?? 600) / 3, zoom: 1 });
      }
    });
  }, [loaded, slug, rf, canvas.nodes.length]);

  // ---- edges ------------------------------------------------------------------
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edges = useMemo<Edge[]>(() => {
    return canvas.edges.map((e) => {
      const [autoFrom, autoTo] = autoSides(nodeById.get(e.fromNode), nodeById.get(e.toNode));
      const { fromEnd, toEnd } = edgeEnds(e);
      const selected = selectedEdges.has(e.id);
      const color = selected ? "var(--accent)" : "var(--edge)";
      const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16, color };
      return {
        id: e.id,
        source: e.fromNode,
        target: e.toNode,
        sourceHandle: e.fromSide ?? autoFrom,
        targetHandle: e.toSide ?? autoTo,
        type: "block",
        data: { label: e.label, style: e.style ?? "solid" },
        markerStart: fromEnd === "arrow" ? marker : undefined,
        markerEnd: toEnd === "arrow" ? marker : undefined,
        selected,
      } satisfies Edge;
    });
  }, [canvas.edges, nodeById, selectedEdges]);

  // ---- local changes → server ops ----------------------------------------------
  const moveTimer = useRef<number | null>(null);
  const movedIds = useRef(new Set<string>());
  const flushMoves = useCallback(() => {
    moveTimer.current = null;
    const ops = [...movedIds.current]
      .map((id) => rf.getNode(id))
      .filter((n): n is Node => !!n)
      .map((n) => ({ op: "node.move" as const, id: n.id, x: n.position.x, y: n.position.y }));
    movedIds.current.clear();
    layout(ops, { coalesce: "nudge" });
  }, [rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === "position") {
          if (c.dragging) interacting.current.add(c.id);
          else if (!dragActive.current && c.position) {
            // Keyboard nudges (arrow keys) arrive as non-drag position changes.
            movedIds.current.add(c.id);
            if (moveTimer.current) clearTimeout(moveTimer.current);
            moveTimer.current = window.setTimeout(flushMoves, 250);
          }
        } else if (c.type === "dimensions" && c.resizing !== undefined) {
          if (c.resizing) interacting.current.add(c.id);
          else setTimeout(() => interacting.current.delete(c.id), 400);
        }
      }
      setNodes((ns) => applyChanges(changes, ns));
    },
    [flushMoves],
  );

  // Dragging a group carries everything inside it along.
  const carried = useRef<{ groups: Map<string, { x: number; y: number }>; members: Map<string, { x: number; y: number }> } | null>(null);

  const onNodeDragStart: OnNodeDrag = useCallback(
    (_e, _node, dragged) => {
      dragActive.current = true;
      closeMenu();
      if (useCanvasUi.getState().commentsFor) useCanvasUi.setState({ commentsFor: null });
      const groups = dragged.filter((n) => n.type === "group");
      if (!groups.length) {
        carried.current = null;
        return;
      }
      const cv = useBoard.getState().canvas;
      const draggedIds = new Set(dragged.map((n) => n.id));
      const members = new Map<string, { x: number; y: number }>();
      for (const g of groups) {
        for (const m of groupMembers(cv, g.id)) if (!draggedIds.has(m.id)) members.set(m.id, { x: m.x, y: m.y });
      }
      carried.current = { groups: new Map(groups.map((g) => [g.id, { ...g.position }])), members };
      members.forEach((_, id) => interacting.current.add(id));
    },
    [closeMenu],
  );

  const onNodeDrag: OnNodeDrag = useCallback((_e, node, dragged) => {
    const c = carried.current;
    if (!c || !c.members.size) return;
    const g = dragged.find((n) => c.groups.has(n.id)) ?? node;
    const start = c.groups.get(g.id);
    if (!start) return;
    const dx = g.position.x - start.x;
    const dy = g.position.y - start.y;
    setNodes((ns) => ns.map((n) => {
      const m = c.members.get(n.id);
      return m ? { ...n, position: { x: m.x + dx, y: m.y + dy } } : n;
    }));
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback((_e, _node, dragged) => {
    dragActive.current = false;
    const moved = [...dragged];
    const c = carried.current;
    if (c?.members.size) for (const id of c.members.keys()) {
      const n = rf.getNode(id);
      if (n) moved.push(n);
    }
    carried.current = null;
    layout(moved.map((n) => ({ op: "node.move" as const, id: n.id, x: n.position.x, y: n.position.y })));
    // Keep the local position until the server's echo lands.
    setTimeout(() => moved.forEach((n) => interacting.current.delete(n.id)), 400);
  }, [rf]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((prev) => {
      let next: Set<string> | null = null;
      for (const c of changes) {
        if (c.type !== "select") continue;
        next ??= new Set(prev);
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      return next ?? prev;
    });
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    layout([
      {
        op: "edge.add",
        edge: {
          id: `e-${c.source}-${c.target}-${Math.random().toString(36).slice(2, 6)}`,
          fromNode: c.source,
          fromSide: (c.sourceHandle ?? undefined) as Side | undefined,
          toNode: c.target,
          toSide: (c.targetHandle ?? undefined) as Side | undefined,
          fromEnd: "none",
          toEnd: "arrow",
        },
      },
    ]);
  }, []);

  // ---- pointer tracking (for "new block here" and paste) ----------------------
  const onPaneMouseMove = useCallback(
    (e: React.MouseEvent) => {
      useCanvasUi.setState({ pointer: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    },
    [rf],
  );

  // ---- menus -----------------------------------------------------------------------
  const selectedNodeIds = useCallback(() => rf.getNodes().filter((n) => n.selected).map((n) => n.id), [rf]);

  const menuItems = useMemo((): MenuEntry[] => {
    if (!menu) return [];
    if (menu.kind === "image" && menu.replace) {
      const name = menu.replace;
      return [
        { kind: "heading", label: `Replace ${displayName(name)} with` },
        { label: "An image…", icon: <ImageIcon size={15} />, disabled: locked, onSelect: () => pickImage((f) => void replaceImage(name, { kind: "photo", file: f })) },
        { kind: "swatches", label: "A blank page", icon: <PenLine size={15} />, disabled: locked || isPhone(), colors: PAGES, onPick: (c) => void replaceImage(name, { kind: "color", color: c }) },
      ];
    }
    if (menu.kind === "image") {
      return [
        { label: "Upload an image…", icon: <ImageIcon size={15} />, hint: "I", disabled: locked, onSelect: () => pickImage((f) => void createImage(f)) },
        { kind: "swatches", label: "Blank page", icon: <PenLine size={15} />, hint: "S", disabled: locked, colors: PAGES, onPick: (c) => void createSketch(undefined, c) },
      ];
    }
    if (menu.kind === "pane") {
      const at = menu.flow;
      return [
        { kind: "heading", label: "New block" },
        { label: "Markdown", icon: <FileText size={15} />, hint: "M", disabled: locked, onSelect: () => void createBlock("markdown", at) },
        { label: "Mermaid diagram", icon: <Workflow size={15} />, hint: "D", disabled: locked, onSelect: () => void createBlock("mermaid", at) },
        { label: "HTML", icon: <Globe size={15} />, hint: "H", disabled: locked, onSelect: () => void createBlock("html", at) },
        { label: "Image…", icon: <ImageIcon size={15} />, hint: "I", disabled: locked, onSelect: () => pickImage((f) => void createImage(f, at)) },
        { kind: "swatches", label: "Blank page", icon: <PenLine size={15} />, hint: "S", disabled: locked, colors: PAGES, onPick: (c) => void createSketch(at, c) },
        { label: "Group (frame)", icon: <Frame size={15} />, hint: "G", disabled: locked, onSelect: () => groupSelection([], at) },
        { kind: "sep" },
        { label: "Fit everything in view", icon: <Maximize size={15} />, hint: "F", disabled: !canvas.nodes.length, onSelect: fitAll },
        {
          label: "Select all",
          icon: <MousePointer2 size={15} />,
          hint: `${modKey}A`,
          disabled: !canvas.nodes.length,
          onSelect: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
        },
      ];
    }
    if (menu.kind === "node" && timeTravel) {
      const tt = timeTravel;
      const inPast = tt.snap.blocks.some((b) => b.name === menu.id) || tt.snap.ghosts.some((g) => g.node.id === menu.id);
      if (!inPast) return [];
      const ghost = tt.snap.ghosts.some((g) => g.node.id === menu.id);
      const rev = ghost ? tt.entry.base : tt.entry.id;
      return [
        { kind: "heading", label: `${displayName(menu.id)} · ${ghost ? "removed here" : "as it was"}` },
        {
          label: "Restore this block",
          icon: <Undo2 size={15} />,
          disabled: !rev || useBoard.getState().lock.locked,
          onSelect: () => void act({ type: "history.restore", rev: rev!, names: [menu.id] }),
        },
        { label: "Compare with now", icon: <ArrowLeftRight size={15} />, disabled: !rev, onSelect: () => useCanvasUi.setState({ diff: { name: menu.id, rev: rev! } }) },
      ];
    }
    if (menu.kind === "node") {
      const sel = selectedNodeIds();
      const multi = sel.length > 1 && sel.includes(menu.id) ? sel : null;
      if (multi) {
        return [
          { kind: "heading", label: `${multi.length} blocks selected` },
          { label: "Zoom to selection", icon: <Crosshair size={15} />, hint: "Z", onSelect: () => void rf.fitView({ nodes: multi.map((id) => ({ id })), padding: FIT_PADDING, duration: 400 }) },
          { label: "Group selection", icon: <BoxSelect size={15} />, hint: "G", disabled: locked, onSelect: () => groupSelection(multi) },
          { label: "Ask the agent about these", icon: <Bot size={15} />, hint: "A", onSelect: () => askAbout(multi) },
          { kind: "sep" },
          { label: `Delete ${multi.length} blocks`, icon: <Trash2 size={15} />, hint: "Del", danger: true, disabled: locked, onSelect: () => deleteBlocks(multi) },
        ];
      }
      const cnode = canvas.nodes.find((n) => n.id === menu.id);
      if (cnode?.type === "group") return groupMenu(cnode, locked);
      const b = useBoard.getState().blocks[menu.id];
      const lastValid = useBoard.getState().mermaidLastValid[menu.id];
      const isProtected = cnode?.type === "file" && !!cnode.protected;
      const items: MenuEntry[] = [{ kind: "heading", label: displayName(menu.id) }];
      if (b && b.type !== "image") {
        const raw = modeOf(menu.id, b.type) === "raw";
        items.push({
          label: raw ? "Show rendered" : "Edit raw",
          icon: raw ? <Eye size={15} /> : <Code2 size={15} />,
          hint: "Enter",
          onSelect: () => {
            setMode(menu.id, raw ? "rendered" : "raw");
            if (!raw) useBoard.setState({ focusRequest: menu.id });
          },
        });
      }
      if (b?.type === "mermaid" && lastValid !== undefined && lastValid !== b.content) {
        items.push({ label: "Revert to last valid version", icon: <Undo2 size={15} />, disabled: locked, onSelect: () => void act({ type: "block.revert", name: menu.id }) });
      }
      if (b?.type === "image") {
        items.push({ label: "Replace image…", icon: <ImageIcon size={15} />, disabled: locked, onSelect: () => openMenu({ kind: "image", x: menu.x, y: menu.y, replace: menu.id }) });
      }
      items.push(
        { label: "Rename…", icon: <Pencil size={15} />, hint: "F2", disabled: locked, onSelect: () => useCanvasUi.setState({ renaming: menu.id }) },
        {
          label: "Protect from the agent",
          checked: isProtected,
          disabled: locked,
          onSelect: () => layout([{ op: "node.protect", id: menu.id, protected: !isProtected }]),
        },
        { kind: "sep" },
        { label: "Ask the agent about it", icon: <Bot size={15} />, hint: "A", onSelect: () => askAbout([menu.id]) },
        { label: "Zoom to block", icon: <Crosshair size={15} />, hint: "Z", onSelect: () => zoomToBlock(menu.id) },
        {
          label: "Copy name",
          icon: <Copy size={15} />,
          onSelect: () => {
            void navigator.clipboard?.writeText(displayName(menu.id)).then(() => toast.success(`Copied “${displayName(menu.id)}”`));
          },
        },
        { label: `Download ${b?.file ?? "file"}`, icon: <Download size={15} />, disabled: !b, onSelect: () => downloadBlock(menu.id) },
        { kind: "sep" },
        { label: "Delete block", icon: <Trash2 size={15} />, hint: "Del", danger: true, disabled: locked, onSelect: () => deleteBlocks([menu.id]) },
      );
      return items;
    }
    const e = canvas.edges.find((x) => x.id === menu.id);
    if (!e) return [];
    const { fromEnd, toEnd } = edgeEnds(e);
    return [
      { kind: "heading", label: `${displayName(e.fromNode)} → ${displayName(e.toNode)}` },
      {
        label: "Arrowhead at start",
        checked: fromEnd === "arrow",
        disabled: locked,
        onSelect: () => layout([{ op: "edge.update", id: e.id, patch: { fromEnd: fromEnd === "arrow" ? "none" : "arrow" } }]),
      },
      {
        label: "Arrowhead at end",
        checked: toEnd === "arrow",
        disabled: locked,
        onSelect: () => layout([{ op: "edge.update", id: e.id, patch: { toEnd: toEnd === "arrow" ? "none" : "arrow" } }]),
      },
      {
        label: "Flip arrows",
        icon: <ArrowLeftRight size={15} />,
        disabled: locked,
        onSelect: () => layout([{ op: "edge.update", id: e.id, patch: { fromEnd: toEnd, toEnd: fromEnd } }]),
      },
      { label: e.label ? "Edit label" : "Add label", icon: <Tag size={15} />, disabled: locked, onSelect: () => useCanvasUi.getState().setEditingEdge(e.id) },
      { kind: "heading", label: "Line" },
      ...(["solid", "dashed", "dotted"] as EdgeStyle[]).map(
        (st): MenuEntry => ({
          label: st === "solid" ? "Solid" : st === "dashed" ? "Dashed" : "Dotted",
          checked: (e.style ?? "solid") === st,
          disabled: locked,
          onSelect: () => layout([{ op: "edge.update", id: e.id, patch: { style: st } }]),
        }),
      ),
      { kind: "sep" },
      { label: "Delete connection", icon: <Trash2 size={15} />, hint: "Del", danger: true, disabled: locked, onSelect: () => deleteEdges([e.id]) },
    ];
  }, [menu, locked, canvas, rf, selectedNodeIds, timeTravel]);

  // ---- keyboard shortcuts ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditable(e.target) || useCanvasUi.getState().drawing) return;
      if (document.querySelector(".overlay, .menu")) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key;
      const sel = () => rf.getNodes().filter((n) => n.selected).map((n) => n.id);
      // Edit ↔ preview for the one selected block (Enter, or ⌘/Ctrl+Enter).
      const toggleSelected = () => {
        const s = sel();
        if (s.length !== 1) return;
        if (rf.getNode(s[0])?.type === "group") {
          e.preventDefault();
          zoomToBlock(s[0]);
          return;
        }
        const b = useBoard.getState().blocks[s[0]];
        if (!b) return;
        e.preventDefault();
        if (b.type === "image") return startDrawing(s[0]);
        const raw = modeOf(s[0], b.type) === "raw";
        setMode(s[0], raw ? "rendered" : "raw");
        if (!raw) useBoard.setState({ focusRequest: s[0] });
      };
      if (mod && !e.altKey && k.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && k.toLowerCase() === "y") {
        e.preventDefault();
        void redo();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && k === "Enter") return toggleSelected();
      if (mod && !e.shiftKey && !e.altKey && k.toLowerCase() === "d") {
        e.preventDefault(); // not the browser's bookmark
        duplicateSelection();
        return;
      }
      if (mod && k.toLowerCase() === "a") {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.type !== "group" })));
        return;
      }
      if (e.altKey && !mod && (k === "ArrowLeft" || k === "ArrowRight")) {
        e.preventDefault();
        if (k === "ArrowLeft") cameraBack();
        else cameraForward();
        return;
      }
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      switch (k) {
        case "m":
        case "M":
          e.preventDefault();
          void createBlock("markdown");
          break;
        case "d":
        case "D":
          e.preventDefault();
          void createBlock("mermaid");
          break;
        case "h":
        case "H":
          e.preventDefault();
          void createBlock("html");
          break;
        case "i":
        case "I":
          e.preventDefault();
          if (!useBoard.getState().lock.locked) pickImage((f) => void createImage(f));
          break;
        case "f":
        case "F":
          e.preventDefault();
          fitAll();
          break;
        case "a":
        case "A": {
          const s = sel().filter((id) => useBoard.getState().blocks[id]);
          if (!s.length) return;
          e.preventDefault();
          askAbout(s);
          break;
        }
        case "g":
        case "G":
          e.preventDefault();
          if (!useBoard.getState().lock.locked) groupSelection(sel(), useCanvasUi.getState().pointer ?? undefined);
          break;
        case "F2": {
          const s = sel();
          if (s.length === 1 && (useBoard.getState().blocks[s[0]] || rf.getNode(s[0])?.type === "group") && !useBoard.getState().lock.locked) {
            e.preventDefault();
            useCanvasUi.setState({ renaming: s[0] });
          }
          break;
        }
        case "z":
        case "Z": {
          const s = sel();
          if (s.length === 1) zoomToBlock(s[0]);
          else if (s.length > 1) void rf.fitView({ nodes: s.map((id) => ({ id })), padding: FIT_PADDING, duration: 400 });
          break;
        }
        case "0":
          void rf.zoomTo(1, { duration: 250 });
          break;
        case "+":
        case "=":
          void rf.zoomIn({ duration: 200 });
          break;
        case "-":
        case "_":
          void rf.zoomOut({ duration: 200 });
          break;
        case "Enter":
          toggleSelected();
          break;
        case "r":
        case "R":
          e.preventDefault();
          previewAll();
          stopDrawing();
          break;
        case "s":
        case "S":
          e.preventDefault();
          void createSketch(useCanvasUi.getState().pointer ?? undefined);
          break;
        case "Delete":
        case "Backspace": {
          const s = sel();
          const edgesSel = [...selectedEdges];
          if (!s.length && !edgesSel.length) return;
          e.preventDefault();
          const groups = s.filter((id) => rf.getNode(id)?.type === "group");
          const blocks = s.filter((id) => !groups.includes(id));
          if (blocks.length) deleteBlocks(blocks);
          if (groups.length) layout(groups.map((id) => ({ op: "group.delete" as const, id })));
          if (edgesSel.length) deleteEdges(edgesSel);
          break;
        }
        case "Escape":
          setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns));
          setSelectedEdges(new Set());
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, selectedEdges]);

  // ---- scrolling: trackpads pan, mouse wheels zoom (scrollMode "auto") ------------
  // A selected block's content scrolls itself (its .nowheel area) — but when
  // there is nothing to scroll in there, the wheel is the canvas's after all,
  // so short content never stops a pan dead.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const zoomAt = (e: WheelEvent, step: number) => {
      const vp = rf.getViewport();
      const zoom = Math.min(2.5, Math.max(0.08, vp.zoom * Math.pow(2, -step * 0.0022)));
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      void rf.setViewport({ x: px - ((px - vp.x) * zoom) / vp.zoom, y: py - ((py - vp.y) * zoom) / vp.zoom, zoom });
      saveViewportSoon();
    };
    const onWheel = (e: WheelEvent) => {
      const mode = useSettings.getState().scrollMode;
      const target = e.target as HTMLElement;
      const inner = target.closest?.(".nowheel") as HTMLElement | null;
      if (inner) {
        if (canScroll(target, inner, e)) return; // the block's own content scrolls
        e.preventDefault();
        e.stopPropagation();
        const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        if (e.ctrlKey || e.metaKey) return zoomAt(e, isMouseWheel(e) ? step : step * 9); // pinch, or ⌘/Ctrl + wheel
        if (mode === "zoom" || (mode === "auto" && isMouseWheel(e))) return zoomAt(e, step);
        const vp = rf.getViewport();
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        void rf.setViewport({ ...vp, x: vp.x - dx, y: vp.y - dy });
        saveViewportSoon();
        return;
      }
      if (mode !== "auto") return;
      if (e.ctrlKey || e.metaKey) return; // pinch, or Ctrl+wheel: React Flow zooms
      if (!isMouseWheel(e)) return; // trackpad: React Flow pans
      e.preventDefault();
      e.stopPropagation();
      zoomAt(e, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf]);

  const saveTimer = useRef<number | null>(null);
  const saveViewportSoon = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveLocal(`think.viewport.${slug}`, rf.getViewport()), 300);
  };

  // ---- mouse back/forward buttons walk the camera history ------------------------
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) cameraBack();
      else cameraForward();
    };
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mousedown", swallow);
    el.addEventListener("auxclick", swallow);
    return () => {
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("mousedown", swallow);
      el.removeEventListener("auxclick", swallow);
    };
  }, []);

  // On touch screens one finger pans (there is no box-select). A block is part
  // of the canvas until it is selected — a swipe on it pans; selected, its body
  // scrolls (BlockNode) and, on a tablet, its title bar moves it. On a phone the
  // layout stays as it is: nothing moves, resizes or connects.
  const touch = useMedia(TOUCH);
  const phone = useMedia(PHONE);
  const flowNodes = useMemo(
    () =>
      touch
        ? nodes.map((n) => ({ ...n, draggable: !phone && !locked && !!n.selected, dragHandle: n.type === "group" ? ".group-label" : ".block-header" }))
        : nodes,
    [nodes, touch, phone, locked],
  );

  // ---- Space held: the hand tool (pan by dragging anywhere) ----------------------
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isEditable(e.target)) setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ---- follow the agent ------------------------------------------------------------
  // While a turn runs — or an outside agent holds the lock — glide to the block
  // the agent edits, unless the user has just moved the camera themselves, which
  // pauses following for a few seconds.
  const followAgent = settings.followAgent;
  const agentFocus = useBoard((s) => s.agentFocus);
  const turnRunning = useBoard((s) => s.turnRunning);
  const guestWorking = useBoard((s) => (s.lock.locked && s.lock.reason === "guest" ? (s.lock.by ?? null) : null));
  const userMovedAt = useRef(0);
  const lastFollow = useRef<{ name: string; at: number } | null>(null);
  useEffect(() => {
    const working = agentFocus?.by ? agentFocus.by === guestWorking : turnRunning;
    if (!followAgent || !working || !agentFocus || agentFocus.action !== "edit") return;
    if (Date.now() - userMovedAt.current < 4000) return;
    const prev = lastFollow.current;
    if (prev && prev.name === agentFocus.name && Date.now() - prev.at < 8000) return;
    const t = setTimeout(() => {
      if (!rf.getNode(agentFocus.name)) return;
      lastFollow.current = { name: agentFocus.name, at: Date.now() };
      void rf.fitView({ nodes: [{ id: agentFocus.name }], padding: { ...FIT_PADDING, top: "120px", bottom: "110px" }, duration: 700, maxZoom: 1 });
    }, 250);
    return () => clearTimeout(t);
  }, [agentFocus, followAgent, turnRunning, guestWorking, rf]);

  // ---- copy, cut, paste (blocks, images, text) ------------------------------------
  useEffect(() => {
    // Text selected in a rendered block, or an editor: the browser's own copy.
    const ours = (e: ClipboardEvent) => !isEditable(e.target) && !document.querySelector(".overlay") && !window.getSelection()?.toString();
    const onCopy = (e: ClipboardEvent) => void (ours(e) && copySelection(e, false));
    const onCut = (e: ClipboardEvent) => void (ours(e) && copySelection(e, true));
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || document.querySelector(".overlay")) return;
      const clip = clipFromPaste(e);
      if (clip) {
        e.preventDefault();
        void pasteClip(clip);
        return;
      }
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        void createImage(file);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim()) {
        e.preventDefault();
        void pasteText(text);
      }
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  const [dropping, setDropping] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = locked ? "none" : "copy";
    setDropping(true);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    files.forEach((f, i) => void createImage(f, { x: at.x + i * 40, y: at.y + i * 40 }));
  };

  const minimapColor = useCallback((n: Node) => {
    if (n.type === "group") return "var(--group-minimap)";
    const t = useBoard.getState().blocks[n.id]?.type ?? "markdown";
    return `var(--type-${t})`;
  }, []);

  return (
    <div
      ref={wrapper}
      className={`canvas-wrap ${dropping ? "dropping" : ""} ${locked ? "is-locked" : ""} ${spaceHeld ? "space-held" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
        void createBlock("markdown", rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onMoveStart={(e) => {
          if (e) userMovedAt.current = Date.now();
        }}
        onPaneMouseMove={onPaneMouseMove}
        onPaneMouseLeave={() => useCanvasUi.setState({ pointer: null })}
        onPaneClick={() => {
          closeMenu();
          useCanvasUi.getState().hideIssues();
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          openMenu({ kind: "pane", x: e.clientX, y: e.clientY, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        }}
        onNodeContextMenu={(e, node) => {
          // In a text editor the browser's own menu wins: spelling suggestions, copy, paste.
          if (isTextField(e.target)) return;
          e.preventDefault();
          openMenu({ kind: "node", x: e.clientX, y: e.clientY, id: node.id });
        }}
        onSelectionContextMenu={(e, sel) => {
          e.preventDefault();
          if (sel[0]) openMenu({ kind: "node", x: e.clientX, y: e.clientY, id: sel[0].id });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          setSelectedEdges(new Set([edge.id]));
          openMenu({ kind: "edge", x: e.clientX, y: e.clientY, id: edge.id });
        }}
        onMoveEnd={(e, vp) => {
          if (e) userMovedAt.current = Date.now();
          saveLocal(`think.viewport.${slug}`, vp);
        }}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={28}
        isValidConnection={(c) => c.source !== c.target}
        snapToGrid
        snapGrid={[gridSize, gridSize]}
        nodesDraggable={!locked && !spaceHeld && !touch}
        nodesConnectable={!locked && !phone}
        edgesFocusable
        elementsSelectable
        deleteKeyCode={null}
        // Figma-style: dragging empty canvas draws a selection box; Space+drag,
        // the middle button or two-finger scrolling pans.
        selectionOnDrag={!spaceHeld && !touch}
        selectionMode={SelectionMode.Partial}
        panOnDrag={spaceHeld || touch ? true : [1]}
        panActivationKeyCode="Space"
        selectionKeyCode={null}
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
        zoomOnDoubleClick={false}
        panOnScroll={settings.scrollMode !== "zoom"}
        zoomOnScroll={settings.scrollMode === "zoom"}
        zoomOnPinch
        minZoom={0.08}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "block" }}
        connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 2 }}
        onlyRenderVisibleElements={false}
        disableKeyboardA11y={false}
      >
        {settings.showGrid && <Background variant={BackgroundVariant.Dots} gap={gridSize} size={1.4} color="var(--grid-dot)" />}
        {settings.minimap && canvas.nodes.length > 0 && (
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapColor}
            nodeBorderRadius={6}
            maskColor="var(--minimap-mask)"
            className="minimap"
            ariaLabel="Mini map"
          />
        )}
        <UploadPlaceholders />
      </ReactFlow>
      <ZoomBar />
      {loaded && blockCount === 0 && canvas.nodes.length === 0 && <EmptyHint />}
      {dropping && !locked && <div className="drop-hint">Drop to add the image</div>}
      {menu && <Menu key={menu.kind === "image" ? `image-${menu.replace ?? ""}` : menu.kind} x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}

/** Open the chat with the blocks mentioned, ready for a question about them. */
function askAbout(names: string[]): void {
  setChatOpen(true);
  useBoard.setState({ composerPrefill: names.map((n) => `@${n}`).join(" ") + " " });
}

function groupMenu(g: Extract<CanvasNode, { type: "group" }>, locked: boolean): MenuEntry[] {
  return [
    { kind: "heading", label: g.label || "Group" },
    { label: g.label ? "Rename group…" : "Name group…", icon: <Pencil size={15} />, disabled: locked, onSelect: () => useCanvasUi.setState({ renaming: g.id }) },
    { label: "Zoom to group", icon: <Crosshair size={15} />, hint: "Z", onSelect: () => zoomToBlock(g.id) },
    { kind: "sep" },
    { label: "Remove group (keep blocks)", icon: <Trash2 size={15} />, danger: true, disabled: locked, onSelect: () => layout([{ op: "group.delete", id: g.id }]) },
  ];
}

/** applyNodeChanges, minus removals (deletion goes through the server). */
function applyChanges(changes: NodeChange[], nodes: Node[]): Node[] {
  return applyNodeChanges(
    changes.filter((c) => c.type !== "remove"),
    nodes,
  );
}

function EmptyHint() {
  return (
    <div className="empty-hint">
      <div className="empty-hint-card">
        <div className="empty-hint-title">An empty canvas</div>
        <p>Add a block from the toolbar, right-click, or double-click anywhere. Paste or drop an image. Or just ask the agent in the chat.</p>
        <div className="empty-hint-keys">
          <span><kbd>M</kbd> Markdown</span>
          <span><kbd>D</kbd> Diagram</span>
          <span><kbd>H</kbd> HTML</span>
          <span><kbd>I</kbd> Image</span>
        </div>
      </div>
    </div>
  );
}

/** Where images being uploaded will land, with their progress. */
function UploadPlaceholders() {
  const uploads = useCanvasUi((s) => s.uploads);
  const list = Object.entries(uploads);
  if (!list.length) return null;
  return (
    <ViewportPortal>
      {list.map(([key, u]) => (
        <div key={key} className="upload-ghost" style={{ transform: `translate(${u.x}px, ${u.y}px)`, width: u.width, height: u.height }}>
          <span className="spinner" />
          <span>{u.progress >= 1 ? "Processing…" : `Uploading… ${Math.round(u.progress * 100)}%`}</span>
          <span className="upload-bar">
            <i style={{ width: `${Math.round(u.progress * 100)}%` }} />
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}
