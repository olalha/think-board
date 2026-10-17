// Quick jump (⌘K / Ctrl+K): a search box in the middle of the screen that
// finds blocks by name, heading or content, groups and saved views, plus the
// common actions. ↑/↓ to choose, Enter to go, Esc to close.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Eye,
  FileText,
  Frame,
  Globe,
  HelpCircle,
  Image as ImageIcon,
  LocateFixed,
  Maximize,
  Bot,
  PanelLeft,
  Presentation,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import { displayName, type BlockType } from "../../shared/blocks";
import { useBoard, setChatOpen, setSidePanelOpen } from "../lib/store";
import { loadLocal, saveLocal, useSettings } from "../lib/settings";
import { modLabel } from "../lib/keys";
import { createBlock, fitAll, goToView, zoomToBlock } from "../canvas/actions";
import { useCanvasUi } from "../canvas/ui-state";
import { startPresenting } from "./Present";

const TYPE_ICON: Record<BlockType, typeof FileText> = { markdown: FileText, mermaid: Workflow, html: Globe, image: ImageIcon };

interface Item {
  key: string;
  section: "Blocks" | "Groups" | "Views" | "Actions" | "Recent";
  icon: ReactNode;
  title: string;
  detail?: string;
  hint?: string;
  score: number;
  /** Characters of `title` that matched, for highlighting. */
  hits?: number[];
  run: () => void;
}

/**
 * Subsequence match with bonuses for word starts and runs, like editor
 * "go to file". Returns null when `q` is not a subsequence of `text`.
 */
export function fuzzy(q: string, text: string): { score: number; hits: number[] } | null {
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of query) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s\-_./]/.test(t[at - 1]);
    score += 1 + (wordStart ? 3 : 0) + (at === prev + 1 ? 2 : 0);
    hits.push(at);
    prev = at;
    ti = at + 1;
  }
  if (t.startsWith(query)) score += 6;
  score -= Math.min(4, (t.length - hits.length) / 20);
  return { score, hits };
}

function snippet(content: string, q: string): string | null {
  const i = content.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return null;
  const start = Math.max(0, i - 30);
  const text = content.slice(start, i + q.length + 50).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (i + q.length + 50 < content.length ? "…" : "");
}

function firstHeading(content: string | undefined): string | undefined {
  const m = /^#{1,3}\s+(.+)$/m.exec(content ?? "");
  return m?.[1].trim();
}

function Highlight({ text, hits }: { text: string; hits?: number[] }) {
  if (!hits?.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((c, i) => (set.has(i) ? <mark key={i}>{c}</mark> : <span key={i}>{c}</span>))}
    </>
  );
}

