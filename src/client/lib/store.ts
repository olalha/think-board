// The board store: everything the server tells a tab about one project, plus
// the tab-local UI state around it. Server messages are applied in one place
// (applyServerMessage) so the protocol stays easy to extend.
import { create } from "zustand";
import type { Canvas } from "../../shared/canvas";
import type {
  AgentCommand,
  AgentStatus,
  HistoryEntry,
  HistorySnapshot,
  LastTurn,
  BlockInfo,
  CanvasSettings,
  ChatEntry,
  Comment,
  GuestEntry,
  GuestInfo,
  LockState,
  ProviderInfo,
  ServerMessage,
  ValidationReport,
} from "../../shared/protocol";
import type { ConnState } from "./connection";
import { loadLocal, saveLocal, useSettings } from "./settings";
import { isPhone } from "./device";

export type ViewMode = "raw" | "rendered";

export interface BoardState {
  slug: string | null;
  conn: ConnState;
  connDetail?: string;
  loaded: boolean;
  project: { slug: string; name: string; provider: ProviderInfo; providers: ProviderInfo[]; settings: CanvasSettings } | null;
  gridSize: number;
  htmlLiveZoom: number;
  blocks: Record<string, BlockInfo>;
  canvas: Canvas;
  canvasError: string | null;
  lock: LockState;
  agent: AgentStatus;
  turnRunning: boolean;
  chat: ChatEntry[];
  validation: ValidationReport | null;
  mermaidLastValid: Record<string, string>;
  conflicts: string[];
  /** Slash commands the agent offers. */
  commands: AgentCommand[];
  /** Where the agent is working right now (for "follow the agent"). `by`: an outside agent's name. */
  agentFocus: { name: string; action: "read" | "edit"; at: number; by?: string | null } | null;
  /** Blocks and frames ringed right now: an agent changed them or points at them (`by`: an outside agent, null: the canvas agent). */
  highlights: Record<string, { at: number; by: string | null }>;
  /** Outside agents that joined this canvas (or left it), and the lines of their tabs. */
  guests: GuestInfo[];
  guestThreads: Record<string, GuestEntry[]>;
  /** Tab-local: the chat tab shown — null is the canvas agent's, else an outside agent's name. */
  chatTab: string | null;
  /** Tab-local: chat tabs with lines not seen yet ("" is the canvas agent's). */
  unreadTabs: Record<string, boolean>;
  /** A commit for History to open at (a link from an outside agent's tab). */
  historyFocus: string | null;
  /** Tab-local: the reply drafted in each outside agent's tab (remembered per canvas). */
  guestDrafts: Record<string, string>;
  readme: string | null;
  lastTurn: LastTurn | null;
  /** Text to put in the chat input (e.g. "@harry @bob " from "Ask about these"). */
  composerPrefill: string | null;
  /** History preview: the canvas as it was at an entry (read-only while set). */
  timeTravel: { entry: HistoryEntry; snap: HistorySnapshot; newer: HistoryEntry | null; older: HistoryEntry | null } | null;

  /** Tab-local: raw/rendered per block (remembered per project). */
  modes: Record<string, ViewMode>;
  /** Tab-local: long-line wrapping per block, where set (remembered per project). */
  wraps: Record<string, boolean>;
  /** Tab-local: autosave state per block. */
  saveState: Record<string, "pending" | "saving" | "error">;
  /** Bumped whenever History gains a point; an open History list reloads. */
  historyVersion: number;
  comments: Comment[];
  /** comments.json is broken on disk (the comments shown are the last good ones). */
  commentsError: string | null;
  chatOpen: boolean;
  chatUnread: boolean;
  loginOutput: string;
  loginOpen: boolean;
  loginExit: number | null | undefined;
  /** A login method the user just picked; the login dialog starts it once mounted. */
  loginRequest: string | null;
  /** Block to focus the editor of once it mounts (after create / double-click). */
  focusRequest: string | null;
}

