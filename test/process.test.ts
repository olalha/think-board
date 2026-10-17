// Stopping an agent stops everything it started (launchers such as npm bins
// start the real agent as a child — which must not outlive them).
import { describe, expect, it } from "vitest";
import { spawnGroup } from "../src/server/agent/process.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("process groups", () => {
  it("kills the launcher and the process it started", async () => {
    const child = spawnGroup("sh", ["-c", "sleep 60 & echo $!; wait"], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
    expect(alive(grandchild)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    for (let i = 0; i < 20 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(grandchild)).toBe(false);
  });
});
