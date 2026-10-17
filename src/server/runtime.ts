// ProjectRuntime — everything live about one open project.
//
// The filesystem is the single source of truth. A watcher sees every change
// to the folder, whoever made it, and broadcasts it; the server's own writes
// are recognised by content hash and not echoed. All mutations go through one
// serial queue per project, so edits, layout changes, watcher events and turn
// steps can never interleave.
//
// While the agent works (a "turn") the project is locked: the server rejects
// every user mutation, and canvas.json is only reconciled in memory for
// display — it is written back once the turn is over.

import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { imageSize } from "image-size";
import type * as acp from "@agentclientprotocol/sdk";
import {
  BLOCK_SIZES,
  displayName,
  EXTENSION_PRECEDENCE,
  extensionForMime,
  initialContent,
  isTextType,
  isValidName,
  parseBlockFile,
  TYPE_EXTENSION,
  type BlockType,
} from "../shared/blocks.js";
import { EDGE_STYLES, emptyCanvas, serializeCanvas, SIDES, type Canvas, type CanvasEdge, type CanvasNode, type CanvasView, type FileNode, type GroupNode, type Side } from "../shared/canvas.js";
import type {
  AgentCommand,
  AgentStatus,
  BlockInfo,
  CanvasSettings,
  Comment,
  ChatEntry,
  ClientMessage,
  GuestEntry,
  LastTurn,
  LayoutOp,
  LockState,
  PasteBlock,
  ServerMessage,
  ValidationIssue,
  ValidationReport,
} from "../shared/protocol.js";
import { AgentHost, AuthRequiredError } from "./agent/host.js";
import { agentEnv } from "./agent/env.js";
import type { LoginManager, LoginSink } from "./agent/login.js";
import {
  defaultSize,
  GROUP_MIN,
  lintCanvas,
  matchRenames,
  parseCanvas,
  reconcileCanvas,
  renameInCanvas,
  snap,
  snapGroup,
  snapSize,
  type BlockEntry,
  type RenameCandidate,
} from "./canvas-model.js";
import { ChatLog } from "./chatlog.js";
import type { ConfigStore, Paths, ProviderConfig } from "./config.js";
import { readJson, writeAtomic, writeJson } from "./fsutil.js";
import {
  AGENT_EMAIL,
  APP_AUTHOR,
  APP_EMAIL,
  changedPaths,
  commitAll,
  commitPaths,
  commitsSince,
  commitUserChanges,
  filesChangedBetween,
  git,
  head,
  isAncestor,
  showFile,
  USER_AUTHOR,
  USER_EMAIL,
} from "./git.js";
import { briefSummary, commitWork, isEmptySummary, summarizeRange, summaryLines, type ChangeSummary } from "./changes.js";
import { CANVAS_COMMANDS, CHANGING_COMMANDS, GUEST_ONLY_COMMANDS, LAYOUT_COMMANDS, OpError, runCommand, toCommandRequest, type Caller, type CommandHost, type CommandRequest } from "./commands.js";
import { GuestRoom } from "./guest-room.js";
import { RequestDir } from "./requests.js";
import { historySnapshot, listHistory } from "./history.js";
import type { MermaidValidator } from "./mermaid.js";
import { allocateName } from "./names.js";
import { SLUG_RE, UserError, type ProjectMeta, type ProjectState, type ProjectStore } from "./projects.js";
import type { Templates } from "./templates.js";
import { NewerFormatError, readThinkFile, sameThinkFile, serializeThinkFile, THINK_FILE } from "./think-file.js";
import { COMMENTS_FILE, MAX_COMMENT, parseComments, serializeComments } from "./comments.js";
import { BASE_FILE_RE, DRAWINGS_DIR, drawingSchema, readDrawing, renderDrawing, sidecarDir } from "./drawings.js";
import { DRAWING_FORMAT, type Drawing } from "../shared/drawing.js";
import { errorMessage, hashOf, newId, SerialQueue, type Logger } from "./util.js";

export interface ClientConn {
  id: string;
  send(msg: ServerMessage): void;
}

export interface RuntimeDeps {
  slug: string;
  paths: Paths;
  store: ProjectStore;
  config: ConfigStore;
  templates: Templates;
  mermaid: MermaidValidator;
  logins: LoginManager;
  log: Logger;
  /** Called once the runtime has shut itself down after its idle grace period. */
  onClosed?: () => void;
  /** Called after a login terminal for this project's provider exits. */
  onProviderLogin?: (providerId: string) => void;
}

interface FileEntry {
  name: string;
  file: string;
  ext: string;
  type: BlockType;
  hash: string;
  size: number;
  content?: string;
  natural?: { width: number; height: number };
  firstSeen: number;
  mtimeMs: number;
}

