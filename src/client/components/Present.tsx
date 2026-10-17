// Present mode: step through the canvas's presentation slides (its own list,
// apart from the views used for getting around). The chrome (top bar, panels,
// chat) slides away; ←/→ move, Esc ends and returns the camera to where it was.
// A slide about a block or group shows it wherever it is now.
import { useEffect } from "react";
import { create } from "zustand";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { setSidePanelOpen, useBoard } from "../lib/store";
import { useSettings } from "../lib/settings";
import { toast } from "../lib/toasts";
import { flow } from "../canvas/actions";
import { cameraBack, pushCamera } from "../canvas/camera";

const NO_VIEWS: never[] = [];

export const usePresent = create<{ active: boolean; index: number }>(() => ({ active: false, index: 0 }));

function slides() {
  return useBoard.getState().canvas.slides ?? [];
}

function show(index: number): void {
  const list = slides();
  const v = list[index];
  const rf = flow();
  if (!v || !rf) return;
  usePresent.setState({ index });
  const node = v.target ? useBoard.getState().canvas.nodes.find((n) => n.id === v.target) : undefined;
  const pad = 40;
  const rect = node ? { x: node.x - pad, y: node.y - pad, width: node.width + pad * 2, height: node.height + pad * 2 } : v;
  void rf.fitBounds(rect, { padding: 0.03, duration: 650 });
}

export function startPresenting(from = 0): void {
  if (!slides().length) {
    const s = useSettings.getState();
    s.set("sidePanel", "slides");
    setSidePanelOpen(true);
    toast.info("Add slides to the presentation first — the Presentation tab is open.");
    return;
  }
  pushCamera();
  usePresent.setState({ active: true, index: from });
  document.documentElement.classList.add("presenting");
  document.documentElement.requestFullscreen?.().catch(() => {});
  setTimeout(() => show(from), 60);
}

export function stopPresenting(): void {
  if (!usePresent.getState().active) return;
  usePresent.setState({ active: false });
  document.documentElement.classList.remove("presenting");
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  cameraBack();
}

export function PresentBar() {
  const { active, index } = usePresent();
  const list = useBoard((s) => s.canvas.slides ?? NO_VIEWS);

  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        if (index < list.length - 1) show(index + 1);
      } else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        if (index > 0) show(index - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopPresenting();
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= list.length) {
        e.preventDefault();
        e.stopPropagation();
        show(Number(e.key) - 1);
      }
    };
    // Leaving full screen with the browser's own Esc ends the presentation too.
    const fs = () => {
      if (!document.fullscreenElement && usePresent.getState().active) stopPresenting();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("fullscreenchange", fs);
    };
  }, [active, index, list.length]);

  if (!active) return null;
  const v = list[index];
  return (
    <div className="present-bar" role="toolbar" aria-label="Presentation">
      <button className="icon-btn" aria-label="Previous slide" disabled={index === 0} onClick={() => show(index - 1)}>
        <ChevronLeft size={18} />
      </button>
      <div className="present-title">
        <span className="present-count">
          {index + 1} / {list.length}
        </span>
        <span>{v?.name ?? ""}</span>
      </div>
      <button className="icon-btn" aria-label="Next slide" disabled={index >= list.length - 1} onClick={() => show(index + 1)}>
        <ChevronRight size={18} />
      </button>
      <span className="present-sep" />
      <button className="icon-btn" aria-label="End presentation" data-tip="End (Esc)" data-tip-pos="top" onClick={stopPresenting}>
        <X size={16} />
      </button>
    </div>
  );
}
