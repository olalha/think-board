// Runtime integration: a real ProjectRuntime driving a scripted ACP agent.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/server/git.js";
import { CANVAS_FORMAT } from "../src/server/think-file.js";
import type { ChatEntry, ServerMessage } from "../src/shared/protocol.js";
import { makeHarness, waitFor, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const send = (h: Harness, msg: Parameters<Harness["runtime"]["handle"]>[1]) => h.runtime.handle(h.client, msg);
const log = (h: Harness) => git(h.dir, ["log", "--format=%an|%s"]).then((s) => s.trim().split("\n"));
const chat = (h: Harness): ChatEntry[] => {
  const byId = new Map<string, ChatEntry>();
  for (const m of h.messages as ServerMessage[]) {
    if (m.type === "chat.append" || m.type === "chat.update") byId.set(m.entry.id, m.entry);
  }
  return [...byId.values()];
};

describe("lock", () => {
  it("rejects every user mutation on the server while the agent works, and releases after", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "slow make-note:tom" });
    expect(h.runtime.working).toBe(true);
    const locked = /agent is working/;
    await expect(send(h, { type: "user.edit", name: "harry", content: "x" })).rejects.toThrow(locked);
    await expect(send(h, { type: "user.layout", ops: [{ op: "node.move", id: "harry", x: 40, y: 40 }] })).rejects.toThrow(locked);
    await expect(send(h, { type: "block.create", blockType: "mermaid", x: 0, y: 0 })).rejects.toThrow(locked);
    await expect(send(h, { type: "block.delete", names: ["harry"] })).rejects.toThrow(locked);
    await expect(send(h, { type: "agent.prompt", text: "again" })).rejects.toThrow(/already working/);
    expect(h.messages.some((m) => m.type === "lock.changed" && m.lock.locked)).toBe(true);
    await h.waitIdle();
    expect(h.messages.filter((m) => m.type === "lock.changed").at(-1)).toMatchObject({ lock: { locked: false } });
    await expect(send(h, { type: "user.edit", name: "harry", content: "# after\n" })).resolves.toBeTruthy();
  });

  it("cancels a turn and still unlocks", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: "slow" });
    await send(h, { type: "agent.cancel" });
    await h.waitIdle();
    expect(chat(h).some((e) => e.kind === "system" && e.text === "Stopped.")).toBe(true);
  });
});

describe("prompt assembly", () => {
  it("appends the turn suffix to every prompt and prepends user-changes only after user commits", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: "first message" });
    await h.waitIdle();
    const [first] = await h.prompts();
    expect(first[0]).toBe("first message");
    expect(first[1]).toContain("Reminder from the canvas app");
    expect(first.join("\n")).not.toContain("the canvas changed since your last turn");

    const state = JSON.parse(await fs.readFile(path.join(h.dir, ".think", "state.json"), "utf8"));
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "second message" });
    await h.waitIdle();
    const second = (await h.prompts())[1];
    expect(second[0]).toContain("the canvas changed since your last turn");
    expect(second[0]).toContain(state.lastAgentHead);
    expect(second[1]).toBe("second message");

    // The user's commit happened before the prompt, authored as `user`.
    expect((await log(h)).some((l) => l.startsWith("user|user: edited"))).toBe(true);
    // The transcript shows the user's own text, with the template text as injected context.
    const users = chat(h).filter((e) => e.kind === "user");
    expect(users.at(-1)).toMatchObject({ text: "second message" });
    expect((users.at(-1) as Extract<ChatEntry, { kind: "user" }>).injected?.before).toContain(state.lastAgentHead);
  });
});

