// The agent chat panel: slides in from the right, one per project.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronUp, KeyRound, LocateFixed, MessageSquarePlus, MoreHorizontal, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import type { AgentCommand, AgentStatus, ChatEntry } from "../../shared/protocol";
import { act, sendPrompt } from "../lib/project";
import { panelMax, setChatOpen, setChatTab, useBoard } from "../lib/store";
import { useSettings } from "../lib/settings";
import { matches, TOUCH } from "../lib/device";
import { Menu } from "../components/Menu";
import { setProviderAuth } from "../lib/api";
import { toast } from "../lib/toasts";
import { ChatEntryView, ToolGroup } from "./ChatEntryView";
import { ChatTabs, GuestComposer, GuestHeader, GuestThread, useGuestTabs } from "./GuestTabs";
import { displayName } from "../../shared/blocks";

export function ChatPanel() {
  const open = useBoard((s) => s.chatOpen);
  const width = useSettings((s) => s.chatWidth);
  const setSetting = useSettings((s) => s.set);
  const [dragW, setDragW] = useState<number | null>(null);

  // The canvas and top bar make room for the panel through --chat-w.
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-w", `${dragW ?? width}px`);
  }, [dragW, width]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const max = panelMax("chat", 760); // leave the canvas room next to the side panel
    const move = (ev: PointerEvent) => setDragW(Math.max(320, Math.min(max, startW + (startX - ev.clientX))));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSetting("chatWidth", Math.max(320, Math.min(max, startW + (startX - ev.clientX))));
      setDragW(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Outside agents that joined get tabs beside the canvas agent's (the strip shows only while there are any).
  const { tabs, close } = useGuestTabs();
  const chatTab = useBoard((s) => s.chatTab);
  const current = tabs.find((t) => t.name === chatTab) ?? null;
  useEffect(() => {
    if (chatTab !== null && !tabs.some((t) => t.name === chatTab)) setChatTab(null);
  }, [tabs, chatTab]);
  const showTabs = tabs.length > 0;

  return (
    <aside className={`chat-panel ${open ? "open" : ""}`} style={{ width: dragW ?? width }} aria-hidden={!open}>
      <div className="chat-resize" onPointerDown={startResize} title="Drag to resize" />
      <div className={`chat-tabs-wrap ${showTabs ? "show" : ""}`} aria-hidden={!showTabs} inert={!showTabs}>
        <div className="chat-tabs-inner">
          <ChatTabs tabs={tabs} onClose={close} />
        </div>
      </div>
      {current ? <GuestHeader tab={current} /> : <ChatHeader />}
      {/* The canvas agent's chat stays mounted on another tab: its scroll and unsent message are kept. */}
      <div className={`chat-pane ${current ? "hidden" : ""}`}>
        <ChatBody active={!current} />
        <Composer />
      </div>
      {current && (
        <div className="chat-pane">
          <GuestThread key={current.name} tab={current} active />
          <GuestComposer tab={current} onDone={() => close(current.name)} />
        </div>
      )}
    </aside>
  );
}

function statusPill(agent: AgentStatus, running: boolean) {
  if (running) return <span className="pill accent"><span className="dot pulse" />Working</span>;
  switch (agent.state) {
    case "ready":
      return <span className="pill ok"><span className="dot" />Ready</span>;
    case "starting":
      return <span className="pill"><span className="spinner tiny" />Starting</span>;
    case "needs-login":
      return <span className="pill warn"><KeyRound size={11} />Log in</span>;
    case "error":
      return <span className="pill danger"><TriangleAlert size={11} />Error</span>;
    default:
      return <span className="pill">Stopped</span>;
  }
}

