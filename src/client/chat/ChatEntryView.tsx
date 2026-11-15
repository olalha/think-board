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
  Copy,
  MessageCircleQuestionMark,
} from "lucide-react";
import type { AskAnswer, AskQuestion, ChatEntry } from "../../shared/protocol";
import { MarkdownView } from "../blocks/renderers";
import { act } from "../lib/project";
import { toast } from "../lib/toasts";

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

/**
 * A command's report (/context, /cost…) is long and mostly tables: its first
 * section shows, the rest fold under their headings.
 */
function splitReport(text: string): { head: string; sections: { title: string; body: string }[] } {
  const parts = text.split(/\n(?=### )/);
  if (parts.length < 3) return { head: text, sections: [] };
  const [head, first, ...rest] = parts;
  return {
    head: `${head}\n${first}`,
    sections: rest.map((p) => {
      const nl = p.indexOf("\n");
      return { title: p.slice(4, nl < 0 ? undefined : nl).trim(), body: nl < 0 ? "" : p.slice(nl + 1) };
    }),
  };
}

function AgentEntry({ text, streaming, command }: { text: string; streaming: boolean; command: boolean }) {
  const report = command && !streaming ? splitReport(text) : null;
  return (
    <div className={`chat-agent${report?.sections.length ? " chat-report" : ""}`}>
      <MarkdownView source={report ? report.head : text} />
      {report?.sections.map((s) => (
        <details key={s.title} className="chat-report-section">
          <summary>{s.title}</summary>
          <MarkdownView source={s.body} />
        </details>
      ))}
      {streaming ? <span className="caret" /> : text.trim() && <CopyReply text={text} />}
    </div>
  );
}

function CopyReply({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text.trim());
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Copying needs clipboard access in this browser.");
    }
  };
  return (
    <div className="chat-reply-actions">
      <button className="icon-btn tiny" aria-label="Copy reply as Markdown" data-tip={done ? "Copied" : "Copy as Markdown"} onClick={() => void copy()}>
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const ChatEntryView = memo(function ChatEntryView({ entry, streaming, command }: { entry: ChatEntry; streaming?: boolean; command?: boolean }) {
  switch (entry.kind) {
    case "user":
      return <UserEntry entry={entry} />;
    case "agent":
      return <AgentEntry text={entry.text} streaming={!!streaming} command={!!command} />;
    case "thought":
      return <ThoughtEntry text={entry.text} streaming={streaming} />;
    case "tool":
      return <ToolEntry entry={entry} />;
    case "permission":
      return <PermissionEntry entry={entry} />;
    case "question":
      return <QuestionEntry entry={entry} />;
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

// ---------------------------------------------------------------- the agent's questions (think ask)

/** One question's answer while the user picks: the options ticked, and the "Other" field. */
interface Draft {
  selected: string[];
  otherOn: boolean;
  other: string;
}

const answered = (d: Draft) => d.selected.length > 0 || (d.otherOn && d.other.trim().length > 0);

function QuestionEntry({ entry }: { entry: Extract<ChatEntry, { kind: "question" }> }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => entry.questions.map(() => ({ selected: [], otherOn: false, other: "" })));
  const [busy, setBusy] = useState(false);
  const settled = !!entry.outcome;
  const set = (i: number, d: Draft) => setDrafts((all) => all.map((x, j) => (j === i ? d : x)));
  const send = async (answers: AskAnswer[] | null) => {
    setBusy(true);
    await act({ type: "agent.answer", questionId: entry.id, answers });
    setBusy(false);
  };
  const submit = () =>
    void send(drafts.map((d) => (d.otherOn && d.other.trim() ? { selected: d.selected, other: d.other.trim() } : { selected: d.selected })));
  const ready = drafts.every(answered);
  const many = entry.questions.length > 1;
  return (
    <div className={`chat-question ${settled ? "settled" : ""}`}>
      <div className="chat-question-head">
        <MessageCircleQuestionMark size={15} />
        <span>{many ? "The agent has a few questions" : "The agent has a question"}</span>
      </div>
      {entry.questions.map((q, i) =>
        settled ? (
          <SettledQuestion key={i} q={q} answer={entry.outcome === "answered" ? entry.answers?.[i] : undefined} />
        ) : (
          <QuestionForm key={i} q={q} name={`${entry.id}-${i}`} draft={drafts[i]} onChange={(d) => set(i, d)} disabled={busy} />
        ),
      )}
      {settled ? (
        entry.outcome !== "answered" && (
          <div className="chat-question-outcome">{entry.outcome === "skipped" ? "Skipped" : "Cancelled — the turn ended before an answer"}</div>
        )
      ) : (
        <div className="chat-question-actions">
          <button className="btn small ghost" disabled={busy} onClick={() => void send(null)}>
            Skip
          </button>
          <button className="btn small primary" disabled={busy || !ready} onClick={submit} data-tip={ready ? undefined : "Answer every question first"}>
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionForm({ q, name, draft, onChange, disabled }: { q: AskQuestion; name: string; draft: Draft; onChange: (d: Draft) => void; disabled: boolean }) {
  const multi = !!q.multiSelect;
  const pick = (label: string, on: boolean) => {
    if (multi) onChange({ ...draft, selected: on ? [...draft.selected, label] : draft.selected.filter((l) => l !== label) });
    else if (on) onChange({ ...draft, selected: [label], otherOn: false });
  };
  const pickOther = (on: boolean) => onChange(multi ? { ...draft, otherOn: on } : { ...draft, selected: on ? [] : draft.selected, otherOn: on });
  const type = multi ? "checkbox" : "radio";
  return (
    <fieldset className="chat-q" disabled={disabled}>
      <legend className="chat-q-text">
        {q.header && <span className="chat-q-chip">{q.header}</span>}
        {q.question}
        {multi && <span className="chat-q-hint">pick any</span>}
      </legend>
      {q.options.map((o) => (
        <label key={o.label} className={`chat-q-option ${draft.selected.includes(o.label) ? "on" : ""}`}>
          <input type={type} name={name} checked={draft.selected.includes(o.label)} onChange={(e) => pick(o.label, e.target.checked)} />
          <span className="chat-q-label">
            <span>{o.label}</span>
            {o.description && <small>{o.description}</small>}
          </span>
        </label>
      ))}
      <label className={`chat-q-option other ${draft.otherOn ? "on" : ""}`}>
        <input type={type} name={name} checked={draft.otherOn} onChange={(e) => pickOther(e.target.checked)} aria-label="Other" />
        <input
          className="input chat-q-other"
          placeholder="Other…"
          value={draft.other}
          maxLength={2000}
          onFocus={() => !draft.otherOn && pickOther(true)}
          onChange={(e) => onChange({ ...draft, other: e.target.value, ...(multi ? { otherOn: true } : { otherOn: true, selected: [] }) })}
        />
      </label>
    </fieldset>
  );
}

function SettledQuestion({ q, answer }: { q: AskQuestion; answer?: AskAnswer }) {
  const parts = answer ? [...answer.selected, ...(answer.other ? [`“${answer.other}”`] : [])] : [];
  return (
    <div className="chat-q settled">
      <div className="chat-q-text">
        {q.header && <span className="chat-q-chip">{q.header}</span>}
        {q.question}
      </div>
      {answer && (
        <div className="chat-q-answer">
          <Check size={13} />
          <span>{parts.join(", ")}</span>
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
