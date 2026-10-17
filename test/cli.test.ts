// The `think` command end to end, through the real POSIX sh script, on both
// of its ways to the server: the canvas agent's (its canvas's .think/cli/,
// from inside a turn) and outside agents' (ROOT/guests/).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/server/git.js";
import { GuestBridge } from "../src/server/guests.js";
import { listHistory } from "../src/server/history.js";
import type { ProjectManager } from "../src/server/manager.js";
import { silentLogger } from "../src/server/util.js";
import type { ChatEntry, GuestEntry, ServerMessage } from "../src/shared/protocol.js";
import { APP_DIR, makeHarness, waitFor, type Harness } from "./helpers.js";

const run = promisify(execFile);
let h: Harness | null = null;
let bridge: GuestBridge | null = null;
afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  await h?.close();
  h = null;
});

const send = (h: Harness, msg: Parameters<Harness["runtime"]["handle"]>[1]) => h.runtime.handle(h.client, msg);
const readCanvas = async (h: Harness) => JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
const chat = (h: Harness): ChatEntry[] => h.messages.flatMap((m) => (m.type === "chat.append" ? [m.entry] : []));
const tab = (h: Harness, name: string): GuestEntry[] => h.messages.flatMap((m) => (m.type === "guest.entry" && m.name === name ? [m.entry] : []));
const lastGuests = (h: Harness) => h.messages.filter((m): m is Extract<ServerMessage, { type: "guests.changed" }> => m.type === "guests.changed").at(-1)?.guests;

describe("the canvas agent's think command", () => {
  it("lays out the canvas during its turn: add, link, frame, read — and is refused protected blocks and guest commands", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 }); // harry
    await send(h, { type: "block.create", blockType: "markdown", x: 1200, y: 0 }); // bob
    await send(h, { type: "user.layout", ops: [{ op: "node.protect", id: "bob", protected: true }] });
    await send(h, {
      type: "agent.prompt",
      text: [
        "make-note:timeline",
        "run: think add timeline.md --near harry --side below",
        'run: think link harry timeline --label "feeds" --style dashed',
        'run: think frame "Plan" harry timeline',
        "run: think read --json",
        "run: think move bob --by 20,0",
        "run: think lock --as me",
        "run: think add nothing-here.md",
      ].join("\n"),
    });
    await h.waitIdle();
    const runs = await h.runs();
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(runs[0].out).toContain("Added “Timeline” at 0,300 (360×260) below “Harry”.");
    expect(runs[1].out).toContain("Linked “Harry” → “Timeline” (“feeds”, dashed).");
    expect(runs[2].out).toContain("Drew the frame “Plan” (grp-plan)");
    const outline = JSON.parse(runs[3].out);
    expect(outline.blocks.find((b: { name: string }) => b.name === "timeline")).toMatchObject({ x: 0, y: 300, frames: ["grp-plan"] });
    expect(runs[4].err).toMatch(/“Bob” is protected/);
    expect(runs[5].err).toMatch(/for agents working from outside the app/);
    expect(runs[6].err).toMatch(/no block file “nothing-here.md”/);

    const canvas = await readCanvas(h);
    expect(canvas.nodes.find((n: { id: string }) => n.id === "timeline")).toMatchObject({ x: 0, y: 300 });
    expect(canvas.edges).toEqual([expect.objectContaining({ fromNode: "harry", toNode: "timeline", label: "feeds", style: "dashed" })]);
    expect(canvas.nodes[0]).toMatchObject({ id: "grp-plan", type: "group", label: "Plan" });
    // think committed the turn, as the agent, with every kind of change in the message.
    const [subject, ...body] = (await git(h.dir, ["log", "-1", "--format=%an|%s%n%b"])).trim().split("\n");
    expect(subject).toBe("agent|agent: added Timeline; connected Harry → Timeline (“feeds”, dashed); new group “Plan” around Harry, Timeline");
    expect(body.join("\n")).toContain("- New blocks: timeline");
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
    // The tabs were shown where the agent worked; no temp files were left beside the blocks.
    expect(h.messages.some((m) => m.type === "blocks.highlight" && m.by === null && m.names.includes("timeline"))).toBe(true);
    expect((await fs.readdir(h.dir)).filter((f) => f.startsWith(".tmp"))).toEqual([]);
  });

  it("is refused outside the agent's turn", async () => {
    h = await makeHarness();
    const dir = path.join(h.dir, ".think", "cli");
    await fs.writeFile(path.join(dir, "req-x.json"), JSON.stringify({ op: "read", args: [], opts: {} }));
    await waitFor(() => fs.stat(path.join(dir, "res-x.txt")).then(() => true, () => false), "the answer");
    expect(await fs.readFile(path.join(dir, "res-x.txt"), "utf8")).toMatch(/^error\n.*only during its turn/);
  });
});

