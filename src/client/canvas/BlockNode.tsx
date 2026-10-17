// One block on the canvas: a card with a header (type, name, state, mode
// toggle, menu) and a body that is either the raw editor or the renderer.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useStore, type NodeProps, type ReactFlowState } from "@xyflow/react";
import { AlertCircle, Check, Code2, Eye, FileText, Globe, Image as ImageIcon, Lock, MoreHorizontal, Pencil, PenLine, Shield, Undo2, Workflow, WrapText } from "lucide-react";
import { BLOCK_SIZES, displayName, isValidName, toBlockName, type BlockType } from "../../shared/blocks";
import type { BlockInfo } from "../../shared/protocol";
import { fileUrl } from "../lib/api";
import { act, layout } from "../lib/project";
import { modeOf, setMode, setWrap, useBoard } from "../lib/store";
import { PHONE, TOUCH, useMedia } from "../lib/device";
import { effectiveTheme, useSettings } from "../lib/settings";
// CodeMirror is sizeable: loaded on first edit (and preloaded when idle, see Board).
const CodeEditor = lazy(() => import("../blocks/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const DrawingSession = lazy(() => import("../drawing/DrawingEditor"));
import { HtmlView, ImageView, MarkdownView, MermaidView } from "../blocks/renderers";
import { useCanvasUi } from "./ui-state";
import { renameBlock, startDrawing, stopDrawing, zoomToBlock } from "./actions";
import { CommentButton } from "../components/Comments";

export const TYPE_META: Record<BlockType, { label: string; icon: typeof FileText }> = {
  markdown: { label: "Markdown", icon: FileText },
  mermaid: { label: "Mermaid diagram", icon: Workflow },
  html: { label: "HTML", icon: Globe },
  image: { label: "Image", icon: ImageIcon },
};

const SIDE_POS = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left } as const;

function useTheme(): "light" | "dark" {
  const theme = useSettings((s) => s.theme);
  const [sys, setSys] = useState(() => effectiveTheme(theme));
  useEffect(() => {
    setSys(effectiveTheme(theme));
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSys(effectiveTheme("system"));
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  return sys;
}

export { useTheme };

/** The block as the History preview shows it (a ghost if that moment removed it). */
function ttBlock(tt: NonNullable<ReturnType<typeof useBoard.getState>["timeTravel"]>, id: string): BlockInfo | undefined {
  return tt.snap.blocks.find((b) => b.name === id) ?? tt.snap.ghosts.find((g) => g.node.id === id)?.block ?? undefined;
}

export const BlockNode = memo(function BlockNode({ id, selected, width, height }: NodeProps) {
  const tt = useBoard((s) => s.timeTravel);
  const block = useBoard((s) => (s.timeTravel ? ttBlock(s.timeTravel, id) : s.blocks[id]));
  const liveMode = useBoard((s) => (block ? s.modes[id] ?? "rendered" : "rendered"));
  const mode = tt ? "rendered" : liveMode;
  const liveLocked = useBoard((s) => s.lock.locked);
  const phone = useMedia(PHONE);
  const touch = useMedia(TOUCH);
  const agentTurn = useBoard((s) => s.lock.locked && s.lock.reason === "agent");
  const slug = useBoard((s) => s.slug);
  const saveState = useBoard((s) => s.saveState[id]);
  const issueText = useBoard((s) =>
    (s.validation?.issues ?? [])
      .filter((i) => i.block === id)
      .map((i) => i.message)
      .join("\n\n"),
  );
  const lastValid = useBoard((s) => s.mermaidLastValid[id]);
  const focusRequest = useBoard((s) => s.focusRequest === id);
  const isProtected = useBoard((s) => s.canvas.nodes.some((n) => n.id === id && n.type === "file" && !!n.protected));
  // History preview and agent turns are read-only — except protected blocks,
  // which stay the user's to write in while the agent works.
  const locked = liveLocked || !!tt;
  const canEdit = !tt && (!liveLocked || (isProtected && agentTurn));
  const ttClass = tt
    ? tt.snap.ghosts.some((g) => g.node.id === id)
      ? "tt-ghost"
      : tt.entry.summary.added.includes(id)
        ? "tt-added"
        : tt.entry.summary.edited.includes(id) || tt.entry.summary.renamed.some(([, to]) => to === id)
          ? "tt-edited"
          : "tt-same"
    : "";
  // Ringed while an agent changes it or points at it (think show); an outside agent's ring carries its name.
  const ring = useBoard((s) => s.highlights[id]);
  const openMenu = useCanvasUi((s) => s.openMenu);
  const renaming = useCanvasUi((s) => s.renaming === id);
  const flash = useCanvasUi((s) => s.flash === id);
  const theme = useTheme();

  const type: BlockType = block?.type ?? "markdown";
  const Icon = TYPE_META[type].icon;
  const drawing = useCanvasUi((s) => s.drawing === id) && type === "image" && !tt;
  const effectiveMode = type === "image" ? (drawing ? "raw" : "rendered") : mode;
  const sizes = BLOCK_SIZES[type];

  // Long lines wrap unless this block says otherwise; Mermaid starts unwrapped.
  const wrapSet = useBoard((s) => s.wraps[id]);
  const wrap = wrapSet ?? type !== "mermaid";
  const toggleWrap = useCallback(() => setWrap(id, !wrap), [id, wrap]);
  const toggleMode = useCallback(() => {
    if (!block) return;
    if (block.type === "image") return useCanvasUi.getState().drawing === id ? stopDrawing() : startDrawing(id);
    const next = modeOf(id, block.type) === "raw" ? "rendered" : "raw";
    setMode(id, next);
    if (next === "raw") useBoard.setState({ focusRequest: id });
  }, [block, id]);

  const resolveFile = useCallback(
    (file: string) => {
      const b = useBoard.getState().blocks[file.replace(/\.[^.]+$/, "")];
      return slug && b && b.file === file ? fileUrl(slug, file, b.hash) : null;
    },
    [slug],
  );

  const revertButton = useMemo(
    () =>
      lastValid !== undefined && lastValid !== block?.content && !locked ? (
        <button
          className="btn small"
          onClick={(e) => {
            e.stopPropagation();
            void act({ type: "block.revert", name: id });
          }}
        >
          <Undo2 size={13} /> Revert to last valid version
        </button>
      ) : null,
    [lastValid, block?.content, locked, id],
  );

  let body: React.ReactNode;
  if (!block) {
    body = <div className="block-missing">This block's file is missing.</div>;
  } else if (drawing) {
    body = (
      <div className="block-drawing">
        <Suspense fallback={<div className="editor-loading"><span className="spinner" /></div>}>
          <DrawingSession name={id} onDone={stopDrawing} />
        </Suspense>
      </div>
    );
  } else if (effectiveMode === "raw") {
    body = (
      <div className="block-raw">
        <Suspense fallback={<div className="editor-loading"><span className="spinner" /></div>}>
          <CodeEditor
            key={`${id}:${block.type}`}
            name={id}
            type={block.type}
            content={block.content ?? ""}
            readOnly={!canEdit}
            autoFocus={focusRequest}
            onEscape={() => setMode(id, "rendered")}
            scrollable={!!selected}
            wrap={wrap}
            onToggleWrap={toggleWrap}
          />
        </Suspense>
        {!canEdit && liveLocked && (
          <div className="lock-overlay">
            <Lock size={12} /> Agent working…
          </div>
        )}
      </div>
    );
  } else {
    switch (block.type) {
      case "markdown":
        body = (
          <div className={`block-scroll ${selected ? `nowheel ${touch ? "nopan" : ""}` : ""}`}>
            <MarkdownView source={block.content ?? ""} resolveFile={resolveFile} />
          </div>
        );
        break;
      case "mermaid":
        body = <MermaidView source={block.content ?? ""} theme={theme} errorActions={revertButton} />;
        break;
      case "html":
        body = <HtmlBody name={id} source={block.content ?? ""} selected={!!selected} width={width} height={height} />;
        break;
      case "image":
        body = slug ? <ImageView src={tt ? `${fileUrl(slug, block.file)}?rev=${block.hash}` : fileUrl(slug, block.file, block.hash)} alt={displayName(id)} /> : null;
        break;
    }
  }

  return (
    <div
      className={`block type-${type} ${selected ? "selected" : ""} ${locked ? "locked" : ""} mode-${effectiveMode} ${ttClass} ${canEdit && liveLocked ? "editable-in-turn" : ""} ${flash ? "flash" : ""} ${isProtected ? "protected" : ""} ${ring ? `agent-here${ring.by ? " by-guest" : ""}` : ""}`}
      onDoubleClick={(e) => {
        if (effectiveMode === "rendered" && canEdit && !(type === "image" && liveLocked)) {
          e.stopPropagation();
          toggleMode();
        }
      }}
    >
      {ring?.by && (
        <span key={ring.at} className="agent-tag" aria-hidden>
          {ring.by}
        </span>
      )}
      <NodeResizer
        isVisible={!!selected && !locked && !phone}
        minWidth={sizes.minWidth}
        minHeight={sizes.minHeight}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_e, p) => layout([{ op: "node.resize", id, x: p.x, y: p.y, width: p.width, height: p.height }])}
      />
      {(Object.keys(SIDE_POS) as (keyof typeof SIDE_POS)[]).map((side) => (
        <Handle key={side} id={side} type="source" position={SIDE_POS[side]} className="block-handle" isConnectable={!locked && !phone} />
      ))}
      <header
        className="block-header"
        onDoubleClick={(e) => {
          // The title bar: fly to the block (from far out, where its editor is too small to use).
          if ((e.target as HTMLElement).closest("button, input")) return;
          e.stopPropagation();
          zoomToBlock(id, { select: true });
        }}
      >
        <span className="block-type" data-tip={TYPE_META[type].label}>
          <Icon size={14} strokeWidth={2.2} />
        </span>
        {renaming ? (
          <NameEditor name={id} />
        ) : (
          <>
            <span className="block-name" title={`${block?.file ?? id} — double-click to zoom in, F2 to rename`}>
              {displayName(id)}
            </span>
            {!locked && (
              <button
                className="icon-btn tiny nodrag rename-btn"
                aria-label="Rename"
                data-tip="Rename (F2)"
                onClick={(e) => {
                  e.stopPropagation();
                  useCanvasUi.setState({ renaming: id });
                }}
              >
                <Pencil size={11} />
              </button>
            )}
          </>
        )}
        {isProtected && (
          <span className="block-protected" data-tip="Protected: the agent can read this block but not change it">
            <Shield size={12} />
          </span>
        )}
        {saveState && (
          <span className={`save-dot ${saveState}`} data-tip={saveState === "error" ? "Not saved" : "Saving…"} />
        )}
        {issueText && (
          <span className="block-issue" data-tip="Validation error — see details">
            <AlertCircle
              size={14}
              onClick={(e) => {
                e.stopPropagation();
                useCanvasUi.getState().showIssues(id, issueText);
              }}
            />
          </span>
        )}
        <span className="block-spacer" />
        {type !== "image" && !tt && effectiveMode === "raw" && (
          <button
            className={`icon-btn small nodrag ${wrap ? "active" : ""}`}
            data-tip={wrap ? "Long lines wrap (Alt+Z)" : "Long lines scroll sideways (Alt+Z)"}
            aria-label="Wrap long lines"
            aria-pressed={wrap}
            onClick={(e) => {
              e.stopPropagation();
              toggleWrap();
            }}
          >
            <WrapText size={14} />
          </button>
        )}
        {type === "image" && !tt && (
          <button
            className={`icon-btn small nodrag ${drawing ? "active" : ""}`}
            data-tip={drawing ? "Done drawing (Esc)" : "Draw on it (Enter)"}
            aria-label={drawing ? "Done drawing" : "Draw on it"}
            disabled={liveLocked && !drawing}
            onClick={(e) => {
              e.stopPropagation();
              toggleMode();
            }}
          >
            {drawing ? <Check size={14} /> : <PenLine size={14} />}
          </button>
        )}
        {type !== "image" && !tt && (
          <button
            className="icon-btn small nodrag"
            data-tip={effectiveMode === "raw" ? "Show rendered (Esc)" : "Edit raw (Enter)"}
            aria-label={effectiveMode === "raw" ? "Show rendered" : "Edit raw"}
            onClick={(e) => {
              e.stopPropagation();
              toggleMode();
            }}
          >
            {effectiveMode === "raw" ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
        )}
        {!tt && <CommentButton id={id} />}
        <button
          className="icon-btn small nodrag"
          aria-label="Block menu"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu({ kind: "node", id, x: r.left, y: r.bottom + 4 });
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </header>
      <div className="block-body">{body}</div>
    </div>
  );
});

// ---------------------------------------------------------------- rename

/** Inline name editor in the block header. Enter renames, Esc cancels. */
function NameEditor({ name }: { name: string }) {
  const [value, setValue] = useState(displayName(name));
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const target = toBlockName(value);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const close = () => useCanvasUi.setState({ renaming: null });
  const commit = async () => {
    if (done.current) return;
    if (!target || target === name) {
      done.current = true;
      return close();
    }
    if (!isValidName(target)) return setError("Use letters, digits and spaces");
    if (useBoard.getState().blocks[target]) return setError(`“${displayName(target)}” exists`);
    done.current = true;
    const ok = await renameBlock(name, target);
    close();
    if (ok) useBoard.setState({ focusRequest: null });
  };
  return (
    <span className="name-editor nodrag">
      <input
        ref={ref}
        className={`name-input ${error ? "invalid" : ""}`}
        value={value}
        maxLength={60}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            done.current = true;
            close();
          }
        }}
        onBlur={() => {
          if (!done.current && !error) void commit();
          else if (!done.current) close();
        }}
      />
      <span className={`name-hint ${error ? "danger-text" : ""}`}>{error ?? (target && target !== name ? `${target}.${useBoard.getState().blocks[name]?.file.split(".").pop() ?? ""}` : "")}</span>
    </span>
  );
}