const empty = (): Omit<BoardState, "slug" | "chatOpen" | "modes" | "wraps" | "guestDrafts"> => ({
  conn: "connecting",
  loaded: false,
  project: null,
  gridSize: 20,
  htmlLiveZoom: 0.45,
  blocks: {},
  canvas: { nodes: [], edges: [] },
  canvasError: null,
  lock: { locked: false },
  agent: { state: "stopped" },
  turnRunning: false,
  chat: [],
  validation: null,
  mermaidLastValid: {},
  conflicts: [],
  commands: [],
  agentFocus: null,
  highlights: {},
  guests: [],
  guestThreads: {},
  chatTab: null,
  unreadTabs: {},
  historyFocus: null,
  readme: null,
  lastTurn: null,
  timeTravel: null,
  composerPrefill: null,
  saveState: {},
  historyVersion: 0,
  comments: [],
  commentsError: null,
  chatUnread: false,
  loginOutput: "",
  loginOpen: false,
  loginExit: undefined,
  loginRequest: null,
  focusRequest: null,
});

export const useBoard = create<BoardState>(() => ({
  slug: null,
  chatOpen: !isPhone() && loadLocal("think.chatOpen", true),
  modes: {},
  wraps: {},
  guestDrafts: {},
  ...empty(),
}));

const modesKey = (slug: string) => `think.modes.${slug}`;
const wrapsKey = (slug: string) => `think.wraps.${slug}`;
const draftsKey = (slug: string) => `think.guestDrafts.${slug}`;

export function resetBoard(slug: string): void {
  useBoard.setState({ slug, modes: loadLocal(modesKey(slug), {}), wraps: loadLocal(wrapsKey(slug), {}), guestDrafts: loadLocal(draftsKey(slug), {}), ...empty() });
}

/** The reply drafted in an outside agent's tab ("" forgets it). */
export function setGuestDraft(name: string, text: string): void {
  const s = useBoard.getState();
  const guestDrafts = { ...s.guestDrafts };
  if (text) guestDrafts[name] = text;
  else delete guestDrafts[name];
  useBoard.setState({ guestDrafts });
  if (s.slug) saveLocal(draftsKey(s.slug), guestDrafts);
}

export function setWrap(name: string, wrap: boolean): void {
  const s = useBoard.getState();
  const wraps = { ...s.wraps, [name]: wrap };
  useBoard.setState({ wraps });
  if (s.slug) saveLocal(wrapsKey(s.slug), wraps);
}

export function setMode(name: string, mode: ViewMode): void {
  const s = useBoard.getState();
  const modes = { ...s.modes, [name]: mode };
  useBoard.setState({ modes });
  if (s.slug) saveLocal(modesKey(s.slug), modes);
}

/** Every block back to its rendered preview (R). */
export function previewAll(): void {
  const s = useBoard.getState();
  if (!Object.values(s.modes).includes("raw")) return;
  useBoard.setState({ modes: {} });
  if (s.slug) saveLocal(modesKey(s.slug), {});
}

/** Forget a block's remembered mode (deleted, or re-created by the agent). */
export function clearMode(name: string): void {
  const s = useBoard.getState();
  if (!(name in s.modes)) return;
  const modes = { ...s.modes };
  delete modes[name];
  useBoard.setState({ modes });
  if (s.slug) saveLocal(modesKey(s.slug), modes);
}

export function modeOf(name: string, type: BlockInfo["type"] | undefined): ViewMode {
  if (type === "image") return "rendered"; // drawing is its edit mode (ui-state `drawing`)
  return useBoard.getState().modes[name] ?? "rendered";
}

/** Room the canvas keeps between the side panel and the chat; with less, they take turns. */
export const MIN_CANVAS = 360;
let lastPanel: "side" | "chat" = "chat";

/** Whether the side panel and the chat fit side by side (with a usable canvas). */
export function panelsFit(sideW = Math.max(320, useSettings.getState().sidePanelWidth), chatW = useSettings.getState().chatWidth): boolean {
  return !isPhone() && window.innerWidth >= sideW + chatW + MIN_CANVAS;
}

/** The widest a panel may be dragged while the other one is open. */
export function panelMax(which: "side" | "chat", max: number): number {
  const s = useSettings.getState();
  const other = which === "side" ? (useBoard.getState().chatOpen ? s.chatWidth : 0) : s.sidePanelOpen ? Math.max(320, s.sidePanelWidth) : 0;
  return other ? Math.max(290, Math.min(max, window.innerWidth - other - MIN_CANVAS)) : max;
}

/** How long a ring stays on a block an agent changed or pointed at. */
export const HIGHLIGHT_MS = 6000;