describe("post-turn validation", () => {
  it("feeds errors back and stops retrying once the agent fixes them", async () => {
    h = await makeHarness({ fakeEnv: { FAKE_FIX: "1" } });
    await send(h, { type: "agent.prompt", text: "make-bad-diagram" });
    await h.waitIdle();
    const prompts = await h.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1][0]).toContain("automatic follow-up 1 of 2");
    expect(prompts[1][0]).toContain("bob.mmd");
    const reports = h.messages.filter((m) => m.type === "validation.errors");
    expect(reports.at(-1)).toMatchObject({ report: { issues: [], final: true } });
    expect(chat(h).some((e) => e.kind === "user" && e.auto === "validation")).toBe(true);
  });

  it("gives up after the configured number of retries and reports the errors", async () => {
    h = await makeHarness({ maxAttempts: 2 });
    await send(h, { type: "agent.prompt", text: "make-bad-diagram" });
    await h.waitIdle();
    expect(await h.prompts()).toHaveLength(3); // the prompt + 2 follow-ups
    const last = h.messages.filter((m) => m.type === "validation.errors").at(-1);
    expect(last).toMatchObject({ report: { final: true, attempt: 2 } });
    expect(last?.type === "validation.errors" && last.report.issues[0].block).toBe("bob");
    expect(chat(h).some((e) => e.kind === "system" && e.level === "error")).toBe(true);
  });
});

describe("post-turn git and layout", () => {
  it("commits the agent's work itself, as the agent, with what changed — no warning", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: "no-commit" });
    await h.waitIdle();
    expect((await log(h))[0]).toBe("agent|agent: added Tom");
    const body = await git(h.dir, ["log", "-1", "--format=%b"]);
    expect(body).toContain("- New blocks: tom");
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(chat(h).some((e) => e.kind === "system" && e.level === "warning")).toBe(false);
  });

  it("heads the commit with the agent's own summary (think summary), and still accepts the agent's own commits", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: 'make-note:tom\nrun: think summary "Started the launch notes"' });
    await h.waitIdle();
    expect((await h.runs())[0]).toMatchObject({ code: 0, out: expect.stringContaining("heads this turn's commit") });
    expect((await log(h))[0]).toBe("agent|agent: Started the launch notes");

    await send(h, { type: "agent.prompt", text: "make-note:bob self-commit" });
    await h.waitIdle();
    const lines = await log(h);
    expect(lines).toContain("agent|the agent's own commit");
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("places a block the agent created next to the block it touched last, and records HEAD", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "touch:harry make-note:tom" });
    await h.waitIdle();
    const canvas = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    const harry = canvas.nodes.find((n: { id: string }) => n.id === "harry");
    const tom = canvas.nodes.find((n: { id: string }) => n.id === "tom");
    expect(tom).toBeTruthy();
    expect(tom.x).toBe(harry.x + harry.width + 40);
    expect(tom.y).toBe(harry.y);
    const state = JSON.parse(await fs.readFile(path.join(h.dir, ".think", "state.json"), "utf8"));
    expect(state.lastAgentHead).toBe((await git(h.dir, ["rev-parse", "HEAD"])).trim());
    expect(state.turnInProgress).toBe(false);
  });

  it("broadcasts agent file edits live, but not echoes of the server's own writes", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.edit", name: "harry", content: "# mine\n" });
    await new Promise((r) => setTimeout(r, 400));
    const echoes = h.messages.filter((m) => m.type === "file.changed" && m.origin !== "user");
    expect(echoes).toHaveLength(0);
    await send(h, { type: "agent.prompt", text: "make-note:tom" });
    await h.waitIdle();
    await waitFor(() => h!.messages.some((m) => m.type === "file.changed" && m.block.name === "tom" && m.origin === "agent"), "tom to be broadcast");
  });
});

describe("renaming", () => {
  it("renames a block for the user: file, node and connections follow", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "block.create", blockType: "markdown", x: 600, y: 0 });
    await send(h, { type: "user.layout", ops: [{ op: "edge.add", edge: { id: "e1", fromNode: "harry", toNode: "bob", label: "leads to" } }] });
    await send(h, { type: "block.rename", name: "harry", to: "tea-guide" });
    const files = await fs.readdir(h.dir);
    expect(files).toContain("tea-guide.md");
    expect(files).not.toContain("harry.md");
    const canvas = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    expect(canvas.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["bob", "tea-guide"]);
    expect(canvas.edges[0]).toMatchObject({ fromNode: "tea-guide", toNode: "bob", label: "leads to" });
    expect(h.messages.some((m) => m.type === "block.renamed" && m.from === "harry" && m.to === "tea-guide")).toBe(true);
    await expect(send(h, { type: "block.rename", name: "bob", to: "tea-guide" })).rejects.toThrow(/already a block/);
    await expect(send(h, { type: "block.rename", name: "bob", to: "Not Valid" })).rejects.toThrow(/lowercase/);
  });

  it("keeps a block's place and connections when the agent renames it with git mv", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 400, y: 200 });
    await send(h, { type: "block.create", blockType: "markdown", x: 1000, y: 200 });
    await send(h, { type: "user.layout", ops: [{ op: "edge.add", edge: { id: "e1", fromNode: "harry", toNode: "bob" } }] });
    const before = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    const harry = before.nodes.find((n: { id: string }) => n.id === "harry");
    await send(h, { type: "agent.prompt", text: "rename:harry:tea-guide" });
    await h.waitIdle();
    const canvas = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    const moved = canvas.nodes.find((n: { id: string }) => n.id === "tea-guide");
    expect(moved).toMatchObject({ x: harry.x, y: harry.y, file: "tea-guide.md" });
    expect(canvas.edges).toEqual([expect.objectContaining({ id: "e1", fromNode: "tea-guide", toNode: "bob" })]);
  });
});

