import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/server/agent/usage.js";
import { renderTemplate, Templates } from "../src/server/templates.js";
import { APP_DIR } from "./helpers.js";

describe("renderTemplate", () => {
  it("substitutes {{placeholders}} and leaves unknown ones visible", () => {
    const r = renderTemplate("Head {{ last_agent_head }}; {{attempt}}/{{max_attempts}}; {{nope}}", { last_agent_head: "abc123", attempt: 1, max_attempts: 2 });
    expect(r.text).toBe("Head abc123; 1/2; {{nope}}");
    expect(r.missing).toEqual(["nope"]);
  });
});

describe("Templates", () => {
  it("reads templates at use time, so edits apply without a restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "think-tpl-"));
    const t = new Templates(dir);
    await fs.writeFile(path.join(dir, "turn-suffix.md"), "first {{x}}\n");
    expect(await t.render("turn-suffix.md", { x: "1" })).toBe("first 1");
    await fs.writeFile(path.join(dir, "turn-suffix.md"), "second {{x}}\n");
    expect(await t.render("turn-suffix.md", { x: "2" })).toBe("second 2");
    await fs.rm(dir, { recursive: true });
  });

  it("ships every template the app uses, with the placeholders it fills", async () => {
    const t = new Templates(path.join(APP_DIR, "prompts"));
    const missing: string[] = [];
    const strict = new Templates(path.join(APP_DIR, "prompts"), (_n, keys) => missing.push(...keys));
    await strict.render("project-agents.md", { project_name: "P", canvas_slug: "p", grid_size: 20, instructions_file: "AGENTS.md" });
    await strict.render("turn-suffix.md", { protected_note: "" });
    await strict.render("user-changes.md", { last_agent_head: "abc", authors: "the user", summary: "- Edited blocks: harry", commit_count: 1 });
    await strict.render("validation-errors.md", { errors: "- x", attempt: 1, max_attempts: 2 });
    expect(missing).toEqual([]);
    expect(await t.render("user-changes.md", { last_agent_head: "abc1234" })).toContain("abc1234");
  });
});


describe("parseUsage", () => {
  it("reads the windows claude-agent-acp's /usage prints", () => {
    const md = "### Limits\n\n**5-hour limit** — **64%** · Resets Sep 26, 8:00 PM GMT+2\n\n`███`\n\n**Weekly · all models** — **80%** · Resets Sep 27, 2:00 PM GMT+2\n";
    expect(parseUsage(md)).toEqual([
      { label: "5-hour limit", percent: 64, resets: "Sep 26, 8:00 PM GMT+2" },
      { label: "Weekly · all models", percent: 80, resets: "Sep 27, 2:00 PM GMT+2" },
    ]);
  });
});
