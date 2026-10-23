// The WebSocket protocol between a browser tab and the server.
//
// One socket per tab, scoped to one project (`/ws/projects/<slug>`). Every
// message is a JSON object with a string `type`. Receivers ignore types they do
// not know, so adding a message type never breaks an older tab — add it to the
// relevant union below and handle it where needed.
//
// Client messages may carry a `ref`; the server answers those with an `ack`
// carrying the same `ref`, so the client can tell whether a mutation was
// accepted (e.g. rejected because the agent holds the lock).

import type { BlockType } from "./blocks.js";
import type { Drawing } from "./drawing.js";
import type { Canvas, CanvasEdge, CanvasView, FileNode, GroupNode, ViewList } from "./canvas.js";

// ---------------------------------------------------------------- shared shapes

export interface BlockInfo {
  name: string;
  file: string;
  type: BlockType;
  /** Content hash; for images it doubles as the cache-busting version. */
  hash: string;
  size: number;
  /** Text content (markdown, mermaid, html). Absent for images. */
  content?: string;
}

export interface LockState {
  locked: boolean;
  since?: number;
  /** Who holds the lock: the canvas's own agent, or an outside ("guest") agent. */
  reason?: "agent" | "guest";
  /** Guest locks: the guest's name and what it said it is doing. */
  by?: string;
  note?: string;
}

/** What changed in a range of commits, grouped for people and agents. */
export interface ChangeSummary {
  /** Block names (current names) added, edited, removed; renames old → new. */
  added: string[];
  edited: string[];
  removed: string[];
  renamed: [string, string][];
  readme: boolean;
  /** Files changed under work/ (count). */
  work: number;
  /** Other files (not blocks). */
  other: string[];
  /** Layout changes in words, one per line. */
  layout: string[];
  /** Comment changes in words, one per line ("- New comment on …"). */
  comments?: string[];
  /** Image blocks drawn on (their drawing changed). */
  drawn?: string[];
}

/** One moment in a canvas's history (see server/history.ts). */
export interface HistoryEntry {
  /** The newest commit of the moment; previews show the canvas as of here. */
  id: string;
  /** The commit just before the moment (null: it starts the history). */
  base: string | null;
  kind: "agent" | "user" | "guest" | "restore" | "app";
  /** "Agent", "You", an outside agent's name, "think". */
  who: string;
  /** Agent turns: the message that started it; others: a short description. */
  title: string;
  /** Agent turns: the start of the agent's final reply. */
  reply?: string;
  /** Agent turns that were slash commands. */
  command?: boolean;
  at: number;
  start: number;
  /** The commits inside the moment, newest first (finer restore points). */
  commits: { hash: string; at: number; subject: string }[];
  summary: ChangeSummary;
}

export interface HistorySnapshot {
  rev: string;
  canvas: Canvas;
  blocks: BlockInfo[];
  readme: string | null;
  /** Blocks this moment removed, as they were just before (null block: file unreadable). */
  ghosts: { node: FileNode; block: BlockInfo | null }[];
}

/** What the agent's most recent turn touched. */
export interface LastTurn {
  at: number;
  /** Blocks added or edited (current names). */
  changed: string[];
}

/** A slash command the agent offers (from ACP `available_commands_update`). */
export interface AgentCommand {
  name: string;
  description: string;
  /** Placeholder for the command's argument, when it takes one. */
  hint?: string;
}

export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string | null;
  /** Only terminal methods can be run from the browser login terminal. */
  terminal: boolean;
  /** A method that needs environment variables set for think (API keys): shown as a hint, not a button. */
  env?: string[];
  /**
   * Set on the method for the provider's own API key (its `apiKeyEnv`): whether
   * the server has that key — then think can switch the provider to it.
   */
  keyOnServer?: boolean;
}

export type AgentStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; sessionId: string; resumed: boolean; account?: string }
  | { state: "needs-login"; methods: AuthMethodInfo[]; message?: string }
  | { state: "error"; message: string };

export interface ProviderInfo {
  id: string;
  label: string;
}

/** A canvas's own settings, kept in its think.json (so they travel with it). */
export interface CanvasSettings {
  /**
   * How long after the first unsaved edit it is committed as a point in
   * History. 0 = only on Save now (and before agent turns, and on leaving).
   */
  autosaveSeconds: number;
}

/** The choices the settings dialog offers (the file may hold any 0–86400). */
export const AUTOSAVE_CHOICES = [30, 60, 120, 300, 600, 0] as const;

export interface ValidationIssue {
  /** Block name the issue belongs to, when it belongs to one. */
  block?: string;
  file?: string;
  message: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** 1-based attempt that produced this report; 0 when not from a turn. */
  attempt: number;
  maxAttempts: number;
  /** True once no further automatic retry will be made. */
  final: boolean;
}

