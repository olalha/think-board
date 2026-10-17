// One ACP agent process for one project.
//
// The server is the ACP client; the browser never speaks ACP. AgentHost owns
// the subprocess and the connection, opens a session (resuming the previous
// one when the agent supports it), and reports status. Everything turn-shaped
// — locking, commits, prompt assembly, validation — lives in the project
// runtime, which drives this class.

import { spawnProcess, type AgentProcess } from "./process.js";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentStatus, AuthMethodInfo } from "../../shared/protocol.js";
import type { ProviderConfig } from "../config.js";
import { errorMessage, type Logger } from "../util.js";

export interface AgentHostEvents {
  status(status: AgentStatus): void;
  update(update: acp.SessionUpdate): void;
  permission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** The process ended without stop() being called. */
  crashed(message: string): void;
}

export interface AgentHostOptions {
  provider: ProviderConfig;
  cwd: string;
  env: Record<string, string>;
  savedSessionId: string | null;
  events: AgentHostEvents;
  log: Logger;
}

const AUTH_REQUIRED = -32000;

/** Thrown by prompt() when the agent says it needs a login. */
export class AuthRequiredError extends Error {}

/**
 * Identity pushed by agents that support the interim `_auth/status_update`
 * extension (claude-agent-acp does). Optional: agents without it are judged by
 * the standard `auth_required` error alone.
 */
interface AuthIdentity {
  kind: string;
  label?: string;
  account?: { plan?: string };
}

