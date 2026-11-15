// Chat replies: a copy button under each, and slash-command reports shown once,
// with their later sections folded.
import { expect, test } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a command report shows once, folded, and a reply copies as Markdown", async ({ page }) => {
  const res = await page.request.post("/api/projects", { data: { name: "Chat replies" } });
  expect(res.ok()).toBeTruthy();
  await page.goto("/p/chat-replies");
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });

  const input = page.locator(".composer-input");
  await input.fill("/report echo-report");
  await input.press("Enter");
  const reply = page.locator(".chat-agent", { hasText: "Context Usage" });
  await expect(reply).toHaveCount(1, { timeout: 20_000 });
  await expect(reply.locator("h2", { hasText: "Context Usage" })).toHaveCount(1);
  // The first section shows; later ones are folded under their headings.
  await expect(reply.locator("table").first()).toBeVisible();
  const skills = reply.locator("details.chat-report-section", { hasText: "Skills" });
  await expect(skills).toHaveCount(1);
  await expect(skills.locator("table")).toBeHidden();
  await skills.locator("summary").click();
  await expect(skills.locator("table")).toBeVisible();

  await reply.hover();
  await reply.getByRole("button", { name: "Copy reply as Markdown" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("## Context Usage");
  expect(copied).toContain("| loop | 120 |");
  await page.screenshot({ path: "test-results/chat-report.png" });
});
