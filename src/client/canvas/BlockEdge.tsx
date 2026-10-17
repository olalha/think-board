// An edge: a bezier between two block sides, optional arrowheads, and a label
// at the midpoint. With no label, a small dot sits at the midpoint — click it
// (or the label) to add/edit the label inline.
import { memo, useEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { layout } from "../lib/project";
import { useBoard } from "../lib/store";
import { useCanvasUi } from "./ui-state";

export interface BlockEdgeData extends Record<string, unknown> {
  label?: string;
  style?: "solid" | "dashed" | "dotted";
}

const DASH = { solid: undefined, dashed: "8 6", dotted: "1.5 5" } as const;

export const BlockEdge = memo(function BlockEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, selected, data } = props;
  const label = (data as BlockEdgeData | undefined)?.label ?? "";
  const lineStyle = (data as BlockEdgeData | undefined)?.style ?? "solid";
  const locked = useBoard((s) => s.lock.locked);
  const editing = useCanvasUi((s) => s.editingEdge === id);
  const setEditing = useCanvasUi((s) => s.setEditingEdge);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.3 });
  // A label may be as wide as most of the gap it sits in; it wraps (to two
  // lines at most) only when it does not fit on one.
  const labelMax = Math.round(Math.min(520, Math.max(140, Math.hypot(targetX - sourceX, targetY - sourceY) * 0.75)));

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={22}
        className={`${selected ? "edge-selected" : ""} line-${lineStyle}`}
        style={lineStyle === "solid" ? undefined : { strokeDasharray: DASH[lineStyle], strokeLinecap: "round" }}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-label-anchor nodrag nopan ${selected ? "selected" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onContextMenu={(e) => {
            // The label lives outside the edge's SVG; give it the edge's menu.
            e.preventDefault();
            e.stopPropagation();
            useCanvasUi.getState().openMenu({ kind: "edge", x: e.clientX, y: e.clientY, id });
          }}
        >
          {editing ? (
            <LabelInput
              initial={label}
              onDone={(value) => {
                setEditing(null);
                if (value !== null && value !== label) layout([{ op: "edge.update", id, patch: { label: value } }]);
              }}
            />
          ) : label ? (
            <button
              className="edge-label"
              style={{ maxWidth: labelMax }}
              onClick={(e) => {
                e.stopPropagation();
                if (!locked) setEditing(id);
              }}
              title={locked ? label : "Click to edit the label"}
            >
              {label}
            </button>
          ) : (
            <button
              className="edge-dot"
              aria-label="Add a label"
              title={locked ? undefined : "Add a label"}
              onClick={(e) => {
                e.stopPropagation();
                if (!locked) setEditing(id);
              }}
            />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

function LabelInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v === null ? null : v.trim());
  };
  return (
    <input
      ref={ref}
      className="edge-label-input"
      value={value}
      placeholder="Label"
      maxLength={200}
      size={Math.max(6, Math.min(40, value.length + 1))}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}
