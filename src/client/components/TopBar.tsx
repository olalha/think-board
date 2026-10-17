import { useEffect, useRef, useState } from "react";
import { Bot, Check, CloudOff, Plus, FileText, Globe, HelpCircle, Image as ImageIcon, KeyRound, PanelLeft, Search, Settings, TriangleAlert, Workflow } from "lucide-react";
import { useSettings } from "../lib/settings";
import { modLabel } from "../lib/keys";
import { sendJSON } from "../lib/api";
import { navigate } from "../lib/router";
import { saveCanvas } from "../lib/project";
import { setChatOpen, setSidePanelOpen, useBoard } from "../lib/store";
import { toast } from "../lib/toasts";
import { createBlock, placementPoint } from "../canvas/actions";
import { useCanvasUi } from "../canvas/ui-state";
import { Logo } from "./Logo";

export function TopBar() {
  const project = useBoard((s) => s.project);
  const locked = useBoard((s) => s.lock.locked);
  const chatOpen = useBoard((s) => s.chatOpen);
  const unread = useBoard((s) => s.chatUnread);
  const setDialog = useCanvasUi((s) => s.setDialog);
  const sideOpen = useSettings((s) => s.sidePanelOpen);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className={`icon-btn ${sideOpen ? "active" : ""}`}
          aria-label="Toggle side panel"
          data-tip={sideOpen ? "Hide panel (B)" : "Outline, views, README, history (B)"}
          onClick={() => setSidePanelOpen(!sideOpen)}
        >
          <PanelLeft size={17} />
        </button>
        <button className="logo-btn" onClick={() => navigate("/")} aria-label="All canvases" data-tip="All canvases">
          <Logo size={22} />
        </button>
        <span className="crumb-sep">/</span>
        {project ? <ProjectName slug={project.slug} name={project.name} /> : <span className="crumb-skeleton" />}
        {project && <SaveStatus />}
      </div>

      <div className="toolbar" role="toolbar" aria-label="Add blocks">
        <ToolButton icon={<FileText size={16} />} label="Markdown" hint="M" disabled={locked} onClick={() => void createBlock("markdown")} />
        <ToolButton icon={<Workflow size={16} />} label="Diagram" hint="D" disabled={locked} onClick={() => void createBlock("mermaid")} />
        <ToolButton icon={<Globe size={16} />} label="HTML" hint="H" disabled={locked} onClick={() => void createBlock("html")} />
        <ToolButton
          icon={<ImageIcon size={16} />}
          label="Image"
          tip="New image: upload one (I), or a blank page to draw on (S)"
          disabled={locked}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            useCanvasUi.getState().openMenu({ kind: "image", x: r.left, y: r.bottom + 6 });
          }}
        />
      </div>

      <div className="topbar-right">
        <button
          className="icon-btn add-btn"
          aria-label="New block"
          disabled={locked}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            useCanvasUi.getState().openMenu({ kind: "pane", x: r.left, y: r.bottom + 6, flow: placementPoint() });
          }}
        >
          <Plus size={18} />
        </button>
        <button className="search-btn" onClick={() => useCanvasUi.setState({ palette: true })} data-tip="Jump to a block, group or view">
          <Search size={14} />
          <span className="search-btn-label">Search</span>
          <kbd>{modLabel === "⌘" ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <AgentPill />
        <button
          className={`icon-btn ${chatOpen ? "active" : ""}`}
          aria-label="Toggle chat"
          data-tip={chatOpen ? "Hide chat (C)" : "Show chat (C)"}
          onClick={() => setChatOpen(!chatOpen)}
        >
          <Bot size={18} />
          {unread && !chatOpen && <span className="unread-dot" />}
        </button>
        <button className="icon-btn" aria-label="Help" data-tip="Shortcuts & help (?)" onClick={() => setDialog("help")}>
          <HelpCircle size={17} />
        </button>
        <button className="icon-btn" aria-label="Settings" data-tip="Settings" data-tip-pos="left" onClick={() => setDialog("settings")}>
          <Settings size={17} />
        </button>
      </div>
    </header>
  );
}

/**
 * Is my work safe? Saved / Saving… / Offline / Not saved — about the files,
 * not git. Clicking it is Save now (⌘S): the edits become a point in History.
 */
function SaveStatus() {
  const conn = useBoard((s) => s.conn);
  const state = useBoard((s) => {
    const all = Object.values(s.saveState);
    return all.includes("error") ? "error" : all.length ? "saving" : "saved";
  });
  const key = modLabel === "⌘" ? "⌘S" : "Ctrl+S";
  let cls = "saved";
  let icon = <Check size={13} />;
  let label = "Saved";
  let tip = `Everything is saved. Click or ${key} to add a point to History now.`;
  if (conn !== "open") {
    cls = "offline";
    icon = <CloudOff size={13} />;
    label = "Offline";
    tip = "Reconnecting — your edits are kept and sent when the connection is back.";
  } else if (state === "error") {
    cls = "error";
    icon = <TriangleAlert size={13} />;
    label = "Not saved";
    tip = "A change could not be saved — see the message on the block.";
  } else if (state === "saving") {
    cls = "saving";
    icon = <span className="spinner tiny" />;
    label = "Saving…";
    tip = "Saving your edits…";
  }
  return (
    <button className={`save-status ${cls}`} onClick={() => void saveCanvas()} data-tip={tip} aria-label={`${label}. Save now`}>
      {icon}
      <span className="save-status-label">{label}</span>
    </button>
  );
}

function ToolButton({ icon, label, hint, tip, disabled, onClick }: { icon: React.ReactNode; label: string; hint?: string; tip?: string; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button className="tool-btn" disabled={disabled} onClick={onClick} aria-label={label} data-tip={tip ?? `New ${label.toLowerCase()} block (${hint})`}>
      {icon}
      <span className="tool-label">{label}</span>
    </button>
  );
}

function AgentPill() {
  const agent = useBoard((s) => s.agent);
  const running = useBoard((s) => s.turnRunning);
  const provider = useBoard((s) => s.project?.provider.label ?? "Agent");
  let cls = "";
  let content: React.ReactNode;
  if (running) {
    cls = "working";
    content = (
      <>
        <span className="dot pulse" /> Working…
      </>
    );
  } else if (agent.state === "ready") {
    cls = "ready";
    content = (
      <>
        <span className="dot" /> {provider}
      </>
    );
  } else if (agent.state === "starting") {
    content = (
      <>
        <span className="spinner tiny" /> Starting
      </>
    );
  } else if (agent.state === "needs-login") {
    cls = "warn";
    content = (
      <>
        <KeyRound size={12} /> Log in
      </>
    );
  } else if (agent.state === "error") {
    cls = "danger";
    content = (
      <>
        <TriangleAlert size={12} /> Agent error
      </>
    );
  } else {
    content = <>Agent stopped</>;
  }
  return (
    <button className={`agent-pill ${cls}`} onClick={() => setChatOpen(true)} data-tip="Open the agent chat">
      {content}
    </button>
  );
}

function ProjectName({ slug, name }: { slug: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(name), [name]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  useEffect(() => {
    document.title = `${name} · think`;
  }, [name]);
  const commit = async () => {
    setEditing(false);
    const v = value.trim();
    if (!v || v === name) return setValue(name);
    try {
      await sendJSON("PATCH", `/api/projects/${slug}`, { name: v });
    } catch (err) {
      toast.error((err as Error).message);
      setValue(name);
    }
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className="project-name-input"
        value={value}
        maxLength={100}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button className="project-name" onClick={() => setEditing(true)} data-tip="Rename">
      {name}
    </button>
  );
}
