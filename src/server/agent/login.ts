// The browser login terminal.
//
// ACP agents advertise how to log in. A "terminal" auth method means: run the
// agent's own command with these extra args in a terminal and let the user
// interact. That is provider-agnostic, so the login flow is too: whatever a
// provider advertises, this runs it in a PTY inside the provider's isolated
// home and streams it to xterm.js in the browser.
//
// One login at a time per provider; credentials land in that provider's home
// and every project using the provider picks them up.

import { spawnPty, type PtyProcess } from "./process.js";
import type { Paths, ProviderConfig } from "../config.js";
import { agentEnv, providerHome } from "./env.js";

export interface LoginSink {
  output(data: string): void;
  exit(code: number | null): void;
}

export interface TerminalMethod {
  id: string;
  /** Run this instead of the agent's command (a provider's own login method). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export class LoginSession {
  private proc: PtyProcess;
  private sinks = new Set<LoginSink>();
  private buffer = "";
  exited = false;

  constructor(paths: Paths, provider: ProviderConfig, method: TerminalMethod, size: { cols: number; rows: number }) {
    const env = agentEnv(paths, provider, { TERM: "xterm-256color", COLORTERM: "truecolor", ...(method.env ?? {}) });
    this.proc = spawnPty({
      command: method.command ?? provider.command,
      args: method.command ? (method.args ?? []) : [...provider.args, ...(method.args ?? [])],
      pty: { cols: Math.max(20, Math.min(400, size.cols || 100)), rows: Math.max(5, Math.min(200, size.rows || 30)) },
      cwd: providerHome(paths, provider),
      env,
    });
    this.proc.onData((data) => {
      // Keep a short scrollback so a second tab joining mid-login sees the URL.
      this.buffer = (this.buffer + data).slice(-20_000);
      for (const s of this.sinks) s.output(data);
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      for (const s of this.sinks) s.exit(exitCode);
      this.sinks.clear();
    });
  }

  attach(sink: LoginSink): void {
    if (this.buffer) sink.output(this.buffer);
    if (this.exited) sink.exit(null);
    else this.sinks.add(sink);
  }

  detach(sink: LoginSink): void {
    this.sinks.delete(sink);
  }

  write(data: string): void {
    if (!this.exited) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.proc.resize(Math.max(20, Math.min(400, cols)), Math.max(5, Math.min(200, rows)));
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }
}

/** Server-wide registry: at most one live login terminal per provider. */
export class LoginManager {
  private sessions = new Map<string, LoginSession>();

  constructor(private readonly paths: Paths) {}

  start(provider: ProviderConfig, method: TerminalMethod, size: { cols: number; rows: number }): LoginSession {
    const existing = this.sessions.get(provider.id);
    if (existing && !existing.exited) return existing;
    const session = new LoginSession(this.paths, provider, method, size);
    this.sessions.set(provider.id, session);
    return session;
  }

  get(providerId: string): LoginSession | undefined {
    const s = this.sessions.get(providerId);
    return s && !s.exited ? s : undefined;
  }
}
