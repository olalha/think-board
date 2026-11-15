// PDF blocks: an uploaded PDF shows its pages, drawn by pdf.js, with a page count.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "two-pages.pdf"));

test("an uploaded PDF becomes a block that draws its pages and scrolls when selected", async ({ page }) => {
  const res = await page.request.post("/api/projects", { data: { name: "Pdf blocks" } });
  expect(res.ok()).toBeTruthy();
  await page.goto("/p/pdf-blocks");
  await expect(page.locator(".react-flow__pane")).toBeVisible();

  const up = await page.request.post("/api/projects/pdf-blocks/images?x=0&y=0", { headers: { "Content-Type": "application/pdf" }, data: fixture });
  expect(up.ok()).toBeTruthy();
  const { name } = (await up.json()) as { name: string };

  const block = page.locator(`.react-flow__node-block[data-id="${name}"] .block.type-pdf`);
  await expect(block).toBeVisible();
  await page.locator(`.react-flow__node-block[data-id="${name}"] .block-name`).dblclick(); // zoom to it: sharp pages
  await expect(block.locator(".pdf-page canvas").first()).toBeVisible();
  await expect(block.locator(".pdf-pager")).toHaveText("Page 1 of 2");

  // Selected, the pages scroll with the wheel instead of the canvas.
  await expect(block.locator(".pdf-pages.nowheel")).toHaveCount(1);
  await block.locator(".pdf-pages").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(block.locator(".pdf-pager")).toHaveText("Page 2 of 2");

  // The file is served as a PDF, for downloads.
  const file = await page.request.get(`/api/projects/pdf-blocks/files/${name}.pdf`);
  expect(file.headers()["content-type"]).toBe("application/pdf");
});
