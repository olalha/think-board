// The agent runner (separate container in production): processes and
// terminals started over its Unix socket behave like local ones.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnProcess, spawnPty } from "../src/server/agent/process.js";
import { APP_DIR, waitFor } from "./helpers.js";

let runner: ChildProcess;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  process.env.THINK_RUNNER_SOCKET = path.join(dir, "r.sock");
  runner = spawn(process.execPath, ["--import", "tsx", path.join(APP_DIR, "src/server/agent/runner.ts")], {
    env: { ...process.env },
    stdio: "ignore",
    cwd: APP_DIR,
  });
  await waitFor(() => fs.existsSync(process.env.THINK_RUNNER_SOCKET!), "the runner socket");
});

afterAll(() => {
  delete process.env.THINK_RUNNER_SOCKET;
  runner.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent runner", () => {
  it("relays stdin, stdout, stderr and the exit code", async () => {
    const p = spawnProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', d => process.stdout.write('echo:' + d)); process.stdin.on('end', () => { console.error('bye'); process.exit(3); })"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const exit = new Promise<number | null>((r) => p.once("exit", (code: number | null) => r(code)));
    p.stdin.write("hello\n");
    await waitFor(() => out.includes("echo:hello"), "the echo");
    p.kill("SIGTERM");
    expect(await exit).not.toBe(0);
  });

  it("runs a terminal", async () => {
    const t = spawnPty({ command: "/bin/sh", args: ["-c", "read x; echo got:$x"], cwd: dir, env: { PATH: process.env.PATH ?? "" }, pty: { cols: 80, rows: 24 } });
    let out = "";
    const exit = new Promise<number | null>((r) => t.onExit(({ exitCode }) => r(exitCode)));
    t.onData((d) => (out += d));
    t.write("abc\r");
    expect(await exit).toBe(0);
    expect(out).toContain("got:abc");
  });
});