function ChatHeader() {
  const project = useBoard((s) => s.project);
  const agent = useBoard((s) => s.agent);
  const running = useBoard((s) => s.turnRunning);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const account = agent.state === "ready" ? agent.account : undefined;
  return (
    <header className="chat-head">
      <div className="chat-head-title">
        <div className="chat-head-name">{project?.provider.label ?? "Agent"}</div>
        <div className="chat-head-sub">{account ?? "One agent per canvas"}</div>
      </div>
      {statusPill(agent, running)}
      <FollowToggle />
      <button
        className="icon-btn"
        aria-label="Agent menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right - 220, y: r.bottom + 4 });
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      <button className="icon-btn" aria-label="Close chat" data-tip="Close (C)" data-tip-pos="left" onClick={() => setChatOpen(false)}>
        <X size={16} />
      </button>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "New conversation",
              hint: "/clear",
              icon: <MessageSquarePlus size={15} />,
              disabled: running,
              onSelect: () => void act({ type: "agent.newSession" }),
            },
            {
              label: "Restart agent",
              icon: <RotateCcw size={15} />,
              disabled: running,
              onSelect: () => void act({ type: "agent.restart" }),
            },
          ]}
        />
      )}
    </header>
  );
}

function FollowToggle() {
  const follow = useSettings((s) => s.followAgent);
  const set = useSettings((s) => s.set);
  return (
    <button
      className={`icon-btn ${follow ? "active" : ""}`}
      aria-label="Follow the agent"
      aria-pressed={follow}
      data-tip={follow ? "Following the agent — click to stop" : "Follow the agent: the camera goes where it edits"}
      data-tip-pos="left"
      onClick={() => set("followAgent", !follow)}
    >
      <LocateFixed size={16} />
    </button>
  );
}

/** The divider the server writes when a new conversation starts (/clear, or the … menu). */
const NEW_CONVERSATION = "New conversation";

/** Commands think runs itself, listed with the agent's own. */
const LOCAL_COMMANDS: AgentCommand[] = [{ name: "clear", description: "Start a new conversation (this one folds away)" }];

type Row = { kind: "entry"; entry: ChatEntry } | { kind: "tools"; id: string; tools: Extract<ChatEntry, { kind: "tool" }>[] };

/** Consecutive tool calls fold into one row; everything else stays as is. */
function toRows(chat: ChatEntry[]): Row[] {
  const rows: Row[] = [];
  for (const e of chat) {
    const last = rows[rows.length - 1];
    if (e.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(e);
      else rows.push({ kind: "tools", id: e.id, tools: [e] });
    } else rows.push({ kind: "entry", entry: e });
  }
  return rows;
}

function ChatBody({ active }: { active: boolean }) {
  const chat = useBoard((s) => s.chat);
  const agent = useBoard((s) => s.agent);
  const running = useBoard((s) => s.turnRunning);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat, running, agent, active]);

  // After /clear (a new conversation) the chat starts over on screen; what came
  // before folds away behind one button — kept, just out of the way.
  const cut = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      const e = chat[i];
      if (e.kind === "divider" && e.text === NEW_CONVERSATION) return i;
    }
    return -1;
  }, [chat]);
  const [earlier, setEarlier] = useState(false);
  useEffect(() => setEarlier(false), [cut]);
  const folded = cut >= 0 && !earlier;
  const shown = useMemo(() => (folded ? chat.slice(cut + 1) : chat), [chat, cut, folded]);
  const earlierCount = useMemo(() => (folded ? chat.slice(0, cut).filter((e) => e.kind === "user" || e.kind === "agent").length : 0), [chat, cut, folded]);

  const lastId = chat[chat.length - 1]?.id;
  const rows = useMemo(() => toRows(shown), [shown]);

  return (
    <div className="chat-body-wrap">
      <div className="chat-body" ref={scroller} onScroll={onScroll}>
        {folded && (
          <button className="chat-earlier" onClick={() => setEarlier(true)}>
            <ChevronUp size={13} /> Show the earlier conversation{earlierCount ? ` (${earlierCount} ${earlierCount === 1 ? "message" : "messages"})` : ""}
          </button>
        )}
        {shown.length === 0 && agent.state === "ready" && <ChatIntro />}
        {rows.map((r, i) =>
          r.kind === "entry" ? (
            <ChatEntryView key={r.entry.id} entry={r.entry} streaming={running && r.entry.id === lastId} />
          ) : r.tools.length === 1 && !(running && i === rows.length - 1) ? (
            <ChatEntryView key={r.id} entry={r.tools[0]} />
          ) : (
            <ToolGroup key={r.id} tools={r.tools} live={running && i === rows.length - 1} />
          ),
        )}
        {running && <WorkingRow />}
        <AgentStateCard />
      </div>
      {!atBottom && (
        <button
          className="jump-latest"
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={13} /> Latest
        </button>
      )}
    </div>
  );
}

