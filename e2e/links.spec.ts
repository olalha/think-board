// Block titles and [[links]]: renaming to free text, undoing it, the @ picker
// in the raw editor, and the chips links render as.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const root = () => fs.readFileSync(path.join(os.tmpdir(), "think-e2e-3095.root"), "utf8").trim();

/** A canvas where alpha links to beta (far to the right) and to a block that doesn't exist. */
async function setup(page: Page, name: string, slug: string): Promise<string> {
  const res = await page.request.post("/api/projects", { data: { name } });
  expect(res.ok()).toBeTruthy();
  const dir = path.join(root(), "data", slug);
  fs.writeFileSync(path.join(dir, "alpha.md"), "# Alpha\n\nSee [[beta]] and [[gone]].\n");
  fs.writeFileSync(path.join(dir, "beta.md"), "# Beta\n");
  fs.writeFileSync(path.join(dir, "gamma.md"), "# Gamma\n");
  const node = (id: string, x: number, y: number) => ({ id, type: "file", file: `${id}.md`, x, y, width: 360, height: 260 });
  fs.writeFileSync(path.join(dir, "canvas.json"), JSON.stringify({ nodes: [node("alpha", 0, 0), node("gamma", 0, 400), node("beta", 1600, 0)], edges: [] }));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "setup"], { cwd: dir });
  await page.goto(`/p/${slug}`);
  await expect(page.locator(".react-flow__node-block")).toHaveCount(3);
  return dir;
}

const block = (page: Page, id: string) => page.locator(`.react-flow__node-block[data-id="${id}"]`);
const read = (dir: string, file: string) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf8") : null);
const titleOf = (dir: string, id: string) => JSON.parse(read(dir, "canvas.json")!).nodes.find((n: { id: string }) => n.id === id)?.title;

test("renaming a block to a title with symbols, with the file name hint, and undoing it", async ({ page }) => {
  const dir = await setup(page, "Link titles", "link-titles");
  await block(page, "beta").locator(".block-name").click();
  await page.keyboard.press("F2");
  const input = page.locator(".name-input");
  await expect(input).toBeFocused();
  await input.fill("Beta & co ✨");
  await expect(page.locator(".name-hint")).toHaveText("File: beta-co.md");
  await input.press("Enter");

  // The header shows the title; the file follows it; the link to it follows the file.
  await expect(block(page, "beta-co").locator(".block-name")).toHaveText("Beta & co ✨");
  await expect.poll(() => read(dir, "beta-co.md")).toBe("# Beta\n");
  await expect.poll(() => titleOf(dir, "beta-co")).toBe("Beta & co ✨");
  await expect.poll(() => read(dir, "alpha.md")).toContain("[[beta-co]]");
  await expect(block(page, "alpha").locator(".block-link", { hasText: "@Beta & co ✨" })).toBeVisible();

  // A title-only change keeps the file.
  await block(page, "beta-co").locator(".block-name").click();
  await page.keyboard.press("F2");
  await expect(page.locator(".name-input")).toBeFocused();
  await page.locator(".name-input").fill("Beta co!");
  await expect(page.locator(".name-hint")).toHaveText("");
  await page.locator(".name-input").press("Enter");
  await expect(block(page, "beta-co").locator(".block-name")).toHaveText("Beta co!");

  // Undo: the title goes back, then the file name and no title; redo brings both back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block(page, "beta-co").locator(".block-name")).toHaveText("Beta & co ✨");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block(page, "beta").locator(".block-name")).toHaveText("Beta");
  await expect.poll(() => read(dir, "beta.md")).toBe("# Beta\n");
  await expect.poll(() => titleOf(dir, "beta")).toBeUndefined();
  await expect(block(page, "alpha").locator(".block-link", { hasText: "@Beta" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(block(page, "beta-co").locator(".block-name")).toHaveText("Beta & co ✨");
  await expect.poll(() => titleOf(dir, "beta-co")).toBe("Beta & co ✨");
});

test("a link chip flies to its block; a link to no block is struck through", async ({ page }) => {
  await setup(page, "Link chips", "link-chips");
  const missing = block(page, "alpha").locator('.block-link.missing[data-block="gone"]');
  await expect(missing).toHaveText("@Gone");
  await expect(missing).toHaveAttribute("data-tip", "No block named “gone”");

  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await block(page, "alpha").locator('.block-link[data-block="beta"]').click();
  await expect(block(page, "beta")).toHaveClass(/selected/);
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
});

test("typing @ or [[ in the raw editor picks a block and writes [[name]]", async ({ page }) => {
  const dir = await setup(page, "Link picker", "link-picker");
  await block(page, "gamma").locator(".block-name").click();
  await page.keyboard.press("Enter"); // raw view, cursor at the end
  const editor = block(page, "gamma").locator(".cm-content");
  await expect(editor).toBeFocused();

  const list = page.locator(".cm-tooltip-autocomplete");
  await page.keyboard.type("See @be");
  await expect(list).toBeVisible();
  await expect(list.locator("li").first()).toContainText("Beta");
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(editor).toContainText("See [[beta]]");

  // Esc with the list open closes only the list.
  await page.keyboard.type(" @");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Backspace");

  await page.keyboard.type("and [[alp");
  await expect(list.locator("li").first()).toContainText("Alpha");
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("See [[beta]] and [[alpha]]");
  await expect.poll(() => read(dir, "gamma.md")).toBe("# Gamma\nSee [[beta]] and [[alpha]]");

  // Leaving the editor: the links render as chips.
  await page.keyboard.press("Escape");
  await expect(block(page, "gamma").locator(".block-link", { hasText: "@Beta" })).toBeVisible();
  await expect(block(page, "gamma").locator(".block-link", { hasText: "@Alpha" })).toBeVisible();
});
