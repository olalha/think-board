// The agent runner: the only process in the "agents" container. It starts the
// processes the server asks for (agents, login terminals, usage checks) and
// relays their input and output over a Unix socket — see agent/process.ts for
// the wire format. The container's network reaches the internet (the model
// API) but no other container and nothing on the host.
//
//   node dist/node/server/agent/runner.js      (THINK_RUNNER_SOCKET=/run/think/runner.sock)

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import * as pty from "node-pty";
import { frame, FRAME, frameReader, killPtyGroup, spawnGroup, type SpawnSpec } from "./process.js";

const socketPath = process.env.THINK_RUNNER_SOCKET || "/run/think/runner.sock";
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), scope: "runner", msg, ...extra }) + "\n");

function serve(sock: net.Socket): void {
  let header: Buffer = Buffer.alloc(0);
  let started = false;
  let onFrame: ((type: number, payload: Buffer) => void) | null = null;
  const reader = frameReader((t, p) => onFrame?.(t, p));
  const send = (type: number, payload: Buffer | string) => {
    if (!sock.destroyed) sock.write(frame(type, payload));
  };

  sock.on("data", (chunk: Buffer) => {
    if (started) return reader(chunk);
    // Bytes, not text: frames right after the header line are binary.
    header = Buffer.concat([header, chunk]);
    const nl = header.indexOf(0x0a);
    if (nl === -1) {
      if (header.length > 1_000_000) sock.destroy();
      return;
    }
    const rest = header.subarray(nl + 1);
    started = true;
    let spec: SpawnSpec;
    try {
      spec = JSON.parse(header.subarray(0, nl).toString("utf8")) as SpawnSpec;
    } catch {
      send(FRAME.error, "bad request");
      return void sock.end();
    }
    start(spec);
    if (rest.length) reader(rest);
  });

  function start(spec: SpawnSpec): void {
    log("start", { command: path.basename(spec.command), cwd: spec.cwd, pty: !!spec.pty });
    if (spec.pty) {
      let p: pty.IPty;
      try {
        p = pty.spawn(spec.command, spec.args, { name: "xterm-256color", cols: spec.pty.cols, rows: spec.pty.rows, cwd: spec.cwd, env: spec.env });
      } catch (err) {
        send(FRAME.error, (err as Error).message);
        send(FRAME.exit, JSON.stringify({ code: 1, signal: null }));
        return void sock.end();
      }
      p.onData((d) => send(FRAME.ptyData, d));
      p.onExit(({ exitCode }) => {
        send(FRAME.exit, JSON.stringify({ code: exitCode, signal: null }));
        sock.end();
      });
      onFrame = (type, payload) => {
        if (type === FRAME.stdin) p.write(payload.toString("utf8"));
        else if (type === FRAME.resize) {
          const { cols, rows } = JSON.parse(payload.toString());
          p.resize(cols, rows);
        } else if (type === FRAME.kill) killPtyGroup(p);
      };
      sock.on("close", () => killPtyGroup(p));
      return;
    }
    const child = spawnGroup(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
    child.stdout.on("data", (d: Buffer) => send(FRAME.stdout, d));
    child.stderr.on("data", (d: Buffer) => send(FRAME.stderr, d));
    child.stdin.on("error", () => {});
    child.on("error", (err) => send(FRAME.error, err.message));
    child.on("exit", (code, signal) => {
      send(FRAME.exit, JSON.stringify({ code, signal }));
      sock.end();
    });
    onFrame = (type, payload) => {
      if (type === FRAME.stdin) child.stdin.write(payload);
      else if (type === FRAME.kill) child.kill(JSON.parse(payload.toString()).signal ?? "SIGTERM");
    };
    // The server went away: stop the process (politely, then firmly).
    sock.on("close", () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
    });
  }
  sock.on("error", () => {});
}

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
const server = net.createServer(serve);
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  log("listening", { socket: socketPath });
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