/** The block header above an image (see blocks.css), so a refitted block shows the whole picture. */
const IMAGE_HEADER = 34;
/** How many deletions back "undo" can reach (their files are kept in .think/trash until then). */
const MAX_UNDOABLE_DELETIONS = 30;
/** Text blocks larger than this are shown as an error instead of loaded into editors. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export class ProjectRuntime {
  readonly slug: string;
  readonly dir: string;
  private readonly thinkDir: string;
  private readonly queue = new SerialQueue();
  private readonly clients = new Map<string, ClientConn>();

  private meta!: ProjectMeta;
  private provider: ProviderConfig | undefined;
  private state!: ProjectState;
  private chat!: ChatLog;

  /** Every block file on disk, by filename. */
  private files = new Map<string, FileEntry>();
  /** The file that owns each block name (see EXTENSION_PRECEDENCE). */
  private blocks = new Map<string, FileEntry>();
  private conflicts: string[] = [];

  private canvasDiskHash: string | null = null;
  private canvasText: string | null = null;
  /**
   * What canvas.json on disk means, in our canonical serialisation — null when
   * it is missing or invalid. Writes compare against this, not the raw text, so
   * an agent's own JSON formatting never causes a rewrite (or a noise commit).
   */
  private diskCanonical: string | null = null;
  private lastValid: Canvas = emptyCanvas();
  private canvasError: string | null = null;
  private view: Canvas = emptyCanvas();

  private lock: LockState = { locked: false };
  private turnRunning = false;
  private cancelRequested = false;
  /** A login or a provider setting changed during a turn: restart the agent once it ends. */
  private restartAfterTurn = false;
  /** Block name → last touch time; anchors auto-placement. Reset each turn. */
  private touched = new Map<string, number>();

  private validation: ValidationReport | null = null;
  private mermaidLastValid: Record<string, string> = {};
  private mermaidTimers = new Map<string, NodeJS.Timeout>();

  private agent: AgentHost | null = null;
  private agentStatus: AgentStatus = { state: "stopped" };
  private agentStarting: Promise<void> | null = null;
  private pendingPermissions = new Map<string, { resolve: (optionId: string | null) => void; entryId: string }>();
  private streaming: { id: string; kind: "agent" | "thought"; text: string; ts: number } | null = null;
  private toolEntries = new Map<string, string>();
  /** Recent deletions that can still be undone (newest last; their files wait in .think/trash/<batch>). */
  private deletions = new Map<string, { files: { name: string; file: string }[]; nodes: Canvas["nodes"]; edges: Canvas["edges"]; drawings: string[] }>();

  /** comments.json as last read (the last valid version, when the file is broken). */
  private comments: Comment[] = [];
  private commentsError: string | null = null;
  /**
   * Comment changes made while the canvas is locked (agent turn, outside
   * agent): shown to every tab at once, written to the file when the lock ends.
   */
  private pendingComments: ((list: Comment[]) => Comment[])[] = [];

  /** README.md, as on disk (null when missing). */
  private readme: string | null = null;
  private readmeHash: string | null = null;
  /** What the last turn changed (for the outline's marks). */
  private lastTurn: LastTurn | null = null;
  /**
   * During a turn: each protected block as it was when the turn started, and
   * the user's edits to it meanwhile (written to the file once the turn ends).
   */
  private pinned = new Map<string, { file: string; bytes: Buffer; node: FileNode; draft?: string }>();
  private turnStartedAt = 0;
  /** The agent's last message in the current turn (recorded in History). */
  private lastReply = "";
  /** Slash commands the agent offers (minus the provider's hidden ones). */
  private commands: AgentCommand[] = [];
  /**
   * Blocks whose file vanished (seen by the watcher, not deleted from the UI),
   * kept for a while so that a file appearing under a new name with the same
   * content is recognised as a rename and keeps the old node's place.
   */
  private recentlyGone = new Map<string, { cand: RenameCandidate; node?: FileNode; edges?: CanvasEdge[]; at: number }>();

  private watcher: FSWatcher | null = null;
  private fsTimers = new Map<string, NodeJS.Timeout>();
  private autosaveTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private loginSinks = new Map<string, LoginSink>();
  private closed = false;
  private suppressNextDivider = false;

  /** Outside agents that joined this canvas, and their tabs. */
  private readonly room: GuestRoom;
  /** The canvas agent's own way to the `think` command (.think/cli/), open while the canvas is. */
  private agentRequests: RequestDir | null = null;
  /** The canvas agent's one-line summary of its turn (`think summary`), heading the turn's commit. */
  private turnSummary: string | null = null;
  /** An outside agent's `think summary`, for the commit when its lock ends. */
  private guestSummaries = new Map<string, string>();

  constructor(private readonly deps: RuntimeDeps) {
    this.slug = deps.slug;
    this.dir = deps.store.dir(deps.slug);
    this.thinkDir = deps.store.thinkDir(deps.slug);
    this.room = new GuestRoom(this.thinkDir);
  }

  private get log(): Logger {
    return this.deps.log;
  }

  private get grid(): number {
    return this.deps.config.get().gridSize;
  }

  // ================================================================== lifecycle

  async open(): Promise<void> {
    await fs.mkdir(this.thinkDir, { recursive: true });
    // Upgrade an older canvas first (a newer one is refused: NewerFormatError).
    await this.deps.store.migrate(this.slug).catch((err) => {
      if (err instanceof NewerFormatError) throw err;
      this.log.error("could not upgrade the canvas folder", { error: errorMessage(err) });
    });
    this.meta = await this.deps.store.meta(this.slug);
    this.provider = this.deps.config.provider(this.meta.provider);
    this.state = await this.deps.store.readState(this.slug);
    this.chat = new ChatLog(path.join(this.thinkDir, "chat.jsonl"));
    await this.chat.load();
    await this.room.load();
    this.mermaidLastValid = await readJson(path.join(this.thinkDir, "mermaid-last-valid.json"), {});
    this.lastValid = await readJson(path.join(this.thinkDir, "canvas-last-valid.json"), emptyCanvas());

    await fs.rm(path.join(this.thinkDir, "trash"), { recursive: true, force: true });
    await this.syncThinkFile({ repair: true });
    await this.readComments();
    await this.readReadme();
    this.lastTurn = await readLastTurn(path.join(this.thinkDir, "turns.jsonl"));
    await this.scanFiles();
    await this.syncCanvasFile({ initial: true });

    if (this.state.turnInProgress) await this.recoverInterruptedTurn();
    await this.renderInstructions().catch((err) => this.log.error("could not render instructions", { error: errorMessage(err) }));
    await this.refreshView({ write: true });
    if ((await changedPaths(this.dir)).length) this.scheduleAutosave();
    for (const b of this.blocks.values()) if (b.type === "mermaid" && !this.mermaidLastValid[b.name]) this.checkMermaid(b.name);
    this.startWatcher();
    // The canvas agent's requests from the `think` command. Any left from
    // before belonged to a turn that is over: dropped, not run.
    this.agentRequests = new RequestDir(path.join(this.thinkDir, "cli"), (req) => this.agentRequest(req), this.log);
    await this.agentRequests.start({ leftovers: false }).catch((err) => this.log.error("the think command is unavailable to the canvas agent", { error: errorMessage(err) }));
  }

  /** The server died mid-turn: commit what the agent left and clear the stale lock state. */
  private async recoverInterruptedTurn(): Promise<void> {
    const committed = await commitAll(this.dir, { message: "agent: uncommitted changes (turn interrupted by a server restart)" });
    this.state.turnInProgress = false;
    this.state.lastAgentHead = await head(this.dir);
    await this.saveState();
    await this.addSystem("warning", "The previous agent turn was interrupted by a server restart." + (committed ? " Its uncommitted changes were committed." : ""));
  }

  attach(client: ClientConn): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.clients.set(client.id, client);
    client.send(this.snapshot());
    const login = this.provider ? this.deps.logins.get(this.provider.id) : undefined;
    if (login) this.attachLogin(client, login);
    void this.ensureAgent();
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
    const sink = this.loginSinks.get(clientId);
    if (sink && this.provider) this.deps.logins.get(this.provider.id)?.detach(sink);
    this.loginSinks.delete(clientId);
    if (this.clients.size === 0) this.scheduleClose();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Rename the canvas (think.json, committed as the app). */
  renameCanvas(name: string): Promise<void> {
    return this.queue.run(async () => {
      const clean = name.trim().slice(0, 100);
      if (!clean) throw new UserError("A canvas needs a name.");
      this.assertUnlocked(); // no app commit while someone else is committing
      if (clean === this.meta.name) return;
      await this.writeMeta({ ...this.meta, name: clean }, `think: renamed the canvas to “${clean}”`);
      await this.renderInstructions().catch(() => {});
    });
  }

  private async updateSettings(patch: Partial<CanvasSettings>): Promise<void> {
    this.assertUnlocked();
    const next = { ...this.meta.settings };
    if (patch.autosaveSeconds !== undefined) {
      const v = patch.autosaveSeconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 86400) throw new UserError("That autosave setting is not valid.");
      next.autosaveSeconds = v;
    }
    if (JSON.stringify(next) === JSON.stringify(this.meta.settings)) return;
    const what = next.autosaveSeconds ? `autosave every ${formatSeconds(next.autosaveSeconds)}` : "autosave off (save with Save now)";
    await this.writeMeta({ ...this.meta, settings: next }, `think: ${what}`);
    this.clearAutosave();
    if ((await changedPaths(this.dir)).some((p) => p !== THINK_FILE)) this.scheduleAutosave();
  }

  /** Write think.json from `meta`, commit only it, and tell every tab. Callers hold the queue. */
  private async writeMeta(meta: ProjectMeta, message: string): Promise<void> {
    this.meta = meta;
    await this.deps.store.writeMeta(this.slug, meta, message);
    this.broadcastMeta();
    this.broadcast({ type: "history.changed" });
  }

  private broadcastMeta(): void {
    this.broadcast({ type: "project.meta", name: this.meta.name, settings: this.meta.settings });
  }

  /**
   * think.json changed on disk (an agent, a person, git) — or is being checked
   * on open or after a turn (`repair`). A valid change to the name or the
   * settings is adopted; anything else (broken JSON, a changed format or
   * provider, a deleted file) gets the app's version written back — straight
   * away, or after the agent's turn when one is running.
   */
  private async syncThinkFile(opts: { repair?: boolean } = {}): Promise<void> {
    const r = await readThinkFile(this.dir, this.deps.store.defaultSettings());
    if (r.ok && r.file.format === this.meta.format && r.file.provider === this.meta.provider) {
      if (sameThinkFile(r.file, this.meta)) return;
      const autosaveChanged = r.file.settings.autosaveSeconds !== this.meta.settings.autosaveSeconds;
      this.meta = r.file;
      this.broadcastMeta();
      if (autosaveChanged) {
        this.clearAutosave();
        this.scheduleAutosave();
      }
      return;
    }
    if (this.lock.locked && !opts.repair) return;
    const problem = r.ok ? "a change to what the app manages" : "missing" in r ? "the file was missing" : r.error;
    this.log.warn("restoring think.json", { problem });
    await writeAtomic(path.join(this.dir, THINK_FILE), serializeThinkFile(this.meta), this.thinkDir);
    await commitPaths(this.dir, [THINK_FILE], { message: "think: restored think.json" });
  }

  get providerId(): string | undefined {
    return this.meta?.provider;
  }

  /** For the project list: is an agent turn in progress right now? */
  get working(): boolean {
    return this.turnRunning;
  }

  get agentState(): AgentStatus["state"] {
    return this.agentStatus.state;
  }

  /** Nobody is looking and nobody is working: close after the idle grace period (the `think` command opens canvases too). */
  idleCheck(): void {
    if (this.clients.size === 0 && !this.lock.locked && !this.closed && !this.closeTimer) this.scheduleClose();
  }

  private scheduleClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const grace = this.deps.config.get().agentIdleShutdownSeconds * 1000;
    this.closeTimer = setTimeout(() => void this.closeIfIdle(), grace);
  }

  private async closeIfIdle(): Promise<void> {
    this.closeTimer = null;
    if (this.clients.size > 0 || this.closed || this.guest) return;
    if (this.turnRunning) {
      // Let the turn finish; runTurn re-checks when it ends.
      return;
    }
    await this.close();
    this.deps.onClosed?.();
  }

  /** Flush pending user edits to git, stop the agent and the watcher. */
  async close(opts: { serverShutdown?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.clearAutosave();
    for (const t of this.fsTimers.values()) clearTimeout(t);
    for (const t of this.mermaidTimers.values()) clearTimeout(t);
    await this.watcher?.close();
    this.watcher = null;
    await this.agentRequests?.stop();
    this.agentRequests = null;
    this.finalizeStreaming();
    if (!this.lock.locked) {
      await this.queue.run(() => this.commitUser()).catch((err) => this.log.error("final commit failed", { error: errorMessage(err) }));
    } else if (opts.serverShutdown) {
      // The turn dies with the server; state.turnInProgress stays set so the
      // next start commits whatever the agent left behind.
      this.log.warn("server shutting down during an agent turn");
    }
    for (const p of this.pendingPermissions.values()) p.resolve(null);
    await this.agent?.stop();
    this.agent = null;
  }

  // ================================================================== snapshot / broadcast

  private snapshot(): ServerMessage {
    const cfg = this.deps.config.get();
    return {
      type: "project.snapshot",
      project: {
        slug: this.slug,
        name: this.meta.name,
        provider: { id: this.meta.provider, label: this.provider?.label ?? this.meta.provider },
        settings: this.meta.settings,
      },
      gridSize: cfg.gridSize,
      htmlLiveZoom: cfg.htmlLiveZoom,
      blocks: [...this.blocks.values()].map((b) => this.blockInfo(b)),
      canvas: this.view,
      canvasError: this.canvasError,
      lock: this.lock,
      agent: this.agentStatus,
      turnRunning: this.turnRunning,
      chat: this.chat.all(),
      validation: this.validation,
      mermaidLastValid: this.mermaidLastValid,
      conflicts: this.conflicts,
      commands: this.commands,
      readme: this.readme,
      lastTurn: this.lastTurn,
      comments: this.shownComments(),
      guests: this.room.info(this.guest?.by ?? null),
      guestThreads: this.room.threads(),
    };
  }

  private broadcast(msg: ServerMessage, exceptClientId?: string): void {
    for (const c of this.clients.values()) if (c.id !== exceptClientId) c.send(msg);
  }

  private blockInfo(b: FileEntry): BlockInfo {
    // A protected block shows the user's version during a turn, whatever the agent wrote.
    const p = this.pinned.get(b.name);
    if (p && p.file === b.file && isTextType(b.type)) {
      const content = p.draft ?? p.bytes.toString("utf8");
      return { name: b.name, file: b.file, type: b.type, hash: hashOf(content), size: Buffer.byteLength(content), content };
    }
    return { name: b.name, file: b.file, type: b.type, hash: b.hash, size: b.size, content: b.content };
  }

  // ================================================================== README

  private async readReadme(): Promise<boolean> {
    let text: string | null;
    try {
      text = await fs.readFile(path.join(this.dir, "README.md"), "utf8");
    } catch {
      text = null;
    }
    const hash = text === null ? null : hashOf(text);
    if (hash === this.readmeHash) return false;
    this.readme = text;
    this.readmeHash = hash;
    return true;
  }

  private async syncReadme(): Promise<void> {
    if (!(await this.readReadme())) return;
    this.broadcast({ type: "readme.changed", content: this.readme });
    if (!this.lock.locked) this.scheduleAutosave();
  }

  private async editReadme(client: ClientConn, content: string): Promise<void> {
    this.assertUnlocked();
    if (typeof content !== "string" || content.length > 200_000) throw new UserError("Invalid README.");
    if (content === this.readme) return;
    this.readme = content;
    this.readmeHash = hashOf(content);
    await writeAtomic(path.join(this.dir, "README.md"), content, this.thinkDir);
    this.broadcast({ type: "readme.changed", content }, client.id);
    this.scheduleAutosave();
  }

  // ================================================================== files

  private async readEntry(file: string, prev?: FileEntry): Promise<FileEntry | null> {
    const parsed = parseBlockFile(file);
    if (!parsed) return null;
    let buf: Buffer;
    let stat;
    try {
      buf = await fs.readFile(path.join(this.dir, file));
      stat = await fs.stat(path.join(this.dir, file));
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const entry: FileEntry = {
      ...parsed,
      file,
      hash: hashOf(buf),
      size: buf.length,
      firstSeen: prev?.firstSeen ?? (stat.birthtimeMs || stat.mtimeMs),
      mtimeMs: stat.mtimeMs,
    };
    if (isTextType(parsed.type)) {
      entry.content = buf.length > MAX_TEXT_BYTES ? `(This file is ${(buf.length / 1048576).toFixed(1)} MB — too large to show on the canvas.)` : buf.toString("utf8");
    } else {
      try {
        const dim = imageSize(buf);
        if (dim.width && dim.height) entry.natural = { width: dim.width, height: dim.height };
      } catch {
        /* unreadable image: still a block, shown broken */
      }
    }
    return entry;
  }

  private async scanFiles(): Promise<void> {
    const names = await fs.readdir(this.dir);
    for (const file of names) {
      const entry = await this.readEntry(file);
      if (entry) this.files.set(file, entry);
    }
    this.recomputeBlocks();
  }

  /** Decide which file owns each name and describe any clashes. Returns names whose owner changed. */
  private recomputeBlocks(): Set<string> {
    const byName = new Map<string, FileEntry[]>();
    for (const f of this.files.values()) {
      const list = byName.get(f.name) ?? [];
      list.push(f);
      byName.set(f.name, list);
    }
    const next = new Map<string, FileEntry>();
    const conflicts: string[] = [];
    for (const [name, list] of byName) {
      list.sort((a, b) => EXTENSION_PRECEDENCE.indexOf(a.ext) - EXTENSION_PRECEDENCE.indexOf(b.ext));
      next.set(name, list[0]);
      if (list.length > 1) {
        conflicts.push(
          `Block name "${name}" is used by ${list.map((f) => f.file).join(" and ")}; names must be unique across extensions, so only ${list[0].file} is shown. Rename or remove the other file.`,
        );
      }
    }
    const changed = new Set<string>();
    for (const name of new Set([...this.blocks.keys(), ...next.keys()])) {
      if (this.blocks.get(name)?.file !== next.get(name)?.file) changed.add(name);
    }
    this.blocks = next;
    if (conflicts.join("\n") !== this.conflicts.join("\n")) {
      this.conflicts = conflicts;
      this.broadcast({ type: "conflicts.changed", conflicts });
    }
    return changed;
  }

  private blockEntries(): Map<string, BlockEntry> {
    const m = new Map<string, BlockEntry>();
    for (const [name, f] of this.blocks) m.set(name, { file: f.file, type: f.type, natural: f.natural });
    return m;
  }

  private firstSeenMap(): Map<string, number> {
    return new Map([...this.blocks].map(([name, f]) => [name, f.firstSeen]));
  }

  private startWatcher(): void {
    const dir = this.dir;
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      // Top-level files only; nothing hidden (.git, .think, .annotations, …).
      ignored: (p: string) => {
        const rel = path.relative(dir, p);
        if (!rel) return false;
        return rel.includes(path.sep) || rel.startsWith(".");
      },
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    this.watcher.on("all", (event, p) => {
      if (event === "addDir" || event === "unlinkDir") return;
      const file = path.basename(p);
      const prev = this.fsTimers.get(file);
      if (prev) clearTimeout(prev);
      this.fsTimers.set(
        file,
        setTimeout(() => {
          this.fsTimers.delete(file);
          void this.queue.run(() => this.syncPath(file)).catch((err) => this.log.error("sync failed", { file, error: errorMessage(err) }));
        }, 40),
      );
    });
    this.watcher.on("error", (err) => this.log.error("watcher error", { error: errorMessage(err) }));
  }

  /** Bring our view of one path up to date with the disk. Runs in the queue. */
  private async syncPath(file: string): Promise<void> {
    if (this.closed) return;
    if (file === "canvas.json") return this.syncCanvasFile();
    if (file === "README.md") return this.syncReadme();
    if (file === THINK_FILE) return this.syncThinkFile();
    if (file === COMMENTS_FILE) {
      if (this.guest) this.touchGuest();
      return this.syncComments();
    }
    if (!parseBlockFile(file)) return;
    const prev = this.files.get(file);
    const entry = await this.readEntry(file, prev);
    const origin = this.lock.locked && this.lock.reason === "agent" ? "agent" : "external";
    if (this.guest) this.touchGuest();

    if (!entry) {
      if (!prev) return;
      if (this.blocks.get(prev.name)?.file === prev.file) {
        this.recentlyGone.set(prev.name, { cand: renameCandidate(prev), at: Date.now() });
      }
      this.files.delete(file);
      const changed = this.recomputeBlocks();
      if (changed.has(prev.name)) {
        const now = this.blocks.get(prev.name);
        if (now) this.broadcast({ type: "file.changed", block: this.blockInfo(now), origin });
        else this.broadcast({ type: "file.deleted", name: prev.name, file });
      }
      await this.refreshView({ write: !this.lock.locked });
      if (!this.lock.locked) this.scheduleAutosave();
      return;
    }

    if (prev && prev.hash === entry.hash) return; // our own write, or a no-op touch
    this.files.set(file, entry);
    if (entry.type === "image") {
      // Something else replaced a drawn-on picture: the drawing no longer fits it.
      const d = await readDrawing(this.dir, entry.name);
      if (d?.output && d.output !== entry.hash) {
        this.log.info("image replaced; its drawing was removed", { name: entry.name });
        await this.dropDrawing(entry.name);
      }
    }
    const changedOwner = this.recomputeBlocks();
    // File mtime, not "now": a rescan must not reorder what was touched when.
    this.touched.set(entry.name, entry.mtimeMs);
    if (this.blocks.get(entry.name)?.file === file) {
      this.broadcast({ type: "file.changed", block: this.blockInfo(entry), origin });
      if (entry.type === "mermaid") this.checkMermaid(entry.name);
      // An outside agent editing: ring the block, as the canvas agent's edits are.
      if (this.guest && this.lock.reason === "guest") this.highlight([entry.name], this.guest.by);
    }
    if (!prev || changedOwner.size) await this.refreshView({ write: !this.lock.locked });
    if (!this.lock.locked) this.scheduleAutosave();
  }

  /**
   * Bring every block file and canvas.json up to date now, without waiting for
   * the watcher. Post-turn steps call this so they never race an agent that
   * wrote a file a few milliseconds before its turn ended.
   */
  private async rescanAll(): Promise<void> {
    const onDisk = new Set((await fs.readdir(this.dir)).filter((f) => parseBlockFile(f)));
    const known = new Set(this.files.keys());
    const all = [...new Set([...onDisk, ...known])].sort(
      (a, b) => (this.files.get(a)?.mtimeMs ?? 0) - (this.files.get(b)?.mtimeMs ?? 0),
    );
    for (const file of all) await this.syncPath(file);
    await this.syncCanvasFile();
  }

  private async syncCanvasFile(opts: { initial?: boolean } = {}): Promise<void> {
    let text: string | null;
    try {
      text = await fs.readFile(path.join(this.dir, "canvas.json"), "utf8");
    } catch {
      text = null;
    }
    const hash = text === null ? null : hashOf(text);
    if (!opts.initial && hash === this.canvasDiskHash) return;
    this.canvasDiskHash = hash;
    this.canvasText = text;
    if (text === null) {
      this.diskCanonical = null;
      this.canvasError = "canvas.json is missing.";
    } else {
      const r = parseCanvas(text);
      if (r.ok) {
        this.lastValid = r.canvas;
        this.diskCanonical = serializeCanvas(r.canvas);
        this.canvasError = null;
        await this.persistLastValid();
      } else {
        this.diskCanonical = null;
        this.canvasError = r.error;
      }
    }
    if (!opts.initial) {
      // A missing canvas.json outside a turn is simply rewritten from the last valid layout.
      await this.refreshView({ write: !this.lock.locked && (this.canvasError === null || text === null), force: true });
      if (!this.lock.locked) this.scheduleAutosave();
    }
  }

  /**
   * Recompute the displayed layout (last valid canvas reconciled against the
   * files) and, when allowed, write it back to canvas.json.
   */
  private async refreshView(opts: { write: boolean; force?: boolean; clientId?: string }): Promise<void> {
    const renames = this.detectRenames();
    const r = reconcileCanvas(this.lastValid, this.blockEntries(), {
      gridSize: this.grid,
      touched: this.touched,
      firstSeen: this.firstSeenMap(),
      renames,
    });
    // Nodes dropped because their file vanished: keep them briefly in case the
    // file turns up again under another name (a rename done outside the app).
    for (const id of r.removed) {
      const g = this.recentlyGone.get(id);
      const node = this.lastValid.nodes.find((n): n is FileNode => n.id === id && n.type === "file");
      if (g && node && !g.node) {
        g.node = node;
        g.edges = this.lastValid.edges.filter((e) => e.fromNode === id || e.toNode === id);
      }
    }
    for (const [to, from] of r.renamed) {
      // Keep the rename in the layout we build on, not only in what is shown:
      // the vanished file's candidate is used up once matched.
      const file = this.blocks.get(to)?.file;
      if (file) this.lastValid = renameInCanvas(this.lastValid, from, to, file);
      this.movedName(from, to);
    }
    const before = serializeCanvas(this.view);
    this.view = r.canvas;
    const text = serializeCanvas(r.canvas);
    if (opts.write && text !== this.diskCanonical && (this.canvasError === null || this.canvasText === null)) {
      await this.writeCanvas(r.canvas);
    }
    if (opts.force || text !== before) {
      this.broadcast({ type: "canvas.changed", canvas: this.view, error: this.canvasError, clientId: opts.clientId });
    }
  }

  /**
   * Pair recently vanished blocks with blocks that have no node yet (see
   * matchRenames). A vanished block's node may already be gone from the layout
   * (outside a turn it is dropped at once); it is put back so the rename can
   * inherit its position, size and connections. Returns new name → old name.
   */
  private detectRenames(): Map<string, string> {
    const now = Date.now();
    for (const [name, g] of this.recentlyGone) if (now - g.at > 10 * 60_000 || this.blocks.has(name)) this.recentlyGone.delete(name);
    if (!this.recentlyGone.size) return new Map();
    const noded = new Set(this.lastValid.nodes.map((n) => n.id));
    const appeared = [...this.blocks.values()].filter((b) => !noded.has(b.name)).map(renameCandidate);
    if (!appeared.length) return new Map();
    const matches = matchRenames([...this.recentlyGone.values()].map((g) => g.cand), appeared);
    for (const [to, from] of matches) {
      const g = this.recentlyGone.get(from)!;
      if (!noded.has(from)) {
        if (!g.node) {
          matches.delete(to);
          continue;
        }
        const edgeIds = new Set(this.lastValid.edges.map((e) => e.id));
        this.lastValid = {
          ...this.lastValid,
          nodes: [...this.lastValid.nodes, g.node],
          edges: [...this.lastValid.edges, ...(g.edges ?? []).filter((e) => !edgeIds.has(e.id))],
        };
      }
      this.recentlyGone.delete(from);
    }
    return matches;
  }

  /** A block changed its name: carry the per-name state along and tell the tabs. */
  private movedName(from: string, to: string): void {
    if (this.mermaidLastValid[from] !== undefined) {
      this.mermaidLastValid[to] = this.mermaidLastValid[from];
      delete this.mermaidLastValid[from];
      void writeJson(path.join(this.thinkDir, "mermaid-last-valid.json"), this.mermaidLastValid).catch(() => {});
    }
    const t = this.touched.get(from);
    if (t !== undefined) {
      this.touched.delete(from);
      this.touched.set(to, t);
    }
    this.log.info("block renamed", { from, to });
    this.broadcast({ type: "block.renamed", from, to });
    void this.moveDrawing(from, to).catch((err) => this.log.warn("could not move a drawing along with its block", { from, to, error: errorMessage(err) }));
    if (this.comments.some((c) => c.on === from) || this.pendingComments.length) {
      void this.changeComments("rename", (list) => list.map((c) => (c.on === from ? { ...c, on: to } : c))).catch(() => {});
    }
  }

  private async writeCanvas(canvas: Canvas): Promise<void> {
    const text = serializeCanvas(canvas);
    this.canvasText = text;
    this.diskCanonical = text;
    this.canvasDiskHash = hashOf(text);
    this.lastValid = canvas;
    this.canvasError = null;
    await writeAtomic(path.join(this.dir, "canvas.json"), text, this.thinkDir);
    await this.persistLastValid();
  }

  private persistLastValid(): Promise<void> {
    return writeJson(path.join(this.thinkDir, "canvas-last-valid.json"), this.lastValid);
  }

  private async writeBlockFile(entry: FileEntry, data: string | Buffer): Promise<void> {
    await writeAtomic(path.join(this.dir, entry.file), data, this.thinkDir);
  }

  // ================================================================== drawings

  private historyFile(name: string): string {
    return path.join(this.thinkDir, "drawings", `${name}.json`);
  }

  /**
   * The drawing on an image block, to edit — or, for an image not drawn on
   * yet, a fresh one on it (nothing is written until the first save).
   */
  private async openDrawing(name: string): Promise<{ drawing: Drawing; history: unknown; saved: boolean }> {
    const b = this.blocks.get(name);
    if (!b || b.type !== "image") throw new UserError(`“${displayName(name)}” is not an image.`);
    const existing = await readDrawing(this.dir, name);
    if (existing) return { drawing: existing, history: await readJson(this.historyFile(name), null), saved: true };
    if (!b.natural) throw new UserError(`The size of “${displayName(name)}” is unknown, so it cannot be drawn on.`);
    const ext = b.ext === "jpeg" ? "jpg" : b.ext;
    return { drawing: { format: DRAWING_FORMAT, base: { kind: "image", file: `base.${ext}`, width: b.natural.width, height: b.natural.height }, shapes: [] }, history: null, saved: false };
  }

  /**
   * Save a drawing: write it next to the block (keeping the original image
   * safe on the first save), render the finished picture into the block's
   * file, and keep the editor's undo history.
   */
  private async saveDrawing(name: string, drawing: unknown, history: unknown): Promise<{ hash: string }> {
    this.assertUnlocked();
    const b = this.blocks.get(name);
    if (!b || b.type !== "image") throw new UserError(`“${displayName(name)}” is not an image.`);
    const r = drawingSchema.safeParse(drawing);
    if (!r.success) throw new UserError(`That drawing is not valid: ${r.error.issues[0]?.message ?? "unknown problem"}.`);
    const d = r.data as Drawing;
    const dir = sidecarDir(this.dir, name);
    await fs.mkdir(dir, { recursive: true });
    let base: Buffer | null = null;
    if (d.base.kind === "image") {
      const basePath = path.join(dir, d.base.file);
      base = await fs.readFile(basePath).catch(() => null);
      if (!base) {
        // The first drawing on this picture: keep the original, untouched.
        if (await readDrawing(this.dir, name)) throw new UserError("This drawing's original image is missing — reopen the block and try again.");
        base = await fs.readFile(path.join(this.dir, b.file));
        await writeAtomic(basePath, base, this.thinkDir);
      }
    }
    const png = await renderDrawing(d, base);
    const hash = hashOf(png);
    await writeAtomic(path.join(dir, "drawing.json"), JSON.stringify({ ...d, output: hash }, null, 2) + "\n", this.thinkDir);
    if (history !== undefined) {
      const text = JSON.stringify(history);
      if (text.length < 4_000_000) {
        await fs.mkdir(path.dirname(this.historyFile(name)), { recursive: true });
        await fs.writeFile(this.historyFile(name), text);
      }
    }
    let natural: { width: number; height: number } | undefined;
    try {
      const dim = imageSize(png);
      if (dim.width && dim.height) natural = { width: dim.width, height: dim.height };
    } catch {
      /* ours: always a PNG */
    }
    await this.replaceImageData(b, png, "png", natural);
    if (history !== undefined) await this.pruneBases(name, d, JSON.stringify(history));
    return { hash };
  }

  /**
   * A photo to become a drawing's page (the editor's page picker, or Replace
   * image keeping the drawing): kept next to the drawing under its own name,
   * so undo can still go back to the previous page. Nothing is drawn yet —
   * the editor saves the drawing on its new page next.
   */
  async putDrawingBase(name: string, data: Buffer, mime: string): Promise<{ file: string; width: number; height: number }> {
    return this.queue.run(async () => {
      this.assertUnlocked();
      const b = this.blocks.get(name);
      if (!b || b.type !== "image") throw new UserError(`“${displayName(name)}” is not an image.`);
      const { ext, natural } = readImage(data, mime);
      if (!natural) throw new UserError("The size of that image is unknown, so it cannot be a page.");
      const dir = sidecarDir(this.dir, name);
      await fs.mkdir(dir, { recursive: true });
      // A picture not drawn on yet: keep it too, as the drawing's first page.
      if (!(await readDrawing(this.dir, name)) && b.natural) {
        const first = path.join(dir, `base.${b.ext === "jpeg" ? "jpg" : b.ext}`);
        if (!(await exists(first))) await writeAtomic(first, await fs.readFile(path.join(this.dir, b.file)), this.thinkDir);
      }
      const file = `base-${hashOf(data).slice(0, 12)}.${ext === "jpeg" ? "jpg" : ext}`;
      await writeAtomic(path.join(dir, file), data, this.thinkDir);
      return { file, ...natural };
    });
  }

  /** Remove originals nothing uses any more: not the page, and not reachable by undo. */
  private async pruneBases(name: string, d: Drawing, history: string): Promise<void> {
    const dir = sidecarDir(this.dir, name);
    const keep = d.base.kind === "image" ? d.base.file : null;
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (BASE_FILE_RE.test(f) && f !== keep && !history.includes(`"${f}"`)) await fs.rm(path.join(dir, f), { force: true });
    }
  }

  /** A sketch: a new image block that is a blank page to draw on. */
  private async createSketch(x: number, y: number, background?: string): Promise<{ name: string }> {
    this.assertUnlocked();
    const name = allocateName(this.deps.config.namePool(), this.takenNames());
    const color = typeof background === "string" && /^#[0-9a-f]{6}$/i.test(background) ? background : "#ffffff";
    const d: Drawing = { format: DRAWING_FORMAT, base: { kind: "color", color, width: 1600, height: 1000 }, shapes: [] };
    const png = await renderDrawing(d, null);
    const hash = hashOf(png);
    const dir = sidecarDir(this.dir, name);
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, "drawing.json"), JSON.stringify({ ...d, output: hash }, null, 2) + "\n", this.thinkDir);
    const entry: FileEntry = { name, file: `${name}.png`, ext: "png", type: "image", hash, size: png.length, natural: { width: 1600, height: 1000 }, firstSeen: Date.now(), mtimeMs: Date.now() };
    await this.addBlock(entry, png, Number(x) || 0, Number(y) || 0);
    return { name };
  }

  /** Put drawings back as they were at `rev` (for these blocks, or all of them). */
  private async restoreDrawings(rev: string, names: string[] | null): Promise<void> {
    if (names) for (const n of names) await fs.rm(sidecarDir(this.dir, n), { recursive: true, force: true });
    else await fs.rm(path.join(this.dir, DRAWINGS_DIR), { recursive: true, force: true });
    const specs = names ? names.map((n) => `${DRAWINGS_DIR}/${n}/`) : [`${DRAWINGS_DIR}/`];
    if (!specs.length) return;
    const files = (await git(this.dir, ["ls-tree", "-r", "--name-only", rev, "--", ...specs]).catch(() => "")).split("\n").filter(Boolean);
    for (const f of files) {
      const bytes = await showFile(this.dir, rev, f);
      if (!bytes) continue;
      await fs.mkdir(path.dirname(path.join(this.dir, f)), { recursive: true });
      await writeAtomic(path.join(this.dir, f), bytes, this.thinkDir);
    }
  }

  /** Forget a block's drawing (its picture was replaced). History keeps it. */
  private async dropDrawing(name: string): Promise<void> {
    await fs.rm(sidecarDir(this.dir, name), { recursive: true, force: true });
    await fs.rm(this.historyFile(name), { force: true });
  }

  /** A block was renamed: its drawing goes along. */
  private async moveDrawing(from: string, to: string): Promise<void> {
    const src = sidecarDir(this.dir, from);
    if (!(await exists(src))) return;
    await fs.rm(sidecarDir(this.dir, to), { recursive: true, force: true });
    await fs.mkdir(path.join(this.dir, DRAWINGS_DIR), { recursive: true });
    await fs.rename(src, sidecarDir(this.dir, to));
    await fs.rename(this.historyFile(from), this.historyFile(to)).catch(() => {});
  }

  // ================================================================== comments

  private async readComments(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir, COMMENTS_FILE), "utf8");
    } catch {
      this.comments = [];
      this.commentsError = null;
      return;
    }
    const r = parseComments(text);
    if (r.ok) {
      this.comments = r.comments;
      this.commentsError = null;
    } else this.commentsError = r.error; // keep the last good ones
  }

  /** What the tabs see: the file's comments plus changes waiting for the lock to end. */
  private shownComments(): Comment[] {
    return this.pendingComments.reduce((list, change) => change(list), this.comments);
  }

  private broadcastComments(): void {
    this.broadcast({ type: "comments.changed", comments: this.shownComments(), error: this.commentsError });
  }

  /** comments.json changed on disk (an agent, a person, git). */
  private async syncComments(): Promise<void> {
    const before = serializeComments(this.comments);
    const hadError = this.commentsError;
    await this.readComments();
    if (serializeComments(this.comments) !== before || hadError !== this.commentsError) this.broadcastComments();
    if (!this.lock.locked) this.scheduleAutosave();
  }

  private async addComment(on: string | null, text: string): Promise<{ id: string }> {
    const clean = cleanComment(text);
    if (!clean) throw new UserError("A comment needs some text.");
    if (on !== null && (typeof on !== "string" || !this.view.nodes.some((n) => n.id === on))) throw new UserError("That block or frame is not on the canvas any more.");
    const id = newId("c-");
    await this.changeComments("add", (list) => [...list, { id, on, by: "you", text: clean, at: new Date().toISOString() }]);
    return { id };
  }

  /**
   * Apply a change to the comments. While the canvas is locked (the agent or
   * an outside agent is working, and may be editing comments.json itself),
   * the change waits and is applied on top of theirs when the lock ends;
   * every tab sees it straight away.
   */
  private async changeComments(what: string, change: (list: Comment[]) => Comment[]): Promise<void> {
    if (this.lock.locked) {
      this.pendingComments.push(change);
      this.broadcastComments();
      return;
    }
    await this.writeComments(change(this.comments));
    this.log.info("comments changed", { what });
  }

  private async writeComments(list: Comment[]): Promise<void> {
    const same = serializeComments(list) === serializeComments(this.comments) && !this.commentsError;
    this.comments = list;
    this.commentsError = null;
    this.broadcastComments();
    if (same) return;
    if (!list.length && !(await exists(path.join(this.dir, COMMENTS_FILE)))) return;
    await writeAtomic(path.join(this.dir, COMMENTS_FILE), serializeComments(list), this.thinkDir);
    this.scheduleAutosave();
  }

  /** The lock ended: read what the agent left, then apply the user's waiting comment changes. Callers hold the queue. */
  private async applyPendingComments(): Promise<void> {
    await this.readComments();
    const pending = this.pendingComments;
    this.pendingComments = [];
    if (!pending.length) {
      this.broadcastComments();
      return;
    }
    await this.writeComments(pending.reduce((list, change) => change(list), this.comments));
    await this.commitUser(); // theirs, like drafts of protected blocks
  }

  // ================================================================== mermaid last-valid

  /** Re-validate a mermaid block shortly after it changes; remember the last source that parsed. */
  private checkMermaid(name: string): void {
    const prev = this.mermaidTimers.get(name);
    if (prev) clearTimeout(prev);
    this.mermaidTimers.set(
      name,
      setTimeout(async () => {
        this.mermaidTimers.delete(name);
        const b = this.blocks.get(name);
        if (!b || b.type !== "mermaid" || b.content === undefined) return;
        const source = b.content;
        const error = await this.deps.mermaid.validate(source);
        if (error || this.closed || this.mermaidLastValid[name] === source) return;
        this.mermaidLastValid[name] = source;
        await writeJson(path.join(this.thinkDir, "mermaid-last-valid.json"), this.mermaidLastValid).catch(() => {});
        this.broadcast({ type: "mermaid.lastValid", name, source });
      }, 250),
    );
  }

  // ================================================================== user mutations

  private assertUnlocked(): void {
    if (!this.lock.locked) return;
    if (this.lock.reason === "guest") throw new UserError(`${this.lock.by} is working on this canvas — editing resumes when they finish (or take over from the banner).`);
    throw new UserError("The agent is working — editing is paused until it finishes.");
  }

  async handle(client: ClientConn, msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case "user.edit":
        return this.queue.run(() => this.userEdit(client, msg.name, msg.content));
      case "user.layout":
        return this.queue.run(() => this.userLayout(client, msg.ops));
      case "block.create":
        return this.queue.run(() => this.createTextBlock(msg.blockType, msg.x, msg.y));
      case "block.delete":
        return this.queue.run(() => this.deleteBlocks(msg.names));
      case "block.rename":
        return this.queue.run(() => this.renameBlock(msg.name, msg.to));
      case "blocks.paste":
        return this.queue.run(() => this.pasteBlocks(msg.blocks, msg.edges, msg.groups));
      case "readme.edit":
        return this.queue.run(() => this.editReadme(client, msg.content));
      case "history.list":
        // The newest page starts with a save, so the top entry really is the latest state.
        if (!msg.before) await this.queue.run(async () => void (!this.lock.locked && (await this.commitUser())));
        return listHistory(this.dir, this.thinkDir, { before: msg.before, limit: msg.limit });
      case "drawing.open":
        return this.openDrawing(msg.name);
      case "drawing.save":
        return this.queue.run(() => this.saveDrawing(msg.name, msg.drawing, msg.history));
      case "sketch.create":
        return this.queue.run(() => this.createSketch(msg.x, msg.y, msg.background));
      case "comment.add":
        return this.queue.run(() => this.addComment(msg.on, msg.text));
      case "comment.update":
        return this.queue.run(() => this.changeComments(`edit`, (list) => list.map((c) => (c.id === msg.id ? { ...c, text: cleanComment(msg.text), edited: new Date().toISOString() } : c))));
      case "comment.delete":
        return this.queue.run(() => {
          const ids = new Set(Array.isArray(msg.ids) ? msg.ids : []);
          return this.changeComments("delete", (list) => list.filter((c) => !ids.has(c.id)));
        });
      case "comment.done":
        return this.queue.run(() =>
          this.changeComments("done", (list) =>
            list.map((c) => (c.id !== msg.id ? c : msg.done ? { ...c, done: { by: "you", at: new Date().toISOString() } } : (({ done: _d, ...rest }) => rest)(c))),
          ),
        );
      case "canvas.save":
        return this.queue.run(() => this.saveNow());
      case "canvas.settings":
        return this.queue.run(() => this.updateSettings(msg.settings ?? {}));
      case "history.snapshot":
        await this.assertRev(msg.rev);
        return historySnapshot(this.dir, msg.rev, typeof msg.base === "string" ? msg.base : null);
      case "history.diff": {
        await this.assertRev(msg.rev);
        const b = this.blocks.get(msg.name);
        const files = (await git(this.dir, ["ls-tree", "--name-only", msg.rev])).split("\n").filter((f) => parseBlockFile(f)?.name === msg.name);
        const then = files[0] ? await showFile(this.dir, msg.rev, files[0]) : null;
        return { then: then?.toString("utf8") ?? null, now: b?.content ?? null };
      }
      case "history.restore":
        return this.queue.run(() => this.restore(msg.rev, msg.names));
      case "guest.takeover":
        return this.guestUnlock(null, undefined, "takeover");
      case "guest.disconnect":
        return this.guestDisconnect(msg.name);
      case "block.revert":
        return this.queue.run(() => this.revertMermaid(client, msg.name));
      case "block.undoDelete":
        return this.queue.run(() => this.undoDelete(msg.batch));
      case "agent.prompt":
        return this.prompt(msg.text);
      case "agent.cancel":
        return this.cancel();
      case "agent.permission":
        return this.answerPermission(msg.requestId, msg.optionId);
      case "agent.restart":
        return this.restartAgent();
      case "agent.newSession":
        return this.newSession();
      case "login.start":
        return this.startLogin(client, msg.methodId, { cols: msg.cols, rows: msg.rows });
      case "login.input":
        if (this.provider) this.deps.logins.get(this.provider.id)?.write(msg.data);
        return;
      case "login.resize":
        if (this.provider) this.deps.logins.get(this.provider.id)?.resize(msg.cols, msg.rows);
        return;
      case "login.stop":
        if (this.provider) this.deps.logins.get(this.provider.id)?.kill();
        return;
      default:
        return undefined; // unknown types are ignored by design
    }
  }

  /** Raw editor autosave. Also used by the pagehide beacon. */
  async userEdit(client: ClientConn | null, name: string, content: string): Promise<{ hash: string }> {
    const pin = this.pinned.get(name);
    if (this.lock.locked && pin && this.turnRunning) {
      // Protected block, agent working: keep the edit as a draft, shown to every
      // tab now and written to the file (as the user's) when the turn ends.
      if (typeof content !== "string") throw new UserError("Invalid content.");
      pin.draft = content;
      const b = this.blocks.get(name);
      if (b) this.broadcast({ type: "file.changed", block: this.blockInfo(b), origin: "user", clientId: client?.id }, client?.id);
      await writeJson(path.join(this.thinkDir, "drafts.json"), Object.fromEntries([...this.pinned].filter(([, p]) => p.draft !== undefined).map(([n, p]) => [n, p.draft]))).catch(() => {});
      return { hash: hashOf(content) };
    }
    this.assertUnlocked();
    const b = this.blocks.get(name);
    if (!b) throw new UserError(`There is no block called "${name}".`);
    if (!isTextType(b.type)) throw new UserError(`"${name}" is an image; it cannot be edited as text.`);
    if (typeof content !== "string") throw new UserError("Invalid content.");
    if (content === b.content) return { hash: b.hash };
    b.content = content;
    b.hash = hashOf(content);
    b.size = Buffer.byteLength(content);
    await this.writeBlockFile(b, content);
    this.touched.set(name, Date.now());
    this.broadcast({ type: "file.changed", block: this.blockInfo(b), origin: "user", clientId: client?.id }, client?.id);
    if (b.type === "mermaid") this.checkMermaid(name);
    this.scheduleAutosave();
    return { hash: b.hash };
  }

  private async userLayout(client: ClientConn, ops: LayoutOp[]): Promise<void> {
    this.assertUnlocked();
    if (!Array.isArray(ops)) throw new UserError("Invalid layout operation.");
    const grid = this.grid;
    const canvas: Canvas = structuredClone(this.view);
    const nodeById = new Map(canvas.nodes.map((n) => [n.id, n]));
    for (const op of ops) {
      switch (op.op) {
        case "node.move": {
          const n = nodeById.get(op.id);
          if (!n) continue;
          n.x = snap(op.x, grid);
          n.y = snap(op.y, grid);
          break;
        }
        case "node.resize": {
          const n = nodeById.get(op.id);
          if (!n) continue;
          const b = this.blocks.get(op.id);
          if (n.type === "file" && !b) continue;
          const min = n.type === "group" ? { minWidth: GROUP_MIN.width, minHeight: GROUP_MIN.height } : BLOCK_SIZES[b!.type];
          n.x = snap(op.x, grid);
          n.y = snap(op.y, grid);
          n.width = snapSize(op.width, min.minWidth, grid);
          n.height = snapSize(op.height, min.minHeight, grid);
          break;
        }
        case "node.protect": {
          const n = nodeById.get(op.id);
          if (!n || n.type !== "file") continue;
          if (op.protected) n.protected = true;
          else delete n.protected;
          break;
        }
        case "group.add": {
          const g = op.group;
          if (!g || typeof g.id !== "string" || !g.id || nodeById.has(g.id) || this.blocks.has(g.id)) throw new UserError("That group is not valid.");
          const group = snapGroup(
            { id: g.id.slice(0, 64), type: "group", x: Number(g.x) || 0, y: Number(g.y) || 0, width: Number(g.width) || GROUP_MIN.width, height: Number(g.height) || GROUP_MIN.height },
            grid,
          );
          if (typeof g.label === "string" && g.label.trim()) group.label = g.label.trim().slice(0, 120);
          if (typeof g.color === "string" && g.color) group.color = g.color;
          canvas.nodes.unshift(group);
          nodeById.set(group.id, group);
          break;
        }
        case "group.update": {
          const n = nodeById.get(op.id);
          if (!n || n.type !== "group") continue;
          const p = op.patch ?? {};
          if ("label" in p) {
            const label = typeof p.label === "string" ? p.label.trim().slice(0, 120) : "";
            if (label) n.label = label;
            else delete n.label;
          }
          if ("color" in p) {
            if (typeof p.color === "string" && p.color) n.color = p.color;
            else delete n.color;
          }
          break;
        }
        case "group.delete":
          canvas.nodes = canvas.nodes.filter((x) => !(x.id === op.id && x.type === "group"));
          canvas.edges = canvas.edges.filter((e) => e.fromNode !== op.id && e.toNode !== op.id);
          nodeById.delete(op.id);
          break;
        case "view.add": {
          const v = op.view;
          const listKey = op.list === "slides" ? "slides" : "views";
          const views = canvas[listKey] ?? [];
          if (!v || typeof v.id !== "string" || !v.id || views.some((x) => x.id === v.id)) throw new UserError("That view is not valid.");
          const [x, y, width, height] = [v.x, v.y, v.width, v.height].map((n) => Math.round(Number(n)));
          if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new UserError("That view is not valid.");
          const view: CanvasView = { id: v.id.slice(0, 64), name: String(v.name ?? "").trim().slice(0, 80) || "Untitled view", x, y, width, height };
          if (typeof v.target === "string" && nodeById.has(v.target)) {
            view.target = v.target;
            if (v.followName) view.followName = true;
          }
          views.push(view);
          canvas[listKey] = views;
          break;
        }
        case "view.update": {
          const v = canvas[op.list === "slides" ? "slides" : "views"]?.find((x) => x.id === op.id);
          if (!v) continue;
          const p = op.patch ?? {};
          if (typeof p.name === "string") {
            v.name = p.name.trim().slice(0, 80) || v.name;
            if (p.followName === undefined) delete v.followName; // named by hand
          }
          for (const k of ["x", "y", "width", "height"] as const) {
            const n = Math.round(Number(p[k]));
            if (p[k] !== undefined && Number.isFinite(n) && (k === "x" || k === "y" || n > 0)) v[k] = n;
          }
          if (p.target === null) {
            delete v.target;
            delete v.followName;
          } else if (typeof p.target === "string" && nodeById.has(p.target)) v.target = p.target;
          if (typeof p.followName === "boolean" && v.target) {
            if (p.followName) v.followName = true;
            else delete v.followName;
          }
          break;
        }
        case "view.delete": {
          const listKey = op.list === "slides" ? "slides" : "views";
          canvas[listKey] = (canvas[listKey] ?? []).filter((x) => x.id !== op.id);
          break;
        }
        case "view.move": {
          const listKey = op.list === "slides" ? "slides" : "views";
          const views = canvas[listKey] ?? [];
          const i = views.findIndex((x) => x.id === op.id);
          if (i === -1) continue;
          const [v] = views.splice(i, 1);
          views.splice(Math.max(0, Math.min(views.length, Math.round(op.index))), 0, v);
          canvas[listKey] = views;
          break;
        }
        case "edge.add": {
          const e = sanitizeEdge(op.edge);
          if (!e || !nodeById.has(e.fromNode) || !nodeById.has(e.toNode)) throw new UserError("That connection is not valid.");
          if (canvas.edges.some((x) => x.id === e.id)) e.id = newId("e-");
          canvas.edges.push(e);
          break;
        }
        case "edge.update": {
          const e = canvas.edges.find((x) => x.id === op.id);
          if (!e) continue;
          const p = op.patch ?? {};
          // null (e.g. from undo) removes the side: the connection picks the nearest.
          for (const k of ["fromSide", "toSide"] as const) {
            if (!(k in p)) continue;
            const v = p[k] as Side | null | undefined;
            if (v === null || v === undefined) delete e[k];
            else if (SIDES.includes(v)) e[k] = v;
          }
          if (p.fromEnd === "none" || p.fromEnd === "arrow") e.fromEnd = p.fromEnd;
          if (p.toEnd === "none" || p.toEnd === "arrow") e.toEnd = p.toEnd;
          if ("label" in p) {
            const label = typeof p.label === "string" ? p.label.trim().slice(0, 200) : "";
            if (label) e.label = label;
            else delete e.label;
          }
          if ("color" in p) {
            if (typeof p.color === "string" && p.color) e.color = p.color;
            else delete e.color;
          }
          if ("style" in p) {
            if (p.style && EDGE_STYLES.includes(p.style) && p.style !== "solid") e.style = p.style;
            else delete e.style;
          }
          break;
        }
        case "edge.delete":
          canvas.edges = canvas.edges.filter((x) => x.id !== op.id);
          break;
      }
    }
    this.lastValid = canvas;
    this.canvasError = null;
    await this.refreshView({ write: true, force: true, clientId: client.id });
    this.scheduleAutosave();
  }

  /** A revision must be a commit of this canvas's own history. */
  private async assertRev(rev: unknown): Promise<void> {
    const now = await head(this.dir);
    if (typeof rev !== "string" || !/^[0-9a-f]{7,40}$/.test(rev) || !now || !(await isAncestor(this.dir, rev, now))) {
      throw new UserError("That point in history does not exist.");
    }
  }

  /**
   * Restore blocks — or the whole canvas (blocks, layout, README) — to how
   * they were at `rev`, as a new commit on top. History is never rewritten, so
   * a restore is undone by restoring again.
   */
  private async restore(rev: string, names?: string[]): Promise<{ restored: string[] }> {
    this.assertUnlocked();
    await this.assertRev(rev);
    await this.commitUser(); // the state being replaced stays one click away
    const snap = await historySnapshot(this.dir, rev, null);
    const when = new Date(Number((await git(this.dir, ["log", "-1", "--format=%at", rev])).trim()) * 1000).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: process.env.TZ || undefined,
    });
    const restored: string[] = [];
    const writeFromRev = async (file: string) => {
      const bytes = await showFile(this.dir, rev, file);
      if (bytes) await writeAtomic(path.join(this.dir, file), bytes, this.thinkDir);
      return !!bytes;
    };
    if (names?.length) {
      const nodes = [...this.view.nodes];
      const edges = [...this.view.edges];
      for (const name of names) {
        const then = snap.blocks.find((b) => b.name === name);
        if (!then) continue;
        const now = this.blocks.get(name);
        if (now && now.file !== then.file) await fs.rm(path.join(this.dir, now.file), { force: true });
        if (!(await writeFromRev(then.file))) continue;
        restored.push(name);
        if (!nodes.some((n) => n.id === name)) {
          const node = snap.canvas.nodes.find((n) => n.id === name);
          if (node) nodes.push(node);
          const ids = new Set(nodes.map((n) => n.id));
          for (const e of snap.canvas.edges) {
            if ((e.fromNode === name || e.toNode === name) && ids.has(e.fromNode) && ids.has(e.toNode) && !edges.some((x) => x.id === e.id)) edges.push(e);
          }
        }
      }
      this.lastValid = { ...this.view, nodes, edges };
      await this.restoreDrawings(rev, restored);
    } else {
      const keep = new Set(snap.blocks.map((b) => b.file));
      for (const b of this.blocks.values()) if (!keep.has(b.file)) await fs.rm(path.join(this.dir, b.file), { force: true });
      for (const b of snap.blocks) if (await writeFromRev(b.file)) restored.push(b.name);
      if (snap.readme !== null) await writeFromRev("README.md");
      await this.restoreDrawings(rev, null);
      // Views and slides are for getting around and presenting, not content: today's stay.
      const { views: _views, slides: _slides, ...layout } = snap.canvas;
      this.lastValid = { ...layout, ...(this.view.views?.length ? { views: this.view.views } : {}), ...(this.view.slides?.length ? { slides: this.view.slides } : {}) };
    }
    this.canvasError = null;
    await this.rescanAll();
    await this.readReadme().then((changed) => changed && this.broadcast({ type: "readme.changed", content: this.readme }));
    await this.refreshView({ write: true, force: true });
    const what = names?.length ? restored.join(", ") || "nothing" : "the canvas";
    const committed = await commitAll(this.dir, { message: `restore: ${what} to ${when} (${rev.slice(0, 7)})`, author: USER_AUTHOR });
    if (committed) this.broadcast({ type: "history.changed" });
    if (committed) await this.addSystem("info", `Restored ${names?.length ? restored.map(displayName).join(", ") : "the whole canvas"} to how ${names?.length === 1 ? "it was" : "things were"} on ${when}.`);
    this.clearAutosave();
    return { restored };
  }

  /** The user renames a block: the file, its node and every connection follow. */
  private async renameBlock(name: string, to: string): Promise<{ name: string }> {
    this.assertUnlocked();
    return this.renameBlockNow(name, to, "user");
  }

  /** Rename a block now (the caller has checked who may). Callers hold the queue. */
  private async renameBlockNow(name: string, to: string, origin: "user" | "agent" | "external"): Promise<{ name: string }> {
    const b = this.blocks.get(name);
    if (!b) throw new UserError(`There is no block called "${name}".`);
    if (typeof to !== "string" || !isValidName(to)) throw new UserError("Names use lowercase letters, digits and hyphens, like tea-flowchart.");
    if (to === name) return { name };
    if (this.takenNames().has(to)) throw new UserError(`There is already a block called “${displayName(to)}”.`);
    if (this.view.nodes.some((n) => n.id === to)) throw new UserError(`“${to}” is already used by a group on this canvas.`);
    const file = `${to}.${b.ext}`;
    await fs.rename(path.join(this.dir, b.file), path.join(this.dir, file));
    const entry: FileEntry = { ...b, name: to, file };
    this.files.delete(b.file);
    this.files.set(file, entry);
    this.recomputeBlocks();
    this.lastValid = renameInCanvas(this.view, name, to, file);
    this.canvasError = null;
    this.movedName(name, to);
    this.broadcast({ type: "file.changed", block: this.blockInfo(entry), origin });
    this.broadcast({ type: "file.deleted", name, file: b.file });
    await this.refreshView({ write: true, force: true });
    this.scheduleAutosave();
    return { name: to };
  }

  private takenNames(): Set<string> {
    return new Set([...this.files.values()].map((f) => f.name));
  }

  private async createTextBlock(type: "markdown" | "mermaid" | "html", x: number, y: number): Promise<{ name: string }> {
    this.assertUnlocked();
    if (!(type in TYPE_EXTENSION)) throw new UserError("Unknown block type.");
    const name = allocateName(this.deps.config.namePool(), this.takenNames());
    const ext = TYPE_EXTENSION[type];
    const content = initialContent(type, name);
    const entry: FileEntry = {
      name,
      file: `${name}.${ext}`,
      ext,
      type,
      hash: hashOf(content),
      size: Buffer.byteLength(content),
      content,
      firstSeen: Date.now(),
      mtimeMs: Date.now(),
    };
    await this.addBlock(entry, content, x, y);
    return { name };
  }

  /**
   * Paste (or duplicate) copied blocks: new files named after the originals
   * (`tom` → `tom-2` when taken), at the given places, with the frames and
   * connections among them. Images are copied from their canvas on this server.
   */
  private async pasteBlocks(items: PasteBlock[], edges: CanvasEdge[], groups: GroupNode[]): Promise<{ names: Record<string, string>; groups: Record<string, string> }> {
    this.assertUnlocked();
    if (!Array.isArray(items) || !Array.isArray(edges ?? []) || !Array.isArray(groups ?? [])) throw new UserError("Nothing to paste.");
    if (items.length + (groups?.length ?? 0) > 80) throw new UserError("That is too much to paste at once (80 items at most).");
    const grid = this.grid;
    const taken = new Set([...this.takenNames(), ...this.view.nodes.map((n) => n.id)]);
    const names: Record<string, string> = {};
    const created: FileEntry[] = [];
    const nodes: CanvasNode[] = [];
    for (const it of items) {
      if (!it || typeof it.from !== "string" || !(it.type in BLOCK_SIZES)) continue;
      const name = freeName(isValidName(it.from) ? it.from : "block", taken);
      let entry: FileEntry;
      let data: string | Buffer;
      if (it.type === "image") {
        const src = it.image;
        const parsed = src && typeof src.file === "string" ? parseBlockFile(src.file) : null;
        if (!src || !SLUG_RE.test(String(src.canvas)) || parsed?.type !== "image") continue;
        try {
          data = await fs.readFile(path.join(this.deps.store.dir(src.canvas), src.file));
        } catch {
          continue; // the original is gone
        }
        let natural: { width: number; height: number } | undefined;
        try {
          const dim = imageSize(data);
          if (dim.width && dim.height) natural = { width: dim.width, height: dim.height };
        } catch {
          continue;
        }
        entry = { name, file: `${name}.${parsed.ext}`, ext: parsed.ext, type: "image", hash: hashOf(data), size: data.length, natural, firstSeen: Date.now(), mtimeMs: Date.now() };
        // Its drawing comes along, so the copy can be drawn on further.
        const srcSidecar = sidecarDir(this.deps.store.dir(src.canvas), parsed.name);
        if (await exists(srcSidecar)) await fs.cp(srcSidecar, sidecarDir(this.dir, name), { recursive: true }).catch(() => {});
      } else {
        const content = typeof it.content === "string" ? it.content : "";
        if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new UserError(`“${displayName(it.from)}” is too large to paste.`);
        const ext = TYPE_EXTENSION[it.type as Exclude<BlockType, "image">];
        data = content;
        entry = { name, file: `${name}.${ext}`, ext, type: it.type, hash: hashOf(content), size: Buffer.byteLength(content), content, firstSeen: Date.now(), mtimeMs: Date.now() };
      }
      taken.add(name);
      await this.writeBlockFile(entry, data);
      this.files.set(entry.file, entry);
      created.push(entry);
      names[it.from] = name;
      const size = BLOCK_SIZES[it.type];
      const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
      nodes.push({
        id: name,
        type: "file",
        file: entry.file,
        x: snap(num(it.x, 0), grid),
        y: snap(num(it.y, 0), grid),
        width: snapSize(num(it.width, size.width), size.minWidth, grid),
        height: snapSize(num(it.height, size.height), size.minHeight, grid),
      });
    }
    const groupIds: Record<string, string> = {};
    for (const g of groups ?? []) {
      if (!g || typeof g.id !== "string") continue;
      const id = freeName("grp", taken, true);
      taken.add(id);
      const group = snapGroup({ id, type: "group", x: Number(g.x) || 0, y: Number(g.y) || 0, width: Number(g.width) || GROUP_MIN.width, height: Number(g.height) || GROUP_MIN.height }, grid);
      if (typeof g.label === "string" && g.label.trim()) group.label = g.label.trim().slice(0, 120);
      if (typeof g.color === "string" && g.color) group.color = g.color;
      groupIds[g.id] = id;
      nodes.unshift(group);
    }
    if (!nodes.length) throw new UserError("Nothing to paste — the copied blocks no longer exist.");
    const newEdges: CanvasEdge[] = [];
    for (const raw of edges ?? []) {
      const from = names[raw?.fromNode] ?? groupIds[raw?.fromNode];
      const to = names[raw?.toNode] ?? groupIds[raw?.toNode];
      const e = from && to ? sanitizeEdge({ ...raw, id: newId("e-"), fromNode: from, toNode: to }) : null;
      if (e) newEdges.push(e);
    }
    this.recomputeBlocks();
    for (const entry of created) {
      this.touched.set(entry.name, Date.now());
      this.broadcast({ type: "file.changed", block: this.blockInfo(entry), origin: "user" });
    }
    this.lastValid = { ...this.view, nodes: [...this.view.nodes, ...nodes], edges: [...this.view.edges, ...newEdges] };
    this.canvasError = null;
    await this.refreshView({ write: true, force: true });
    for (const entry of created) if (entry.type === "mermaid") this.checkMermaid(entry.name);
    this.scheduleAutosave();
    return { names, groups: groupIds };
  }

  /** New content for an image block (possibly with a new extension). Callers hold the queue. */
  private async replaceImageData(old: FileEntry, data: Buffer, ext: string, natural?: { width: number; height: number }): Promise<FileEntry> {
    const entry: FileEntry = { ...old, ext, file: `${old.name}.${ext}`, hash: hashOf(data), size: data.length, natural };
    await this.writeBlockFile(entry, data);
    if (entry.file !== old.file) {
      await fs.rm(path.join(this.dir, old.file), { force: true });
      this.files.delete(old.file);
    }
    this.files.set(entry.file, entry);
    this.recomputeBlocks();
    this.touched.set(entry.name, Date.now());
    this.broadcast({ type: "file.changed", block: this.blockInfo(entry), origin: "user" });
    // A picture of a new shape (cropped, rotated, another image): the block
    // keeps its width and takes the picture's proportions, header included.
    const node = this.view.nodes.find((n): n is FileNode => n.id === old.name && n.type === "file");
    if (node && natural && old.natural && Math.abs(natural.width / natural.height - old.natural.width / old.natural.height) > 0.02) {
      const height = snapSize(node.width * (natural.height / natural.width) + IMAGE_HEADER, BLOCK_SIZES.image.minHeight, this.grid);
      this.lastValid = { ...this.view, nodes: this.view.nodes.map((n) => (n === node ? { ...node, height } : n)) };
      await this.refreshView({ write: true, force: true });
    } else await this.refreshView({ write: true });
    this.scheduleAutosave();
    return entry;
  }

  /** Image upload: a new block, or (with `replace`) new content for an existing image block. */
  async putImage(data: Buffer, mime: string, opts: { x?: number; y?: number; replace?: string }): Promise<{ name: string }> {
    return this.queue.run(async () => {
      this.assertUnlocked();
      const { ext, natural } = readImage(data, mime);
      if (opts.replace) {
        const old = this.blocks.get(opts.replace);
        if (!old || old.type !== "image") throw new UserError(`"${opts.replace}" is not an image block.`);
        await this.replaceImageData(old, data, ext, natural);
        // A new picture: any drawing on the old one goes (History keeps it).
        await this.dropDrawing(old.name);
        return { name: old.name };
      }
      const name = allocateName(this.deps.config.namePool(), this.takenNames());
      const entry: FileEntry = { name, file: `${name}.${ext}`, ext, type: "image", hash: hashOf(data), size: data.length, natural, firstSeen: Date.now(), mtimeMs: Date.now() };
      await this.addBlock(entry, data, opts.x ?? 0, opts.y ?? 0);
      return { name };
    });
  }

  private async addBlock(entry: FileEntry, data: string | Buffer, x: number, y: number): Promise<void> {
    await this.writeBlockFile(entry, data);
    this.files.set(entry.file, entry);
    this.recomputeBlocks();
    this.touched.set(entry.name, Date.now());
    const size = defaultSize({ file: entry.file, type: entry.type, natural: entry.natural }, this.grid);
    const node = { id: entry.name, type: "file" as const, file: entry.file, x: snap(x, this.grid), y: snap(y, this.grid), ...size };
    this.lastValid = { ...this.view, nodes: [...this.view.nodes.filter((n) => n.id !== entry.name), node] };
    this.canvasError = null;
    this.broadcast({ type: "file.changed", block: this.blockInfo(entry), origin: "user" });
    await this.refreshView({ write: true, force: true });
    if (entry.type === "mermaid") this.checkMermaid(entry.name);
    this.scheduleAutosave();
  }

  /**
   * Delete blocks. Files are moved to .think/trash/<batch>/ rather than removed,
   * so the most recent deletion can be undone (git has everything older).
   */
  private async deleteBlocks(names: string[]): Promise<{ batch: string } | undefined> {
    this.assertUnlocked();
    return this.deleteBlocksNow(names, "user");
  }

  /** Delete blocks now (the caller has checked who may). Callers hold the queue. */
  private async deleteBlocksNow(names: string[], origin: "user" | "agent" | "external"): Promise<{ batch: string } | undefined> {
    if (!Array.isArray(names) || names.length === 0) return;
    const trashRoot = path.join(this.thinkDir, "trash");
    const batch = newId("del-");
    const trash = path.join(trashRoot, batch);
    await fs.mkdir(trash, { recursive: true });
    const gone = new Map<string, string>();
    for (const name of names) {
      const b = this.blocks.get(name);
      if (!b) continue;
      await fs.rename(path.join(this.dir, b.file), path.join(trash, b.file)).catch(() => fs.rm(path.join(this.dir, b.file), { force: true }));
      this.files.delete(b.file);
      gone.set(name, b.file);
      if (this.mermaidLastValid[name] !== undefined) delete this.mermaidLastValid[name];
    }
    if (!gone.size) {
      await fs.rm(trash, { recursive: true, force: true });
      return;
    }
    // Drawings go into the trash with their images.
    const drawings: string[] = [];
    for (const name of gone.keys()) {
      if (!(await exists(sidecarDir(this.dir, name)))) continue;
      await fs.mkdir(path.join(trash, DRAWINGS_DIR), { recursive: true });
      await fs.rename(sidecarDir(this.dir, name), path.join(trash, DRAWINGS_DIR, name)).catch(() => {});
      drawings.push(name);
    }
    this.deletions.set(batch, {
      drawings,
      files: [...gone].map(([name, file]) => ({ name, file })),
      nodes: this.view.nodes.filter((n) => gone.has(n.id)),
      edges: this.view.edges.filter((e) => gone.has(e.fromNode) || gone.has(e.toNode)),
    });
    while (this.deletions.size > MAX_UNDOABLE_DELETIONS) {
      const oldest = this.deletions.keys().next().value!;
      this.deletions.delete(oldest);
      await fs.rm(path.join(trashRoot, oldest), { recursive: true, force: true });
    }
    const changed = this.recomputeBlocks();
    for (const [name, file] of gone) {
      const now = this.blocks.get(name);
      if (now && changed.has(name)) this.broadcast({ type: "file.changed", block: this.blockInfo(now), origin });
      else this.broadcast({ type: "file.deleted", name, file });
    }
    this.lastValid = {
      ...this.view,
      nodes: this.view.nodes.filter((n) => !gone.has(n.id) || this.blocks.has(n.id)),
      edges: this.view.edges.filter((e) => !gone.has(e.fromNode) && !gone.has(e.toNode)),
    };
    this.canvasError = null;
    await writeJson(path.join(this.thinkDir, "mermaid-last-valid.json"), this.mermaidLastValid).catch(() => {});
    await this.refreshView({ write: true, force: true });
    this.scheduleAutosave();
    return { batch };
  }

  private async undoDelete(batch: string): Promise<{ restored: string[] }> {
    this.assertUnlocked();
    const del = this.deletions.get(batch);
    if (!del) throw new UserError("That deletion can no longer be undone.");
    this.deletions.delete(batch);
    const trash = path.join(this.thinkDir, "trash", batch);
    const restored: string[] = [];
    for (const { name, file } of del.files) {
      if (this.takenNames().has(name)) continue; // the name was reused meanwhile
      try {
        await fs.rename(path.join(trash, file), path.join(this.dir, file));
      } catch {
        continue;
      }
      const entry = await this.readEntry(file);
      if (!entry) continue;
      this.files.set(file, entry);
      restored.push(name);
      if (del.drawings.includes(name)) {
        await fs.mkdir(path.join(this.dir, DRAWINGS_DIR), { recursive: true });
        await fs.rename(path.join(trash, DRAWINGS_DIR, name), sidecarDir(this.dir, name)).catch(() => {});
      }
    }
    this.recomputeBlocks();
    for (const name of restored) {
      const b = this.blocks.get(name);
      if (b) this.broadcast({ type: "file.changed", block: this.blockInfo(b), origin: "user" });
      if (b?.type === "mermaid") this.checkMermaid(name);
    }
    const ok = new Set(restored);
    const present = new Set([...this.view.nodes.map((n) => n.id), ...restored]);
    this.lastValid = {
      ...this.view,
      nodes: [...this.view.nodes, ...del.nodes.filter((n) => ok.has(n.id))],
      edges: [...this.view.edges, ...del.edges.filter((e) => present.has(e.fromNode) && present.has(e.toNode))],
    };
    this.canvasError = null;
    await fs.rm(trash, { recursive: true, force: true });
    await this.refreshView({ write: true, force: true });
    this.scheduleAutosave();
    return { restored };
  }

  private async revertMermaid(client: ClientConn, name: string): Promise<{ hash: string }> {
    const source = this.mermaidLastValid[name];
    if (source === undefined) throw new UserError(`No valid version of "${name}" is known yet.`);
    const res = await this.userEdit(null, name, source);
    // The requesting tab needs the reverted content too.
    const b = this.blocks.get(name);
    if (b) client.send({ type: "file.changed", block: this.blockInfo(b), origin: "user" });
    return res;
  }

  // ================================================================== git

  /**
   * Autosave: the user's edits become a point in History a fixed time after
   * the first unsaved one (the canvas's autosaveSeconds). Further edits do not
   * postpone it — a long stretch of editing still lands every interval. 0 =
   * only on Save now; turns and closing commit regardless.
   */
  private scheduleAutosave(): void {
    if (this.autosaveTimer || this.closed) return;
    const seconds = this.meta.settings.autosaveSeconds;
    if (!seconds) return;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.queue
        .run(async () => {
          if (this.lock.locked || this.closed) return; // the turn commits them first
          await this.commitUser();
        })
        .catch((err) => this.log.error("autosave failed", { error: errorMessage(err) }));
    }, seconds * 1000);
  }

  private clearAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  /** Commit whatever the user changed, as `user`. Callers hold the queue. */
  private async commitUser(): Promise<boolean> {
    this.clearAutosave();
    const r = await commitUserChanges(this.dir);
    if (r) {
      this.log.info("user commit", { head: r.head.slice(0, 8), files: r.paths.length });
      this.broadcast({ type: "history.changed" });
    }
    return !!r;
  }

  /** Save now (⌘S): the user's edits become a point in History. */
  private async saveNow(): Promise<{ saved: boolean; note?: string }> {
    if (this.lock.locked) {
      return { saved: false, note: this.lock.reason === "guest" ? `Saved. ${this.lock.by} is working — your edits join History when they finish.` : "Saved. The agent is working — your edits join History when it finishes." };
    }
    return { saved: await this.commitUser() };
  }

  private async saveState(): Promise<void> {
    await this.deps.store.writeState(this.slug, this.state);
  }

  // ================================================================== agent

  private setAgentStatus(status: AgentStatus): void {
    this.agentStatus = status;
    this.broadcast({ type: "agent.status", status });
  }

  private ensureAgent(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.agent || this.agentStarting) return this.agentStarting ?? Promise.resolve();
    // Re-read: the provider's settings may have changed since the canvas opened.
    const provider = (this.provider = this.deps.config.provider(this.meta.provider));
    if (!provider) {
      this.setAgentStatus({ state: "error", message: `This project uses the agent provider "${this.meta.provider}", which is not configured in config/providers.json.` });
      return Promise.resolve();
    }
    this.agentStarting = (async () => {
      try {
        await this.renderInstructions();
      } catch (err) {
        this.log.error("could not render instructions", { error: errorMessage(err) });
      }
      const agent = new AgentHost({
        provider,
        cwd: this.dir,
        // The `think` command finds its canvas (and its way to the server) from these.
        env: agentEnv(this.deps.paths, provider, { THINK_CANVAS: this.slug, THINK_CANVAS_DIR: this.dir }),
        savedSessionId: this.state.sessionId,
        log: this.log,
        events: {
          status: (s) => this.onAgentStatus(agent, s),
          update: (u) => this.onSessionUpdate(u),
          permission: (req) => this.onPermission(req),
          crashed: (message) => {
            if (this.agent === agent) this.agent = null;
            // Between turns this is usually think being updated or restarted (the
            // agents' container goes down with it): nothing was lost, so no alarm.
            if (this.turnRunning) void this.addSystem("error", "The agent process stopped unexpectedly. It will be restarted with your next message.", message);
            else void this.addSystem("info", "The agent stopped while idle (think was probably updated). It starts again with your next message, in the same conversation.", message);
          },
        },
      });
      this.agent = agent;
      try {
        await agent.start();
      } catch {
        if (this.agent === agent) this.agent = null;
      }
    })().finally(() => {
      this.agentStarting = null;
    });
    return this.agentStarting;
  }

  private onAgentStatus(agent: AgentHost, status: AgentStatus): void {
    if (this.agent !== agent && status.state !== "ready") return;
    this.setAgentStatus(status);
    if (status.state === "ready" && status.sessionId !== this.state.sessionId) {
      const hadHistory = this.state.sessionId !== null || this.chat.all().length > 0;
      this.state.sessionId = status.sessionId;
      void this.saveState();
      if (hadHistory && !this.suppressNextDivider) void this.addEntry({ kind: "divider", id: newId("d-"), ts: Date.now(), text: "New agent session" });
      this.suppressNextDivider = false;
    }
  }

  private async restartAgent(): Promise<void> {
    if (this.turnRunning) throw new UserError("Wait for the current turn to finish (or stop it) before restarting the agent.");
    const agent = this.agent;
    this.agent = null;
    await agent?.stop();
    await this.ensureAgent();
  }

  /** Forget the agent's conversation and start a fresh ACP session. */
  private async newSession(): Promise<void> {
    if (this.turnRunning) throw new UserError("Wait for the current turn to finish (or stop it) first.");
    const agent = this.agent;
    this.agent = null;
    await agent?.stop();
    this.state.sessionId = null;
    await this.saveState();
    await this.addEntry({ kind: "divider", id: newId("d-"), ts: Date.now(), text: "New conversation" });
    // The divider above already marks the break; don't add a second one.
    this.suppressNextDivider = true;
    await this.ensureAgent();
  }

  /**
   * Called by the manager after any login terminal for our provider exits, or
   * when its settings change (its sign-in mode). A fresh agent process re-reads
   * its credentials and settings and resumes the session — after the turn, if
   * one is running.
   */
  async onProviderLogin(): Promise<void> {
    if (this.closed) return;
    if (this.turnRunning) {
      this.restartAfterTurn = true;
      return;
    }
    const agent = this.agent;
    this.agent = null;
    await agent?.stop();
    await this.ensureAgent();
  }

  private async startLogin(client: ClientConn, methodId: string, size: { cols: number; rows: number }): Promise<void> {
    const provider = this.provider;
    if (!provider) throw new UserError("No agent provider configured for this project.");
    const own = provider.loginMethods.find((m) => m.id === methodId);
    if (own) {
      const session = this.deps.logins.start(provider, { id: own.id, command: own.command, args: own.args, env: own.env }, size);
      for (const c of this.clients.values()) this.attachLogin(c, session);
      return;
    }
    const method = this.agent?.authMethods.find((m) => m.id === methodId);
    if (!method) throw new UserError("That login method is not available right now — try restarting the agent.");
    if ((method as { type?: string }).type !== "terminal") {
      await this.agent!.authenticate(methodId);
      return;
    }
    const m = method as acp.AuthMethodTerminal;
    const session = this.deps.logins.start(provider, { id: m.id, args: m.args, env: m.env }, size);
    for (const c of this.clients.values()) this.attachLogin(c, session);
  }

  private attachLogin(client: ClientConn, session: import("./agent/login.js").LoginSession): void {
    if (this.loginSinks.has(client.id)) return;
    const sink: LoginSink = {
      output: (data) => client.send({ type: "login.output", data }),
      exit: (code) => {
        this.loginSinks.delete(client.id);
        client.send({ type: "login.exit", code });
        if (this.provider) this.deps.onProviderLogin?.(this.provider.id);
      },
    };
    this.loginSinks.set(client.id, sink);
    session.attach(sink);
  }

  /** Render the provider's instructions file (AGENTS.md) from its template. */
  private async renderInstructions(): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const pool = this.deps.config.namePool();
    const cfg = this.deps.config.get();
    const text = await this.deps.templates.render(provider.instructionsTemplate, {
      project_name: this.meta.name,
      canvas_slug: this.slug,
      name_pool: pool.join(", "),
      grid_size: cfg.gridSize,
      instructions_file: provider.instructionsFile,
    });
    const file = path.join(this.dir, provider.instructionsFile);
    let current: string | null = null;
    try {
      current = await fs.readFile(file, "utf8");
    } catch {
      /* first render */
    }
    if (current !== text + "\n") await writeAtomic(file, text + "\n", this.thinkDir);
    // Canvases made before the switch to AGENTS.md carry a generated CLAUDE.md;
    // Claude Code reads AGENTS.md only when there is no CLAUDE.md, so drop it.
    if (provider.instructionsFile !== "CLAUDE.md") {
      const old = path.join(this.dir, "CLAUDE.md");
      try {
        if ((await fs.readFile(old, "utf8")).includes("Generated by the think app")) await fs.rm(old);
      } catch {
        /* none */
      }
    }
  }

  // ---------------------------------------------------------------- chat

  private async addEntry(entry: ChatEntry): Promise<void> {
    await this.chat.put(entry);
    this.broadcast({ type: "chat.append", entry });
  }

  private async updateEntry(entry: ChatEntry, persist: boolean): Promise<void> {
    if (persist) await this.chat.put(entry);
    else this.chat.putMemory(entry);
    this.broadcast({ type: "chat.update", entry });
  }

  private addSystem(level: "info" | "warning" | "error", text: string, detail?: string): Promise<void> {
    return this.addEntry({ kind: "system", id: newId("s-"), ts: Date.now(), level, text, detail });
  }

  private appendStream(kind: "agent" | "thought", text: string): void {
    if (!text) return;
    if (!this.streaming || this.streaming.kind !== kind) {
      this.finalizeStreaming();
      this.streaming = { id: newId(kind === "agent" ? "a-" : "t-"), kind, text: "", ts: Date.now() };
      const entry: ChatEntry = { kind, id: this.streaming.id, ts: this.streaming.ts, text: "" };
      this.chat.putMemory(entry);
      this.broadcast({ type: "chat.append", entry });
    }
    this.streaming.text += text;
    this.chat.putMemory({ kind, id: this.streaming.id, ts: this.streaming.ts, text: this.streaming.text });
    this.broadcast({ type: "chat.delta", id: this.streaming.id, text });
  }

  private finalizeStreaming(): void {
    const s = this.streaming;
    if (!s) return;
    this.streaming = null;
    if (s.kind === "agent" && s.text.trim()) this.lastReply = s.text.trim();
    void this.chat.put({ kind: s.kind, id: s.id, ts: s.ts, text: s.text }).catch(() => {});
  }

  private onSessionUpdate(u: acp.SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.appendStream("agent", u.content.text);
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.appendStream("thought", u.content.text);
        break;
      case "tool_call": {
        this.finalizeStreaming();
        const id = newId("tc-");
        this.toolEntries.set(u.toolCallId, id);
        this.noteToolLocations(u.locations, u.kind);
        void this.addEntry({
          kind: "tool",
          id,
          ts: Date.now(),
          toolCallId: u.toolCallId,
          title: u.title,
          toolKind: u.kind,
          status: u.status ?? "pending",
          detail: toolDetail(u.rawInput, u.content),
        });
        break;
      }
      case "tool_call_update": {
        const id = this.toolEntries.get(u.toolCallId);
        const prev = id ? this.chat.get(id) : undefined;
        if (!prev || prev.kind !== "tool") break;
        this.noteToolLocations(u.locations, u.kind ?? prev.toolKind);
        const status = u.status ?? prev.status;
        const detail = u.rawInput !== undefined || u.content ? toolDetail(u.rawInput, u.content) ?? prev.detail : prev.detail;
        const next: ChatEntry = { ...prev, title: u.title ?? prev.title, toolKind: u.kind ?? prev.toolKind, status, detail };
        void this.updateEntry(next, status === "completed" || status === "failed");
        break;
      }
      case "available_commands_update": {
        const hidden = new Set(this.provider?.hiddenCommands ?? []);
        const allowed = this.provider?.commands ? new Set(this.provider.commands) : null;
        this.commands = u.availableCommands
          .filter((c) => (allowed ? allowed.has(c.name) : true) && !hidden.has(c.name))
          .map((c) => ({ name: c.name, description: c.description, ...(c.input?.hint ? { hint: c.input.hint } : {}) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        this.broadcast({ type: "agent.commands", commands: this.commands });
        break;
      }
      default:
        break; // plans, mode/config/usage updates: not shown
    }
  }

  /**
   * Tool calls that name files count as touching those blocks (placement
   * anchors), and tell the tabs where the agent is working ("follow the agent").
   */
  private noteToolLocations(locations: acp.ToolCallLocation[] | null | undefined, kind?: string | null): void {
    for (const loc of locations ?? []) {
      const rel = path.relative(this.dir, loc.path);
      if (rel.includes(path.sep) || rel.startsWith("..")) continue;
      const parsed = parseBlockFile(rel);
      if (!parsed) continue;
      this.touched.set(parsed.name, Date.now());
      if (this.blocks.has(parsed.name)) {
        const action = kind === "edit" || kind === "delete" || kind === "move" ? "edit" : "read";
        this.broadcast({ type: "agent.focus", name: parsed.name, action });
      }
    }
  }

  private onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.finalizeStreaming();
    const requestId = newId("p-");
    const entry: ChatEntry = {
      kind: "permission",
      id: newId("pe-"),
      ts: Date.now(),
      requestId,
      title: req.toolCall.title ?? "The agent asks for permission",
      options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
    void this.addEntry(entry);
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        entryId: entry.id,
        resolve: (optionId) => {
          this.pendingPermissions.delete(requestId);
          const chosen = entry.options.find((o) => o.optionId === optionId);
          void this.updateEntry({ ...entry, outcome: chosen ? chosen.name : "cancelled" }, true);
          resolve(optionId && chosen ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
        },
      });
    });
  }

  private answerPermission(requestId: string, optionId: string | null): void {
    const p = this.pendingPermissions.get(requestId);
    if (!p) throw new UserError("That permission request is no longer pending.");
    p.resolve(optionId);
  }

  // ---------------------------------------------------------------- turns

  private setLock(locked: boolean, guest?: { by: string; note: string }): void {
    this.lock = locked ? { locked: true, since: Date.now(), reason: guest ? "guest" : "agent", ...(guest ? { by: guest.by, note: guest.note } : {}) } : { locked: false };
    this.broadcast({ type: "lock.changed", lock: this.lock });
  }

  // ---------------------------------------------------------------- outside agents ("guests")
  //
  // An outside agent joins (`think join`, or `think lock`, which joins too)
  // and gets a tab in the chat; it edits only while it holds the canvas lock,
  // and think commits its edits under its name when the lock ends (unlock,
  // leave, the user taking over or disconnecting it, or 30 minutes idle).

  private guest: { by: string; note: string; startHead: string | null; timer: NodeJS.Timeout | null } | null = null;
  private static readonly GUEST_IDLE_MS = 30 * 60_000;

  private broadcastGuests(): void {
    this.broadcast({ type: "guests.changed", guests: this.room.info(this.guest?.by ?? null) });
  }

  private async guestLine(name: string, line: Parameters<GuestRoom["add"]>[1]): Promise<GuestEntry> {
    const entry = await this.room.add(name, line);
    this.broadcast({ type: "guest.entry", name, entry });
    return entry;
  }

  /** Ring blocks in every tab — an agent changed them or points at them. `by`: an outside agent, null for the canvas agent. */
  private highlight(names: string[], by: string | null): void {
    const known = [...new Set(names)].filter((n) => this.blocks.has(n) || this.view.nodes.some((x) => x.id === n));
    if (!known.length) return;
    for (const n of known) if (this.blocks.has(n)) this.touched.set(n, Date.now());
    this.broadcast({ type: "blocks.highlight", names: known, by });
  }

  /** Join the canvas: a tab in the chat, and AGENTS.md made current for the agent to read. Callers hold the queue. */
  private async joinNow(name: string, about: string | undefined, note: string | undefined): Promise<{ already: boolean; wasDisconnected: boolean }> {
    const r = await this.room.join(name, about, note);
    await this.renderInstructions().catch((err) => this.log.error("could not render instructions", { error: errorMessage(err) }));
    if (!r.already) await this.guestLine(name, { kind: "activity", event: "joined", text: note?.trim() ? `Joined — ${note.trim()}` : "Joined" });
    this.broadcastGuests();
    return r;
  }

  /** An outside agent joins (`think join`). */
  async guestJoin(name: string, about: string | undefined, note: string | undefined): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      const r = await this.joinNow(name, about, note);
      const back = r.wasDisconnected ? " (The user had disconnected you earlier — you are back now.)" : "";
      return {
        ok: true,
        message: `${r.already ? "Still on" : "Joined"} “${this.meta.name}” as ${name}; the user sees you in a tab of the canvas chat.${back}\nRead AGENTS.md in the canvas folder before changing anything, then: think lock "what you are about to do" --as ${name}`,
      };
    });
  }

  /** An outside agent takes the canvas lock (`think lock`), joining first if it has not. */
  async guestLock(by: string, note: string, about?: string): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      if (this.lock.locked) {
        if (this.lock.reason === "guest" && this.guest?.by === by) return { ok: true, message: `You already hold the lock on “${this.meta.name}”.` };
        return {
          ok: false,
          message: this.lock.reason === "agent" ? "The canvas's own agent is working right now. Try again when it has finished." : `${this.lock.by} is working on this canvas — try again later.`,
        };
      }
      if (!this.room.isJoined(by)) await this.joinNow(by, about, undefined);
      if (note.trim()) await this.room.setNote(by, note);
      this.clearAutosave();
      await this.commitUser(); // the user's edits so far stay theirs
      await this.renderInstructions().catch(() => {});
      this.guest = { by, note, startHead: await head(this.dir), timer: null };
      this.setLock(true, { by, note });
      this.touchGuest();
      await this.guestLine(by, { kind: "activity", event: "working", text: note.trim() ? `Started editing — ${note.trim()}` : "Started editing" });
      this.broadcastGuests();
      return {
        ok: true,
        message: `Locked “${this.meta.name}” for ${by}. Edit the block files; use think add, move, link, frame… for the layout (think help). When done: think unlock "one-line summary" --as ${by} — think commits your edits under your name. The lock lapses after 30 minutes without changes.`,
      };
    });
  }

  /**
   * End an outside agent's lock: commit its edits under its name (think's
   * summary of them in the message) and tell its tab. Callers hold the queue.
   */
  private async unlockNow(summary: string | undefined): Promise<{ by: string; committed: boolean; what: string; whatFull: string; rev?: string }> {
    const g = this.guest!;
    if (g.timer) clearTimeout(g.timer);
    await this.rescanAll();
    await this.refreshView({ write: true, force: true });
    const given = summary?.trim() || this.guestSummaries.get(g.by);
    this.guestSummaries.delete(g.by);
    const done = await commitWork(this.dir, {
      subject: (s) => `${g.by}: ${given || briefSummary(s) || g.note || "changes"}`,
      author: `${g.by} <guest@think>`,
    });
    const end = done?.head ?? (await head(this.dir));
    // Everything since the lock was taken — including commits it made itself.
    const whole = g.startHead && end && g.startHead !== end ? await summarizeRange(this.dir, g.startHead, end) : null;
    const what = whole && !isEmptySummary(whole) ? briefSummary(whole) : "";
    const whatFull = whole && !isEmptySummary(whole) ? briefSummary(whole, 20) : ""; // for the agent: everything
    this.guest = null;
    this.setLock(false);
    await this.room.setNote(g.by, ""); // it said what it was doing with the lock
    await this.applyPendingComments(); // the user's comments written meanwhile
    if (done) this.broadcast({ type: "history.changed" });
    if (this.clients.size === 0) this.scheduleClose();
    return { by: g.by, committed: !!done, what, whatFull, ...(what && end ? { rev: end } : {}) };
  }

  /** `think unlock`, the banner's Take over, and the 30-minute lapse. */
  async guestUnlock(by: string | null, message: string | undefined, reason: "done" | "expired" | "takeover"): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      const g = this.guest;
      if (!g) {
        return reason === "done"
          ? { ok: true, message: "You did not hold the lock (it lapsed, the user took over, or think restarted) — anything you changed was committed then." }
          : { ok: true, message: "The canvas was not locked." };
      }
      if (reason === "done" && by && by !== g.by) return { ok: false, message: `The lock belongs to ${g.by}, not ${by}.` };
      const r = await this.unlockNow(message);
      const text =
        reason === "done"
          ? r.what
            ? `Finished — ${r.what}`
            : "Finished — no changes"
          : reason === "expired"
            ? `The lock lapsed after 30 minutes without changes${r.what ? ` — edits so far committed: ${r.what}` : ""}`
            : `You took over${r.what ? ` — its edits so far committed: ${r.what}` : ""}`;
      await this.guestLine(r.by, { kind: "activity", event: reason === "done" ? "finished" : reason === "expired" ? "lapsed" : "takeover", text, ...(r.rev ? { rev: r.rev } : {}) });
      this.broadcastGuests();
      return { ok: true, message: r.committed ? `Committed as ${r.by} and unlocked: ${r.whatFull}.` : r.whatFull ? `Unlocked: ${r.whatFull}.` : "Unlocked — nothing had changed." };
    });
  }

  /** `think leave`: the lock ends (edits committed), and the agent's tab closes. */
  async guestLeave(name: string, summary: string | undefined): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      if (!this.room.isJoined(name)) return { ok: true, message: `You were not on “${this.meta.name}”.` };
      const r = this.guest?.by === name ? await this.unlockNow(summary) : null;
      await this.room.leave(name, false);
      this.guestSummaries.delete(name);
      await this.guestLine(name, { kind: "activity", event: "left", text: r?.what ? `Finished and left — ${r.what}` : "Left", ...(r?.rev ? { rev: r.rev } : {}) });
      this.broadcastGuests();
      if (this.clients.size === 0 && !this.lock.locked) this.scheduleClose();
      return { ok: true, message: `Left “${this.meta.name}”${r?.whatFull ? ` — your edits were committed: ${r.whatFull}` : ""}. Your tab closes in the user's chat.` };
    });
  }

  /** The user disconnects an outside agent (its tab's menu): like Take over, and it leaves; its next `think` call is told. */
  private async guestDisconnect(name: string): Promise<void> {
    if (typeof name !== "string") throw new UserError("Which outside agent?");
    await this.queue.run(async () => {
      if (!this.room.isJoined(name)) return;
      const r = this.guest?.by === name ? await this.unlockNow(undefined) : null;
      await this.room.leave(name, true);
      this.guestSummaries.delete(name);
      await this.guestLine(name, { kind: "activity", event: "disconnected", text: `You disconnected ${name}${r?.what ? ` — its edits so far committed: ${r.what}` : ""}`, ...(r?.rev ? { rev: r.rev } : {}) });
      this.broadcastGuests();
    });
  }

  /**
   * An outside agent the user disconnected, calling again: what to tell it
   * (once), or null. It is told only once; after that it can join again.
   */
  async guestNotice(name: string): Promise<string | null> {
    return this.queue.run(async () => {
      const g = this.room.get(name);
      if (!g?.notice) return null;
      await this.room.clearNotice(name);
      const when = g.leftAt ? new Date(g.leftAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.TZ || undefined }) : "earlier";
      return `The user disconnected you from “${this.meta.name}” (${when}). Your edits up to then were committed under your name. Don't join again unless your user asks you to (then: think join ${this.slug} --as ${name}).`;
    });
  }

  /** A message from an outside agent, shown in its own tab (`think say`). */
  async guestSay(by: string, text: string): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      if (!this.room.isJoined(by)) return { ok: false, message: `Join first: think join ${this.slug} --as ${by}` };
      await this.guestLine(by, { kind: "say", text: text.slice(0, 20_000) });
      if (this.clients.size === 0 && !this.lock.locked) this.scheduleClose();
      return { ok: true, message: `Posted in your tab of “${this.meta.name}”'s chat. The user answers wherever they usually talk to you — not in think.` };
    });
  }

  /** The canvases an outside agent is on, by name — for the `think` command's requests. */
  isGuestJoined(name: string): boolean {
    return this.room.isJoined(name);
  }

  /** For `think status`. */
  guestStatus(): string {
    const l = this.lock;
    const who = !l.locked ? "free" : l.reason === "agent" ? "the canvas agent is working" : `locked by ${l.by}${l.note ? ` (${l.note})` : ""}`;
    const joined = this.room.joined();
    return [
      `canvas: ${this.meta.name} (${this.slug})`,
      `open in ${this.clients.size} tab${this.clients.size === 1 ? "" : "s"}`,
      `agent: ${this.agentStatus.state}`,
      `lock: ${who}`,
      `outside agents here: ${joined.length ? joined.join(", ") : "none"}`,
    ].join("\n");
  }

  /** The canvas agent's chat as plain text, for `think chat`. */
  chatText(n: number): string {
    const entries = this.chat.all().filter((e) => e.kind === "user" || e.kind === "agent" || e.kind === "guest" || e.kind === "system");
    return entries
      .slice(-n)
      .map((e) => {
        const t = new Date(e.ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: process.env.TZ || undefined });
        const who = e.kind === "user" ? "user" : e.kind === "agent" ? "agent" : e.kind === "guest" ? e.by : "think";
        return `[${t}] ${who}: ${e.kind === "system" ? e.text : (e as { text: string }).text}`;
      })
      .join("\n\n");
  }

  private touchGuest(): void {
    const g = this.guest;
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => void this.guestUnlock(null, undefined, "expired").catch(() => {}), ProjectRuntime.GUEST_IDLE_MS);
  }

  // ---------------------------------------------------------------- the think command's canvas commands

  /**
   * A canvas command from the `think` command (commands.ts) — the canvas
   * agent's during its turn, an outside agent's once it has joined (and, for
   * the commands that change something, while it holds the lock).
   */
  async command(caller: Caller, req: CommandRequest): Promise<{ ok: boolean; message: string }> {
    if (!CANVAS_COMMANDS.has(req.op)) return { ok: false, message: `Unknown command “${req.op}” (think help).` };
    return this.queue.run(async () => {
      if (caller.kind === "agent") {
        if (!this.turnRunning) return { ok: false, message: "The think command works for the canvas's own agent only during its turn." };
      } else {
        if (!this.room.isJoined(caller.name)) return { ok: false, message: `Join the canvas first: think join ${this.slug} --as ${caller.name}` };
        if (CHANGING_COMMANDS.has(req.op) && this.guest?.by !== caller.name) {
          const now = !this.lock.locked ? "" : this.lock.reason === "agent" ? " The canvas's own agent is working right now — wait until it has finished." : ` ${this.lock.by} holds it right now.`;
          return { ok: false, message: `Take the lock before changing the canvas: think lock "what you are about to do" --as ${caller.name}.${now}` };
        }
        if (this.guest?.by === caller.name) this.touchGuest();
      }
      await this.rescanAll(); // build on what is on disk this moment (the agent may have just written a file)
      if (LAYOUT_COMMANDS.has(req.op) && this.canvasError) {
        return { ok: false, message: `canvas.json is not valid right now (${this.canvasError}). Fix it first — the layout commands build on it.` };
      }
      if (req.op === "comment") {
        await this.readComments();
        if (this.commentsError) return { ok: false, message: `comments.json is not valid right now (${this.commentsError}). Fix it first.` };
      }
      try {
        return { ok: true, message: await runCommand(this.commandHost(caller), caller, req) };
      } catch (err) {
        if (err instanceof OpError || err instanceof UserError) return { ok: false, message: err.message };
        throw err;
      }
    });
  }

  /** What a command may do to this canvas, on behalf of `caller`. Used inside the queue. */
  private commandHost(caller: Caller): CommandHost {
    const by = caller.kind === "agent" ? null : caller.name;
    const origin = caller.kind === "agent" ? "agent" : "external";
    return {
      meta: { name: this.meta.name, slug: this.slug, grid: this.grid },
      view: () => this.view,
      blockType: (name) => this.blocks.get(name)?.type,
      blockTypes: () => new Map([...this.blocks].map(([name, b]) => [name, b.type])),
      comments: async () => {
        await this.readComments();
        return this.comments;
      },
      setLayout: async (next, touched) => {
        this.lastValid = next;
        this.canvasError = null;
        await this.refreshView({ write: true, force: true });
        this.highlight(touched, by);
      },
      rename: async (name, to) => {
        await this.renameBlockNow(name, to, origin);
        this.highlight([to], by);
      },
      remove: async (names) => {
        await this.deleteBlocksNow(names, origin);
      },
      setComments: (list) => this.writeComments(list),
      highlight: (names) => this.highlight(names, by),
      setSummary: (text) => {
        if (caller.kind === "agent") this.turnSummary = text;
        else this.guestSummaries.set(caller.name, text);
      },
    };
  }

  /** A request from the canvas agent's `think` command (this canvas's .think/cli/). */
  private async agentRequest(raw: unknown): Promise<{ ok: boolean; message: string }> {
    const req = toCommandRequest(raw);
    if (!req) return { ok: false, message: "That request is not one the think command sends (is it up to date?)." };
    if (GUEST_ONLY_COMMANDS.has(req.op)) {
      return {
        ok: false,
        message: `think ${req.op} is for outside agents. You are this canvas's own agent: you work during your turn, think commits your work when it ends, and you answer the user in your chat.`,
      };
    }
    if (req.op === "status") return { ok: true, message: this.guestStatus() };
    return this.command({ kind: "agent" }, req);
  }

  private setValidation(report: ValidationReport | null): void {
    this.validation = report;
    if (report) this.broadcast({ type: "validation.errors", report });
  }

  /** Accept a prompt: take the lock (after any edits already queued), then run the turn in the background. */
  private async prompt(text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim()) throw new UserError("Type a message first.");
    await this.queue.run(async () => {
      if (this.lock.locked) throw new UserError(this.lock.reason === "guest" ? `${this.lock.by} is working on this canvas right now.` : "The agent is already working.");
      if (!this.agent || this.agentStatus.state !== "ready") {
        const s = this.agentStatus;
        if (s.state === "needs-login") throw new UserError("Log the agent in first.");
        if (s.state === "starting") throw new UserError("The agent is still starting — try again in a moment.");
        void this.ensureAgent();
        throw new UserError("The agent is not running. Starting it — try again in a moment.");
      }
      this.setLock(true);
      this.turnRunning = true;
      this.cancelRequested = false;
      this.broadcast({ type: "agent.turn", running: true });
    });
    void this.runTurn(text, { command: this.isSlashCommand(text) });
  }

  /**
   * "/compact", "/context now"… — a command the agent offers. Commands are only
   * recognised at the very start of a message, so they are sent on their own,
   * without the app's notes around them.
   */
  private isSlashCommand(text: string): boolean {
    const m = /^\/([^\s]+)/.exec(text.trim());
    return !!m && this.commands.some((c) => c.name === m[1]);
  }

  private cancel(): void {
    if (!this.turnRunning) return;
    this.cancelRequested = true;
    for (const p of [...this.pendingPermissions.values()]) p.resolve(null);
    this.agent?.cancel();
  }

  private async sendPrompt(parts: (string | undefined)[]): Promise<acp.StopReason> {
    const agent = this.agent;
    if (!agent) throw new Error("The agent is not running.");
    return agent.prompt(parts.filter((p): p is string => !!p && p.length > 0).map((text) => ({ type: "text", text })));
  }

  private async runTurn(text: string, opts: { command?: boolean } = {}): Promise<void> {
    const max = this.deps.config.get().validationMaxAttempts;
    let turnStartHead: string | null = null;
    this.touched.clear();
    this.toolEntries.clear();
    try {
      // 1–2. Flush and commit the user's edits (queued edits were applied before the lock).
      await this.queue.run(async () => {
        this.clearAutosave();
        await this.commitUser();
        this.state.turnInProgress = true;
        await this.saveState();
        await this.renderInstructions();
        await this.pinProtected();
      });
      turnStartHead = await head(this.dir);
      this.turnStartedAt = Date.now();
      this.lastReply = "";
      this.turnSummary = null;

      // 4. Assemble the prompt from templates.
      const before = opts.command ? undefined : await this.changeNote(turnStartHead);
      const protectedNames = [...this.pinned.keys()];
      const after = opts.command
        ? undefined
        : await this.deps.templates.render("turn-suffix.md", {
            protected_note: protectedNames.length
              ? `Protected blocks (read them, never change, move, rename or delete them): ${protectedNames.join(", ")}.`
              : "",
          });
      await this.addEntry({ kind: "user", id: newId("u-"), ts: Date.now(), text, injected: before || after ? { before, after } : undefined });

      // 5. Run the turn.
      let stop: acp.StopReason = await this.sendPrompt([before, text, after]);
      let attempt = 0;
      for (;;) {
        this.finalizeStreaming();
        // Post-turn 1–2: undo changes to protected blocks, then commit the
        // agent's work — think commits it; agents don't run git.
        const protectedIssues = await this.queue.run(async () => {
          await this.rescanAll();
          const found = await this.enforceProtected();
          await this.refreshView({ write: true });
          await this.commitAgentWork(attempt);
          return found;
        });
        if (stop === "cancelled" || this.cancelRequested) {
          await this.addSystem("info", "Stopped.");
          break;
        }
        // Post-turn 3–4: validate; feed errors back, up to the cap.
        const issues = [...protectedIssues, ...(await this.validateTurn(turnStartHead))];
        if (issues.length === 0) {
          this.setValidation({ issues: [], attempt, maxAttempts: max, final: true });
          break;
        }
        if (attempt >= max || !this.agent) {
          this.setValidation({ issues, attempt, maxAttempts: max, final: true });
          await this.addSystem(
            "error",
            attempt > 0
              ? `Validation still fails after ${attempt} automatic ${attempt === 1 ? "retry" : "retries"}.`
              : "The agent's changes did not validate.",
            formatIssues(issues),
          );
          break;
        }
        attempt++;
        this.setValidation({ issues, attempt, maxAttempts: max, final: false });
        const followUp = await this.deps.templates.render("validation-errors.md", {
          errors: formatIssues(issues),
          attempt,
          max_attempts: max,
        });
        await this.addEntry({
          kind: "user",
          id: newId("u-"),
          ts: Date.now(),
          text: `Automatic follow-up: fix ${issues.length} validation ${issues.length === 1 ? "error" : "errors"} (attempt ${attempt} of ${max})`,
          injected: { before: followUp },
          auto: "validation",
        });
        stop = await this.sendPrompt([followUp]);
      }
    } catch (err) {
      this.finalizeStreaming();
      if (err instanceof AuthRequiredError) {
        await this.addSystem("warning", err.message).catch(() => {});
      } else {
        this.log.error("turn failed", { error: errorMessage(err) });
        await this.addSystem("error", "The turn ended with an error.", errorMessage(err)).catch(() => {});
      }
      await this.queue
        .run(async () => {
          await this.rescanAll();
          await this.commitAgentWork(0);
        })
        .catch(() => {});
    } finally {
      // Post-turn 5–6: reconcile the layout, record HEAD, unlock.
      await this.queue
        .run(async () => {
          await this.rescanAll();
          await this.enforceProtected();
          await this.refreshView({ write: true, force: true });
          await this.commitAgentWork(0);
          await this.syncThinkFile({ repair: true });
          const end = await head(this.dir);
          // A slash command is not a conversation turn: the user's changes it
          // did not show the agent are still reported with the next message.
          if (!opts.command) this.state.lastAgentHead = end;
          this.state.turnInProgress = false;
          await this.saveState();
          await this.recordTurn(text, turnStartHead, end, !!opts.command);
          // The user's edits to protected blocks during the turn land now, as theirs —
          // and so do the comments they wrote meanwhile.
          await this.applyPendingComments();
          await this.applyDrafts();
        })
        .catch((err) => this.log.error("post-turn steps failed", { error: errorMessage(err) }));
      for (const p of [...this.pendingPermissions.values()]) p.resolve(null);
      this.turnRunning = false;
      this.cancelRequested = false;
      this.broadcast({ type: "agent.turn", running: false });
      this.setLock(false);
      if (this.restartAfterTurn) {
        this.restartAfterTurn = false;
        void this.onProviderLogin();
      }
      if (this.clients.size === 0) this.scheduleClose();
    }
  }

  /**
   * The note put before the user's message when anyone but the agent changed
   * the canvas since its last turn: who, and what — content from git, layout
   * described in words (not a raw canvas.json diff).
   */
  private async changeNote(now: string | null): Promise<string | undefined> {
    const base = this.state.lastAgentHead;
    if (!now || base === now) return undefined;
    const others = (await commitsSince(this.dir, base)).filter((c) => c.authorEmail !== AGENT_EMAIL);
    if (!others.length && !this.chat.all().some((e) => e.kind === "guest" && e.ts > (this.lastTurn?.at ?? 0))) return undefined;
    const summary = await summarizeRange(this.dir, base, now, "file");
    const who = [...new Set(others.map((c) => (c.authorEmail === USER_EMAIL ? "the user" : c.authorEmail === APP_EMAIL ? "the think app" : `${c.authorName} (an outside agent)`)))];
    const restores = others.filter((c) => c.subject.startsWith("restore:")).map((c) => `- ${c.subject.replace(/^restore:\s*/, "Restored ")}`);
    const since = this.lastTurn?.at ?? 0;
    for (const e of this.chat.all()) {
      if (e.kind === "guest" && e.ts > since) restores.push(`- ${e.by} wrote in the chat: “${e.text.length > 400 ? e.text.slice(0, 400) + "…" : e.text}”`);
    }
    const lines = [...restores, ...summaryLines(summary)];
    // Only the app's own housekeeping (settings, upgrades): nothing to tell.
    if (!lines.length && others.every((c) => c.authorEmail === APP_EMAIL)) return undefined;
    return this.deps.templates.render("user-changes.md", {
      last_agent_head: base ?? "(the first commit)",
      authors: who.join(", "),
      summary: lines.length ? lines.join("\n") : "- (only housekeeping — nothing to look at)",
      commit_count: others.length,
    });
  }

  /** Remember every protected block as it is now (turn start). */
  private async pinProtected(): Promise<void> {
    this.pinned.clear();
    for (const n of this.view.nodes) {
      if (n.type !== "file" || !n.protected) continue;
      const b = this.blocks.get(n.id);
      if (!b) continue;
      try {
        this.pinned.set(n.id, { file: b.file, bytes: await fs.readFile(path.join(this.dir, b.file)), node: { ...n } });
      } catch {
        /* vanished meanwhile */
      }
    }
  }

  /**
   * Undo whatever the agent did to protected blocks — content, position,
   * size, the protected flag itself, and copies left by a rename — and
   * return the issues to tell it about. Runs in the queue.
   */
  private async enforceProtected(): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!this.pinned.size) return issues;
    const restored: string[] = [];
    const pinnedHashes = new Map([...this.pinned].map(([n, p]) => [hashOf(p.bytes), n]));
    for (const [name, p] of this.pinned) {
      let cur: Buffer | null = null;
      try {
        cur = await fs.readFile(path.join(this.dir, p.file));
      } catch {
        /* deleted or renamed */
      }
      if (cur && cur.equals(p.bytes)) continue;
      await writeAtomic(path.join(this.dir, p.file), p.bytes, this.thinkDir);
      restored.push(p.file);
      issues.push({
        block: name,
        file: p.file,
        message: `"${name}" is protected: the user asked you not to change it (reading it is fine). Your ${cur ? "edit" : "deletion or rename"} was undone. Put new content in a new block instead.`,
      });
    }
    // A protected block "renamed" by the agent leaves a copy under the new name.
    for (const b of this.blocks.values()) {
      const owner = pinnedHashes.get(b.hash);
      if (owner && owner !== b.name && b.firstSeen >= this.turnStartedAt - 1000) {
        await fs.rm(path.join(this.dir, b.file), { force: true });
        restored.push(b.file);
      }
    }
    // Layout: protected blocks keep their node exactly (and stay protected).
    const moved: string[] = [];
    const nodes = this.lastValid.nodes.map((n) => {
      const p = this.pinned.get(n.id);
      if (!p || n.type !== "file") return n;
      if (n.x !== p.node.x || n.y !== p.node.y || n.width !== p.node.width || n.height !== p.node.height || !n.protected) {
        moved.push(n.id);
        return { ...p.node };
      }
      return n;
    });
    for (const [name, p] of this.pinned) {
      if (!nodes.some((n) => n.id === name)) {
        nodes.push({ ...p.node });
        moved.push(name);
      }
    }
    if (moved.length) {
      this.lastValid = { ...this.lastValid, nodes };
      issues.push({ file: "canvas.json", message: `Protected blocks keep their place, size and "protected": true — restored: ${moved.join(", ")}.` });
    }
    if (restored.length) {
      await this.rescanAll();
      // Only what the agent had committed itself needs undoing in git: its
      // uncommitted changes are simply gone, and the rest of its work is
      // committed as its own next.
      const dirty = new Set(await changedPaths(this.dir));
      await commitPaths(this.dir, restored.filter((f) => dirty.has(f)), { message: "think: undo the agent's changes to protected blocks", author: APP_AUTHOR });
    }
    if (issues.length) this.log.warn("agent touched protected blocks", { issues: issues.length });
    return issues;
  }

  /** Write the user's mid-turn edits to protected blocks and commit them as theirs. */
  private async applyDrafts(): Promise<void> {
    const drafts = [...this.pinned].filter(([, p]) => p.draft !== undefined);
    this.pinned.clear();
    await fs.rm(path.join(this.thinkDir, "drafts.json"), { force: true });
    for (const [name, p] of drafts) {
      const b = this.blocks.get(name);
      if (!b || b.file !== p.file) continue;
      await this.writeBlockFile(b, p.draft!);
      const entry = await this.readEntry(b.file, b);
      if (entry) this.files.set(b.file, entry);
    }
    this.recomputeBlocks();
    // Everyone sees the real file contents again (drafts included).
    for (const b of this.blocks.values()) if (drafts.some(([n]) => n === b.name)) this.broadcast({ type: "file.changed", block: this.blockInfo(b), origin: "user" });
    if (drafts.length) await this.commitUser();
  }

  /** Append the turn to .think/turns.jsonl (History reads it) and tell tabs what changed. */
  private async recordTurn(prompt: string, start: string | null, end: string | null, command: boolean): Promise<void> {
    if (!end) return;
    let summary: ChangeSummary | null = null;
    try {
      summary = start && start !== end ? await summarizeRange(this.dir, start, end) : null;
    } catch {
      /* history is best-effort */
    }
    const record = { at: Date.now(), start, end, prompt: prompt.slice(0, 2000), reply: this.lastReply.slice(0, 600), command, summary };
    await fs.appendFile(path.join(this.thinkDir, "turns.jsonl"), JSON.stringify(record) + "\n").catch(() => {});
    this.lastTurn = { at: record.at, changed: summary ? [...summary.added, ...summary.edited, ...summary.renamed.map(([, b]) => b)] : [] };
    this.broadcast({ type: "turn.summary", lastTurn: this.lastTurn });
  }

  /**
   * Commit the agent's work (think does; agents never run git): its one-line
   * summary (`think summary`) — or think's own — then the list of changes.
   * `attempt` > 0: the fixes after a validation follow-up. Callers hold the queue.
   */
  private async commitAgentWork(attempt: number): Promise<void> {
    const given = this.turnSummary;
    const done = await commitWork(this.dir, {
      subject: (s) => `agent: ${given ?? (attempt > 0 ? `fixed the problems think found — ${briefSummary(s) || "changes"}` : briefSummary(s) || "changes")}`,
    });
    if (!done) return;
    this.turnSummary = null; // said once: a follow-up's fixes get their own
    this.log.info("agent commit", { head: done.head.slice(0, 8) });
    this.broadcast({ type: "history.changed" });
  }

  /** Mermaid files changed since the turn started, plus canvas.json (parse, schema, consistency). */
  async validateTurn(sinceHead: string | null): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const now = await head(this.dir);
    const changed = new Set(await filesChangedBetween(this.dir, sinceHead, now));
    for (const file of changed) {
      const parsed = parseBlockFile(file);
      if (!parsed || parsed.type !== "mermaid") continue;
      let source: string;
      try {
        source = await fs.readFile(path.join(this.dir, file), "utf8");
      } catch {
        continue; // deleted in the turn
      }
      const error = await this.deps.mermaid.validate(source);
      if (error) issues.push({ block: parsed.name, file, message: error });
    }
    let text: string | null = null;
    try {
      text = await fs.readFile(path.join(this.dir, "canvas.json"), "utf8");
    } catch {
      issues.push({ file: "canvas.json", message: "canvas.json is missing." });
    }
    if (text !== null) {
      const r = parseCanvas(text);
      if (!r.ok) issues.push({ file: "canvas.json", message: r.error });
      else issues.push(...lintCanvas(r.canvas, this.blockEntries()));
    }
    if (changed.has(COMMENTS_FILE)) {
      await this.readComments();
      if (this.commentsError) issues.push({ file: COMMENTS_FILE, message: this.commentsError });
      else {
        const known = new Set(this.view.nodes.map((n) => n.id));
        const orphans = this.comments.filter((c) => c.on !== null && !known.has(c.on) && !this.blocks.has(c.on));
        if (orphans.length) issues.push({ file: COMMENTS_FILE, message: `comments on nodes that do not exist: ${[...new Set(orphans.map((c) => c.on))].join(", ")} — use a block name, a group id, or null for the canvas` });
      }
    }
    for (const c of this.conflicts) issues.push({ message: c });
    issues.push(...(await this.strayFiles(changed)));
    return issues;
  }

  /**
   * Files the turn left where they do not belong: the top level holds blocks,
   * canvas.json and README.md only; scratch work goes in work/.
   */
  private async strayFiles(changed: Set<string>): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const allowed = new Set(["canvas.json", "README.md", THINK_FILE, COMMENTS_FILE, "AGENTS.md", "CLAUDE.md", ".gitignore"]);
    const seenDirs = new Set<string>();
    for (const f of changed) {
      if (f.startsWith(".") || f.startsWith("work/") || allowed.has(f) || parseBlockFile(f)) continue;
      if (!(await exists(path.join(this.dir, f)))) continue; // deleted in the turn
      if (f.includes("/")) {
        const top = f.split("/")[0];
        if (seenDirs.has(top)) continue;
        seenDirs.add(top);
        issues.push({ file: `${top}/`, message: `folder "${top}/" is not part of the canvas; keep scratch work in work/ (move it there, or delete it).` });
        continue;
      }
      const m = /^(.+)\.(md|mmd|html|png|jpe?g|webp|gif)$/i.exec(f);
      issues.push({
        file: f,
        message: m
          ? `"${f}" does not show on the canvas: block names are lowercase letters, digits and hyphens. Rename it (e.g. "${toSlug(m[1])}.${m[2].toLowerCase()}") or move it into work/.`
          : `"${f}" is not a block; the top level holds only blocks, canvas.json and README.md. Move it into work/ (or delete it).`,
      });
    }
    return issues;
  }
}

