// The left side panel: Outline (every block, by group), Views (saved
// viewpoints), README (what the canvas is about) and History (moments you can
// preview and restore). Toggle with B.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Crosshair,
  Eye,
  FileText,
  Frame,
  Globe,
  GripVertical,
  History as HistoryIcon,
  Image as ImageIcon,
  ListTree,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Presentation,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  User,
  Workflow,
  X,
} from "lucide-react";
import { displayName, type BlockType } from "../../shared/blocks";
import { groupMembers, type CanvasView, type ViewList } from "../../shared/canvas";
import type { HistoryEntry, HistorySnapshot } from "../../shared/protocol";
import { MarkdownView } from "../blocks/renderers";
import { act, flushEdits, layout, request } from "../lib/project";
import { panelMax, useBoard } from "../lib/store";
import { PHONE, useMedia } from "../lib/device";
import { useSettings, type Settings } from "../lib/settings";
import { toast } from "../lib/toasts";
import { addViewsAsSlides, goToView, jumped, saveViewSlot, zoomToBlock } from "../canvas/actions";
import { useCanvasUi } from "../canvas/ui-state";
import { startPresenting } from "./Present";
import { CommentBadge, CommentsPanel as Comments } from "./Comments";
import { Dialog } from "./Dialogs";

const TYPE_ICON: Record<BlockType, typeof FileText> = { markdown: FileText, mermaid: Workflow, html: Globe, image: ImageIcon };
const TABS: { id: Settings["sidePanel"]; label: string; icon: typeof FileText }[] = [
  { id: "outline", label: "Blocks", icon: ListTree },
  { id: "views", label: "Views", icon: Eye },
  { id: "slides", label: "Presentation", icon: Presentation },
  { id: "comments", label: "Comments", icon: MessageSquare },
  { id: "readme", label: "README", icon: FileText },
  { id: "history", label: "History", icon: HistoryIcon },
];

