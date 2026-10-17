// Comments: notes on blocks, frames and the canvas as a whole (comments.json).
// A 💬 button on each block and frame opens a small pane beside it (it closes
// when the canvas moves, like a menu); the side panel's Comments tab lists them
// all, with tidy-up actions. The agent reads them, ticks them done with a note,
// and writes its own only when asked.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, CheckCheck, MessageSquare, MessageSquarePlus, PanelLeftOpen, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { displayName } from "../../shared/blocks";
import type { Comment } from "../../shared/protocol";
import { act } from "../lib/project";
import { useSettings } from "../lib/settings";
import { setChatOpen, setSidePanelOpen, useBoard } from "../lib/store";
import { toast } from "../lib/toasts";
import { useCanvasUi } from "../canvas/ui-state";
import { jumped, zoomToBlock } from "../canvas/actions";

const NO_COMMENTS: Comment[] = [];

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

const who = (by: string) => (by === "you" ? "You" : by === "agent" ? "Agent" : by);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Tea flowchart", the frame's label, or "The whole canvas". */
export function targetName(on: string | null): string {
  if (on === null) return "The whole canvas";
  const n = useBoard.getState().canvas.nodes.find((x) => x.id === on);
  if (n?.type === "group") return n.label?.trim() || "Untitled group";
  return displayName(on);
}

/** Open the chat with a request to address open comments (on one node, or all). */
export function askToAddress(on: string | null | "all"): void {
  setChatOpen(true);
  useBoard.setState({
    composerPrefill:
      on === "all" ? "Please address the open comments on this canvas." : on === null ? "Please address the open comments on the whole canvas." : `Please address the open comments on @${on}.`,
  });
}

/** Show a node's comments in the side panel's Comments tab (closing the pane). */
export function showInPanel(on: string | null): void {
  useCanvasUi.setState({ commentsFor: null, commentsFocus: on ?? "" });
  useSettings.getState().set("sidePanel", "comments");
  setSidePanelOpen(true);
}

/** Clear the done comments in `list`, saying how many went. */
function clearDone(list: Comment[]): void {
  const ids = list.filter((c) => c.done).map((c) => c.id);
  if (!ids.length) return;
  void act({ type: "comment.delete", ids }).then((r) => {
    if (r !== null) toast.status("comments", `Cleared ${plural(ids.length, "done comment")}`);
  });
}

/** Delete every comment in `list`, after asking. */
function deleteAll(list: Comment[], where: string): void {
  if (!list.length) return;
  const open = list.filter((c) => !c.done).length;
  useCanvasUi.getState().askConfirm({
    title: `Delete ${list.length === 1 ? "the comment" : `all ${list.length} comments`} ${where}?`,
    body: `${open ? `${open === list.length ? (open === 1 ? "It is still open. " : "They are all still open. ") : `${open} of them ${open === 1 ? "is" : "are"} still open. `}` : ""}History keeps a copy.`,
    action: "Delete",
    danger: true,
    run: () => void act({ type: "comment.delete", ids: list.map((c) => c.id) }),
  });
}

/** A textarea that grows with its text (up to its CSS max-height, then scrolls). */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    const border = el.offsetHeight - el.clientHeight;
    const h = el.scrollHeight + border;
    el.style.height = `${Math.min(h, max)}px`;
    el.style.overflowY = h > max ? "auto" : "hidden";
  }, [ref, value]);
}

/** The comments on one node (or the canvas), with a box to add one — the 💬 pane. */
export function CommentThread({ on, autoFocus }: { on: string | null; autoFocus?: boolean }) {
  const all = useBoard((s) => s.comments ?? NO_COMMENTS);
  const list = useMemo(() => all.filter((c) => c.on === on), [all, on]);
  const open = list.filter((c) => !c.done).length;
  return (
    <div className="comment-thread">
      {list.length === 0 && <p className="comment-empty">No comments yet — note what should change, a question, an idea.</p>}
      {list.map((c) => (
        <CommentItem key={c.id} c={c} />
      ))}
      <CommentComposer on={on} autoFocus={autoFocus} />
      {open > 0 && (
        <button className="comment-ask" onClick={() => askToAddress(on)}>
          <Bot size={14} /> Ask the agent to address {open === 1 ? "this" : `these ${open}`}
        </button>
      )}
    </div>
  );
}

