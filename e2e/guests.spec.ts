// An outside agent on a canvas, end to end: the `think` command (the real sh
// script) joins, and a tab appears beside the canvas agent's; its composer
// only drafts (Copy, no Send); it leaves, and the tab goes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);
const root = () => fs.readFileSync(path.join(os.tmpdir(), "think-e2e-3095.root"), "utf8").trim();
const think = (...args: string[]) => run("sh", [path.join(root(), "app", "bin", "think"), ...args], { env: { ...process.env, THINK_ROOT: root() } });

test("an outside agent's tab: appears on join, drafts only, goes on leave", async ({ page }) => {
  await think("new", "Guest test", "An outside agent visits");
  await page.goto("/p/guest-test");
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chat-tabs-wrap.show")).toHaveCount(0); // no tabs without outside agents

  await think("join", "guest-test", "--as", "planner", "--about", "Claude Code in a terminal", "to help plan");
  const tab = page.getByRole("tab", { name: /planner/ });
  await expect(page.locator(".chat-tabs-wrap.show")).toBeVisible();
  await expect(tab).toBeVisible();

  await think("say", "I mapped the launch — have a look.", "--as", "planner");
  await expect(tab.locator(".unread-dot")).toBeVisible();
  await tab.click();
  await expect(page.locator(".guest-msg", { hasText: "I mapped the launch" })).toBeVisible();
  await expect(page.locator(".chat-head-sub", { hasText: "Claude Code in a terminal" })).toBeVisible();
  // The canvas agent's chat never shows it.
  await page.getByRole("tab", { name: /Fake agent/ }).click();
  await expect(page.locator(".chat-body", { hasText: "I mapped the launch" })).toHaveCount(0);
  await tab.click();

  // Draft only: a Copy button, no Send.
  const draft = page.getByLabel("Draft a reply to planner");
  await draft.fill("Looks good — add the dates.");
  await expect(page.getByRole("button", { name: /Copy/ })).toBeEnabled();
  await expect(page.locator(".chat-pane:not(.hidden) .composer-btn.send")).toHaveCount(0);
  await expect(page.getByText("planner can't read replies here")).toBeVisible();
  await draft.press("Enter"); // a new line, never a send
  await expect(draft).toHaveValue("Looks good — add the dates.\n");
  await draft.fill("");

  // Leaving: "left" for a moment, then the tab and the strip go, back on the canvas agent's tab.
  await think("leave", "--as", "planner");
  await expect(tab).toContainText("left");
  await expect(tab).toHaveCount(0, { timeout: 6_000 });
  await expect(page.locator(".chat-tabs-wrap.show")).toHaveCount(0);
  await expect(page.locator(".chat-pane:not(.hidden) .composer-btn.send")).toBeVisible();
});