describe("slash commands", () => {
  it("offers the agent's commands and sends one on its own, without the app's notes", async () => {
    h = await makeHarness();
    await waitFor(() => h!.messages.some((m) => m.type === "agent.commands"), "the command list");
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "/compact keep the decisions" });
    await h.waitIdle();
    const [cmd] = await h.prompts();
    expect(cmd).toEqual(["/compact keep the decisions"]);
    // The user's edit before the command is still reported with the next real message.
    await send(h, { type: "agent.prompt", text: "hello" });
    await h.waitIdle();
    const next = (await h.prompts())[1];
    expect(next[0]).toContain("the canvas changed since your last turn");
  });
});

describe("protected blocks", () => {
  it("undoes the agent's change, tells it, and keeps the user's mid-turn edit as theirs", async () => {
    h = await makeHarness({ maxAttempts: 0 });
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.edit", name: "harry", content: "# My notes\n" });
    await send(h, { type: "user.layout", ops: [{ op: "node.protect", id: "harry", protected: true }] });
    await send(h, { type: "agent.prompt", text: "slow overwrite:harry" });
    // While the agent works, the user may still type in the protected block.
    await send(h, { type: "user.edit", name: "harry", content: "# My notes\n\ntyped during the turn\n" });
    await expect(send(h, { type: "user.edit", name: "bob", content: "x" })).rejects.toThrow();
    await h.waitIdle();
    expect(await fs.readFile(path.join(h.dir, "harry.md"), "utf8")).toBe("# My notes\n\ntyped during the turn\n");
    const [prompt] = await h.prompts();
    expect(prompt.at(-1)).toContain("Protected blocks");
    expect(chat(h).some((e) => e.kind === "system" && /did not validate/.test(e.text) && /protected/.test((e as { detail?: string }).detail ?? ""))).toBe(true);
    const lines = await log(h);
    expect(lines[0]).toMatch(/^user\|user: edited harry\.md/);
    // Undone before think committed the agent's work: the change never reached History.
    expect(lines.some((l) => l.startsWith("think|think: undo"))).toBe(false);
    expect(await git(h.dir, ["log", "--author=agent", "--format=%H", "--", "harry.md"])).toBe("");
  });

  it("undoes a change the agent committed itself, in a commit of the app's", async () => {
    h = await makeHarness({ maxAttempts: 0 });
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.edit", name: "harry", content: "# My notes\n" });
    await send(h, { type: "user.layout", ops: [{ op: "node.protect", id: "harry", protected: true }] });
    await send(h, { type: "agent.prompt", text: "overwrite:harry make-note:tom self-commit" });
    await h.waitIdle();
    expect(await fs.readFile(path.join(h.dir, "harry.md"), "utf8")).toBe("# My notes\n");
    const lines = await log(h);
    expect(lines.some((l) => l.startsWith("think|think: undo the agent's changes to protected blocks"))).toBe(true);
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
  });
});