function CommentItem({ c }: { c: Comment }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={`comment ${c.done ? "done" : ""}`}>
      <div className="comment-head">
        <span className={`comment-by ${c.by === "you" ? "" : "other"}`}>{who(c.by)}</span>
        <span className="comment-time" title={new Date(c.at).toLocaleString()}>
          {ago(c.at)}
          {c.edited ? " · edited" : ""}
        </span>
        <span className="grow" />
        <span className="comment-tools">
          <button className="icon-btn tiny" aria-label={c.done ? "Reopen" : "Mark done"} data-tip={c.done ? "Reopen" : "Done"} onClick={() => void act({ type: "comment.done", id: c.id, done: !c.done })}>
            {c.done ? <RotateCcw size={12} /> : <Check size={13} />}
          </button>
          {!editing && (
            <button className="icon-btn tiny" aria-label="Edit" data-tip="Edit" onClick={() => setEditing(true)}>
              <Pencil size={11} />
            </button>
          )}
          <button className="icon-btn tiny" aria-label="Delete" data-tip="Delete" onClick={() => void act({ type: "comment.delete", ids: [c.id] })}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {editing ? (
        <CommentEditor
          initial={c.text}
          onDone={(text) => {
            setEditing(false);
            if (text !== null && text !== c.text) void act({ type: "comment.update", id: c.id, text });
          }}
        />
      ) : (
        <p className="comment-text">{c.text}</p>
      )}
      {c.done && (
        <div className="comment-done">
          <CheckCheck size={13} />
          <span>
            Done{c.done.by !== "you" ? ` by ${who(c.done.by).toLowerCase() === "agent" ? "the agent" : who(c.done.by)}` : ""}
            {c.done.note ? `: ${c.done.note}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function CommentEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(initial.length, initial.length);
  }, [initial]);
  return (
    <div className="comment-edit">
      <textarea
        ref={ref}
        className="comment-input"
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onDone(text.trim() || null);
          }
          if (e.key === "Escape") onDone(null);
        }}
        onBlur={() => onDone(text.trim() || null)}
      />
      <p className="comment-hint">Enter to save · Shift+Enter for a new line · Esc to cancel</p>
    </div>
  );
}

function CommentComposer({ on, autoFocus, onIdle }: { on: string | null; autoFocus?: boolean; onIdle?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus(), 40);
  }, [autoFocus]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await act({ type: "comment.add", on, text: t });
    setBusy(false);
    if (r !== null) setText("");
  };
  // The Add row shows while the box is in use; an idle box is a single line.
  const active = focused || !!text;
  return (
    <div className={`comment-composer ${active ? "active" : ""}`}>
      <textarea
        ref={ref}
        className="comment-input"
        placeholder={on === null ? "Comment on the whole canvas…" : "Add a comment…"}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (!text.trim()) onIdle?.();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") {
            if (text) setText("");
            else if (onIdle) onIdle();
            else if (useCanvasUi.getState().commentsFor !== null) useCanvasUi.setState({ commentsFor: null });
            else ref.current?.blur();
          }
        }}
      />
      {active && (
        <div className="comment-composer-foot">
          <span className="comment-hint">Enter to add · Shift+Enter for a new line</span>
          <button
            className="btn small primary"
            disabled={!text.trim() || busy}
            // Keep the focus in the box: a click here must not blur it first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send()}
            aria-label="Add comment"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

/** The 💬 button on a block's title bar or a frame's label; shows the open count. */
export function CommentButton({ id, className = "" }: { id: string; className?: string }) {
  const count = useBoard((s) => s.comments?.filter((c) => c.on === id && !c.done).length ?? 0);
  const open = useCanvasUi((s) => s.commentsFor === id);
  return (
    <button
      className={`icon-btn small nodrag comment-btn ${count ? "has" : ""} ${open ? "active" : ""} ${className}`}
      data-comments-anchor={id}
      aria-label={count ? `${count} open comment${count === 1 ? "" : "s"}` : "Comments"}
      data-tip={count ? `${count} open comment${count === 1 ? "" : "s"}` : "Comment"}
      onClick={(e) => {
        e.stopPropagation();
        useCanvasUi.setState({ commentsFor: open ? null : id });
      }}
    >
      <MessageSquare size={14} />
      {count > 0 && <span className="comment-count">{count}</span>}
    </button>
  );
}

/**
 * The pane for one node's comments, next to its 💬 button. It follows its
 * block while open (a resize, the agent's edits) and closes when the canvas
 * is panned or zoomed, or a block is dragged (BoardCanvas's onNodeDragStart).
 */
export function CommentsPopover() {
  const on = useCanvasUi((s) => s.commentsFor);
  const exists = useBoard((s) => !on || s.canvas.nodes.some((n) => n.id === on));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!on) return;
    let raf = 0;
    let camera: string | undefined;
    const tick = () => {
      // Like a menu, the pane goes away when the canvas is panned or zoomed.
      const t = (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform;
      if (camera === undefined) camera = t;
      else if (t !== camera) return void useCanvasUi.setState({ commentsFor: null });
      const a = document.querySelector(`[data-comments-anchor="${CSS.escape(on)}"]`);
      if (a) {
        const r = a.getBoundingClientRect();
        const w = ref.current?.offsetWidth ?? 360;
        const h = ref.current?.offsetHeight ?? 300;
        const x = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w + 8));
        const below = r.bottom + 8;
        const y = below + h > window.innerHeight - 12 ? Math.max(12, r.top - h - 8) : below;
        setPos((p) => (p && Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 ? p : { x, y }));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      setPos(null);
    };
  }, [on]);

  useEffect(() => {
    if (!on) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest(`[data-comments-anchor]`)) return;
      useCanvasUi.setState({ commentsFor: null });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest?.(".comment-pop")) useCanvasUi.setState({ commentsFor: null });
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [on]);

  useEffect(() => {
    if (on && !exists) useCanvasUi.setState({ commentsFor: null });
  }, [on, exists]);

  if (!on || !exists) return null;
  return createPortal(
    <div ref={ref} className="comment-pop" role="dialog" aria-label={`Comments on ${targetName(on)}`} style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}>
      <header className="comment-pop-head">
        <MessageSquare size={14} />
        <span>{targetName(on)}</span>
        <button className="icon-btn tiny" aria-label="Show in the side panel" data-tip="Show in the side panel" onClick={() => showInPanel(on)}>
          <PanelLeftOpen size={14} />
        </button>
        <button className="icon-btn tiny" aria-label="Close" data-tip="Close (Esc)" onClick={() => useCanvasUi.setState({ commentsFor: null })}>
          <X size={14} />
        </button>
      </header>
      <CommentThread on={on} autoFocus />
    </div>,
    document.body,
  );
}

/** The rail's count of open comments. */
export function CommentBadge() {
  const n = useBoard((s) => s.comments?.filter((c) => !c.done).length ?? 0);
  return n ? <span className="rail-badge">{n > 99 ? "99+" : n}</span> : null;
}

type Filter = "open" | "done" | "all";
const matchesFilter = (f: Filter) => (c: Comment) => (f === "all" ? true : f === "open" ? !c.done : !!c.done);

/** The side panel's Comments tab: every comment, grouped by where it is. */
export function CommentsPanel() {
  const all = useBoard((s) => s.comments ?? NO_COMMENTS);
  const nodes = useBoard((s) => s.canvas.nodes);
  const error = useBoard((s) => s.commentsError);
  const focus = useCanvasUi((s) => s.commentsFocus);
  const [filter, setFilter] = useState<Filter>("open");
  const [lit, setLit] = useState<string | null>(null);
  // A block whose group shows a box to add a comment (from "Show in the side panel").
  const [compose, setCompose] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shown = all.filter(matchesFilter(filter));
  const openCount = all.filter((c) => !c.done).length;
  const doneCount = all.length - openCount;
  const present = new Set(nodes.map((n) => n.id));

  // Groups: the canvas first, then nodes top-to-bottom, then removed blocks.
  const order = new Map(nodes.map((n, i) => [n.id, n.y * 10000 + n.x + i * 1e-6]));
  const keys = [...new Set(shown.map((c) => c.on).filter((k): k is string => k !== null))];
  if (compose && !keys.includes(compose) && present.has(compose)) keys.push(compose);
  keys.sort((a, b) => {
    const pa = present.has(a) ? 0 : 1;
    const pb = present.has(b) ? 0 : 1;
    return pa - pb || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });

  // "Show in the side panel" from a 💬 pane: bring its group into view and light it up.
  useEffect(() => {
    if (focus === null) return;
    const key = focus || "canvas";
    const list = all.filter((c) => (focus ? c.on === focus : c.on === null));
    if (list.length && !list.some(matchesFilter(filter))) setFilter("all");
    if (focus) setCompose(focus);
    useCanvasUi.setState({ commentsFocus: null });
    setLit(key);
    // After the render that shows the group (a new filter, a new box).
    setTimeout(() => {
      ref.current?.querySelector(`[data-comment-group="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      setTimeout(() => setLit((l) => (l === key ? null : l)), 1400);
    }, 60);
  }, [focus, all, filter]);

  const canvasWide = all.filter((c) => c.on === null);
  const empty = shown.length === 0 && !compose;
  return (
    <div className="comments-panel" ref={ref}>
      <div className="comments-bar">
        <div className="segmented small" role="radiogroup" aria-label="Show">
          {(["open", "done", "all"] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "open" ? "Open" : f === "done" ? "Done" : "All"}
              {f === "open" && openCount > 0 && <span className="seg-count">{openCount}</span>}
              {f === "done" && doneCount > 0 && <span className="seg-count">{doneCount}</span>}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="icon-btn small" aria-label="Clear every done comment" data-tip={doneCount ? `Clear ${plural(doneCount, "done comment")}` : "Nothing is marked done"} disabled={!doneCount} onClick={() => clearDone(all)}>
          <CheckCheck size={15} />
        </button>
        <button className="icon-btn small danger-hover" aria-label="Delete every comment" data-tip="Delete all comments…" disabled={!all.length} onClick={() => deleteAll(all, "on this canvas")}>
          <Trash2 size={15} />
        </button>
      </div>
      {openCount > 0 && (
        <button className="comment-ask wide" onClick={() => askToAddress("all")}>
          <Bot size={14} /> Ask the agent to address {openCount === 1 ? "it" : `all ${openCount}`}
        </button>
      )}
      {error && <p className="side-hint danger-text">comments.json is broken on disk — showing the last good comments. {error}</p>}

      <CommentGroup id={null} list={canvasWide} shown={canvasWide.filter(matchesFilter(filter))} lit={lit === "canvas"} />
      {keys.map((k) => (
        <CommentGroup
          key={k}
          id={k}
          list={all.filter((c) => c.on === k)}
          shown={shown.filter((c) => c.on === k)}
          present={present.has(k)}
          lit={lit === k}
          composing={compose === k}
          onCompose={(on) => setCompose(on ? k : null)}
        />
      ))}
      {empty && (
        <p className="side-empty">
          {filter === "done"
            ? "No comments are marked done."
            : filter === "open" && all.length
              ? "Nothing open — every comment is done."
              : "No comments yet. Use the 💬 button on a block or frame to leave one — the agent can address them for you."}
        </p>
      )}
    </div>
  );
}

/** One block's (or the canvas's) comments in the panel, with its tidy-up buttons. */
function CommentGroup({
  id,
  list,
  shown,
  present = true,
  lit,
  composing,
  onCompose,
}: {
  id: string | null;
  list: Comment[];
  shown: Comment[];
  present?: boolean;
  lit: boolean;
  composing?: boolean;
  onCompose?: (on: boolean) => void;
}) {
  const done = list.filter((c) => c.done).length;
  const where = id === null ? "on the whole canvas" : `on ${targetName(id)}`;
  return (
    <section className={`comment-group ${id === null ? "canvas-wide" : ""} ${lit ? "lit" : ""}`} data-comment-group={id ?? "canvas"}>
      <div className="comment-group-head">
        {id === null ? (
          <span className="comment-group-name">The whole canvas</span>
        ) : (
          <button
            className="comment-group-name link"
            disabled={!present}
            onClick={() => {
              jumped(() => zoomToBlock(id, { select: true }));
              // After the flight (450 ms): the pane closes when the camera moves.
              setTimeout(() => useCanvasUi.setState({ commentsFor: id }), 520);
            }}
            data-tip={present ? "Go to it, with its comments open" : undefined}
          >
            {targetName(id)}
          </button>
        )}
        {!present && <span className="comment-gone">removed</span>}
        <span className="grow" />
        {id !== null && present && !composing && (
          <button className="icon-btn tiny" aria-label={`Add a comment ${where}`} data-tip="Add a comment" onClick={() => onCompose?.(true)}>
            <MessageSquarePlus size={13} />
          </button>
        )}
        {list.length > 0 && (
          <button className="icon-btn tiny" aria-label={`Clear the done comments ${where}`} data-tip={done ? `Clear ${plural(done, "done comment")} here` : "No done comments here"} disabled={!done} onClick={() => clearDone(list)}>
            <CheckCheck size={13} />
          </button>
        )}
        {list.length > 0 && (
          <button className="icon-btn tiny danger-hover" aria-label={`Delete all comments ${where}`} data-tip="Delete all here…" onClick={() => deleteAll(list, where)}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {shown.map((c) => (
        <CommentItem key={c.id} c={c} />
      ))}
      {(id === null || composing) && <CommentComposer on={id} autoFocus={composing} onIdle={composing ? () => onCompose?.(false) : undefined} />}
    </section>
  );
}