function ChatIntro() {
  return (
    <div className="chat-intro">
      <div className="chat-intro-title">Ask the agent to work on this canvas</div>
      <ul>
        <li>“Summarise Harry into three bullet points”</li>
        <li>“Draw the flow from Bob as a sequence diagram next to it”</li>
        <li>“Build an interactive HTML mockup of the idea in Tom”</li>
      </ul>
      <p>Refer to blocks by name. While it works, editing pauses — you can still pan, zoom and read.</p>
    </div>
  );
}

function WorkingRow() {
  const since = useBoard((s) => s.lock.since);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  return (
    <div className="chat-working">
      <span className="typing"><i /><i /><i /></span>
      <span>Working · {label}</span>
    </div>
  );
}

function AgentStateCard() {
  const agent = useBoard((s) => s.agent);
  const provider = useBoard((s) => s.project?.provider.label ?? "the agent");
  const providerId = useBoard((s) => s.project?.provider.id);
  const [switching, setSwitching] = useState(false);
  if (agent.state === "starting") {
    return (
      <div className="agent-card subtle">
        <span className="spinner" /> Starting {provider}…
      </div>
    );
  }
  if (agent.state === "needs-login") {
    const methods = agent.methods;
    // The provider's own API key: a button when the server has it, else how to add it.
    const key = methods.find((m) => m.keyOnServer !== undefined);
    const otherEnv = [...new Set(methods.filter((m) => m.env && m !== key).flatMap((m) => m.env ?? []))];
    const useKey = () => {
      if (!providerId) return;
      setSwitching(true);
      setProviderAuth(providerId, "api-key").then(
        () => setSwitching(false),
        (e: Error) => {
          setSwitching(false);
          toast.error(e.message);
        },
      );
    };
    return (
      <div className="agent-card login">
        <div className="agent-card-icon"><KeyRound size={18} /></div>
        <div className="agent-card-title">Log in to {provider}</div>
        <p>
          The agent runs in its own isolated home on the server. Logging in stores its credentials there and nowhere else — this canvas app never sees them.
        </p>
        <div className="agent-card-actions">
          {methods.filter((m) => !m.env).map((m, i) => (
            <button
              key={m.id}
              className={`btn ${i === 0 ? "primary" : ""}`}
              title={m.description ?? undefined}
              onClick={() => useBoard.setState({ loginOpen: true, loginOutput: "", loginExit: undefined, loginRequest: m.id })}
            >
              {m.name}
            </button>
          ))}
          {key?.keyOnServer && (
            <button className="btn" onClick={useKey} disabled={switching} data-tip={`Every canvas using ${provider} switches to ${key.env?.[0]}; Settings can switch it back`}>
              {switching ? <span className="spinner tiny" /> : <KeyRound size={14} />} Use the server's API key
            </button>
          )}
          {methods.length === 0 && <span className="muted">The agent offered no login methods. Check its configuration.</span>}
        </div>
        {key && !key.keyOnServer && (
          <p className="muted small">
            Or use an API key: add <code>{key.env?.[0]}</code> to think's environment (its <code>.env</code> file) and restart think.
            A button for it then shows here.
          </p>
        )}
        {otherEnv.length > 0 && (
          <p className="muted small">
            Or set {otherEnv.map((v, i) => (
              <span key={v}>
                {i > 0 && " or "}
                <code>{v}</code>
              </span>
            ))}{" "}
            for think (see the install guide).
          </p>
        )}
      </div>
    );
  }
  if (agent.state === "error") {
    return (
      <div className="agent-card error">
        <div className="agent-card-title"><TriangleAlert size={15} /> The agent isn't running</div>
        <pre>{agent.message}</pre>
        <button className="btn" onClick={() => void act({ type: "agent.restart" })}>
          <RotateCcw size={14} /> Restart agent
        </button>
      </div>
    );
  }
  if (agent.state === "stopped") {
    return (
      <div className="agent-card subtle">
        The agent is stopped.
        <button className="btn small" onClick={() => void act({ type: "agent.restart" })}>Start</button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- composer

const HISTORY_KEY = "think.promptHistory";

function Composer() {
  const commands = useBoard((s) => s.commands);
  const blocks = useBoard((s) => s.blocks);
  const prefill = useBoard((s) => s.composerPrefill);
  const [caret, setCaret] = useState(0);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const running = useBoard((s) => s.turnRunning);
  const agent = useBoard((s) => s.agent);
  const conn = useBoard((s) => s.conn);
  const open = useBoard((s) => s.chatOpen);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const histIdx = useRef(-1);

  const ready = agent.state === "ready" && conn === "open";
  const disabled = running || !ready || sending;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [text]);

  // Focus the input with "/" from anywhere on the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName) || t.closest(".cm-editor")) return;
      if (document.querySelector(".overlay, .menu")) return;
      e.preventDefault();
      if (!useBoard.getState().chatOpen) setChatOpen(true);
      if (useBoard.getState().chatTab !== null) setChatTab(null); // "/" is for talking to the canvas agent
      setTimeout(() => ta.current?.focus(), 30);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening the panel (C, the toolbar, "/") puts the cursor straight in the
  // input. Only on a change after mount: page load never steals focus. Not on
  // a touch screen, where focus brings up the keyboard over half the screen.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && !matches(TOUCH)) {
      const t = setTimeout(() => ta.current?.focus({ preventScroll: true }), 60);
      wasOpen.current = open;
      return () => clearTimeout(t);
    }
    wasOpen.current = open;
  }, [open]);

  // When a turn ends, put the cursor back in the input for the follow-up —
  // but never steal focus on page load (keyboard shortcuts need it).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && open && ready && !matches(TOUCH) && !document.activeElement?.closest(".cm-editor")) {
      ta.current?.focus({ preventScroll: true });
    }
    wasRunning.current = running;
  }, [running, open, ready]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || disabled) return;
    if (/^\/clear$/i.test(value)) {
      setText("");
      setCmdDismissed(false);
      void act({ type: "agent.newSession" });
      return;
    }
    setSending(true);
    const ok = await sendPrompt(value);
    setSending(false);
    if (ok) {
      setText("");
      setCmdDismissed(false);
      histIdx.current = -1;
      try {
        const hist: string[] = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
        localStorage.setItem(HISTORY_KEY, JSON.stringify([value, ...hist.filter((h) => h !== value)].slice(0, 50)));
      } catch {
        /* storage unavailable */
      }
    }
  }, [text, disabled]);

  const recall = (dir: 1 | -1): boolean => {
    let hist: string[] = [];
    try {
      hist = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return false;
    }
    const next = histIdx.current + dir;
    if (next < -1 || next >= hist.length) return false;
    histIdx.current = next;
    setText(next === -1 ? "" : hist[next]);
    return true;
  };

  // "/" at the start of an empty-ish message lists the agent's commands.
  const cmdQuery = /^\/(\S*)$/.exec(text)?.[1];
  const cmdMatches = useMemo(() => {
    if (cmdQuery === undefined || cmdDismissed) return [];
    const q = cmdQuery.toLowerCase();
    const all = [...LOCAL_COMMANDS, ...commands.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const rest = all.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)));
    return [...starts, ...rest].slice(0, 8);
  }, [cmdQuery, commands, cmdDismissed]);
  // "@" before the caret lists blocks: "@tea" → @tea-flowchart.
  const mention = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  const mentionMatches = useMemo(() => {
    if (!mention || cmdDismissed) return [];
    const q = mention[2].toLowerCase();
    return Object.keys(blocks)
      .filter((n) => n.includes(q) || displayName(n).toLowerCase().includes(q))
      .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.localeCompare(b))
      .slice(0, 8)
      .map((n) => ({ name: n, description: displayName(n) + (blocks[n].type === "image" ? " · image" : "") }));
  }, [mention?.[2], mention === null, blocks, cmdDismissed]);
  const pickMention = (name: string) => {
    const before = text.slice(0, caret).replace(/@([a-z0-9-]*)$/i, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(before.length, before.length);
    });
  };
  const popItems = cmdMatches.length ? cmdMatches.map((c) => ({ name: c.name, description: c.description, hint: c.hint, kind: "cmd" as const })) : mentionMatches.map((m) => ({ ...m, hint: undefined, kind: "mention" as const }));
  const showCmds = popItems.length > 0 && !disabled;
  useEffect(() => {
    if (prefill === null) return;
    setText((t) => (t.trim() ? `${t.trimEnd()} ${prefill}` : prefill));
    useBoard.setState({ composerPrefill: null });
    setTimeout(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    }, 80);
  }, [prefill]);
  useEffect(() => setCmdIdx(0), [cmdQuery, mention?.[2]]);
  // Keep the highlighted command or block in sight while ↑↓ walk the list.
  const popList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    popList.current?.querySelector(".cmd-item.active")?.scrollIntoView({ block: "nearest" });
  }, [cmdIdx]);
  const pick = (i: number) => {
    const it = popItems[i];
    if (!it) return;
    if (it.kind === "cmd") pickCommand(it.name);
    else pickMention(it.name);
  };
  const pickCommand = (name: string) => {
    // think's own commands take no argument: picking one runs it.
    if (LOCAL_COMMANDS.some((c) => c.name === name)) {
      setText("");
      if (name === "clear") void act({ type: "agent.newSession" });
      return;
    }
    setText(`/${name} `);
    setCmdDismissed(true);
    ta.current?.focus();
  };

  const placeholder = running
    ? "The agent is working…"
    : conn !== "open"
      ? "Reconnecting…"
      : agent.state === "needs-login"
        ? "Log in to start chatting"
        : agent.state !== "ready"
          ? "Waiting for the agent…"
          : "Ask the agent…  (/ for commands)";

  return (
    <div className={`composer ${running ? "running" : ""}`} title="Enter to send · Shift+Enter for a new line · ↑ recalls your last message">
      {showCmds && (
        <div className="cmd-popover">
          <div className="cmd-list" ref={popList} role="listbox" aria-label={popItems[0]?.kind === "cmd" ? "Agent commands" : "Blocks"}>
          {popItems.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === cmdIdx}
              className={`cmd-item ${i === cmdIdx ? "active" : ""}`}
              onMouseEnter={() => setCmdIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              <span className="cmd-name">{c.kind === "cmd" ? "/" : "@"}{c.name}</span>
              {c.hint && <span className="cmd-hint">{c.hint}</span>}
              <span className="cmd-desc">{c.description}</span>
            </button>
          ))}
          </div>
          <div className="cmd-foot">{popItems[0]?.kind === "cmd" ? "↑↓ choose · Tab or Enter to pick · Esc to close" : "Mention a block: ↑↓ · Tab or Enter · Esc"}</div>
        </div>
      )}
      <textarea
        ref={ta}
        className="composer-input"
        value={text}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          if (!e.target.value.startsWith("/")) setCmdDismissed(false);
          else if (e.target.value === "/") setCmdDismissed(false);
          histIdx.current = -1;
        }}
        onKeyDown={(e) => {
          if (showCmds) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = popItems.length;
              setCmdIdx((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
              return;
            }
            const cur = popItems[cmdIdx];
            if (cur && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !(cur.kind === "cmd" && `/${cur.name}` === text.trim())))) {
              e.preventDefault();
              pick(cmdIdx);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setCmdDismissed(true);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === "ArrowUp" && (text === "" || histIdx.current >= 0) && ta.current?.selectionStart === 0) {
            if (recall(1)) e.preventDefault();
          } else if (e.key === "ArrowDown" && histIdx.current >= 0) {
            if (recall(-1)) e.preventDefault();
          } else if (e.key === "Escape") {
            ta.current?.blur();
          }
        }}
      />
      {running ? (
        <button className="composer-btn stop" aria-label="Stop the agent" data-tip="Stop" data-tip-pos="top" onClick={() => void act({ type: "agent.cancel" })}>
          <Square size={13} fill="currentColor" />
        </button>
      ) : (
        <button className="composer-btn send" aria-label="Send" disabled={disabled || !text.trim()} onClick={() => void submit()}>
          {sending ? <span className="spinner tiny" /> : <ArrowUp size={16} />}
        </button>
      )}
    </div>
  );
}