describe("tidy top level", () => {
  it("flags files the agent leaves outside work/", async () => {
    h = await makeHarness({ maxAttempts: 0 });
    await send(h, { type: "agent.prompt", text: "make-stray" });
    await h.waitIdle();
    const sys = chat(h).find((e) => e.kind === "system" && /did not validate/.test(e.text)) as { detail?: string } | undefined;
    expect(sys?.detail).toMatch(/notes\.txt.*work\//);
  });
});

describe("README and the change note", () => {
  it("creates a README, streams edits to it, and summarises changes for the agent in words", async () => {
    h = await makeHarness();
    expect(await fs.readFile(path.join(h.dir, "README.md"), "utf8")).toMatch(/^# Test canvas/);
    await send(h, { type: "agent.prompt", text: "first" });
    await h.waitIdle();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "block.create", blockType: "markdown", x: 600, y: 0 });
    await send(h, { type: "user.layout", ops: [{ op: "edge.add", edge: { id: "e1", fromNode: "harry", toNode: "bob", label: "why", style: "dashed" } }] });
    await send(h, { type: "readme.edit", content: "# Test canvas\n\nPlanning a tea party.\n" });
    await send(h, { type: "agent.prompt", text: "second" });
    await h.waitIdle();
    const note = (await h.prompts())[1][0];
    expect(note).toContain("by the user");
    expect(note).toMatch(/New blocks: (harry, bob|bob, harry)/);
    expect(note).toContain("README.md changed");
    expect(note).toMatch(/Connected harry → bob \(“why”, dashed\)/);
    expect(note).not.toMatch(/"x":/);
  });

  it("renders AGENTS.md and drops an old generated CLAUDE.md", async () => {
    h = await makeHarness();
    await fs.writeFile(path.join(h.dir, "CLAUDE.md"), "<!-- Generated by the think app -->\nold\n");
    await send(h, { type: "agent.prompt", text: "hello" });
    await h.waitIdle();
    const files = await fs.readdir(h.dir);
    expect(files).toContain("AGENTS.md");
    expect(files).not.toContain("CLAUDE.md");
    expect(await fs.readFile(path.join(h.dir, "AGENTS.md"), "utf8")).toContain("Protected blocks");
  });
});

describe("history", () => {
  it("groups commits into moments, previews the past and restores forward", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.edit", name: "harry", content: "# Version one\n" });
    await send(h, { type: "agent.prompt", text: "make-note:tom" });
    await h.waitIdle();
    await send(h, { type: "user.edit", name: "harry", content: "# Version two\n" });
    await send(h, { type: "agent.prompt", text: "touch:tom" });
    await h.waitIdle();

    const { entries } = (await send(h, { type: "history.list" })) as { entries: import("../src/shared/protocol.js").HistoryEntry[] };
    expect(entries.map((e) => e.kind)).toEqual(["agent", "user", "agent", "user", "app"]);
    expect(entries[0].title).toBe("touch:tom");
    expect(entries[0].summary.edited).toContain("tom");
    expect(entries[3].summary.added).toContain("harry");

    // The canvas as it was after the first turn.
    const firstTurn = entries[2];
    const snap = (await send(h, { type: "history.snapshot", rev: firstTurn.id, base: firstTurn.base })) as import("../src/shared/protocol.js").HistorySnapshot;
    expect(snap.blocks.find((b) => b.name === "harry")?.content).toBe("# Version one\n");
    const diff = (await send(h, { type: "history.diff", rev: firstTurn.id, name: "harry" })) as { then: string; now: string };
    expect(diff).toEqual({ then: "# Version one\n", now: "# Version two\n" });

    // Restore one block: a new commit on top, reported to the agent next time.
    await send(h, { type: "history.restore", rev: firstTurn.id, names: ["harry"] });
    expect(await fs.readFile(path.join(h.dir, "harry.md"), "utf8")).toBe("# Version one\n");
    expect((await log(h))[0]).toMatch(/^user\|restore: harry to /);
    await expect(send(h, { type: "history.snapshot", rev: "0000000", base: null })).rejects.toThrow(/does not exist/);
    await send(h, { type: "agent.prompt", text: "hi" });
    await h.waitIdle();
    expect((await h.prompts()).at(-1)![0]).toMatch(/Restored harry to /);
  });
});