/** Ring blocks (and frames) for a moment. */
export function addHighlights(names: string[], by: string | null): void {
  if (!names.length) return;
  const at = Date.now();
  const next = { ...useBoard.getState().highlights };
  for (const n of names) next[n] = { at, by };
  useBoard.setState({ highlights: next });
  setTimeout(() => {
    const cur = useBoard.getState().highlights;
    const kept = Object.fromEntries(Object.entries(cur).filter(([, h]) => Date.now() - h.at < HIGHLIGHT_MS - 50));
    if (Object.keys(kept).length !== Object.keys(cur).length) useBoard.setState({ highlights: kept });
  }, HIGHLIGHT_MS);
}

/** Show a chat tab (null: the canvas agent's); its unread mark goes. */
export function setChatTab(tab: string | null): void {
  const s = useBoard.getState();
  const key = tab ?? "";
  useBoard.setState({ chatTab: tab, ...(s.unreadTabs[key] ? { unreadTabs: { ...s.unreadTabs, [key]: false } } : {}) });
}

export function setChatOpen(open: boolean): void {
  const s0 = useBoard.getState();
  const key = s0.chatTab ?? "";
  useBoard.setState({ chatOpen: open, ...(open ? { chatUnread: false, ...(s0.unreadTabs[key] ? { unreadTabs: { ...s0.unreadTabs, [key]: false } } : {}) } : {}) });
  if (open) lastPanel = "chat";
  // Where both don't fit (a phone, a tablet), each panel covers the other: one at a time.
  if (open && !panelsFit() && useSettings.getState().sidePanelOpen) useSettings.getState().set("sidePanelOpen", false);
  if (isPhone()) return; // not remembered on a phone
  saveLocal("think.chatOpen", open);
}

/** Open or close the side panel (where both don't fit, opening it closes the chat). */
export function setSidePanelOpen(open: boolean): void {
  useSettings.getState().set("sidePanelOpen", open);
  if (open) lastPanel = "side";
  if (open && !panelsFit() && useBoard.getState().chatOpen) setChatOpen(false);
}

/** After the window changes size (a tablet turned): close the panel opened first if both no longer fit. */
export function fitPanels(): void {
  if (!useBoard.getState().chatOpen || !useSettings.getState().sidePanelOpen || panelsFit()) return;
  if (lastPanel === "chat") useSettings.getState().set("sidePanelOpen", false);
  else setChatOpen(false);
}

export function setSaveState(name: string, state: "pending" | "saving" | "error" | null): void {
  const cur = useBoard.getState().saveState;
  if ((cur[name] ?? null) === state) return;
  const next = { ...cur };
  if (state) next[name] = state;
  else delete next[name];
  useBoard.setState({ saveState: next });
}

