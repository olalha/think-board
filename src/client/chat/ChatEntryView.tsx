// Rendering of one chat transcript entry.
import { memo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  FilePen,
  FileSearch,
  Info,
  Search,
  ShieldQuestion,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
  Globe2,
  MoveRight,
  Bot,
} from "lucide-react";
import type { ChatEntry } from "../../shared/protocol";
import { MarkdownView } from "../blocks/renderers";
import { act } from "../lib/project";

export const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileSearch,
  edit: FilePen,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe2,
  other: Wrench,
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const ChatEntryView = memo(function ChatEntryView({ entry, streaming }: { entry: ChatEntry; streaming?: boolean }) {
  switch (entry.kind) {
    case "user":
      return <UserEntry entry={entry} />;
    case "agent":
      return (
        <div className="chat-agent">
          <MarkdownView source={entry.text} />
          {streaming && <span className="caret" />}
        </div>
      );
    case "thought":
      return <ThoughtEntry text={entry.text} streaming={streaming} />;
    case "tool":
      return <ToolEntry entry={entry} />;
    case "permission":
      return <PermissionEntry entry={entry} />;
    case "system":
      return <SystemEntry entry={entry} />;
    case "guest":
      return (
        <div className="chat-guest">
          <div className="chat-guest-head">
            <Bot size={13} /> <b>{entry.by}</b> <span className="muted">· outside agent · {time(entry.ts)}</span>
          </div>
          <MarkdownView source={entry.text} />
        </div>
      );
    case "divider":
      return (
        <div className="chat-divider">
          <span>{entry.text}</span>
          <time>{time(entry.ts)}</time>
        </div>
      );
  }
});