describe("views", () => {
  it("keep every saved view when blocks are created, deleted, un-deleted and the canvas is restored", async () => {
    h = await makeHarness();
    const view = { id: "v1", name: "Overview", x: 0, y: 0, width: 800, height: 600 };
    await send(h, { type: "user.layout", ops: [{ op: "view.add", view }] });
    const views = async () => JSON.parse(await fs.readFile(path.join(h!.dir, "canvas.json"), "utf8")).views;
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    expect(await views()).toEqual([view]);
    await send(h, { type: "canvas.save" });
    const saved = (await git(h.dir, ["rev-parse", "HEAD"])).trim();
    const del = (await send(h, { type: "block.delete", names: ["harry"] })) as { batch: string };
    expect(await views()).toEqual([view]);
    await send(h, { type: "block.undoDelete", batch: del.batch });
    expect(await views()).toEqual([view]);
    // Restoring a version from before a view existed keeps today's views.
    const second = { ...view, id: "v2", name: "Later" };
    await send(h, { type: "user.layout", ops: [{ op: "view.add", view: second }] });
    await send(h, { type: "history.restore", rev: saved });
    expect(await views()).toEqual([view, second]);
  });
});

describe("saving", () => {
  it("autosaves on schedule even while edits keep coming, per the canvas's own setting", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "canvas.save" });
    await send(h, { type: "canvas.settings", settings: { autosaveSeconds: 1 } });
    const meta = JSON.parse(await fs.readFile(path.join(h.dir, "think.json"), "utf8"));
    expect(meta.settings.autosaveSeconds).toBe(1);
    expect((await log(h))[0]).toBe("think|think: autosave every 1 s");
    expect(h.messages.some((m) => m.type === "project.meta" && m.settings.autosaveSeconds === 1)).toBe(true);
    // Keep typing every 250 ms for ~1.6 s: the commit still lands after 1 s.
    const before = (await log(h)).length;
    for (let i = 0; i < 7; i++) {
      await send(h, { type: "user.edit", name: "harry", content: `# edit ${i}\n` });
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await log(h)).length).toBeGreaterThan(before);
    expect((await log(h))[0]).toMatch(/^user\|user: edited harry\.md/);
    await expect(send(h, { type: "canvas.settings", settings: { autosaveSeconds: -5 } })).rejects.toThrow(/not valid/);
  });

  it("commits on Save now and before listing History; says so when there is nothing new", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    expect(await send(h, { type: "canvas.save" })).toEqual({ saved: true });
    expect(await send(h, { type: "canvas.save" })).toEqual({ saved: false });
    await send(h, { type: "user.edit", name: "harry", content: "# fresh\n" });
    const { entries } = (await send(h, { type: "history.list" })) as { entries: import("../src/shared/protocol.js").HistoryEntry[] };
    expect(entries[0].kind).toBe("user");
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
  });
});

describe("think.json", () => {
  it("renames through the runtime, adopts valid outside edits and puts back broken ones", async () => {
    h = await makeHarness();
    const file = path.join(h.dir, "think.json");
    const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
    expect(await read()).toMatchObject({ format: CANVAS_FORMAT, name: "Test canvas", provider: "fake" });

    await h.runtime.renameCanvas("Tea shop");
    expect((await read()).name).toBe("Tea shop");
    expect((await log(h))[0]).toBe("think|think: renamed the canvas to “Tea shop”");
    expect(h.messages.some((m) => m.type === "project.meta" && m.name === "Tea shop")).toBe(true);

    // A valid edit from outside (a person, git) is adopted.
    await fs.writeFile(file, JSON.stringify({ ...(await read()), name: "Tea house" }));
    await waitFor(() => h!.messages.some((m) => m.type === "project.meta" && m.name === "Tea house"), "the new name");

    // Broken JSON, or a change of provider, is put back.
    await fs.writeFile(file, "{ nope");
    await waitFor(async () => (await fs.readFile(file, "utf8")).includes('"Tea house"'), "think.json restored");
    await fs.writeFile(file, JSON.stringify({ ...(await read()), provider: "other" }));
    await waitFor(async () => (await read()).provider === "fake", "the provider restored");
    // The restore is committed right after it is written.
    await waitFor(async () => (await git(h!.dir, ["status", "--porcelain"])).trim() === "", "the restore to be committed");
  });

  it("is not reported to the agent as a change", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: "first" });
    await h.waitIdle();
    await send(h, { type: "canvas.settings", settings: { autosaveSeconds: 120 } });
    await send(h, { type: "agent.prompt", text: "second" });
    await h.waitIdle();
    expect((await h.prompts()).at(-1)!.join("\n")).not.toContain("the canvas changed since your last turn");
  });
});

