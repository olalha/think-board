// Pasting text onto the canvas: into a fresh, untouched block when there is one
// (just created, or selected), otherwise as a new block.
import { expect, test, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function newCanvas(page: Page, name: string, slug: string): Promise<void> {
  const res = await page.request.post("/api/projects", { data: { name } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/p/${slug}`);
  await expect(page.locator(".react-flow__pane")).toBeVisible();
}

const blockNames = (page: Page) => page.locator(".react-flow__node-block").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")));

test("pasting right after creating a block fills it instead of adding another", async ({ page }) => {
  await newCanvas(page, "Paste fresh", "paste-fresh");
  await page.evaluate(() => navigator.clipboard.writeText("Pasted line\nsecond"));
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 400 } });
  await page.keyboard.press("m");
  await page.keyboard.press("ControlOrMeta+v"); // before the editor has focus
  await expect.poll(async () => (await page.request.get("/api/projects/paste-fresh/files/harry.md")).text()).toContain("Pasted line");
  expect(await blockNames(page)).toEqual(["harry"]);
});

test("pasting with an untouched block selected fills it; otherwise text becomes a block", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("think.settings.v1", JSON.stringify({ newBlockMode: "rendered" })));
  await newCanvas(page, "Paste selected", "paste-selected");
  await page.evaluate(() => navigator.clipboard.writeText("Into the block"));
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 400 } });
  await page.keyboard.press("m");
  await expect(page.locator(".react-flow__node-block")).toHaveCount(1);
  await page.locator('.react-flow__node-block[data-id="harry"]').click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".md", { hasText: "Into the block" })).toBeVisible();
  expect(await blockNames(page)).toEqual(["harry"]);

  // Harry now has text: the next paste makes a block of its own.
  await page.evaluate(() => navigator.clipboard.writeText("A new note"));
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".react-flow__node-block")).toHaveCount(2);
});

test("Copy content: Markdown from the raw view, formatted text from the rendered one", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("think.settings.v1", JSON.stringify({ newBlockMode: "rendered" })));
  await newCanvas(page, "Copy content", "copy-content");
  await page.evaluate(() => navigator.clipboard.writeText("Some **bold** words"));
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 400 } });
  await page.keyboard.press("m");
  await page.keyboard.press("ControlOrMeta+v");
  const block = page.locator('.react-flow__node-block[data-id="harry"]');
  await expect(block.locator(".md strong", { hasText: "bold" })).toBeVisible();

  await block.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy content (formatted)" }).click();
  // The copy renders the Markdown first: wait for the clipboard to hold HTML.
  const read = () =>
    page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      if (!item.types.includes("text/html")) return null;
      return { html: await (await item.getType("text/html")).text(), plain: await (await item.getType("text/plain")).text() };
    });
  await expect.poll(read).not.toBeNull();
  const formatted = (await read())!;
  expect(formatted.html).toContain("<strong>bold</strong>");
  expect(formatted.plain).toContain("Some bold words");

  await block.click();
  await page.keyboard.press("Enter"); // raw view
  await page.keyboard.press("Escape");
  await block.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy content", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Some **bold** words");
});
