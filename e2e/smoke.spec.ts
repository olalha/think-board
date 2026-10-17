// The core flow, end to end: create a canvas, add and edit a block, prompt the
// agent, see the lock, see the agent's edit appear, see the unlock.
import { expect, test } from "@playwright/test";

test("create a canvas, edit a block, and watch an agent edit appear", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New canvas/ }).first().click();
  await page.getByLabel("Name").fill("Smoke test");
  await page.getByRole("button", { name: "Create canvas" }).click();
  await expect(page).toHaveURL(/\/p\/smoke-test$/);
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });

  // Add a Markdown block from the toolbar; it opens in raw mode, focused.
  await page.locator(".tool-btn", { hasText: "Markdown" }).click();
  await expect(page.locator(".block-name", { hasText: /^Harry$/ })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("Hello from the smoke test");
  await expect(page.locator(".save-dot")).toHaveCount(0, { timeout: 5_000 });
  await page.keyboard.press("Escape"); // leave the editor → rendered view
  await expect(page.locator(".md", { hasText: "Hello from the smoke test" })).toBeVisible();

  // Ask the (scripted) agent to create a block; the canvas locks while it works.
  const input = page.locator(".composer-input");
  await input.fill("slow make-note:tom");
  await input.press("Enter");
  await expect(page.locator(".lock-banner.show")).toBeVisible();
  await expect(page.locator(".tool-btn", { hasText: "Markdown" })).toBeDisabled();

  // The agent's new file appears on the canvas live; then editing unlocks.
  await expect(page.locator(".block-name", { hasText: /^Tom$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".lock-banner.show")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".tool-btn", { hasText: "Markdown" })).toBeEnabled();
  await expect(page.locator(".chat-user-bubble", { hasText: "slow make-note:tom" })).toBeVisible();

  // The user's edit reached the file on disk.
  const res = await page.request.get("/api/projects/smoke-test/files/harry.md");
  expect(await res.text()).toContain("Hello from the smoke test");
});
