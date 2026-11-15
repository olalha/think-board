// Moving an arrow's end: select it, drag an end onto another block — onto a side
// handle, or anywhere on the block (its nearest side).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const root = () => fs.readFileSync(path.join(os.tmpdir(), "think-e2e-3095.root"), "utf8").trim();

/** A canvas with alpha → beta, and gamma below beta. */
async function setup(page: Page, name: string, slug: string): Promise<string> {
  const res = await page.request.post("/api/projects", { data: { name } });
  expect(res.ok()).toBeTruthy();
  const dir = path.join(root(), "data", slug);
  for (const b of ["alpha", "beta", "gamma"]) fs.writeFileSync(path.join(dir, `${b}.md`), `# ${b}\n`);
  const node = (id: string, x: number, y: number) => ({ id, type: "file", file: `${id}.md`, x, y, width: 360, height: 260 });
  fs.writeFileSync(
    path.join(dir, "canvas.json"),
    JSON.stringify({ nodes: [node("alpha", 0, 0), node("beta", 600, 0), node("gamma", 600, 440)], edges: [{ id: "e1", fromNode: "alpha", fromSide: "right", toNode: "beta", toSide: "left" }] }),
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "setup"], { cwd: dir });
  await page.goto(`/p/${slug}`);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  return dir;
}

async function dragArrowEnd(page: Page, to: (g: { x: number; y: number; width: number; height: number }) => { x: number; y: number }): Promise<void> {
  const line = await page.locator(".react-flow__edge path").first().boundingBox();
  await page.mouse.click(line!.x + 30, line!.y + line!.height / 2); // on the line, clear of the label
  const end = page.locator(".react-flow__edgeupdater-target");
  const e = (await end.boundingBox())!;
  const g = (await page.locator('.react-flow__node[data-id="gamma"]').boundingBox())!;
  const p = to(g);
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y, { steps: 15 });
  await page.mouse.up();
}

const edges = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"), "utf8")).edges;

test("dragging an arrow's end onto a block's body attaches it to the nearest side", async ({ page }) => {
  const dir = await setup(page, "Arrow body", "arrow-body");
  await dragArrowEnd(page, (g) => ({ x: g.x + g.width / 2, y: g.y + 30 }));
  await expect.poll(() => edges(dir)).toEqual([{ id: "e1", fromNode: "alpha", fromSide: "right", toNode: "gamma", toSide: "top" }]);
});

test("dragging an arrow's end onto a side handle attaches it there", async ({ page }) => {
  const dir = await setup(page, "Arrow handle", "arrow-handle");
  await dragArrowEnd(page, (g) => ({ x: g.x, y: g.y + g.height / 2 }));
  await expect.poll(() => edges(dir)).toEqual([{ id: "e1", fromNode: "alpha", fromSide: "right", toNode: "gamma", toSide: "left" }]);
});