describe("paste and undo support", () => {
  it("pastes copies with new names, their frame and the connection between them", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.edit", name: "harry", content: "# Harry\n" });
    const r = (await send(h, {
      type: "blocks.paste",
      blocks: [
        { from: "harry", type: "markdown", content: "# Harry\n", x: 400, y: 0, width: 360, height: 260 },
        { from: "tea", type: "mermaid", content: "flowchart LR\n  a --> b\n", x: 800, y: 0, width: 420, height: 300 },
      ],
      groups: [{ id: "grp-old", type: "group", label: "Copied", x: 380, y: -40, width: 900, height: 400 }],
      edges: [{ id: "e1", fromNode: "harry", toNode: "tea" }],
    })) as { names: Record<string, string>; groups: Record<string, string> };
    expect(r.names).toEqual({ harry: "harry-2", tea: "tea" });
    expect(await fs.readFile(path.join(h.dir, "harry-2.md"), "utf8")).toBe("# Harry\n");
    const canvas = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    expect(canvas.edges).toEqual([expect.objectContaining({ fromNode: "harry-2", toNode: "tea" })]);
    expect(canvas.nodes.find((n: { id: string }) => n.id === r.groups["grp-old"])).toMatchObject({ type: "group", label: "Copied" });
  });

  it("keeps several deletions undoable, not just the last", async () => {
    h = await makeHarness();
    const { name: a } = (await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 })) as { name: string };
    const { name: b } = (await send(h, { type: "block.create", blockType: "markdown", x: 400, y: 0 })) as { name: string };
    const first = (await send(h, { type: "block.delete", names: [a] })) as { batch: string };
    const second = (await send(h, { type: "block.delete", names: [b] })) as { batch: string };
    expect(await send(h, { type: "block.undoDelete", batch: first.batch })).toEqual({ restored: [a] });
    expect(await send(h, { type: "block.undoDelete", batch: second.batch })).toEqual({ restored: [b] });
    await expect(send(h, { type: "block.undoDelete", batch: first.batch })).rejects.toThrow(/no longer be undone/);
  });

  it("keeps a view about a block in step with it: renames carry its name along", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "user.layout", ops: [{ op: "view.add", view: { id: "v1", name: "Harry", x: 0, y: 0, width: 360, height: 260, target: "harry", followName: true } }] });
    await send(h, { type: "block.rename", name: "harry", to: "harriet" });
    const canvas = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    expect(canvas.views[0]).toMatchObject({ target: "harriet", name: "Harriet", followName: true });
    // Renamed by hand, the view stops following the block's name.
    await send(h, { type: "user.layout", ops: [{ op: "view.update", id: "v1", patch: { name: "Mine" } }] });
    await send(h, { type: "block.rename", name: "harriet", to: "hattie" });
    const after = JSON.parse(await fs.readFile(path.join(h.dir, "canvas.json"), "utf8"));
    expect(after.views[0]).toEqual({ id: "v1", name: "Mine", x: 0, y: 0, width: 360, height: 260, target: "hattie" });
  });
});

