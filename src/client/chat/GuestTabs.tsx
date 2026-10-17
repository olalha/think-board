// Outside agents' tabs in the chat panel: one for each agent that joined the
// canvas (`think join`), beside the canvas agent's. Messages only: the agent
// posts (`think say`) and think notes what it does. The user can't answer
// here — the composer drafts a reply to copy into wherever they talk to that
// agent.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronUp, Copy, History as HistoryIcon, LogIn, LogOut, MoreHorizontal, PencilLine, Sparkles, SquareCheckBig, TimerOff, Unplug, X } from "lucide-react";
import type { GuestEntry, GuestEvent, GuestInfo } from "../../shared/protocol";
import { act } from "../lib/project";
import { setChatOpen, setChatTab, setGuestDraft, setSidePanelOpen, useBoard } from "../lib/store";
import { useSettings } from "../lib/settings";
import { isPhone } from "../lib/device";
import { Menu } from "../components/Menu";
import { MarkdownView } from "../blocks/renderers";
import { useCanvasUi } from "../canvas/ui-state";
import { toast } from "../lib/toasts";

const EMPTY: GuestEntry[] = [];
/** How long a tab says "left" before it goes. */
const LINGER_MS = 2400;
/** The tab's leaving animation (see chat.css). */
const LEAVE_MS = 320;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface GuestTab {
  name: string;
  info: GuestInfo;
  /** live: joined · left: just left, or left with a draft waiting · leaving: animating away. */
  phase: "live" | "left" | "leaving";
}

type Phase = { phase: "left" | "leaving" | "gone"; since: number };

/**
 * The outside agents' tabs to show, and how. Joined agents have a live tab;
 * one that leaves says "left" for a moment, then goes — or stays, greyed,
 * while a reply drafted in it waits to be copied (or the tab is closed).
 */
