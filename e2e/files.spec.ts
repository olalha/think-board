// The Files tab: upload, preview a CSV as a table, rename, delete — and the
// tab working on a phone.
import { expect, test } from "@playwright/test";

test("upload, preview, rename and delete a reference file", async ({ page }) => {
  const res = await page.request.post("/api/projects", { data: { name: "Files test" } });
  expect(res.ok()).toBeTruthy();
  await page.goto("/p/files-test");
  await expect(page.locator(".chat-head .pill.ok")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Toggle side panel" }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.locator(".side-title")).toHaveText("Files");

  await page.locator(".files input[type=file]").setInputFiles({
    name: "sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('region,total\nnorth,3\n"south, east",4\n'),
  });
  const row = page.locator(".file-row", { hasText: "sales.csv" });
  await expect(row).toBeVisible();

  // Preview: a table.
  await row.locator(".file-main").click();
  const dialog = page.getByRole("dialog", { name: "sales.csv" });
  await expect(dialog.locator("th", { hasText: "region" })).toBeVisible();
  await expect(dialog.locator("td", { hasText: "south, east" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).last().click();

  // Rename into a folder.
  await row.hover();
  await row.getByRole("button", { name: /Rename/ }).click();
  await page.getByLabel("File name").fill("data/q3.csv");
  await page.getByLabel("File name").press("Enter");
  await expect(page.locator(".file-row", { hasText: "q3.csv" })).toBeVisible();
  await expect(page.locator(".file-meta", { hasText: "data/" })).toBeVisible();
  const list = await page.request.get("/api/projects/files-test/reference-files");
  expect((await list.json()).files.map((f: { path: string }) => f.path)).toEqual(["data/q3.csv"]);

  // Delete (no confirmation by default).
  const renamed = page.locator(".file-row", { hasText: "q3.csv" });
  await renamed.hover();
  await renamed.getByRole("button", { name: /Delete/ }).click();
  await expect(page.locator(".file-row")).toHaveCount(0);
  await expect(page.locator(".files .side-empty")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });

  test("the Files tab lists files with their tools in reach", async ({ page }) => {
    const res = await page.request.post("/api/projects", { data: { name: "Files phone" } });
    expect(res.ok()).toBeTruthy();
    await page.goto("/p/files-phone");
    // An upload over HTTP needs the canvas open: the page has opened it.
    await expect
      .poll(async () => (await page.request.put("/api/projects/files-phone/reference-files/notes.txt", { data: Buffer.from("hello"), headers: { "content-type": "application/octet-stream" } })).status(), { timeout: 20_000 })
      .toBe(200);
    await page.getByRole("button", { name: "Toggle side panel" }).tap();
    await page.getByRole("tab", { name: "Files" }).tap();
    const row = page.locator(".file-row", { hasText: "notes.txt" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: /Download/ })).toBeVisible();
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await row.locator(".file-main").tap();
    await expect(page.getByRole("dialog", { name: "notes.txt" }).locator("pre")).toHaveText("hello");
  });
});