// ---------------------------------------------------------------- html body

const zoomSelector = (s: ReactFlowState) => s.transform[2];

/**
 * A live iframe is expensive, so HTML blocks only mount one when the block is
 * on screen and the canvas is zoomed in enough to read it. Otherwise: a
 * lightweight placeholder. The iframe only takes pointer events once the block
 * is selected, so it never swallows canvas drags or zooms.
 */
function HtmlBody({ name, source, selected, width, height }: { name: string; source: string; selected: boolean; width?: number; height?: number }) {
  const pref = useSettings((s) => s.htmlPreviews);
  const threshold = useBoard((s) => s.htmlLiveZoom);
  const node = useStore(useCallback((s: ReactFlowState) => s.nodeLookup.get(name), [name]));
  const visible = useStore(
    useCallback(
      (s: ReactFlowState) => {
        if (!node) return false;
        const [tx, ty, zoom] = s.transform;
        const { x, y } = node.internals.positionAbsolute;
        const w = (width ?? 0) * zoom;
        const h = (height ?? 0) * zoom;
        const sx = x * zoom + tx;
        const sy = y * zoom + ty;
        const margin = 200;
        return sx + w > -margin && sy + h > -margin && sx < s.width + margin && sy < s.height + margin;
      },
      [node, width, height],
    ),
  );
  const zoomOk = useStore(useCallback((s: ReactFlowState) => zoomSelector(s) >= threshold, [threshold]));
  const theme = useTheme();
  const live = pref === "always" ? visible : pref === "never" ? false : visible && zoomOk;
  if (!live) {
    return (
      <div className="html-placeholder">
        <Globe size={22} />
        <span>{pref === "never" ? "HTML preview (live previews are off)" : "Zoom in to preview"}</span>
      </div>
    );
  }
  return (
    <div className={`html-wrap ${selected ? "interactive nowheel" : ""}`}>
      <HtmlView source={source} title={displayName(name)} theme={theme} />
      {!selected && <div className="html-shield" title="Select the block to interact with it" />}
    </div>
  );
}
