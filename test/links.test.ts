// Block titles and [[links]]: the shared helpers server and client agree on.
import { describe, expect, it } from "vitest";
import { blockLabel, cleanTitle, MAX_TITLE, renameTarget } from "../src/shared/blocks.js";
import { serializeCanvas } from "../src/shared/canvas.js";
import { codeRanges, findBlockLinks, rewriteBlockLinks } from "../src/shared/links.js";
import { parseCanvas, reconcileCanvas, renameInCanvas } from "../src/server/canvas-model.js";

describe("titles", () => {
  it("label a block by its title, else its name made readable", () => {
    expect(blockLabel("cli-notes")).toBe("CLI notes");
    expect(blockLabel("cli-notes", { title: "CLI — notes 🚀" })).toBe("CLI — notes 🚀");
    expect(blockLabel("cli-notes", {})).toBe("CLI notes");
  });

  it("keeps a title to one trimmed line of at most 120 characters", () => {
    expect(cleanTitle("  Tea\nplan \r\n 🍵 ")).toBe("Tea plan 🍵");
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle(42)).toBeUndefined();
    const long = cleanTitle("🍵".repeat(200))!;
    expect(Array.from(long)).toHaveLength(MAX_TITLE);
  });

  it("turns rename text into a file name and a title", () => {
    expect(renameTarget("tea-guide", "harry")).toEqual({ name: "tea-guide" });
    expect(renameTarget("Tea guide", "harry")).toEqual({ name: "tea-guide" });
    expect(renameTarget("CLI notes", "harry")).toEqual({ name: "cli-notes" });
    expect(renameTarget("Tea guide!", "harry")).toEqual({ name: "tea-guide", title: "Tea guide!" });
    expect(renameTarget("Crème brûlée", "harry")).toEqual({ name: "creme-brulee", title: "Crème brûlée" });
    expect(renameTarget("🚀", "harry")).toEqual({ name: "harry", title: "🚀" });
    expect(renameTarget("  ", "harry")).toBeNull();
  });

  it("travel in canvas.json: parsed, cleaned by reconciliation, serialised, carried by renames", () => {
    const text = JSON.stringify({ nodes: [{ id: "harry", type: "file", file: "harry.md", title: " Big\nplan ", x: 0, y: 0, width: 360, height: 260 }], edges: [] });
    const parsed = parseCanvas(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = reconcileCanvas(parsed.canvas, new Map([["harry", { file: "harry.md", type: "markdown" as const }]]), { gridSize: 20 });
    expect(r.canvas.nodes[0]).toMatchObject({ title: "Big plan" });
    expect(serializeCanvas(r.canvas)).toContain('"title": "Big plan"');
    const withView = { ...r.canvas, views: [{ id: "v1", name: "Big plan", x: 0, y: 0, width: 10, height: 10, target: "harry", followName: true }] };
    const renamed = renameInCanvas(withView, "harry", "plan", "plan.md");
    expect(renamed.nodes[0]).toMatchObject({ id: "plan", title: "Big plan" });
    expect(renamed.views![0]).toMatchObject({ target: "plan", name: "Big plan" });
    const cleared = reconcileCanvas({ ...r.canvas, nodes: [{ ...r.canvas.nodes[0], title: "  " } as never] }, new Map([["harry", { file: "harry.md", type: "markdown" as const }]]), { gridSize: 20 });
    expect(cleared.canvas.nodes[0]).not.toHaveProperty("title");
  });
});

describe("block links", () => {
  it("finds [[name]] and [[name|text]] outside code", () => {
    const md = "See [[bob]] and [[ tea-guide | the guide ]].\n\n`[[inline]]` and ``a ` [[double]]``\n\n```\n[[fenced]]\n```\n~~~js\n[[tilde]]\n~~~\n\n    - list\n  ```\n  [[indented-fence]]\n  ```\nlast [[harry|]]";
    const links = findBlockLinks(md);
    expect(links.map((l) => l.target)).toEqual(["bob", "tea-guide", "harry"]);
    expect(links[1].text).toBe(" the guide ");
    expect(links[2].text).toBe("");
  });

  it("treats an unclosed fence as code to the end, and an unmatched backtick as text", () => {
    expect(findBlockLinks("a ` b [[bob]]")).toHaveLength(1);
    expect(findBlockLinks("```\n[[bob]]\nno close")).toHaveLength(0);
    expect(codeRanges("x\n````\n```\n[[a]]\n````\ny")).toEqual([[2, 21]]);
  });

  it("rewrites links to renamed blocks, keeping their text, and leaves code alone", () => {
    const md = "[[bob]] · [[bob|Bob's list]] · [[bobby]] · `[[bob]]`\n```\n[[bob]]\n```\n";
    expect(rewriteBlockLinks(md, [["bob", "tea-guide"]])).toBe("[[tea-guide]] · [[tea-guide|Bob's list]] · [[bobby]] · `[[bob]]`\n```\n[[bob]]\n```\n");
    expect(rewriteBlockLinks("[[a]] [[b]]", [["a", "b"], ["b", "c"]])).toBe("[[c]] [[c]]");
    const same = "nothing [[here]]";
    expect(rewriteBlockLinks(same, [["bob", "x"]])).toBe(same);
  });
});
