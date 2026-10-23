// Switching a canvas's agent: from the chat's menu to an agent that needs a
// login, and back from that login card.
import { expect, test } from "@playwright/test";

test("switch a canvas to another agent and back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /New canvas/ }).first().click();
  await page.getByLabel("Name").fill("Switch test");
  await page.getByRole("button", { name: "Create canvas" }).click();
  await expect(page).toHaveURL(/\/p\/switch-test$/);
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chat-head-name")).toHaveText("Fake agent");

  await page.getByRole("button", { name: "Agent menu" }).click();
  await page.getByText("Switch to Locked agent").click();
  await expect(page.locator(".chat-head-name")).toHaveText("Locked agent");
  await expect(page.locator(".chat-divider", { hasText: "Switched to Locked agent" })).toBeVisible();
  await expect(page.locator(".agent-card.login", { hasText: "Log in to Locked agent" })).toBeVisible({ timeout: 20_000 });

  await page.locator(".agent-card-switch").getByRole("button", { name: "Fake agent" }).click();
  await expect(page.locator(".chat-head-name")).toHaveText("Fake agent");
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chat-divider", { hasText: "Switched to Fake agent" })).toBeVisible();
});