export function Palette() {
  const open = useCanvasUi((s) => s.palette);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const blocks = useBoard((s) => s.blocks);
  const canvas = useBoard((s) => s.canvas);
  const slug = useBoard((s) => s.slug);
  const locked = useBoard((s) => s.lock.locked);
  const recentKey = `think.recent.${slug}`;
  const close = () => useCanvasUi.setState({ palette: false });

  useEffect(() => input.current?.focus(), []);

  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    const query = q.trim();
    const remember = (key: string) => {
      const recent = loadLocal<string[]>(recentKey, []);
      saveLocal(recentKey, [key, ...recent.filter((k) => k !== key)].slice(0, 6));
    };
    const blockItem = (name: string, section: Item["section"], score: number, hits?: number[], detail?: string): Item | null => {
      const b = blocks[name];
      if (!b) return null;
      const Icon = TYPE_ICON[b.type];
      return {
        key: `b:${name}`,
        section,
        icon: <Icon size={15} />,
        title: displayName(name),
        detail: detail ?? firstHeading(b.content) ?? b.file,
        score,
        hits,
        run: () => {
          remember(`b:${name}`);
          zoomToBlock(name, { select: true });
        },
      };
    };

    // Blocks: by name first, then by heading or content.
    for (const name of Object.keys(blocks)) {
      const b = blocks[name];
      const byName = fuzzy(query, displayName(name));
      if (byName) {
        const it = blockItem(name, "Blocks", byName.score + 10, byName.hits);
        if (it) out.push(it);
        continue;
      }
      if (query.length < 2) continue;
      const heading = firstHeading(b.content);
      const byHeading = heading ? fuzzy(query, heading) : null;
      if (byHeading && byHeading.score > query.length * 2) {
        const it = blockItem(name, "Blocks", byHeading.score, undefined, heading);
        if (it) out.push(it);
        continue;
      }
      const snip = b.content ? snippet(b.content, query) : null;
      if (snip) {
        const it = blockItem(name, "Blocks", 1, undefined, snip);
        if (it) out.push(it);
      }
    }

    for (const g of canvas.nodes) {
      if (g.type !== "group") continue;
      const title = g.label || "Untitled group";
      const m = fuzzy(query, title);
      if (!m) continue;
      out.push({ key: `g:${g.id}`, section: "Groups", icon: <Frame size={15} />, title, score: m.score + 8, hits: m.hits, run: () => { remember(`g:${g.id}`); zoomToBlock(g.id, { select: true }); } });
    }

    (canvas.views ?? []).forEach((v, i) => {
      const m = fuzzy(query, v.name);
      if (!m) return;
      out.push({
        key: `v:${v.id}`,
        section: "Views",
        icon: <Eye size={15} />,
        title: v.name,
        hint: i < 9 ? String(i + 1) : undefined,
        score: m.score + 9,
        hits: m.hits,
        run: () => { remember(`v:${v.id}`); goToView(v); },
      });
    });

    const settings = useSettings.getState();
    const actions: Omit<Item, "score" | "section" | "hits">[] = [
      { key: "a:md", icon: <FileText size={15} />, title: "New Markdown block", hint: "M", run: () => void createBlock("markdown") },
      { key: "a:mmd", icon: <Workflow size={15} />, title: "New Mermaid diagram", hint: "D", run: () => void createBlock("mermaid") },
      { key: "a:html", icon: <Globe size={15} />, title: "New HTML block", hint: "H", run: () => void createBlock("html") },
      { key: "a:fit", icon: <Maximize size={15} />, title: "Fit everything in view", hint: "F", run: fitAll },
      { key: "a:chat", icon: <Bot size={15} />, title: useBoard.getState().chatOpen ? "Hide the chat" : "Show the chat", hint: "C", run: () => setChatOpen(!useBoard.getState().chatOpen) },
      { key: "a:panel", icon: <PanelLeft size={15} />, title: settings.sidePanelOpen ? "Hide the side panel" : "Show the side panel", hint: "B", run: () => setSidePanelOpen(!settings.sidePanelOpen) },
      { key: "a:follow", icon: <LocateFixed size={15} />, title: settings.followAgent ? "Stop following the agent" : "Follow the agent", run: () => settings.set("followAgent", !settings.followAgent) },
      { key: "a:present", icon: <Presentation size={15} />, title: "Present the saved views", hint: "P", run: startPresenting },
      { key: "a:settings", icon: <Settings size={15} />, title: "Settings", hint: `${modLabel},`, run: () => useCanvasUi.getState().setDialog("settings") },
      { key: "a:help", icon: <HelpCircle size={15} />, title: "Shortcuts & help", hint: "?", run: () => useCanvasUi.getState().setDialog("help") },
    ];
    for (const a of actions) {
      if (locked && a.key.startsWith("a:m") && a.key !== "a:md") continue;
      const m = fuzzy(query, a.title);
      if (!m) continue;
      out.push({ ...a, section: "Actions", score: query ? m.score : -100, hits: m.hits });
    }

    if (!query) {
      // Nothing typed: recent jumps first, then views, blocks A→Z, actions.
      const recent = loadLocal<string[]>(recentKey, []);
      const byKey = new Map(out.map((i) => [i.key, i]));
      const recents = recent.map((k) => byKey.get(k)).filter((i): i is Item => !!i).map((i) => ({ ...i, section: "Recent" as const, key: `r:${i.key}` }));
      const blocksAZ = out.filter((i) => i.section === "Blocks").sort((a, b) => a.title.localeCompare(b.title));
      return [...recents, ...out.filter((i) => i.section === "Views"), ...out.filter((i) => i.section === "Groups"), ...blocksAZ, ...out.filter((i) => i.section === "Actions")];
    }
    const order = { Blocks: 0, Groups: 1, Views: 2, Recent: 3, Actions: 4 };
    return out.sort((a, b) => b.score - a.score || order[a.section] - order[b.section]).slice(0, 40);
  }, [q, blocks, canvas, locked, recentKey]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    // Start the flight once the palette is gone: tearing the overlay down in
    // the flight's first frames made them stutter.
    requestAnimationFrame(() => requestAnimationFrame(() => it.run()));
  };

  let lastSection = "";
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Quick jump">
        <div className="pal-search">
          <Search size={16} />
          <input
            ref={input}
            value={q}
            placeholder="Jump to a block, group or view — or run an action"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(idx);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={list}>
          {items.length === 0 && <div className="pal-empty">Nothing matches “{q}”.</div>}
          {items.map((it, i) => {
            const head = it.section !== lastSection ? <div className="pal-section">{it.section}</div> : null;
            lastSection = it.section;
            return (
              <div key={it.key}>
                {head}
                <button className={`pal-item ${i === idx ? "active" : ""}`} onMouseMove={() => setIdx(i)} onClick={() => choose(i)}>
                  <span className="pal-icon">{it.icon}</span>
                  <span className="pal-text">
                    <span className="pal-title"><Highlight text={it.title} hits={it.hits} /></span>
                    {it.detail && <span className="pal-detail">{it.detail}</span>}
                  </span>
                  {it.hint && <kbd className="pal-hint">{it.hint}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> go</span>
          <span><kbd>Alt</kbd><kbd>←</kbd> back to where you were</span>
        </div>
      </div>
    </div>
  );
}