/** Apply one server message. Returns nothing; UI subscribes to the slices it needs. */
export function applyServerMessage(msg: ServerMessage, onExternalChange?: (block: BlockInfo) => void): void {
  const s = useBoard.getState();
  switch (msg.type) {
    case "project.snapshot":
      useBoard.setState({
        loaded: true,
        project: msg.project,
        gridSize: msg.gridSize,
        htmlLiveZoom: msg.htmlLiveZoom,
        blocks: Object.fromEntries(msg.blocks.map((b) => [b.name, b])),
        canvas: msg.canvas,
        canvasError: msg.canvasError,
        lock: msg.lock,
        agent: msg.agent,
        turnRunning: msg.turnRunning,
        chat: msg.chat,
        validation: msg.validation,
        mermaidLastValid: msg.mermaidLastValid,
        conflicts: msg.conflicts,
        commands: msg.commands ?? [],
        readme: msg.readme ?? null,
        lastTurn: msg.lastTurn ?? null,
        comments: msg.comments ?? [],
        guests: msg.guests ?? [],
        guestThreads: msg.guestThreads ?? {},
      });
      for (const b of msg.blocks) onExternalChange?.(b);
      break;
    case "comments.changed":
      useBoard.setState({ comments: msg.comments, commentsError: msg.error });
      break;
    case "history.changed":
      useBoard.setState({ historyVersion: s.historyVersion + 1 });
      break;
    case "project.meta":
      if (s.project) useBoard.setState({ project: { ...s.project, name: msg.name, provider: msg.provider, settings: msg.settings } });
      break;
    case "file.changed":
      // A block the agent (or anyone outside this tab) just created opens
      // rendered, whatever a deleted block of the same name was showing.
      if (!s.blocks[msg.block.name] && msg.origin !== "user") clearMode(msg.block.name);
      useBoard.setState({ blocks: { ...s.blocks, [msg.block.name]: msg.block } });
      onExternalChange?.(msg.block);
      if (msg.origin === "agent" && s.turnRunning) {
        useBoard.setState({ agentFocus: { name: msg.block.name, action: "edit", at: Date.now() } });
        addHighlights([msg.block.name], null);
      }
      break;
    case "file.deleted": {
      const blocks = { ...s.blocks };
      delete blocks[msg.name];
      useBoard.setState({ blocks });
      clearMode(msg.name);
      break;
    }
    case "block.renamed": {
      const modes = { ...s.modes };
      if (msg.from in modes) {
        modes[msg.to] = modes[msg.from];
        delete modes[msg.from];
        useBoard.setState({ modes });
        if (s.slug) saveLocal(modesKey(s.slug), modes);
      }
      break;
    }
    case "readme.changed":
      useBoard.setState({ readme: msg.content });
      break;
    case "turn.summary":
      useBoard.setState({ lastTurn: msg.lastTurn });
      break;
    case "agent.commands":
      useBoard.setState({ commands: msg.commands });
      break;
    case "agent.focus":
      useBoard.setState({ agentFocus: { name: msg.name, action: msg.action, at: Date.now() } });
      if (msg.action === "edit" && s.turnRunning) addHighlights([msg.name], null);
      break;
    case "blocks.highlight":
      if (msg.names.length) useBoard.setState({ agentFocus: { name: msg.names[msg.names.length - 1], action: "edit", at: Date.now(), by: msg.by } });
      addHighlights(msg.names, msg.by);
      break;
    case "guests.changed":
      useBoard.setState({ guests: msg.guests });
      break;
    case "guest.entry": {
      const seen = s.chatOpen && s.chatTab === msg.name;
      useBoard.setState({
        guestThreads: { ...s.guestThreads, [msg.name]: [...(s.guestThreads[msg.name] ?? []), msg.entry] },
        ...(seen ? {} : { unreadTabs: { ...s.unreadTabs, [msg.name]: true } }),
        chatUnread: s.chatUnread || !s.chatOpen,
      });
      break;
    }
    case "canvas.changed":
      useBoard.setState({ canvas: msg.canvas, canvasError: msg.error });
      break;
    case "lock.changed":
      useBoard.setState({ lock: msg.lock });
      break;
    case "validation.errors":
      useBoard.setState({ validation: msg.report });
      break;
    case "mermaid.lastValid": {
      const next = { ...s.mermaidLastValid };
      if (msg.source === null) delete next[msg.name];
      else next[msg.name] = msg.source;
      useBoard.setState({ mermaidLastValid: next });
      break;
    }
    case "conflicts.changed":
      useBoard.setState({ conflicts: msg.conflicts });
      break;
    case "agent.status":
      useBoard.setState({ agent: msg.status });
      break;
    case "agent.turn":
      useBoard.setState({ turnRunning: msg.running });
      break;
    case "chat.append":
      useBoard.setState({
        chat: [...s.chat, msg.entry],
        chatUnread: s.chatUnread || !s.chatOpen,
        // Seen on another tab: the canvas agent's tab gets a mark (not for the user's own message).
        ...(s.chatTab !== null && msg.entry.kind !== "user" ? { unreadTabs: { ...s.unreadTabs, "": true } } : {}),
      });
      break;
    case "chat.delta":
      useBoard.setState({
        chat: s.chat.map((e) => (e.id === msg.id && (e.kind === "agent" || e.kind === "thought") ? { ...e, text: e.text + msg.text } : e)),
      });
      break;
    case "chat.update": {
      const i = s.chat.findIndex((e) => e.id === msg.entry.id);
      if (i === -1) useBoard.setState({ chat: [...s.chat, msg.entry] });
      else {
        const chat = s.chat.slice();
        chat[i] = msg.entry;
        useBoard.setState({ chat });
      }
      break;
    }
    case "login.output":
      useBoard.setState({ loginOutput: (s.loginOutput + msg.data).slice(-50_000), loginOpen: true, loginExit: undefined });
      break;
    case "login.exit":
      useBoard.setState({ loginExit: msg.code });
      break;
    default:
      break; // unknown message types are ignored by design
  }
}
