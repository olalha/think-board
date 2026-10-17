// Bottom-left canvas controls: zoom out / level / in, fit, minimap toggle.
import { useReactFlow, useStore } from "@xyflow/react";
import { ArrowLeft, ArrowRight, Map as MapIcon, Maximize, Minus, Plus } from "lucide-react";
import { useSettings } from "../lib/settings";
import { fitAll } from "./actions";
import { cameraBack, cameraForward, useCamera } from "./camera";

export function ZoomBar() {
  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const minimap = useSettings((s) => s.minimap);
  const set = useSettings((s) => s.set);
  const { canBack, canForward } = useCamera();
  return (
    <div className="zoombar" onDoubleClick={(e) => e.stopPropagation()}>
      <button className="icon-btn small" aria-label="Back" disabled={!canBack} data-tip="Back to where you were (Alt+←)" data-tip-pos="top" onClick={cameraBack}>
        <ArrowLeft size={14} />
      </button>
      <button className="icon-btn small" aria-label="Forward" disabled={!canForward} data-tip="Forward (Alt+→)" data-tip-pos="top" onClick={cameraForward}>
        <ArrowRight size={14} />
      </button>
      <span className="zoombar-sep" />
      <button className="icon-btn small" aria-label="Zoom out" data-tip="Zoom out (−)" data-tip-pos="top" onClick={() => void rf.zoomOut({ duration: 200 })}>
        <Minus size={14} />
      </button>
      <button className="zoom-level" data-tip="Reset to 100% (0)" data-tip-pos="top" onClick={() => void rf.zoomTo(1, { duration: 250 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn small" aria-label="Zoom in" data-tip="Zoom in (+)" data-tip-pos="top" onClick={() => void rf.zoomIn({ duration: 200 })}>
        <Plus size={14} />
      </button>
      <span className="zoombar-sep" />
      <button className="icon-btn small" aria-label="Fit to view" data-tip="Fit everything (F)" data-tip-pos="top" onClick={fitAll}>
        <Maximize size={14} />
      </button>
      <button
        className={`icon-btn small ${minimap ? "active" : ""}`}
        aria-label="Toggle minimap"
        data-tip={minimap ? "Hide minimap" : "Show minimap"}
        data-tip-pos="top"
        onClick={() => set("minimap", !minimap)}
      >
        <MapIcon size={14} />
      </button>
    </div>
  );
}
