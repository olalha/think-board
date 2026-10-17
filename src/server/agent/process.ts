// Starting agent processes — here, or in the separate agent container.
//
// With THINK_RUNNER_SOCKET set (the Docker deployment), agents, login
// terminals and usage checks run in the "agents" container: a network that
// reaches the internet but nothing else on the host. The server asks the
// runner (agent/runner.ts) over a Unix socket on a shared volume, so the two
// containers need no network path to each other. Without it (development,
// tests) processes start locally.
//
// Wire format, per connection: one JSON header line, then frames of
// [type: 1 byte][length: 4 bytes, big-endian][payload] in both directions.

import { spawn } from "node:child_process";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough, Writable, type Readable } from "node:stream";
import * as pty from "node-pty";

export const FRAME = {
  stdin: 0,
  stdout: 1,
  stderr: 2,
  exit: 3,
  error: 4,
  ptyData: 5,
  resize: 6,
  kill: 7,
} as const;

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Run in a pseudo-terminal of this size (login terminals). */
  pty?: { cols: number; rows: number };
}

/** The subset of ChildProcess the agent host and usage check use. */
export interface AgentProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number | null }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function frame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Incremental frame parser. */
export function frameReader(onFrame: (type: number, payload: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      onFrame(buf[0], buf.subarray(5, 5 + len));
      buf = buf.subarray(5 + len);
    }
  };
}

const runnerSocket = () => process.env.THINK_RUNNER_SOCKET || "";

/** Where agents run: "runner" (separate container) or "local". */
export function agentPlacement(): "runner" | "local" {
  return runnerSocket() ? "runner" : "local";
}

function connect(spec: SpawnSpec): net.Socket {
  const sock = net.connect(runnerSocket());
  sock.write(JSON.stringify(spec) + "\n");
  return sock;
}

/**
 * Start a process in a group of its own, and stop the whole group: some agent
 * commands are launchers (e.g. an npm bin that starts a native binary), and
 * stopping only the launcher would leave the real agent running.
 */
export function spawnGroup(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) {
  const child = spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const killOne = child.kill.bind(child);
  child.kill = (signal: NodeJS.Signals | number = "SIGTERM") => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      return true;
    } catch {
      return killOne(signal);
    }
  };
  return child;
}

/** Signal a pseudo-terminal's whole process group (its session), not just its first process. */
export function killPtyGroup(p: pty.IPty, signal: NodeJS.Signals = "SIGHUP"): void {
  try {
    process.kill(-p.pid, signal);
  } catch {
    try {
      p.kill(signal);
    } catch {
      /* gone */
    }
  }
}

export function spawnProcess(spec: Omit<SpawnSpec, "pty">): AgentProcess {
  if (!runnerSocket()) {
    return spawnGroup(spec.command, spec.args, { cwd: spec.cwd, env: spec.env }) as unknown as AgentProcess;
  }
  const proc = new EventEmitter() as AgentProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sock = connect(spec);
  let exited = false;
  const finish = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    proc.exitCode = code ?? (signal ? null : 1);
    stdout.end();
    stderr.end();
    proc.emit("exit", code, signal);
  };
  proc.exitCode = null;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (exited || sock.destroyed) return cb();
      sock.write(frame(FRAME.stdin, chunk), () => cb());
    },
  });
  proc.kill = (signal = "SIGTERM") => {
    if (!exited && !sock.destroyed) sock.write(frame(FRAME.kill, JSON.stringify({ signal })));
  };
  sock.on(
    "data",
    frameReader((type, payload) => {
      if (type === FRAME.stdout) stdout.write(payload);
      else if (type === FRAME.stderr) stderr.write(payload);
      else if (type === FRAME.exit) {
        const { code, signal } = JSON.parse(payload.toString());
        finish(code, signal);
      } else if (type === FRAME.error) {
        stderr.write(payload);
        proc.emit("error", new Error(payload.toString()));
      }
    }),
  );
  sock.on("error", (err) => {
    stderr.write(`agent runner unreachable: ${err.message}\n`);
    proc.emit("error", err);
    finish(null, "SIGKILL");
  });
  sock.on("close", () => finish(null, "SIGKILL"));
  return proc;
}

export function spawnPty(spec: SpawnSpec & { pty: { cols: number; rows: number } }): PtyProcess {
  if (!runnerSocket()) {
    const p = pty.spawn(spec.command, spec.args, { name: "xterm-256color", cols: spec.pty.cols, rows: spec.pty.rows, cwd: spec.cwd, env: spec.env });
    return {
      onData: (cb) => void p.onData(cb),
      onExit: (cb) => void p.onExit(({ exitCode }) => cb({ exitCode })),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: () => killPtyGroup(p),
    };
  }
  const sock = connect(spec);
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number | null }) => void)[] = [];
  let exited = false;
  const done = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb({ exitCode: code });
  };
  sock.on(
    "data",
    frameReader((type, payload) => {
      if (type === FRAME.ptyData) for (const cb of dataCbs) cb(payload.toString("utf8"));
      else if (type === FRAME.exit) done(JSON.parse(payload.toString()).code ?? null);
      else if (type === FRAME.error) for (const cb of dataCbs) cb(`\r\n${payload.toString()}\r\n`);
    }),
  );
  sock.on("error", () => done(null));
  sock.on("close", () => done(null));
  return {
    onData: (cb) => void dataCbs.push(cb),
    onExit: (cb) => void exitCbs.push(cb),
    write: (d) => void (!exited && sock.write(frame(FRAME.stdin, d))),
    resize: (c, r) => void (!exited && sock.write(frame(FRAME.resize, JSON.stringify({ cols: c, rows: r })))),
    kill: () => void (!exited && sock.write(frame(FRAME.kill, JSON.stringify({ signal: "SIGTERM" })))),
  };
}
