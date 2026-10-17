// Phones: the side panel is a column with its tab rail along the bottom. Its
// content must scroll inside it — not stretch the panel past the top of the
// screen, where the title and the start of the list can't be reached.
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 360 }, isMobile: true, hasTouch: true });

test("the side panel scrolls within the screen on a phone", async ({ page }) => {
  // A description makes the README long enough to overflow a short screen.
  const res = await page.request.post("/api/projects", {
    data: { name: "Phone test", description: "A canvas for checking the phone layout. ".repeat(12) },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto("/p/phone-test");
  await page.getByRole("button", { name: "Toggle side panel" }).tap();
  await page.getByRole("tab", { name: "README" }).tap();

  const box = (sel: string) => page.locator(sel).evaluate((e) => ({ ...e.getBoundingClientRect().toJSON(), scroll: e.scrollHeight, client: e.clientHeight }));
  await expect(page.locator(".side-title")).toHaveText("README");
  const head = await box(".side-head");
  const body = await box(".side-body");
  const rail = await box(".side-rail");
  expect(head.top).toBeGreaterThanOrEqual(0); // the title is on screen
  expect(body.bottom).toBeLessThanOrEqual(rail.top + 1); // the content ends above the rail
  expect(rail.bottom).toBeLessThanOrEqual(360 + 1);
  expect(body.scroll).toBeGreaterThan(body.client); // and scrolls, for the rest
});