function UserEntry({ entry }: { entry: Extract<ChatEntry, { kind: "user" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-user ${entry.auto ? "auto" : ""}`}>
      <div className="chat-user-bubble">
        {entry.auto && <Sparkles size={13} className="auto-icon" />}
        <span className="chat-user-text">{entry.text}</span>
      </div>
      {entry.injected && (
        <div className="injected">
          <button className="injected-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronRight size={12} className={open ? "rot" : ""} />+ injected context
          </button>
          {open && (
            <div className="injected-body">
              {entry.injected.before && (
                <>
                  <div className="injected-label">Before your message</div>
                  <pre>{entry.injected.before}</pre>
                </>
              )}
              {entry.injected.after && (
                <>
                  <div className="injected-label">After your message</div>
                  <pre>{entry.injected.after}</pre>
                </>
              )}
              <div className="injected-note">From the templates in app/prompts/.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThoughtEntry({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-thought">
      <button className="chat-thought-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={13} />
        <span>{streaming ? "Thinking…" : "Thought"}</span>
        <ChevronRight size={12} className={open ? "rot" : ""} />
      </button>
      {open && <div className="chat-thought-body">{text}</div>}
    </div>
  );
}

export function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <Check size={13} className="st-ok" />;
  if (status === "failed") return <X size={13} className="st-fail" />;
  if (status === "in_progress") return <span className="spinner tiny" />;
  return <CircleDashed size={13} className="st-pending" />;
}

export function ToolEntry({ entry }: { entry: Extract<ChatEntry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[entry.toolKind ?? "other"] ?? Wrench;
  return (
    <div className={`chat-tool ${open ? "open" : ""} status-${entry.status}`}>
      <button className="chat-tool-row" onClick={() => entry.detail && setOpen(!open)} disabled={!entry.detail}>
        <Icon size={13} className="chat-tool-icon" />
        <span className="chat-tool-title">{entry.title}</span>
        <StatusIcon status={entry.status} />
        {entry.detail && <ChevronRight size={12} className={`chevron ${open ? "rot" : ""}`} />}
      </button>
      {open && entry.detail && <pre className="chat-tool-detail">{entry.detail}</pre>}
    </div>
  );
}

function PermissionEntry({ entry }: { entry: Extract<ChatEntry, { kind: "permission" }> }) {
  const [busy, setBusy] = useState(false);
  const answer = async (optionId: string | null) => {
    setBusy(true);
    await act({ type: "agent.permission", requestId: entry.requestId, optionId });
    setBusy(false);
  };
  const label = (kind: string, name: string) =>
    kind === "allow_once" ? "Allow" : kind === "allow_always" ? "Always allow" : kind.startsWith("reject") ? "Deny" : name;
  return (
    <div className={`chat-permission ${entry.outcome ? "answered" : ""}`}>
      <div className="chat-permission-head">
        <ShieldQuestion size={15} />
        <span>{entry.title}</span>
      </div>
      {entry.outcome ? (
        <div className="chat-permission-outcome">
          {entry.outcome === "cancelled" ? "Cancelled" : entry.outcome}
        </div>
      ) : (
        <div className="chat-permission-actions">
          {entry.options.map((o) => (
            <button
              key={o.optionId}
              className={`btn small ${o.kind === "allow_once" ? "primary" : o.kind.startsWith("reject") ? "danger" : ""}`}
              disabled={busy}
              onClick={() => void answer(o.optionId)}
              title={o.name}
            >
              {label(o.kind, o.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemEntry({ entry }: { entry: Extract<ChatEntry, { kind: "system" }> }) {
  const [open, setOpen] = useState(entry.level === "error");
  const Icon = entry.level === "error" ? AlertOctagon : entry.level === "warning" ? AlertTriangle : Info;
  return (
    <div className={`chat-system ${entry.level}`}>
      <div className="chat-system-row">
        <Icon size={14} />
        <span>{entry.text}</span>
        {entry.detail && (
          <button className="link-btn" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {open && entry.detail && <pre className="chat-system-detail">{entry.detail}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- tool groups

type ToolItem = Extract<ChatEntry, { kind: "tool" }>;

/** "Edit `bob.mmd`" → "bob.mmd": the object of a tool call, for summaries. */
function toolObject(title: string): string {
  return title.replace(/^(read|edit|write|create|update|delete|view|open)\s+/i, "").replace(/[`"]/g, "").trim();
}

function summarize(tools: ToolItem[]): string {
  const edited = [...new Set(tools.filter((t) => t.toolKind === "edit" || t.toolKind === "delete" || t.toolKind === "move").map((t) => toolObject(t.title).split("/").pop() ?? ""))].filter(Boolean);
  const reads = tools.filter((t) => t.toolKind === "read" || t.toolKind === "search").length;
  const runs = tools.filter((t) => t.toolKind === "execute").length;
  const parts: string[] = [];
  if (edited.length) parts.push(`edited ${edited.slice(0, 3).join(", ")}${edited.length > 3 ? ` +${edited.length - 3}` : ""}`);
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (runs) parts.push(`ran ${runs} ${runs === 1 ? "command" : "commands"}`);
  const other = tools.length - tools.filter((t) => ["edit", "delete", "move", "read", "search", "execute"].includes(t.toolKind ?? "")).length;
  if (other) parts.push(`${other} other`);
  return parts.join(" · ");
}

/** A run of consecutive tool calls, folded into one row that expands. */
export function ToolGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = tools.filter((t) => t.status === "failed").length;
  const active = tools.find((t) => t.status === "in_progress" || t.status === "pending");
  const current = live ? active ?? tools[tools.length - 1] : undefined;
  const kinds = [...new Set(tools.map((t) => t.toolKind ?? "other"))].slice(0, 4);
  return (
    <div className={`chat-toolgroup ${open ? "open" : ""}`}>
      <button className="chat-toolgroup-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chat-toolgroup-icons">
          {kinds.map((k) => {
            const Icon = TOOL_ICONS[k] ?? Wrench;
            return <Icon key={k} size={12} />;
          })}
        </span>
        <span className="chat-toolgroup-title">
          {current && active ? (
            <span className="mono">{current.title}</span>
          ) : (
            <>
              <b>{tools.length} steps</b>
              <span className="muted"> · {summarize(tools)}</span>
            </>
          )}
        </span>
        {active && live ? <span className="spinner tiny" /> : failed ? <span className="st-fail small">{failed} failed</span> : <Check size={13} className="st-ok" />}
        <ChevronRight size={12} className={`chevron ${open ? "rot" : ""}`} />
      </button>
      {open && (
        <div className="chat-toolgroup-list">
          {tools.map((t) => (
            <ToolEntry key={t.id} entry={t} />
          ))}
        </div>
      )}
    </div>
  );
}
