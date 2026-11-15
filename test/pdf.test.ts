// PDF blocks: the block type, text extraction, and the text sidecar agents read.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/server/git.js";
import { extractPdfText, pdfTextRel } from "../src/server/pdf-text.js";
import { EXTENSION_PRECEDENCE, isTextType, looksLikePdf, MAX_PDF_BYTES, parseBlockFile } from "../src/shared/blocks.js";
import { APP_DIR, makeHarness, waitFor, type Harness } from "./helpers.js";

// Two pages of text, built by test/fixtures/make-pdf.mjs.
const fixture = () => fs.readFile(path.join(APP_DIR, "test", "fixtures", "two-pages.pdf"));

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const send = (h: Harness, msg: Parameters<Harness["runtime"]["handle"]>[1]) => h.runtime.handle(h.client, msg);
const textOf = (h: Harness, file: string) => fs.readFile(path.join(h.dir, pdfTextRel(file)), "utf8");
const gone = (p: string) => fs.access(p).then(() => false, () => true);

describe("the pdf block type", () => {
  it("is a binary block type, after every other extension in precedence", () => {
    expect(parseBlockFile("report.pdf")).toEqual({ name: "report", ext: "pdf", type: "pdf" });
    expect(parseBlockFile("Report.PDF")).toBeNull();
    expect(isTextType("pdf")).toBe(false);
    expect(isTextType("markdown")).toBe(true);
    expect(EXTENSION_PRECEDENCE.at(-1)).toBe("pdf");
  });

  it("recognises PDF bytes", async () => {
    expect(looksLikePdf(await fixture())).toBe(true);
    expect(looksLikePdf(Buffer.from("not a pdf at all"))).toBe(false);
  });
});

describe("PDF text extraction", () => {
  it("reads the text of every page, page by page", async () => {
    const { text, pages } = await extractPdfText(await fixture());
    expect(pages).toBe(2);
    expect(text).toMatch(/--- Page 1 ---\nHello from page one\n[\s\S]*--- Page 2 ---\nSecond page text/);
  });

  it("rejects a file that is not a PDF", async () => {
    await expect(extractPdfText(Buffer.from("%PDF-1.4\nthis is broken"))).rejects.toThrow();
  });
});

describe("PDF blocks on a canvas", () => {
  it("uploads a PDF as a block and keeps its text in .think/text/, out of git, following renames and deletes", async () => {
    h = await makeHarness();
    const { name } = await h.runtime.putUpload(await fixture(), "application/pdf", { x: 0, y: 0 });
    expect(await fs.readFile(path.join(h.dir, `${name}.pdf`))).toEqual(await fixture());
    expect(h.messages.some((m) => m.type === "file.changed" && m.block.name === name && m.block.type === "pdf" && m.block.content === undefined)).toBe(true);
    await waitFor(() => textOf(h!, `${name}.pdf`).then(() => true, () => false), "the PDF's text");
    const text = await textOf(h, `${name}.pdf`);
    expect(text).toContain(`${name}.pdf (2 pages)`);
    expect(text).toContain("Hello from page one");
    expect(text).toContain("Second page text");

    await send(h, { type: "canvas.save" });
    const tracked = await git(h.dir, ["ls-files"]);
    expect(tracked).toContain(`${name}.pdf`);
    expect(tracked).not.toContain(".think/");

    await send(h, { type: "block.rename", name, to: "report" });
    await waitFor(() => textOf(h!, "report.pdf").then(() => true, () => false), "the text to follow the rename");
    await waitFor(() => gone(path.join(h!.dir, pdfTextRel(`${name}.pdf`))), "the old text to go");

    await send(h, { type: "block.delete", names: ["report"] });
    await waitFor(() => gone(path.join(h!.dir, pdfTextRel("report.pdf"))), "the text to go with the block");
  });

  it("copies a PDF block on paste, with its own text", async () => {
    h = await makeHarness();
    const { name } = await h.runtime.putUpload(await fixture(), "application/pdf", { x: 0, y: 0 });
    const slug = path.basename(h.dir);
    const r = (await send(h, {
      type: "blocks.paste",
      blocks: [{ from: name, type: "pdf", image: { canvas: slug, file: `${name}.pdf` }, x: 600, y: 0, width: 420, height: 560 }],
      edges: [],
      groups: [],
    })) as { names: Record<string, string> };
    const copy = r.names[name];
    expect(copy).toBeTruthy();
    expect(copy).not.toBe(name);
    expect(await fs.readFile(path.join(h.dir, `${copy}.pdf`))).toEqual(await fixture());
    await waitFor(() => textOf(h!, `${copy}.pdf`).then((t) => t.includes("Hello from page one"), () => false), "the copy's text");
  });

  it("extracts the text of a PDF placed in the folder from outside", async () => {
    h = await makeHarness();
    await fs.writeFile(path.join(h.dir, "paper.pdf"), await fixture());
    await waitFor(() => textOf(h!, "paper.pdf").then((t) => t.includes("Second page text"), () => false), "the text of paper.pdf");
  });

  it("writes a note instead of text for a PDF it cannot read", async () => {
    h = await makeHarness();
    await fs.writeFile(path.join(h.dir, "broken.pdf"), "%PDF-1.4\nnot really\n");
    await waitFor(() => textOf(h!, "broken.pdf").then((t) => t.startsWith("think could not read the text of broken.pdf"), () => false), "a note about broken.pdf");
  });

  it("refuses an upload that is not a PDF, or too large", async () => {
    h = await makeHarness();
    await expect(h.runtime.putUpload(Buffer.from("hello"), "application/pdf", {})).rejects.toThrow(/not a PDF/);
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_PDF_BYTES)]);
    await expect(h.runtime.putUpload(big, "application/pdf", {})).rejects.toThrow(/too large/);
    await expect(h.runtime.putUpload(await fixture(), "application/pdf", { replace: "anything" })).rejects.toThrow(/cannot replace/);
  });
});