export function isAuthRequired(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === AUTH_REQUIRED;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

export class AgentHost {
  status: AgentStatus = { state: "stopped" };
  sessionId: string | null = null;
  authMethods: acp.AuthMethod[] = [];
  private child: AgentProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private agentCaps: acp.AgentCapabilities | undefined;
  /** session/load replays history as updates; we have our own transcript. */
  private replaying = false;
  private stopping = false;
  private stderrTail: string[] = [];
  private identity: AuthIdentity | null = null;

  constructor(private readonly opts: AgentHostOptions) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  private setStatus(status: AgentStatus): void {
    this.status = status;
    this.opts.events.status(status);
  }

  async start(): Promise<void> {
    const { provider, cwd, env, log } = this.opts;
    this.stopping = false;
    this.setStatus({ state: "starting" });
    const child = spawnProcess({ command: provider.command, args: provider.args, cwd, env });
    this.child = child;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.once("exit", (code: number | null, signal: string | null) => {
      const expected = this.stopping;
      this.child = null;
      this.conn = null;
      if (expected) {
        this.setStatus({ state: "stopped" });
        return;
      }
      const tail = this.stderrTail.slice(-5).join("\n");
      const message = `The agent process exited (code ${code ?? "none"}${signal ? `, ${signal}` : ""}).${tail ? `\n${tail}` : ""}`;
      log.warn("agent exited unexpectedly", { code, signal });
      this.setStatus({ state: "error", message });
      this.opts.events.crashed(message);
    });
    child.once("error", (err: Error) => log.error("agent spawn error", { error: errorMessage(err) }));

    const conn = acp
      .client({ name: "think" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.opts.events.permission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (this.replaying || ctx.params.sessionId !== this.sessionId) return;
        this.opts.events.update(ctx.params.update);
      })
      .onNotification(
        "_auth/status_update",
        (p: unknown) => p as { authStatus?: AuthIdentity },
        (ctx) => this.onIdentity(ctx.params?.authStatus ?? null),
      )
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    this.conn = conn;

    try {
      const init = await Promise.race([
        withTimeout(
          conn.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: "think", version: "0.1.0" },
            clientCapabilities: {
              // No fs/terminal capabilities: the agent reads and writes the
              // project folder directly with its own tools. The file watcher
              // is what sees its edits, whichever agent it is.
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              // Lets agents advertise terminal login methods, which the
              // browser login terminal can run.
              auth: { terminal: true },
            },
          }),
          60_000,
          "initialize",
        ),
        exited.then(() => {
          throw new Error(`The agent process exited during startup.\n${this.stderrTail.slice(-5).join("\n")}`);
        }),
      ]);
      this.agentCaps = init.agentCapabilities;
      this.authMethods = init.authMethods ?? [];
      await this.openSession();
    } catch (err) {
      if (!this.stopping) {
        log.error("agent start failed", { error: errorMessage(err) });
        this.setStatus({ state: "error", message: errorMessage(err) });
      }
      await this.stop();
      throw err;
    }
  }

  /**
   * How to log in: the provider's own terminal methods (from its config) first,
   * then the agent's — terminal ones run in the browser terminal, "env_var"
   * ones are shown as a hint, others go through `authenticate`.
   */
  authMethodInfo(): AuthMethodInfo[] {
    const provider = this.opts.provider;
    const list: AuthMethodInfo[] = [
      ...provider.loginMethods.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null, terminal: true })),
      ...this.authMethods
        .filter((m) => !provider.hiddenAuthMethods.includes(m.id) && m.id !== provider.apiKeyMethod)
        .map((m) => {
          const type = (m as { type?: string }).type;
          const vars = type === "env_var" ? ((m as { vars?: { name: string }[] }).vars ?? []).map((v) => v.name) : undefined;
          return { id: m.id, name: m.name, description: m.description ?? null, terminal: type === "terminal", ...(vars ? { env: vars } : {}) };
        }),
    ];
    // The provider's own key: a switch in think (offered when the server has the key).
    const key = provider.apiKeyEnv;
    if (key) {
      const keyOnServer = !!process.env[key];
      const own = list.find((m) => m.env?.includes(key));
      if (own) own.keyOnServer = keyOnServer;
      else list.push({ id: "think:api-key", name: "API key", description: null, terminal: false, env: [key], keyOnServer });
    }
    return list;
  }

  private async openSession(): Promise<void> {
    const conn = this.conn!;
    const { cwd, provider, savedSessionId } = this.opts;
    const _meta = provider.sessionMeta ?? undefined;
    let sessionId: string | null = null;
    let resumed = false;
    let modes: acp.SessionModeState | null | undefined;

    try {
      if (savedSessionId && this.agentCaps?.sessionCapabilities?.resume) {
        try {
          const r = await withTimeout(
            conn.agent.request(acp.methods.agent.session.resume, { sessionId: savedSessionId, cwd, mcpServers: [], _meta }),
            60_000,
            "session/resume",
          );
          sessionId = savedSessionId;
          modes = r.modes;
          resumed = true;
        } catch (err) {
          if (isAuthRequired(err)) throw err;
          this.opts.log.warn("session/resume failed; starting a new session", { error: errorMessage(err) });
        }
      } else if (savedSessionId && this.agentCaps?.loadSession) {
        this.replaying = true;
        try {
          const r = await withTimeout(
            conn.agent.request(acp.methods.agent.session.load, { sessionId: savedSessionId, cwd, mcpServers: [], _meta }),
            120_000,
            "session/load",
          );
          sessionId = savedSessionId;
          modes = r.modes;
          resumed = true;
        } catch (err) {
          if (isAuthRequired(err)) throw err;
          this.opts.log.warn("session/load failed; starting a new session", { error: errorMessage(err) });
        } finally {
          this.replaying = false;
        }
      }
      if (!sessionId) {
        const r = await withTimeout(
          conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta }),
          120_000,
          "session/new",
        );
        sessionId = r.sessionId;
        modes = r.modes;
      }
    } catch (err) {
      if (isAuthRequired(err)) {
        // API-key mode: an agent that wants its key method chosen explicitly
        // (Codex) is authenticated with it once, then the session is retried.
        const keyMethod = this.envKeyMethod();
        if (keyMethod && !this.triedKeyMethod) {
          this.triedKeyMethod = true;
          try {
            await conn.agent.request(acp.methods.agent.authenticate, { methodId: keyMethod });
            return await this.openSession();
          } catch (e) {
            this.opts.log.warn("API-key authentication failed", { method: keyMethod, error: errorMessage(e) });
          }
        }
        this.setStatus({ state: "needs-login", methods: this.authMethodInfo(), message: errorMessage(err) });
        return;
      }
      throw err;
    }

    this.sessionId = sessionId;
    const wanted = provider.permissionMode;
    if (wanted && modes && modes.currentModeId !== wanted) {
      if (modes.availableModes.some((m) => m.id === wanted)) {
        await conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: wanted });
      } else {
        this.opts.log.warn("configured permission mode is not offered by the agent", {
          wanted,
          available: modes.availableModes.map((m) => m.id),
        });
      }
    }
    this.setReady(resumed);
  }

  private resumedFlag = false;
  private triedKeyMethod = false;

  /** In API-key mode: the auth method to call with the key — configured, or an "env_var" one whose variables are set. */
  private envKeyMethod(): string | null {
    const provider = this.opts.provider;
    if (provider.auth !== "api-key" || !provider.apiKeyEnv || !process.env[provider.apiKeyEnv]) return null;
    if (provider.apiKeyMethod && this.authMethods.some((m) => m.id === provider.apiKeyMethod)) return provider.apiKeyMethod;
    for (const m of this.authMethods) {
      const vars = (m as { type?: string; vars?: { name: string }[] }).type === "env_var" ? ((m as { vars?: { name: string }[] }).vars ?? []) : [];
      if (vars.length && vars.every((v) => v.name === provider.apiKeyEnv && process.env[v.name])) return m.id;
    }
    return null;
  }

  /** Ready — unless the agent has told us it is logged out. */
  private setReady(resumed: boolean): void {
    this.resumedFlag = resumed;
    if (this.identity?.kind === "none") {
      this.setStatus({ state: "needs-login", methods: this.authMethodInfo(), message: this.identity.label });
      return;
    }
    this.setStatus({ state: "ready", sessionId: this.sessionId!, resumed, account: this.accountLabel() });
  }

  private accountLabel(): string | undefined {
    const id = this.identity;
    if (!id || id.kind === "none") return undefined;
    return id.label ?? id.kind;
  }

  private onIdentity(identity: AuthIdentity | null): void {
    if (!identity || typeof identity.kind !== "string") return;
    this.identity = identity;
    if (!this.sessionId) return; // session still opening; setReady() will judge
    if (identity.kind === "none" && this.status.state === "ready") {
      this.setStatus({ state: "needs-login", methods: this.authMethodInfo(), message: identity.label });
    } else if (identity.kind !== "none" && (this.status.state === "needs-login" || this.status.state === "ready")) {
      this.setStatus({ state: "ready", sessionId: this.sessionId, resumed: this.resumedFlag, account: this.accountLabel() });
    }
  }

  /** Run a non-terminal ("agent") auth method, then retry the session. */
  async authenticate(methodId: string): Promise<void> {
    if (!this.conn) throw new Error("agent is not running");
    await this.conn.agent.request(acp.methods.agent.authenticate, { methodId });
    await this.openSession();
  }

  /** After a login elsewhere (the login terminal), try opening a session again. */
  async retrySession(): Promise<void> {
    if (!this.conn) return this.start();
    this.setStatus({ state: "starting" });
    await this.openSession();
  }

  async prompt(prompt: acp.ContentBlock[]): Promise<acp.StopReason> {
    if (!this.conn || !this.sessionId) throw new Error("The agent has no open session.");
    try {
      const r = await this.conn.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt });
      return r.stopReason;
    } catch (err) {
      if (isAuthRequired(err)) {
        this.setStatus({ state: "needs-login", methods: this.authMethodInfo(), message: errorMessage(err) });
        throw new AuthRequiredError("The agent needs you to log in before it can work.");
      }
      throw err;
    }
  }

  cancel(): void {
    if (!this.conn || !this.sessionId) return;
    void this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    try {
      this.conn?.close();
    } catch {
      /* already closed */
    }
    if (child && child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await gone;
      clearTimeout(timer);
    }
    this.child = null;
    this.conn = null;
    if (this.status.state !== "stopped") this.setStatus({ state: "stopped" });
  }
}