export type ChatEntry =
  | {
      kind: "user";
      id: string;
      ts: number;
      /** Exactly what the user typed (or the automatic follow-up label). */
      text: string;
      /** Template text the app added around it — shown behind "+ injected context". */
      injected?: { before?: string; after?: string };
      /** Set on automatic follow-ups (validation retries), which the user did not type. */
      auto?: "validation";
    }
  | { kind: "agent"; id: string; ts: number; text: string }
  | { kind: "thought"; id: string; ts: number; text: string }
  | {
      kind: "tool";
      id: string;
      ts: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: string;
      detail?: string;
    }
  | {
      kind: "permission";
      id: string;
      ts: number;
      requestId: string;
      title: string;
      options: { optionId: string; name: string; kind: string }[];
      /** Set once answered: the chosen option name, or "cancelled". */
      outcome?: string;
    }
  | { kind: "system"; id: string; ts: number; level: "info" | "warning" | "error"; text: string; detail?: string }
  /** A message from an outside agent (posted with `think say`). */
  | { kind: "guest"; id: string; ts: number; by: string; text: string }
  | { kind: "divider"; id: string; ts: number; text: string };

/**
 * An outside agent that joined the canvas (`think join`, or `think lock`),
 * shown as a tab in the chat while it is there.
 */
export interface GuestInfo {
  name: string;
  /** What it says it is, e.g. "Claude Code in a terminal". */
  about?: string;
  state: "joined" | "left";
  /** Holds the canvas lock right now (it is editing). */
  working: boolean;
  /** What it said it is doing (when joining or taking the lock). */
  note?: string;
  joinedAt: number;
  leftAt?: number;
  /** It left because the user disconnected it. */
  disconnected?: boolean;
}

/** What happened, for an activity line in an outside agent's tab. */
export type GuestEvent = "joined" | "working" | "finished" | "left" | "disconnected" | "lapsed" | "takeover";

/**
 * One line in an outside agent's tab: its messages (`think say`) and what it
 * did. Kept per agent in .think/guests/<name>.jsonl, apart from the canvas
 * agent's chat; the canvas agent never sees these.
 */
export type GuestEntry =
  | { kind: "say"; id: string; ts: number; text: string }
  /** `rev`: the commit its edits went into (History shows it). */
  | { kind: "activity"; id: string; ts: number; event: GuestEvent; text: string; rev?: string };

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | {
      type: "project.snapshot";
      /** `providers`: every configured agent provider, which the canvas can switch to. */
      project: { slug: string; name: string; provider: ProviderInfo; providers: ProviderInfo[]; settings: CanvasSettings };
      gridSize: number;
      htmlLiveZoom: number;
      blocks: BlockInfo[];
      canvas: Canvas;
      canvasError: string | null;
      lock: LockState;
      agent: AgentStatus;
      turnRunning: boolean;
      chat: ChatEntry[];
      validation: ValidationReport | null;
      mermaidLastValid: Record<string, string>;
      conflicts: string[];
      commands: AgentCommand[];
      /** The canvas's README.md (null if missing). */
      readme: string | null;
      /** Blocks the agent's last turn added or changed (for the outline). */
      lastTurn: LastTurn | null;
      comments: Comment[];
      /** Outside agents that joined (or left) this canvas, and their tabs' lines (the latest of each). */
      guests?: GuestInfo[];
      guestThreads?: Record<string, GuestEntry[]>;
    }
  | { type: "project.meta"; name: string; provider: ProviderInfo; settings: CanvasSettings }
  | { type: "readme.changed"; content: string | null }
  | { type: "turn.summary"; lastTurn: LastTurn }
  /** A new point in History (a save, a restore, the app's housekeeping). */
  | { type: "history.changed" }
  /** The comments as they stand (`error`: comments.json is broken on disk; these are the last good ones). */
  | { type: "comments.changed"; comments: Comment[]; error: string | null }
  | { type: "file.changed"; block: BlockInfo; origin: "user" | "agent" | "external"; clientId?: string }
  | { type: "file.deleted"; name: string; file: string }
  | { type: "block.renamed"; from: string; to: string }
  | { type: "canvas.changed"; canvas: Canvas; error: string | null; clientId?: string }
  | { type: "lock.changed"; lock: LockState }
  | { type: "validation.errors"; report: ValidationReport }
  | { type: "mermaid.lastValid"; name: string; source: string | null }
  | { type: "conflicts.changed"; conflicts: string[] }
  | { type: "agent.status"; status: AgentStatus }
  | { type: "agent.turn"; running: boolean }
  | { type: "agent.commands"; commands: AgentCommand[] }
  /** The agent is working on this block right now (a tool call named its file). */
  | { type: "agent.focus"; name: string; action: "read" | "edit" }
  /** Blocks (or frames) an agent just changed or pointed at (`think show`): ring them. `by`: an outside agent's name, null for the canvas agent. */
  | { type: "blocks.highlight"; names: string[]; by: string | null }
  /** The outside agents on this canvas changed (joined, started or stopped editing, left). */
  | { type: "guests.changed"; guests: GuestInfo[] }
  /** A new line in an outside agent's tab. */
  | { type: "guest.entry"; name: string; entry: GuestEntry }
  | { type: "chat.append"; entry: ChatEntry }
  | { type: "chat.delta"; id: string; text: string }
  | { type: "chat.update"; entry: ChatEntry }
  | { type: "login.output"; data: string }
  | { type: "login.exit"; code: number | null }
  | { type: "ack"; ref: string; ok: boolean; error?: string; result?: unknown }
  | { type: "error"; message: string };