describe("an outside agent's think command", () => {
  async function guestSetup() {
    h = await makeHarness();
    const runtime = h.runtime;
    const manager = { peek: (s: string) => (s === runtime.slug ? runtime : undefined), get: async () => runtime, openSlugs: () => [runtime.slug] } as unknown as ProjectManager;
    bridge = new GuestBridge(h.paths, h.store, manager, h.config, silentLogger, "");
    await bridge.start();
    const root = h.root;
    const think = (...args: string[]) => run("sh", [path.join(APP_DIR, "bin", "think"), ...args], { env: { ...process.env, THINK_ROOT: root } });
    const fails = async (args: string[], re: RegExp) => expect(think(...args)).rejects.toMatchObject({ stderr: expect.stringMatching(re) });
    return { think, fails, slug: runtime.slug };
  }

  it("joins (a tab), needs the lock to change anything, lays out the canvas, and is committed under its name", async () => {
    const { think, fails, slug } = await guestSetup();
    const g = ["--as", "planner"];
    await send(h!, { type: "block.create", blockType: "markdown", x: 0, y: 0 }); // harry
    const { id: commentId } = (await send(h!, { type: "comment.add", on: "harry", text: "Check the dates" })) as { id: string };

    await fails(["read", ...g], /have not joined a canvas/);
    await fails(["read"], /--as <name>/);
    await fails(["join", slug, "--as", "agent"], /that name is the app's own/);
    await fails(["join", slug, "--as", "Big Planner"], /lowercase letters, digits and hyphens \(e\.g\. big-planner\)/);

    const joined = await think("join", slug, ...g, "--about", "Claude Code in a terminal", "to map the launch");
    expect(joined.stdout).toContain(`Joined “Test canvas” as planner`);
    expect(joined.stdout).toContain(`folder: ${h!.dir}`);
    expect(lastGuests(h!)).toEqual([expect.objectContaining({ name: "planner", about: "Claude Code in a terminal", state: "joined", working: false })]);
    expect(await fs.readFile(path.join(h!.dir, "AGENTS.md"), "utf8")).toContain("think help");

    // Reading is fine once joined; changing needs the lock.
    expect((await think("read", ...g)).stdout).toContain("1 block");
    await fails(["add", "plan.md", ...g], /Take the lock before changing the canvas/);

    await think("lock", "arranging the plan", ...g);
    await fs.writeFile(path.join(h!.dir, "plan.md"), "# The plan\n");
    expect(lastGuests(h!)?.[0]).toMatchObject({ working: true });
    await think("add", "plan.md", "--near", "harry", "--side", "right", ...g);
    await think("frame", "Launch", "harry", "plan", ...g);
    await think("comment", "done", commentId, "Dates checked", ...g);
    await think("say", "Mapped the launch plan — have a look.", ...g);
    const unlocked = await think("unlock", "Laid out the launch plan", ...g);
    expect(unlocked.stdout).toMatch(/Committed as planner and unlocked: added Plan; .*new group “Launch” around Harry, Plan; marked 1 comment done/);

    const [line, ...body] = (await git(h!.dir, ["log", "-1", "--format=%an <%ae>|%s%n%b"])).trim().split("\n");
    expect(line).toBe("planner <guest@think>|planner: Laid out the launch plan");
    expect(body.join("\n")).toContain("marked done by planner");
    // Its messages and activity are in its own tab, not the canvas agent's chat.
    const lines = tab(h!, "planner");
    expect(lines.map((e) => (e.kind === "say" ? "say" : e.event))).toEqual(["joined", "working", "say", "finished"]);
    const finished = lines.at(-1) as Extract<GuestEntry, { kind: "activity" }>;
    expect(finished.rev).toBe((await git(h!.dir, ["rev-parse", "HEAD"])).trim());
    expect(chat(h!).some((e) => e.kind === "guest" || /planner/.test(JSON.stringify(e)))).toBe(false);
    expect(await fs.readFile(path.join(h!.dir, ".think", "guests", "planner.jsonl"), "utf8")).toContain("Mapped the launch plan");
    expect(h!.messages.some((m) => m.type === "blocks.highlight" && m.by === "planner" && m.names.includes("plan"))).toBe(true);

    // The canvas agent hears what changed (as always), but never the guest's messages.
    await send(h!, { type: "agent.prompt", text: "what changed?" });
    await h!.waitIdle();
    const [prompt] = await h!.prompts();
    expect(prompt[0]).toContain("planner (an outside agent)");
    expect(prompt.join("\n")).not.toContain("Mapped the launch plan");
  });

  it("keeps each lock session its own moment in History, titled with its summary", async () => {
    const { think, slug } = await guestSetup();
    const g = ["--as", "planner"];
    await think("lock", slug, "first", ...g);
    await fs.writeFile(path.join(h!.dir, "one.md"), "# One\n");
    await think("unlock", "Wrote the first note", ...g);
    await think("lock", "second", ...g);
    await fs.writeFile(path.join(h!.dir, "two.md"), "# Two\n");
    await think("unlock", "Wrote the second note", ...g);
    const { entries } = await listHistory(h!.dir, path.join(h!.dir, ".think"));
    expect(entries.slice(0, 2).map((e) => [e.kind, e.who, e.title])).toEqual([
      ["guest", "planner", "Wrote the second note"],
      ["guest", "planner", "Wrote the first note"],
    ]);
  });

  it("is told once that the user disconnected it; its edits are committed; joining again brings its tab back", async () => {
    const { think, fails, slug } = await guestSetup();
    const g = ["--as", "codex-1"];
    await think("lock", slug, "sketching", ...g); // lock joins too
    await fs.writeFile(path.join(h!.dir, "sketch.md"), "# Sketch\n");
    await waitFor(() => h!.messages.some((m) => m.type === "file.changed" && m.block.name === "sketch"), "the edit to be seen");

    await send(h!, { type: "guest.disconnect", name: "codex-1" });
    expect(h!.runtime.agentState).toBeTruthy();
    expect(lastGuests(h!)).toEqual([expect.objectContaining({ name: "codex-1", state: "left", disconnected: true, working: false })]);
    expect((await git(h!.dir, ["log", "-1", "--format=%an|%s"])).trim()).toBe("codex-1|codex-1: added Sketch");
    expect(tab(h!, "codex-1").at(-1)).toMatchObject({ event: "disconnected", text: "You disconnected codex-1 — its edits so far committed: added Sketch" });

    await fails(["say", "hello?", ...g], /The user disconnected you from “Test canvas”/);
    await fails(["say", "hello?", ...g], /have not joined a canvas/); // told once
    await think("join", slug, ...g);
    expect(lastGuests(h!)?.[0]).toMatchObject({ state: "joined" });
    expect((await think("leave", ...g)).stdout).toContain("Left “Test canvas”");
    expect(lastGuests(h!)?.[0]).toMatchObject({ state: "left" });
    expect(lastGuests(h!)?.[0].disconnected).toBeUndefined();
  });
});
