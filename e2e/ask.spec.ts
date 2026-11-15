// The canvas agent's questions (`think ask`): a card in the chat that the user
// answers — options, an "Other" text, Submit — and that then shows the answers.
import { expect, test } from "@playwright/test";

const SPEC = {
  questions: [
    { question: "Which layout?", header: "Layout", options: [{ label: "Timeline", description: "one row per month" }, { label: "Mind map" }] },
    { question: "Which sections?", options: [{ label: "Goals" }, { label: "Risks" }], multiSelect: true },
  ],
};

test("the agent asks; the user answers in the card", async ({ page }) => {
  const res = await page.request.post("/api/projects", { data: { name: "Ask the user" } });
  expect(res.ok()).toBeTruthy();
  await page.goto("/p/ask-the-user");
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });

  const input = page.locator(".composer-input");
  await input.fill(`run: printf '%s' '${JSON.stringify(SPEC)}' | think ask`);
  await input.press("Enter");

  const card = page.locator(".chat-question");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator(".chat-q-chip", { hasText: "Layout" })).toBeVisible();
  const submit = card.getByRole("button", { name: "Submit" });
  await expect(submit).toBeDisabled();

  await card.getByLabel("Timeline").check();
  await card.getByLabel("Goals").check();
  await card.locator(".chat-q").nth(1).getByPlaceholder("Other…").fill("a budget");
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: "test-results/ask-card.png" });
  await submit.click();

  await expect(card).toHaveClass(/settled/);
  await expect(card.locator(".chat-q-answer").first()).toHaveText("Timeline");
  await expect(card.locator(".chat-q-answer").nth(1)).toHaveText("Goals, “a budget”");
  await expect(page.locator(".chat-agent", { hasText: "Done." })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "test-results/ask-answered.png" });
});
