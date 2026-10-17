// A group: a labelled frame behind the blocks it holds. Dragging it carries
// its blocks along (see BoardCanvas); JSON Canvas calls these "group" nodes.
import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useStore, type NodeProps, type ReactFlowState } from "@xyflow/react";
import { Frame } from "lucide-react";
import { layout } from "../lib/project";
import { useBoard } from "../lib/store";
import { PHONE, useMedia } from "../lib/device";
import { useCanvasUi } from "./ui-state";
import { zoomToBlock } from "./actions";
import { CommentButton } from "../components/Comments";

const zoomOf = (s: ReactFlowState) => s.transform[2];

const SIDE_POS = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left } as const;

/** JSON Canvas preset colours ("1"–"6") map to theme tokens; anything else is used as-is. */
export function canvasColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return /^[1-6]$/.test(color) ? `var(--preset-${color})` : color;
}

export const GroupFrame = memo(function GroupFrame({ id, selected }: NodeProps) {
  const node = useBoard((s) => (s.timeTravel?.snap.canvas ?? s.canvas).nodes.find((n) => n.id === id));
  const locked = useBoard((s) => s.lock.locked);
  const phone = useMedia(PHONE);
  const renaming = useCanvasUi((s) => s.renaming === id);
  const flash = useCanvasUi((s) => s.flash === id);
  const ring = useBoard((s) => s.highlights[id]);
  const label = node?.type === "group" ? node.label ?? "" : "";
  const color = canvasColor(node?.color);
  // The name sits above the frame and keeps a readable size when zoomed out
  // (like frame names in design tools), so groups double as signposts.
  const zoom = useStore(zoomOf);
  const labelScale = Math.min(5, Math.max(1, 0.85 / zoom));
  return (
    <div
      className={`group-frame ${selected ? "selected" : ""} ${flash ? "flash" : ""} ${locked ? "locked" : ""} ${ring ? `agent-here${ring.by ? " by-guest" : ""}` : ""}`}
      style={color ? ({ "--group-color": color } as React.CSSProperties) : undefined}
    >
      <NodeResizer
        isVisible={!!selected && !locked && !phone}
        minWidth={160}
        minHeight={100}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, p) => layout([{ op: "node.resize", id, x: p.x, y: p.y, width: p.width, height: p.height }])}
      />
      {(Object.keys(SIDE_POS) as (keyof typeof SIDE_POS)[]).map((side) => (
        <Handle key={side} id={side} type="source" position={SIDE_POS[side]} className="block-handle" isConnectable={!locked && !phone} />
      ))}
      <div
        className="group-label"
        style={{ transform: `scale(${labelScale})`, maxWidth: Math.max(120, ((node?.width ?? 400) - 12) / labelScale) }}
        onDoubleClick={(e) => {
          if (renaming) return;
          e.stopPropagation();
          zoomToBlock(id, { select: true });
        }}
      >
        <Frame size={13} />
        {renaming ? (
          <LabelEditor
            initial={label}
            onDone={(v) => {
              useCanvasUi.setState({ renaming: null });
              if (v !== null && v !== label) layout([{ op: "group.update", id, patch: { label: v } }]);
            }}
          />
        ) : (
          <span className={`group-label-text ${label ? "" : "muted"}`}>{label || "Untitled group"}</span>
        )}
        {!renaming && <CommentButton id={id} className="group-comment" />}
      </div>
    </div>
  );
});

function LabelEditor({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
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
      className="group-label-input nodrag"
      value={value}
      placeholder="Name this group"
      maxLength={120}
      size={Math.max(12, Math.min(48, value.length + 2))}
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
