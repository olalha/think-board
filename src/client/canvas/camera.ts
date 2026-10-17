// Camera history: every deliberate jump (search, a view, zoom-to-block, fit)
// remembers where you were, so Alt+←/→ — or the mouse's back/forward
// buttons — take you back and forth like a browser.
import { create } from "zustand";
import type { Viewport } from "@xyflow/react";
import { flow } from "./actions";

const LIMIT = 60;
const back: Viewport[] = [];
const forward: Viewport[] = [];

export const useCamera = create<{ canBack: boolean; canForward: boolean }>(() => ({ canBack: false, canForward: false }));

function sync(): void {
  useCamera.setState({ canBack: back.length > 0, canForward: forward.length > 0 });
}

function same(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.zoom - b.zoom) < 0.001;
}

/** Call right before a programmatic jump. */
export function pushCamera(): void {
  const rf = flow();
  if (!rf) return;
  const vp = rf.getViewport();
  const last = back[back.length - 1];
  if (last && same(last, vp)) return;
  back.push(vp);
  if (back.length > LIMIT) back.shift();
  forward.length = 0;
  sync();
}

export function cameraBack(): void {
  const rf = flow();
  const vp = back.pop();
  if (!rf || !vp) return sync();
  forward.push(rf.getViewport());
  void rf.setViewport(vp, { duration: 380 });
  sync();
}

export function cameraForward(): void {
  const rf = flow();
  const vp = forward.pop();
  if (!rf || !vp) return sync();
  back.push(rf.getViewport());
  void rf.setViewport(vp, { duration: 380 });
  sync();
}

export function resetCamera(): void {
  back.length = 0;
  forward.length = 0;
  sync();
}
