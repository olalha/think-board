// Transient UI state around the canvas: menus, popovers, dialogs.
import { create } from "zustand";

export type MenuState =
  | { kind: "pane"; x: number; y: number; flow: { x: number; y: number } }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "edge"; x: number; y: number; id: string }
  /** The top bar's Image button: upload one, or a blank page to draw on;
   *  with `replace`, the same choice for an image block's Replace image. */
  | { kind: "image"; x: number; y: number; replace?: string };

/** A new page for a drawing: a colour (a blank page) or a photo. */
export type PageChoice = { kind: "color"; color: string } | { kind: "photo"; file: File };

interface CanvasUi {
  menu: MenuState | null;
  openMenu: (m: MenuState) => void;
  closeMenu: () => void;
  editingEdge: string | null;
  setEditingEdge: (id: string | null) => void;
  issues: { id: string; text: string } | null;
  showIssues: (id: string, text: string) => void;
  hideIssues: () => void;
  dialog: "help" | "settings" | null;
  setDialog: (d: "help" | "settings" | null) => void;
  /** The quick-jump palette (⌘K) is open. */
  palette: boolean;
  /** A block or group to briefly highlight after jumping to it. */
  flash: string | null;
  /** A block whose name is being edited inline. */
  renaming: string | null;
  /** "Compare with now" for a block at a past revision. */
  diff: { name: string; rev: string } | null;
  /** The History list the preview steps through with ←/→. */
  historyList: import("../../shared/protocol").HistoryEntry[];
  /** Last pointer position over the canvas, in flow coordinates. */
  pointer: { x: number; y: number } | null;
  /** The image block being drawn on (its edit mode). */
  drawing: string | null;
  /** A new page for the drawing that is open or about to open (Replace image):
   *  `ask` whether to keep what is drawn, or `keep` it, or start `fresh`. */
  drawingPage: { name: string; choice: PageChoice; mode: "ask" | "keep" | "fresh" } | null;
  /** The block or frame whose comments pane is open (anchored to its 💬 button). */
  commentsFor: string | null;
  /** Bring a node's comments into view in the side panel ("" = the whole canvas). */
  commentsFocus: string | null;
  /** Images on their way up: a placeholder shows where each will land. */
  uploads: Record<string, { x: number; y: number; width: number; height: number; progress: number }>;
  /** A question before something that loses work; `alt` is a second way to go on (e.g. "Start fresh"). */
  confirm: { title: string; body: string; action: string; danger?: boolean; run: () => void; alt?: { action: string; danger?: boolean; run: () => void } } | null;
  askConfirm: (c: NonNullable<CanvasUi["confirm"]>) => void;
  closeConfirm: () => void;
}

export const useCanvasUi = create<CanvasUi>((set) => ({
  menu: null,
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  editingEdge: null,
  setEditingEdge: (editingEdge) => set({ editingEdge }),
  issues: null,
  showIssues: (id, text) => set({ issues: { id, text } }),
  hideIssues: () => set({ issues: null }),
  dialog: null,
  setDialog: (dialog) => set({ dialog }),
  palette: false,
  flash: null,
  renaming: null,
  diff: null,
  historyList: [],
  pointer: null,
  drawing: null,
  drawingPage: null,
  commentsFor: null,
  commentsFocus: null,
  uploads: {},
  confirm: null,
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
}));