describe("comments", () => {
  const readComments = async (h: Harness) => JSON.parse(await fs.readFile(path.join(h.dir, "comments.json"), "utf8")).comments as import("../src/shared/protocol.js").Comment[];

  it("adds, edits, ticks and deletes comments; they follow a renamed block", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    const { id } = (await send(h, { type: "comment.add", on: "harry", text: "  Make it shorter  " })) as { id: string };
    await send(h, { type: "comment.add", on: null, text: "Overall: good" });
    expect(await readComments(h)).toMatchObject([{ id, on: "harry", by: "you", text: "Make it shorter" }, { on: null }]);
    await send(h, { type: "comment.update", id, text: "Make it much shorter" });
    await send(h, { type: "comment.done", id, done: true });
    expect((await readComments(h))[0]).toMatchObject({ text: "Make it much shorter", done: { by: "you" } });
    await send(h, { type: "block.rename", name: "harry", to: "harriet" });
    await waitFor(async () => (await readComments(h!))[0].on === "harriet", "the comment to follow the rename");
    await send(h, { type: "comment.delete", ids: [id] });
    expect((await readComments(h)).map((c) => c.text)).toEqual(["Overall: good"]);
    await expect(send(h, { type: "comment.add", on: "nobody", text: "x" })).rejects.toThrow(/not on the canvas/);
    expect(h.messages.some((m) => m.type === "comments.changed")).toBe(true);
  });

  it("holds comments written during a turn and saves them after it, as the user's", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "slow" });
    await send(h, { type: "comment.add", on: "harry", text: "while you work" });
    const shown = h.messages.filter((m) => m.type === "comments.changed").at(-1);
    expect(shown?.type === "comments.changed" && shown.comments.map((c) => c.text)).toEqual(["while you work"]);
    await h.waitIdle();
    expect((await readComments(h)).map((c) => c.text)).toEqual(["while you work"]);
    expect((await git(h.dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await log(h)).some((l) => l.startsWith("user|") && l.includes("comments.json"))).toBe(true);
  });

  it("tells the agent about new comments in its change note", async () => {
    h = await makeHarness();
    await send(h, { type: "block.create", blockType: "markdown", x: 0, y: 0 });
    await send(h, { type: "agent.prompt", text: "first" });
    await h.waitIdle();
    await send(h, { type: "comment.add", on: "harry", text: "Add a diagram" });
    await send(h, { type: "agent.prompt", text: "second" });
    await h.waitIdle();
    expect((await h.prompts()).at(-1)![0]).toContain("New comment on harry by you: “Add a diagram”");
  });
});