export function SidePanel() {
  const open = useSettings((s) => s.sidePanelOpen);
  const tab = useSettings((s) => s.sidePanel);
  // The icon rail takes 50px: widths saved before it existed get the room back.
  const width = Math.max(320, useSettings((s) => s.sidePanelWidth));
  const set = useSettings((s) => s.set);
  const [dragW, setDragW] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--side-w", `${dragW ?? width}px`);
  }, [dragW, width]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const max = panelMax("side", 600); // leave the canvas room next to the chat
    const clamp = (x: number) => Math.max(290, Math.min(max, width + (x - startX)));
    const move = (ev: PointerEvent) => setDragW(clamp(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      set("sidePanelWidth", clamp(ev.clientX));
      setDragW(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const phone = useMedia(PHONE);
  return (
    <aside className={`side-panel ${open ? "open" : ""}`} style={{ width: dragW ?? width }} aria-hidden={!open}>
      <div className="side-resize" onPointerDown={startResize} />
      <nav className="side-rail" role="tablist" aria-orientation="vertical" aria-label="Side panel">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            className={tab === t.id ? "on" : ""}
            onClick={() => set("sidePanel", t.id)}
            data-tip={t.label}
            data-tip-pos="right"
          >
            <t.icon size={17} />
            {t.id === "comments" && <CommentBadge />}
          </button>
        ))}
      </nav>
      <div className="side-main">
        <header className="side-head">
          <h2 className="side-title">{current.label}</h2>
          <button className="icon-btn small" aria-label="Close panel" data-tip="Close (B)" onClick={() => set("sidePanelOpen", false)}>
            <X size={15} />
          </button>
        </header>
        <div className="side-body">
          {open && tab === "outline" && <Outline />}
          {open && tab === "views" && <Views />}
          {open && tab === "slides" && <Slides />}
          {open && tab === "comments" && <Comments />}
          {open && tab === "readme" && <Readme />}
          {open && tab === "history" && (phone ? <p className="side-empty">History — seeing the canvas as it was, and restoring — is on a tablet or computer, where the canvas has room to show it.</p> : <History />)}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- outline

function Outline() {
  const blocks = useBoard((s) => s.blocks);
  const canvas = useBoard((s) => s.canvas);
  const lastTurn = useBoard((s) => s.lastTurn);
  const [q, setQ] = useState("");
  const changed = new Set(lastTurn?.changed ?? []);
  const match = (name: string) => !q || displayName(name).toLowerCase().includes(q.toLowerCase()) || (blocks[name]?.content ?? "").toLowerCase().includes(q.toLowerCase());

  const sections = useMemo(() => {
    const groups = canvas.nodes.filter((n) => n.type === "group").sort((a, b) => a.y - b.y || a.x - b.x);
    const placed = new Set<string>();
    const out: { id: string | null; label: string; names: string[] }[] = [];
    for (const g of groups) {
      const names = groupMembers(canvas, g.id)
        .filter((n) => n.type === "file" && !placed.has(n.id))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((n) => n.id);
      names.forEach((n) => placed.add(n));
      out.push({ id: g.id, label: g.type === "group" && g.label ? g.label : "Untitled group", names });
    }
    const rest = canvas.nodes
      .filter((n) => n.type === "file" && !placed.has(n.id))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((n) => n.id);
    out.push({ id: null, label: groups.length ? "Not in a group" : "Blocks", names: rest });
    return out;
  }, [canvas]);

  const protectedIds = new Set(canvas.nodes.filter((n) => n.type === "file" && n.protected).map((n) => n.id));
  const total = Object.keys(blocks).length;

  return (
    <div className="outline">
      <div className="side-search">
        <Search size={14} />
        <input value={q} placeholder={`Filter ${total} blocks`} onChange={(e) => setQ(e.target.value)} />
      </div>
      {lastTurn && lastTurn.changed.length > 0 && !q && (
        <div className="last-turn">
          <div className="last-turn-head">
            <Sparkles size={13} /> The agent's last turn changed
          </div>
          <div className="chip-row">
            {lastTurn.changed.filter((n) => blocks[n]).map((n) => (
              <button key={n} className="chip changed" onClick={() => jumped(() => zoomToBlock(n, { select: true }))}>
                {displayName(n)}
              </button>
            ))}
          </div>
        </div>
      )}
      {sections.map((sec) => {
        const names = sec.names.filter(match);
        if (!names.length && (q || sec.id === null)) return null;
        return (
          <section key={sec.id ?? "rest"} className="outline-section">
            <button className="outline-group" disabled={!sec.id} onClick={() => sec.id && jumped(() => zoomToBlock(sec.id!, { select: true }))}>
              {sec.id ? <Frame size={13} /> : null}
              <span>{sec.label}</span>
              <span className="muted">{names.length}</span>
            </button>
            {names.map((n) => {
              const b = blocks[n];
              if (!b) return null;
              const Icon = TYPE_ICON[b.type];
              const heading = /^#{1,3}\s+(.+)$/m.exec(b.content ?? "")?.[1];
              return (
                <button key={n} className="outline-row" onClick={() => jumped(() => zoomToBlock(n, { select: true }))}>
                  <Icon size={14} className={`type-${b.type}`} />
                  <span className="outline-name">{displayName(n)}</span>
                  {heading && heading.toLowerCase() !== displayName(n).toLowerCase() && <span className="outline-detail">{heading}</span>}
                  {protectedIds.has(n) && <Shield size={12} className="outline-protected" />}
                  {changed.has(n) && <span className="changed-dot" title="Changed in the agent's last turn" />}
                </button>
              );
            })}
          </section>
        );
      })}
      {total === 0 && <p className="side-empty">No blocks yet. Add one from the toolbar, or ask the agent.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- views

function Views() {
  const list = useBoard((s) => s.canvas.views ?? NO_VIEWS);
  const locked = useBoard((s) => s.lock.locked);
  return (
    <div className="views">
      <div className="views-actions">
        <button className="btn small primary" disabled={locked} onClick={() => void saveViewSlot(list.length + 1)} data-tip="The selected block or group — or what's on screen (Shift+1–9 saves into a slot)">
          <Plus size={14} /> Save view
        </button>
      </div>
      {list.length === 0 && (
        <p className="side-empty">
          A view remembers an area of the canvas — or, saved with a block or group selected, that block wherever it goes. Jump back with a click or <kbd>1</kbd>–<kbd>9</kbd>; <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>9</kbd> saves into a slot. The agent can make views too.
        </p>
      )}
      <ViewRows list="views" items={list} />
    </div>
  );
}

/** The presentation: its own ordered list of slides, apart from the views. */
function Slides() {
  const list = useBoard((s) => s.canvas.slides ?? NO_VIEWS);
  const views = useBoard((s) => s.canvas.views ?? NO_VIEWS);
  const locked = useBoard((s) => s.lock.locked);
  const [picking, setPicking] = useState(false);
  return (
    <div className="views">
      <div className="views-actions">
        <button className="btn small primary" disabled={locked} onClick={() => void saveViewSlot(list.length + 1, "slides")} data-tip="The selected block or group — or what's on screen">
          <Plus size={14} /> Add slide
        </button>
        {views.length > 0 && (
          <button className={`btn small ${picking ? "on" : ""}`} disabled={locked} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
            <Eye size={14} /> From a view
          </button>
        )}
        <span className="grow" />
        <button className="btn small" disabled={!list.length} onClick={() => startPresenting()} data-tip="Present (P)">
          <Play size={13} /> Play
        </button>
      </div>
      {picking && (
        <div className="slide-picker">
          {views.map((v) => (
            <button
              key={v.id}
              className="slide-pick"
              onClick={() => {
                addViewsAsSlides([v]);
                setPicking(false);
              }}
            >
              {v.target ? <Crosshair size={12} className="view-linked" /> : <Eye size={12} />}
              <span>{v.name}</span>
            </button>
          ))}
          {views.length > 1 && (
            <button
              className="slide-pick all"
              onClick={() => {
                addViewsAsSlides(views);
                setPicking(false);
              }}
            >
              <Plus size={12} /> All {views.length} views, in order
            </button>
          )}
        </div>
      )}
      {list.length === 0 && (
        <p className="side-empty">
          A presentation is its own list of slides — rearrange it freely without touching the views you use to get around. Add what's on screen, a selected block or group (the slide follows it), or copies of your views. Press <kbd>P</kbd> to present.
        </p>
      )}
      <ViewRows list="slides" items={list} />
    </div>
  );
}

const NO_VIEWS: CanvasView[] = [];

/** Rows of views or slides: go, rename, update, delete, drag to reorder. */
function ViewRows({ list, items }: { list: ViewList; items: CanvasView[] }) {
  const locked = useBoard((s) => s.lock.locked);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const slides = list === "slides";
  const extra = slides ? { list } : {};
  return (
    <ol className="view-list">
      {items.map((v, i) => (
        <li
          key={v.id}
          className={`view-row ${dragging === v.id ? "dragging" : ""}`}
          draggable={!locked && editing !== v.id}
          onDragStart={(e) => {
            setDragging(v.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => {
            if (dragging && dragging !== v.id) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragging && dragging !== v.id) void layout([{ op: "view.move", id: dragging, index: i, ...extra }]);
            setDragging(null);
          }}
        >
          <GripVertical size={13} className="view-grip" />
          <span className="view-num">{slides || i < 9 ? i + 1 : "·"}</span>
          {editing === v.id ? (
            <ViewName view={v} list={list} onDone={() => setEditing(null)} />
          ) : (
            <button className="view-name" onClick={() => jumped(() => goToView(v))} onDoubleClick={() => !locked && setEditing(v.id)}>
              {v.target && <Crosshair size={12} className="view-linked" aria-label="Follows a block" />}
              <span>{v.name}</span>
            </button>
          )}
          <span className="view-tools">
            {slides && (
              <button className="icon-btn tiny" aria-label="Present from here" data-tip="Present from here" onClick={() => startPresenting(i)}>
                <Play size={11} />
              </button>
            )}
            <button className="icon-btn tiny" aria-label="Rename" data-tip="Rename" disabled={locked} onClick={() => setEditing(v.id)}>
              <Pencil size={12} />
            </button>
            <button
              className="icon-btn tiny"
              aria-label={slides ? "Update this slide" : "Update this view"}
              data-tip={!slides && i < 9 ? `Update: the selected block, or what's on screen (Shift+${i + 1})` : "Update: the selected block, or what's on screen"}
              disabled={locked}
              onClick={() => void saveViewSlot(i + 1, list)}
            >
              <RefreshCw size={12} />
            </button>
            <button className="icon-btn tiny" aria-label="Delete" data-tip="Delete" disabled={locked} onClick={() => void layout([{ op: "view.delete", id: v.id, ...extra }])}>
              <Trash2 size={12} />
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ViewName({ view, list, onDone }: { view: CanvasView; list: ViewList; onDone: () => void }) {
  const [value, setValue] = useState(view.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() && value.trim() !== view.name) void layout([{ op: "view.update", id: view.id, patch: { name: value.trim() }, ...(list === "slides" ? { list } : {}) }]);
    onDone();
  };
  return (
    <input
      ref={ref}
      className="view-input"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

// ---------------------------------------------------------------- readme

function Readme() {
  const readme = useBoard((s) => s.readme);
  const locked = useBoard((s) => s.lock.locked);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(readme ?? "");
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!editing) setText(readme ?? "");
  }, [readme, editing]);
  useEffect(() => {
    if (locked) setEditing(false);
  }, [locked]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v !== null) void act({ type: "readme.edit", content: v });
  }, []);
  useEffect(() => () => flush(), [flush]);

  const placeholder = !readme || /^_What is this canvas about\?/m.test(readme);
  return (
    <div className="readme">
      <div className="readme-bar">
        <span className="muted small">README.md — the agent reads it first and keeps it current</span>
        {editing ? (
          <button
            className="btn small primary"
            onClick={() => {
              flush();
              setEditing(false);
            }}
          >
            Done
          </button>
        ) : (
          <button className="btn small" disabled={locked} onClick={() => setEditing(true)}>
            <Pencil size={13} /> Edit
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          className="readme-editor"
          value={text}
          autoFocus
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            pending.current = e.target.value;
            if (timer.current) clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 600);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              flush();
              setEditing(false);
            }
          }}
        />
      ) : (
        <div className="readme-view" onDoubleClick={() => !locked && setEditing(true)}>
          {readme ? <MarkdownView source={readme} /> : <p className="side-empty">No README yet.</p>}
          {placeholder && <p className="side-empty">Describe what this canvas is for — or ask the agent to write the README from what's on the board.</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- history

const KIND_ICON: Record<HistoryEntry["kind"], typeof User> = { agent: Sparkles, user: User, guest: Bot, restore: RotateCcw, app: Settings2 };

function day(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function entryTitle(e: HistoryEntry): string {
  if (e.kind === "agent") return e.title || "Agent changes";
  if (e.kind === "user") {
    const s = e.summary;
    const bits: string[] = [];
    if (s.added.length) bits.push(`added ${s.added.map(displayName).join(", ")}`);
    if (s.edited.length) bits.push(`edited ${s.edited.map(displayName).join(", ")}`);
    if (s.renamed.length) bits.push(`renamed ${s.renamed.map(([a, b]) => `${displayName(a)} → ${displayName(b)}`).join(", ")}`);
    if (s.removed.length) bits.push(`deleted ${s.removed.map(displayName).join(", ")}`);
    if (s.readme) bits.push("edited the README");
    if (!bits.length && s.layout.length) bits.push("rearranged the canvas");
    const t = bits.join("; ") || "edits";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return e.title || e.who;
}

/** Open the History preview at an entry. Exported for the preview bar's ←/→. */
async function preview(entry: HistoryEntry, list: HistoryEntry[]): Promise<void> {
  try {
    const snap = await request<HistorySnapshot>({ type: "history.snapshot", rev: entry.id, base: entry.base });
    const i = list.findIndex((e) => e.id === entry.id);
    useBoard.setState({ timeTravel: { entry, snap, newer: i > 0 ? list[i - 1] : null, older: i >= 0 && i < list.length - 1 ? list[i + 1] : null } });
    useCanvasUi.setState({ historyList: list });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

function History() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState<"all" | "agent" | "user">("all");
  const [open, setOpen] = useState<string | null>(null);
  const tt = useBoard((s) => s.timeTravel);
  const lastTurn = useBoard((s) => s.lastTurn);
  const conn = useBoard((s) => s.conn);
  const version = useBoard((s) => s.historyVersion);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      // The newest page begins with a save (server side); send this tab's
      // pending edits first so it includes them.
      if (!before) await flushEdits();
      const r = await request<{ entries: HistoryEntry[]; more: boolean }>({ type: "history.list", before, limit: 40 });
      setEntries((prev) => (before && prev ? [...prev, ...r.entries] : r.entries));
      setMore(r.more);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (conn === "open") void load();
  }, [load, lastTurn, conn, version]);

  // Opened from a link to a commit (an outside agent's tab): preview the moment that holds it.
  const focus = useBoard((s) => s.historyFocus);
  useEffect(() => {
    if (!focus || !entries) return;
    const hit = entries.find((e) => e.id === focus || e.commits.some((c) => c.hash === focus));
    if (!hit) {
      if (!loading && more) return void load(entries[entries.length - 1].id); // an older page
      useBoard.setState({ historyFocus: null });
      return;
    }
    useBoard.setState({ historyFocus: null });
    setFilter("all");
    void preview(hit, entries);
    requestAnimationFrame(() => document.querySelector(`[data-history-id="${hit.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [focus, entries, loading, more, load]);

  const shown = (entries ?? []).filter((e) => filter === "all" || (filter === "agent" ? e.kind === "agent" : e.kind !== "agent"));
  let lastDay = "";
  return (
    <div className="history">
      <div className="history-bar">
        <div className="segmented small" role="radiogroup">
          {(["all", "agent", "user"] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "agent" ? "Agent" : "You & others"}
            </button>
          ))}
        </div>
        <button className="icon-btn small" aria-label="Save and refresh" data-tip="Save and refresh" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>
      <p className="side-hint">Click a moment to see the canvas as it was. Nothing changes until you restore.</p>
      {entries === null && <div className="center-pad"><span className="spinner" /></div>}
      {shown.map((e) => {
        const d = day(e.at);
        const head = d !== lastDay ? <div className="history-day">{d}</div> : null;
        lastDay = d;
        const Icon = KIND_ICON[e.kind];
        const s = e.summary;
        const active = tt?.entry.id === e.id;
        return (
          <div key={e.id}>
            {head}
            <div className={`history-entry kind-${e.kind} ${active ? "active" : ""}`} data-history-id={e.id}>
              <button className="history-main" onClick={() => jumped(() => void preview(e, entries ?? []))}>
                <span className="history-icon"><Icon size={13} /></span>
                <span className="history-text">
                  <span className="history-meta">
                    <b>{e.who}</b> · {time(e.at)}
                    {e.command && <span className="pill tiny">command</span>}
                  </span>
                  <span className={`history-title ${e.kind === "agent" ? "quoted" : ""}`}>{entryTitle(e)}</span>
                  {e.reply && <span className="history-reply">{plainText(e.reply)}</span>}
                </span>
              </button>
              {(s.added.length + s.edited.length + s.removed.length + s.renamed.length > 0 || s.layout.length > 0) && (
                <div className="history-changes">
                  {s.added.map((n) => <span key={`a${n}`} className="chip added" onClick={() => void preview(e, entries ?? []).then(() => zoomToBlock(n, { select: true }))}>+ {displayName(n)}</span>)}
                  {s.edited.map((n) => <span key={`e${n}`} className="chip edited" onClick={() => void preview(e, entries ?? []).then(() => zoomToBlock(n, { select: true }))}>{displayName(n)}</span>)}
                  {s.renamed.map(([a, b]) => <span key={`r${b}`} className="chip edited">{displayName(a)} → {displayName(b)}</span>)}
                  {s.removed.map((n) => <span key={`d${n}`} className="chip removed">{displayName(n)}</span>)}
                  {s.layout.length > 0 && (
                    <button className="history-layout" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      {open === e.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {s.layout.length === 1 && s.layout[0].length < 48 ? s.layout[0] : `${s.layout.length} layout change${s.layout.length === 1 ? "" : "s"}`}
                    </button>
                  )}
                </div>
              )}
              {open === e.id && (
                <ul className="history-layout-list">
                  {s.layout.map((l, i) => <li key={i}>{l}</li>)}
                  {e.commits.length > 1 && <li className="muted">{e.commits.length} saves in this moment</li>}
                </ul>
              )}
            </div>
          </div>
        );
      })}
      {more && (
        <button className="btn small ghost load-more" onClick={() => entries && void load(entries[entries.length - 1].id)}>
          <Clock3 size={13} /> Older
        </button>
      )}
      {entries?.length === 0 && <p className="side-empty">No history yet.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- preview bar & compare

/** Shown over the canvas while previewing history: where you are, step, restore, leave. */
export function TimeTravelBar() {
  const tt = useBoard((s) => s.timeTravel);
  const locked = useBoard((s) => s.lock.locked);

  useEffect(() => {
    if (!tt) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || document.querySelector(".overlay")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        useBoard.setState({ timeTravel: null });
      } else if (e.key === "ArrowLeft" && !e.altKey && tt.older) {
        e.preventDefault();
        void preview(tt.older, useCanvasUi.getState().historyList);
      } else if (e.key === "ArrowRight" && !e.altKey && tt.newer) {
        e.preventDefault();
        void preview(tt.newer, useCanvasUi.getState().historyList);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [tt]);

  if (!tt) return null;
  const e = tt.entry;
  const when = `${day(e.at)}, ${time(e.at)}`;
  return (
    <div className="tt-bar" role="toolbar" aria-label="History preview">
      <button className="icon-btn small" aria-label="Older" data-tip="Older (←)" data-tip-pos="bottom" disabled={!tt.older} onClick={() => tt.older && void preview(tt.older, useCanvasUi.getState().historyList)}>
        <ChevronLeft size={16} />
      </button>
      <div className="tt-text">
        <span className="tt-when"><Clock3 size={13} /> {when}</span>
        <span className="tt-what">
          <b>{e.who}</b> · {entryTitle(e)}
        </span>
      </div>
      <button className="icon-btn small" aria-label="Newer" data-tip="Newer (→)" data-tip-pos="bottom" disabled={!tt.newer} onClick={() => tt.newer && void preview(tt.newer, useCanvasUi.getState().historyList)}>
        <ChevronRight size={16} />
      </button>
      <span className="tt-legend">
        <i className="added" /> added <i className="edited" /> changed <i className="ghost" /> removed
      </span>
      <button
        className="btn small"
        disabled={locked}
        onClick={() =>
          useCanvasUi.getState().askConfirm({
            title: `Restore the canvas to ${when}?`,
            body: "Blocks, layout and README go back to how they were then. This is added as a new change — nothing is lost, and you can restore forward again from History.",
            action: "Restore canvas",
            run: async () => {
              const r = await act({ type: "history.restore", rev: e.id });
              if (r) useBoard.setState({ timeTravel: null });
            },
          })
        }
      >
        <RotateCcw size={13} /> Restore canvas to here
      </button>
      <button className="btn small primary" onClick={() => useBoard.setState({ timeTravel: null })}>
        Back to live <kbd className="on-accent">Esc</kbd>
      </button>
    </div>
  );
}

/** "Compare with now": the block then vs now, line by line. */
export function DiffDialog() {
  const d = useCanvasUi((s) => s.diff);
  const [data, setData] = useState<{ then: string | null; now: string | null } | null>(null);
  useEffect(() => {
    setData(null);
    if (!d) return;
    request<{ then: string | null; now: string | null }>({ type: "history.diff", rev: d.rev, name: d.name }).then(setData, (err: Error) => toast.error(err.message));
  }, [d]);
  if (!d) return null;
  const close = () => useCanvasUi.setState({ diff: null });
  const rows = data ? lineDiff(data.then ?? "", data.now ?? "") : [];
  return (
    <Dialog
      title={`${displayName(d.name)}: then → now`}
      icon={<ArrowLeftRight size={18} />}
      onClose={close}
      wide
      footer={
        <>
          <button className="btn" onClick={close}>Close</button>
          <button
            className="btn primary"
            // Nothing to restore when the text is the same (an unchanged block, or only its place changed).
            disabled={useBoard.getState().lock.locked || (!!data && data.then !== null && data.now !== null && rows.length === 0)}
            onClick={async () => {
              close();
              await act({ type: "history.restore", rev: d.rev, names: [d.name] });
            }}
          >
            <RotateCcw size={14} /> Restore this version
          </button>
        </>
      }
    >
      {!data ? (
        <div className="center-pad"><span className="spinner" /></div>
      ) : data.then === null ? (
        <p className="muted">This block did not exist then.</p>
      ) : data.now === null ? (
        <p className="muted">This block no longer exists — restoring brings it back.</p>
      ) : (
        <pre className="diff">
          {rows.length === 0 ? <span className="diff-line fold">No differences — the text is the same now as it was then.</span> : rows.map((r, i) => (
            <span key={i} className={`diff-line ${r.op}`}>{r.op === "add" ? "+ " : r.op === "del" ? "− " : "  "}{r.text}{"\n"}</span>
          ))}
        </pre>
      )}
    </Dialog>
  );
}

/** Line diff (LCS); long unchanged stretches are folded. */
/** A Markdown reply as one plain line for a preview: no emphasis marks, code ticks, links or headings. */
function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|\*|`)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lineDiff(a: string, b: string): { op: "same" | "add" | "del" | "fold"; text: string }[] {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 4_000_000) return [{ op: "fold", text: "(too large to compare)" }];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: "same" | "add" | "del" | "fold"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      out.push({ op: "same", text: A[i] });
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) out.push({ op: "add", text: B[j++] });
    else out.push({ op: "del", text: A[i++] });
  }
  if (!out.some((r) => r.op !== "same")) return [];
  // Fold unchanged runs longer than 6 lines, keeping 2 lines of context.
  const folded: typeof out = [];
  for (let k = 0; k < out.length; ) {
    if (out[k].op !== "same") {
      folded.push(out[k++]);
      continue;
    }
    let end = k;
    while (end < out.length && out[end].op === "same") end++;
    const run = out.slice(k, end);
    if (run.length > 6) {
      if (k > 0) folded.push(...run.slice(0, 2));
      folded.push({ op: "fold", text: `… ${run.length - (k > 0 ? 2 : 0) - (end < out.length ? 2 : 0)} unchanged lines` });
      if (end < out.length) folded.push(...run.slice(-2));
    } else folded.push(...run);
    k = end;
  }
  return folded;
}