export function useGuestTabs(): { tabs: GuestTab[]; close: (name: string) => void } {
  const guests = useBoard((s) => s.guests);
  const drafts = useBoard((s) => s.guestDrafts);
  const loaded = useBoard((s) => s.loaded);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const prev = useRef<Map<string, GuestInfo["state"]> | null>(null);

  // Joins and leaves.
  useEffect(() => {
    if (!loaded) return;
    const was = prev.current;
    const waiting = useBoard.getState().guestDrafts;
    setPhases((cur) => {
      const next = { ...cur };
      for (const g of guests) {
        if (g.state === "joined") delete next[g.name];
        else if (was === null) {
          // Opening the canvas: an agent that left keeps its tab only while a draft waits.
          if (waiting[g.name]?.trim()) next[g.name] = { phase: "left", since: 0 };
        } else if (was.get(g.name) === "joined") next[g.name] = { phase: "left", since: Date.now() };
      }
      return next;
    });
    prev.current = new Map(guests.map((g) => [g.name, g.state]));
  }, [guests, loaded]);

  // Then along: "left" (long enough, and no draft waiting) → "leaving" → "gone".
  useEffect(() => {
    const move = (name: string, phase: Phase["phase"]) => setPhases((cur) => (cur[name] && cur[name].phase !== phase ? { ...cur, [name]: { ...cur[name], phase } } : cur));
    const timers: number[] = [];
    for (const [name, p] of Object.entries(phases)) {
      if (p.phase === "left" && !drafts[name]?.trim()) timers.push(window.setTimeout(() => move(name, "leaving"), Math.max(0, p.since + LINGER_MS - Date.now())));
      else if (p.phase === "leaving") timers.push(window.setTimeout(() => move(name, "gone"), reducedMotion() ? 0 : LEAVE_MS));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phases, drafts]);

  const tabs = useMemo(
    () =>
      guests.flatMap((g): GuestTab[] => {
        if (g.state === "joined") return [{ name: g.name, info: g, phase: "live" }];
        const p = phases[g.name];
        if (p) return p.phase !== "gone" ? [{ name: g.name, info: g, phase: p.phase }] : [];
        // Just left, and the effect above has not caught up yet: it is "left" already.
        return prev.current?.get(g.name) === "joined" ? [{ name: g.name, info: g, phase: "left" }] : [];
      }),
    [guests, phases],
  );
  const close = (name: string) => {
    setGuestDraft(name, "");
    setPhases((cur) => ({ ...cur, [name]: { phase: "leaving", since: 0 } }));
  };
  return { tabs, close };
}

/** The strip of tabs: the canvas agent's, then one per outside agent. */
export function ChatTabs({ tabs, onClose }: { tabs: GuestTab[]; onClose: (name: string) => void }) {
  const active = useBoard((s) => s.chatTab);
  const unread = useBoard((s) => s.unreadTabs);
  const label = useBoard((s) => s.project?.provider.label ?? "Agent");
  const running = useBoard((s) => s.turnRunning);
  return (
    <div className="chat-tabs" role="tablist" aria-label="Chats">
      <button role="tab" aria-selected={active === null} className={`chat-tab ${active === null ? "on" : ""}`} onClick={() => setChatTab(null)} data-tip="This canvas's own agent" data-tip-pos="bottom">
        <Sparkles size={13} className="chat-tab-icon" />
        <span className="chat-tab-name">{label}</span>
        {running && <span className="presence working agent" aria-label="working" />}
        {unread[""] && active !== null && <span className="unread-dot" aria-label="new messages" />}
      </button>
      {tabs.map((t) => {
        const on = active === t.name;
        return (
          <div key={t.name} className={`chat-tab-slot ${t.phase}`}>
            <button
              role="tab"
              aria-selected={on}
              className={`chat-tab guest ${on ? "on" : ""} ${t.phase !== "live" ? "off" : ""}`}
              onClick={() => setChatTab(t.name)}
              data-tip={t.phase !== "live" ? `${t.name} left` : t.info.working ? `${t.name} is editing the canvas` : `${t.name} · outside agent`}
              data-tip-pos="bottom"
            >
              <span className={`presence ${t.info.working && t.phase === "live" ? "working" : ""} ${t.phase !== "live" ? "off" : ""}`} aria-hidden />
              <span className="chat-tab-name">{t.name}</span>
              {t.phase !== "live" && <span className="chat-tab-left">left</span>}
              {unread[t.name] && !on && <span className="unread-dot" aria-label="new messages" />}
            </button>
            {t.phase === "left" && (
              <button className="chat-tab-close" aria-label={`Close ${t.name}'s tab (its draft goes)`} data-tip="Close (the draft goes)" data-tip-pos="bottom" onClick={() => onClose(t.name)}>
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- one outside agent's tab

export function GuestHeader({ tab }: { tab: GuestTab }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { name, info } = tab;
  const live = tab.phase === "live";
  const disconnect = () =>
    useCanvasUi.getState().askConfirm({
      title: `Disconnect ${name}?`,
      body: `${name} stops working on this canvas: ${info.working ? "its lock ends and its edits so far are committed under its name, and " : ""}its tab closes. The next time it runs a think command, it is told you disconnected it. It can join again if you ask it to.`,
      action: "Disconnect",
      danger: true,
      run: () => void act({ type: "guest.disconnect", name }),
    });
  return (
    <header className="chat-head guest-head">
      <div className="guest-avatar" aria-hidden>
        &gt;_
      </div>
      <div className="chat-head-title">
        <div className="chat-head-name">{name}</div>
        <div className="chat-head-sub" title={info.about}>
          {info.about ?? "An agent working from outside think"}
        </div>
      </div>
      {!live ? (
        <span className="pill">Left</span>
      ) : info.working ? (
        <span className="pill ok">
          <span className="dot pulse" />
          Working
        </span>
      ) : (
        <span className="pill ok">
          <span className="dot" />
          Joined
        </span>
      )}
      <button
        className="icon-btn"
        aria-label={`${name} menu`}
        disabled={!live}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right - 240, y: r.bottom + 4 });
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      <button className="icon-btn" aria-label="Close chat" data-tip="Close (C)" data-tip-pos="left" onClick={() => setChatOpen(false)}>
        <X size={16} />
      </button>
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: `Disconnect ${name}`, icon: <Unplug size={15} />, danger: true, onSelect: disconnect }]} />}
    </header>
  );
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const EVENT_ICON: Record<GuestEvent, typeof LogIn> = {
  joined: LogIn,
  working: PencilLine,
  finished: SquareCheckBig,
  left: LogOut,
  disconnected: Unplug,
  lapsed: TimerOff,
  takeover: LogOut,
};

/** Open History at the moment that holds a commit (on a phone, History isn't there). */
function openHistoryAt(rev: string): void {
  useBoard.setState({ historyFocus: rev });
  useSettings.getState().set("sidePanel", "history");
  setSidePanelOpen(true);
}

export function GuestThread({ tab, active }: { tab: GuestTab; active: boolean }) {
  const lines = useBoard((s) => s.guestThreads[tab.name]) ?? EMPTY;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Coming back after leaving: the earlier visit folds away behind one button.
  const cut = useMemo(() => {
    for (let i = lines.length - 1; i > 0; i--) if (lines[i].kind === "activity" && (lines[i] as { event: string }).event === "joined") return i;
    return -1;
  }, [lines]);
  const [earlier, setEarlier] = useState(false);
  useEffect(() => setEarlier(false), [cut]);
  const folded = cut > 0 && !earlier;
  const shown = folded ? lines.slice(cut) : lines;
  const earlierSays = folded ? lines.slice(0, cut).filter((e) => e.kind === "say").length : 0;
  const says = lines.some((e) => e.kind === "say");
  const phone = isPhone();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, active, folded]);

  return (
    <div className="chat-body-wrap">
      <div
        className="chat-body guest-body"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="guest-badge">
          <span>Outside agent · on this machine</span>
          {tab.info.note && tab.info.working && tab.phase === "live" && <span className="guest-note">{tab.info.note}</span>}
        </div>
        {folded && (
          <button className="chat-earlier" onClick={() => setEarlier(true)}>
            <ChevronUp size={13} /> Earlier with {tab.name}
            {earlierSays ? ` (${earlierSays} ${earlierSays === 1 ? "message" : "messages"})` : ""}
          </button>
        )}
        {shown.map((e) => {
          if (e.kind === "say") {
            return (
              <div key={e.id} className="guest-msg">
                <div className="guest-msg-head">
                  <b>{tab.name}</b> <time>{time(e.ts)}</time>
                </div>
                <MarkdownView source={e.text} />
              </div>
            );
          }
          const Icon = EVENT_ICON[e.event] ?? LogIn;
          return (
            <div key={e.id} className={`guest-activity ev-${e.event}`}>
              <Icon size={13} />
              <div className="guest-activity-body">
                {e.text}
                <span className="guest-activity-meta">
                  <time>{time(e.ts)}</time>
                  {e.rev && !phone && (
                    <button className="link-btn" onClick={() => openHistoryAt(e.rev!)} data-tip="See it in History">
                      <HistoryIcon size={12} /> History
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
        {!says && tab.phase === "live" && <p className="guest-intro">What {tab.name} changes and says on this canvas shows here.</p>}
      </div>
    </div>
  );
}

export function GuestComposer({ tab, onDone }: { tab: GuestTab; onDone: () => void }) {
  const draft = useBoard((s) => s.guestDrafts[tab.name] ?? "");
  const [copied, setCopied] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [draft]);
  useEffect(() => setCopied(false), [draft]);

  const copy = async () => {
    if (!draft.trim()) return;
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      // No clipboard (an insecure page, a denied permission): select it for ⌘C instead.
      ta.current?.focus();
      ta.current?.select();
      toast.info("Couldn't copy — the text is selected: copy it with ⌘C / Ctrl+C.");
      return;
    }
    if (tab.phase !== "live") {
      // It left: the draft was all that kept the tab here.
      toast.success(`Copied — send it wherever you talk to ${tab.name}.`);
      onDone();
      return;
    }
    setCopied(true);
    toast.success(`Copied — send it wherever you talk to ${tab.name}.`);
  };

  return (
    <div className="composer guest-composer">
      <p className="guest-composer-hint">
        {tab.name} can't read replies here. Draft yours, copy it, and send it wherever you usually talk to {tab.name}.
      </p>
      <div className="guest-composer-row">
        <textarea
          ref={ta}
          className="composer-input"
          value={draft}
          rows={1}
          placeholder={`Draft a reply to ${tab.name}…`}
          aria-label={`Draft a reply to ${tab.name}`}
          onChange={(e) => setGuestDraft(tab.name, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void copy();
            } else if (e.key === "Escape") ta.current?.blur();
          }}
        />
        <button className={`btn small composer-copy ${copied ? "done" : ""}`} disabled={!draft.trim()} onClick={() => void copy()} data-tip="Copy the draft (⌘↵)" data-tip-pos="top">
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