// ---------------------------------------------------------------- client → server

export type LayoutOp =
  | { op: "node.move"; id: string; x: number; y: number }
  | { op: "node.resize"; id: string; x: number; y: number; width: number; height: number }
  | { op: "edge.add"; edge: CanvasEdge }
  | { op: "edge.update"; id: string; patch: Partial<Omit<CanvasEdge, "id" | "fromNode" | "toNode">> }
  | { op: "edge.delete"; id: string }
  | { op: "node.protect"; id: string; protected: boolean }
  | { op: "group.add"; group: GroupNode }
  | { op: "group.update"; id: string; patch: { label?: string; color?: string | null } }
  | { op: "group.delete"; id: string }
  // Views and presentation slides share these; `list` says which (default "views").
  | { op: "view.add"; view: CanvasView; list?: ViewList }
  /** `target: null` unties a view from its node. Renaming by hand stops `followName` unless the patch sets it. */
  | { op: "view.update"; id: string; patch: Partial<Omit<CanvasView, "id" | "target">> & { target?: string | null }; list?: ViewList }
  | { op: "view.delete"; id: string; list?: ViewList }
  | { op: "view.move"; id: string; index: number; list?: ViewList };

/** A note on a block, a frame, or (on: null) the canvas as a whole — kept in comments.json. */
export interface Comment {
  id: string;
  on: string | null;
  /** "you" (the app's user), "agent", or an outside agent's name. */
  by: string;
  text: string;
  /** ISO time it was written (`edited`: last changed). */
  at: string;
  edited?: string;
  done?: { by: string; at: string; note?: string };
}

/** A copied block, pasted (or duplicated) into a canvas. */
export interface PasteBlock {
  /** Its name where it was copied from (the edges refer to it). */
  from: string;
  type: BlockType;
  /** Text blocks: the content. */
  content?: string;
  /** Image blocks: the file to copy, from a canvas on this server. */
  image?: { canvas: string; file: string };
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ClientMessage = { ref?: string } & (
  | { type: "user.edit"; name: string; content: string }
  | { type: "user.layout"; ops: LayoutOp[] }
  | { type: "block.create"; blockType: "markdown" | "mermaid" | "html"; x: number; y: number }
  | { type: "block.delete"; names: string[] }
  | { type: "block.rename"; name: string; to: string }
  /** Paste copied blocks (and the frames and connections among them) → the new names and group ids by old. */
  | { type: "blocks.paste"; blocks: PasteBlock[]; edges: CanvasEdge[]; groups: GroupNode[] }
  | { type: "readme.edit"; content: string }
  /** The drawing on an image block (a fresh one if it has none) → { drawing, history, saved }. */
  | { type: "drawing.open"; name: string }
  /** Save a drawing: the block's image becomes the rendered result → { hash }. */
  | { type: "drawing.save"; name: string; drawing: Drawing; history?: unknown }
  /** A new sketch block (a blank page to draw on) → { name }. */
  | { type: "sketch.create"; x: number; y: number; background?: string }
  | { type: "comment.add"; on: string | null; text: string }
  | { type: "comment.update"; id: string; text: string }
  | { type: "comment.delete"; ids: string[] }
  /** Tick a comment done (or reopen it). */
  | { type: "comment.done"; id: string; done: boolean }
  /** Save a point in History now (commit the user's edits). */
  | { type: "canvas.save" }
  | { type: "canvas.settings"; settings: Partial<CanvasSettings> }
  | { type: "history.list"; before?: string; limit?: number }
  | { type: "history.snapshot"; rev: string; base?: string | null }
  | { type: "history.diff"; rev: string; name: string }
  /** Restore blocks (or, with no names, the whole canvas) to how they were at `rev`. */
  | { type: "history.restore"; rev: string; names?: string[] }
  /** End an outside agent's lock now (its edits are committed under its name). */
  | { type: "guest.takeover" }
  /** Disconnect an outside agent: its lock ends (edits committed under its name) and its tab goes. */
  | { type: "guest.disconnect"; name: string }
  | { type: "block.revert"; name: string }
  | { type: "block.undoDelete"; batch: string }
  | { type: "agent.prompt"; text: string }
  | { type: "agent.cancel" }
  | { type: "agent.permission"; requestId: string; optionId: string | null }
  | { type: "agent.restart" }
  | { type: "agent.newSession" }
  /** Switch the canvas to another provider's agent, in a new conversation. */
  | { type: "agent.switch"; provider: string }
  | { type: "login.start"; methodId: string; cols: number; rows: number }
  | { type: "login.input"; data: string }
  | { type: "login.resize"; cols: number; rows: number }
  | { type: "login.stop" }
);

export type ClientMessageType = ClientMessage["type"];