describe("drawings", () => {
  const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
  const drawingOf = async (h: Harness) => JSON.parse(await fs.readFile(path.join(h.dir, ".drawings", "photo", "drawing.json"), "utf8"));

  it("keeps the original safe, renders the drawing into the block, and follows renames", async () => {
    h = await makeHarness();
    const { name } = await h.runtime.putImage(png1x1, "image/png", { x: 0, y: 0 });
    await send(h, { type: "block.rename", name, to: "photo" });
    const opened = (await send(h, { type: "drawing.open", name: "photo" })) as { drawing: import("../src/shared/drawing.js").Drawing; saved: boolean };
    expect(opened).toMatchObject({ saved: false, drawing: { base: { kind: "image", file: "base.png", width: 2, height: 2 } } });
    const drawing = { ...opened.drawing, shapes: [{ id: "s1", type: "rect" as const, color: "#e5484d", x: 0, y: 0, width: 2, height: 2, size: 1 }] };
    const { hash } = (await send(h, { type: "drawing.save", name: "photo", drawing, history: { undo: [1], redo: [] } })) as { hash: string };
    expect(await fs.readFile(path.join(h.dir, ".drawings", "photo", "base.png"))).toEqual(png1x1);
    expect((await drawingOf(h)).output).toBe(hash);
    expect(await fs.readFile(path.join(h.dir, "photo.png"))).not.toEqual(png1x1);
    await send(h, { type: "block.rename", name: "photo", to: "picture" });
    await waitFor(() => fs.access(path.join(h!.dir, ".drawings", "picture", "drawing.json")).then(() => true, () => false), "the drawing to follow the rename");
    await send(h, { type: "canvas.save" });
    expect((await log(h))[0]).toMatch(/^user\|/);
    await expect(send(h, { type: "drawing.save", name: "picture", drawing: { ...drawing, shapes: [{ id: "x", type: "nope" }] } as never })).rejects.toThrow(/not valid/);
  });

  it("drops the drawing when something else replaces the picture, and tells the agent what was drawn", async () => {
    h = await makeHarness();
    const { name } = await h.runtime.putImage(png1x1, "image/png", { x: 0, y: 0 });
    await send(h, { type: "block.rename", name, to: "photo" });
    await send(h, { type: "agent.prompt", text: "first" });
    await h.waitIdle();
    const { drawing } = (await send(h, { type: "drawing.open", name: "photo" })) as { drawing: import("../src/shared/drawing.js").Drawing };
    await send(h, { type: "drawing.save", name: "photo", drawing: { ...drawing, shapes: [{ id: "a", type: "line", color: "#1f1f1f", x1: 0, y1: 0, x2: 2, y2: 2, size: 1 }] } });
    await send(h, { type: "agent.prompt", text: "second" });
    await h.waitIdle();
    expect((await h.prompts()).at(-1)![0]).toContain("Drawn on by the user (look at the image again): photo");
    // Replaced from outside (an agent, a person): the drawing no longer fits.
    await fs.writeFile(path.join(h.dir, "photo.png"), Buffer.concat([png1x1, Buffer.from([0])]));
    await waitFor(() => fs.access(path.join(h!.dir, ".drawings", "photo")).then(() => false, () => true), "the drawing to be dropped");
  });

  it("puts a drawing on a new photo, keeping earlier originals only while undo can reach them", async () => {
    h = await makeHarness();
    const { name } = (await send(h, { type: "sketch.create", x: 0, y: 0 })) as { name: string };
    const dir = path.join(h.dir, ".drawings", name);
    const { file, width, height } = await h.runtime.putDrawingBase(name, png1x1, "image/png");
    expect(file).toMatch(/^base-[0-9a-f]{12}\.png$/);
    expect({ width, height }).toEqual({ width: 2, height: 2 });
    const { drawing } = (await send(h, { type: "drawing.open", name })) as { drawing: import("../src/shared/drawing.js").Drawing };
    const onPhoto = { ...drawing, base: { kind: "image" as const, file, width, height } };
    // The history still reaches the photo: it stays while the page goes back to a colour.
    await send(h, { type: "drawing.save", name, drawing: onPhoto, history: { undo: [], redo: [] } });
    await send(h, { type: "drawing.save", name, drawing, history: { undo: [{ shapes: [], page: { before: { base: onPhoto.base }, after: {} } }], redo: [] } });
    expect(await fs.readdir(dir)).toContain(file);
    // Out of reach of undo: removed.
    await send(h, { type: "drawing.save", name, drawing, history: { undo: [], redo: [] } });
    expect(await fs.readdir(dir)).not.toContain(file);
    await expect(h.runtime.putDrawingBase(name, Buffer.from("not an image"), "image/png")).rejects.toThrow(/not an image/);
  });

  it("creates sketches: a blank page as an image block", async () => {
    h = await makeHarness();
    const { name } = (await send(h, { type: "sketch.create", x: 0, y: 0, background: "#fbf8f1" })) as { name: string };
    const d = JSON.parse(await fs.readFile(path.join(h.dir, ".drawings", name, "drawing.json"), "utf8"));
    expect(d.base).toEqual({ kind: "color", color: "#fbf8f1", width: 1600, height: 1000 });
    expect((await fs.stat(path.join(h.dir, `${name}.png`))).size).toBeGreaterThan(100);
  });
});

describe("a provider's sign-in mode", () => {
  it("switched to the server's API key: the agent restarts with the key — after a running turn", async () => {
    process.env.FAKE_API_KEY = "sk-test-not-real";
    try {
      h = await makeHarness({ providerExtra: { apiKeyEnv: "FAKE_API_KEY" } });
      const keys = async () =>
        (await fs.readFile(path.join(h!.root, "agent-prompts.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l).key as string | null);
      await send(h, { type: "agent.prompt", text: "first" });
      await h.waitIdle();

      // The switch comes while a turn runs: that turn finishes on the old agent.
      await send(h, { type: "agent.prompt", text: "slow" });
      await h.config.setProviderAuth("fake", "api-key");
      await h.runtime.onProviderLogin();
      expect(h.config.provider("fake")!.auth).toBe("api-key");
      await h.waitIdle();

      const sent = async () => {
        try {
          await send(h!, { type: "agent.prompt", text: "third" });
          return true;
        } catch {
          return false; // still restarting
        }
      };
      await waitFor(sent, "the restarted agent to take a prompt");
      await h.waitIdle();
      expect(await keys()).toEqual([null, null, "sk-test-not-real"]);

      // And back: its own sign-in, no key.
      await h.config.setProviderAuth("fake", "login");
      await h.runtime.onProviderLogin();
      await waitFor(async () => (await sent()) || false, "the agent to take a prompt again");
      await h.waitIdle();
      expect((await keys()).at(-1)).toBeNull();
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });
});