// ------------------------------------------------------------------ helpers

/** A comment's text: trimmed, capped. */
/** An uploaded image's type and size, or a UserError saying why it is not one. */
function readImage(data: Buffer, mime: string): { ext: string; natural?: { width: number; height: number } } {
  let natural: { width: number; height: number } | undefined;
  let ext = extensionForMime(mime);
  try {
    const dim = imageSize(data);
    if (dim.width && dim.height) natural = { width: dim.width, height: dim.height };
    ext = ext ?? (dim.type === "jpg" ? "jpg" : dim.type ?? null);
  } catch {
    throw new UserError("That file is not an image this canvas can show (PNG, JPEG, WebP or GIF).");
  }
  if (!ext || !["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    throw new UserError("Only PNG, JPEG, WebP and GIF images are supported.");
  }
  return { ext, natural };
}

function cleanComment(text: unknown): string {
  return typeof text === "string" ? text.replace(/\r/g, "").trim().slice(0, MAX_COMMENT) : "";
}

/** `like` if it is free, else `like-2`, `like-3`… (`always`: never the bare name — for new group ids). */
function freeName(like: string, taken: Set<string>, always = false): string {
  const base = like.replace(/-\d+$/, "").slice(0, 60) || "block";
  if (!always && !taken.has(like)) return like;
  for (let i = 2; ; i++) {
    const candidate = always ? `${base}-${Math.random().toString(36).slice(2, 8)}` : `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 30 → "30 s", 60 → "1 min", 150 → "2.5 min", 3600 → "1 h". */
export function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
  return `${+(s / 3600).toFixed(1)} h`;
}

function sanitizeEdge(input: CanvasEdge): CanvasEdge | null {
  if (!input || typeof input.fromNode !== "string" || typeof input.toNode !== "string") return null;
  const e: CanvasEdge = { id: typeof input.id === "string" && input.id ? input.id.slice(0, 64) : newId("e-"), fromNode: input.fromNode, toNode: input.toNode };
  if (input.fromSide && SIDES.includes(input.fromSide)) e.fromSide = input.fromSide;
  if (input.toSide && SIDES.includes(input.toSide)) e.toSide = input.toSide;
  if (input.fromEnd === "none" || input.fromEnd === "arrow") e.fromEnd = input.fromEnd;
  if (input.toEnd === "none" || input.toEnd === "arrow") e.toEnd = input.toEnd;
  if (typeof input.label === "string" && input.label.trim()) e.label = input.label.trim().slice(0, 200);
  if (input.style && EDGE_STYLES.includes(input.style) && input.style !== "solid") e.style = input.style;
  return e;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "block";
}

async function readLastTurn(file: string): Promise<LastTurn | null> {
  try {
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as { at: number; summary: ChangeSummary | null };
    const s = last.summary;
    return { at: last.at, changed: s ? [...s.added, ...s.edited, ...s.renamed.map(([, b]) => b)] : [] };
  } catch {
    return null;
  }
}

function renameCandidate(b: FileEntry): RenameCandidate {
  return { name: b.name, type: b.type, hash: b.hash, text: b.content };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `- ${i.file ?? i.block ?? "project"}: ${i.message.replace(/\n+/g, "\n  ")}`).join("\n");
}

function toolDetail(rawInput: unknown, content: acp.ToolCallContent[] | null | undefined): string | undefined {
  const parts: string[] = [];
  if (rawInput !== undefined && rawInput !== null && !(typeof rawInput === "object" && Object.keys(rawInput as object).length === 0)) {
    parts.push(typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2));
  }
  for (const c of content ?? []) {
    if (c.type === "content" && c.content.type === "text") parts.push(c.content.text);
    else if (c.type === "diff") parts.push(`--- ${c.path}\n${c.newText.slice(0, 2000)}`);
  }
  const text = parts.join("\n\n").trim();
  if (!text) return undefined;
  return text.length > 6000 ? text.slice(0, 6000) + "\n…" : text;
}

export { AGENT_EMAIL };
