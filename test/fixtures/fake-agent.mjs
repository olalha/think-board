#!/usr/bin/env node
// A scripted ACP agent for tests. It reacts to keywords in the prompt text:
//
//   touch:<name>       append a line to <name>.md first (marks it "touched")
//   make-note:<name>   create <name>.md (no canvas.json edit)
//   make-bad-diagram   write an invalid bob.mmd
//   no-commit          write tom.md (like every change here: think commits it)
//   self-commit        commit everything with git itself, as agents used to
//   run: <command>     run a shell command (a line of its own), e.g. the
//                      `think` command; its output is logged
//   slow               take ~1.5s before finishing (cancellable)
//
// $FAKE_NEEDS_LOGIN=1 makes every new session fail with "auth required", so the
// chat shows its login card.
// $FAKE_SCENE names a JSON file of scripted turns, for demos and screenshots:
//   [{ "match": "text in the prompt", "files": { "name.md": "content" },
//      "run": ["think add name.md --near welcome"], "reply": "Markdown" }]
// The first entry whose `match` is in the prompt is played instead: each file is
// written (shown as a tool call), each command run, then the reply streamed.
//
// Like a real agent now, it never commits unless told to (self-commit): think
// commits its work at the end of the turn. On a validation follow-up
// ("automatic follow-up" in the prompt) it fixes bob.mmd only if FAKE_FIX=1.
// Every prompt it receives is appended as JSON to $FAKE_AGENT_LOG so tests can
// assert exactly what the agent saw (and whether it was given $FAKE_API_KEY);
// so is each run: command, with its output.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const cwdOf = new Map();
let active = null;

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function commit(cwd, msg) {
  git(cwd, "add", "-A");
  try {
    git(cwd, "commit", "-q", "-m", msg);
  } catch {
    /* nothing to commit */
  }
}
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

async function playScene(ctx, sessionId, cwd, scene, signal) {
  const update = (u) => ctx.client.notify("session/update", { sessionId, update: u });
  let n = 0;
  for (const [file, content] of Object.entries(scene.files ?? {})) {
    const toolCallId = `scene-${++n}`;
    await update({ sessionUpdate: "tool_call", toolCallId, title: `Write ${file}`, kind: "edit", status: "in_progress", locations: [{ path: path.join(cwd, file) }] });
    fs.writeFileSync(path.join(cwd, file), content);
    await sleep(400, signal);
    await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  }
  for (const command of scene.run ?? []) {
    const toolCallId = `scene-${++n}`;
    await update({ sessionUpdate: "tool_call", toolCallId, title: command, kind: "execute", status: "in_progress" });
    spawnSync("/bin/sh", ["-c", command], { cwd, env: process.env, encoding: "utf8" });
    await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  }
  for (const word of (scene.reply ?? "Done.").split(/(?<= )/)) {
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
    await sleep(15, signal);
  }
}

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest("session/new", (ctx) => {
    if (process.env.FAKE_NEEDS_LOGIN === "1") throw acp.RequestError.authRequired(undefined, "Not logged in");
    const id = `fake-${Math.random().toString(36).slice(2, 10)}`;
    cwdOf.set(id, ctx.params.cwd);
    // Like claude-agent-acp: advertise slash commands shortly after the session starts.
    setTimeout(() => {
      void ctx.client.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Summarise the conversation" },
            { name: "init", description: "Write CLAUDE.md" },
          ],
        },
      });
    }, 50);
    return { sessionId: id };
  })
  .onRequest("session/set_mode", () => ({}))
  .onNotification("session/cancel", () => active?.abort())
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const cwd = cwdOf.get(sessionId);
    const texts = prompt.filter((b) => b.type === "text").map((b) => b.text);
    const text = texts.join("\n\n");
    if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ blocks: texts, key: process.env.FAKE_API_KEY ?? null }) + "\n");
    active = new AbortController();
    const say = (t) =>
      ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
    try {
      const scene = process.env.FAKE_SCENE ? JSON.parse(fs.readFileSync(process.env.FAKE_SCENE, "utf8")).find((s) => text.includes(s.match)) : null;
      if (scene) {
        await playScene(ctx, sessionId, cwd, scene, active.signal);
        return { stopReason: "end_turn" };
      }
      await say("Working on it. ");
      const touch = /touch:([a-z0-9-]+)/.exec(text);
      if (touch) {
        fs.appendFileSync(path.join(cwd, `${touch[1]}.md`), "\nedited by the agent\n");
        await sleep(250, active.signal); // let the watcher see it before the next file
      }
      if (text.includes("slow")) await sleep(1500, active.signal);
      const note = /make-note:([a-z0-9-]+)/.exec(text);
      if (note) fs.writeFileSync(path.join(cwd, `${note[1]}.md`), `# ${note[1]}\n`);
      if (text.includes("make-bad-diagram")) fs.writeFileSync(path.join(cwd, "bob.mmd"), "flowchart LR\n  A[Start --> B\n");
      if (text.includes("automatic follow-up") && process.env.FAKE_FIX === "1") fs.writeFileSync(path.join(cwd, "bob.mmd"), "flowchart LR\n  A[Start] --> B[End]\n");
      if (text.includes("no-commit")) fs.writeFileSync(path.join(cwd, "tom.md"), "# tom\nuncommitted\n");
      // rename:<from>:<to> — `git mv` a Markdown block without touching canvas.json.
      const rename = /rename:([a-z0-9-]+):([a-z0-9-]+)/.exec(text);
      if (rename) execFileSync("git", ["mv", `${rename[1]}.md`, `${rename[2]}.md`], { cwd });
      // overwrite:<name> — replace a Markdown block's content.
      const over = /overwrite:([a-z0-9-]+)/.exec(text);
      if (over) fs.writeFileSync(path.join(cwd, `${over[1]}.md`), "# overwritten by the agent\n");
      // stray — leave a non-block file in the top level.
      if (text.includes("make-stray")) fs.writeFileSync(path.join(cwd, "notes.txt"), "scratch\n");
      for (const m of text.matchAll(/^run: (.+)$/gm)) {
        const r = spawnSync("/bin/sh", ["-c", m[1]], { cwd, env: process.env, encoding: "utf8" });
        if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ run: m[1], code: r.status, out: r.stdout, err: r.stderr }) + "\n");
      }
      if (text.includes("self-commit")) commit(cwd, "the agent's own commit");
      await say("Done.");
      return { stopReason: "end_turn" };
    } catch {
      return { stopReason: "cancelled" };
    } finally {
      active = null;
    }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
