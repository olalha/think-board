// The text of PDF blocks, for agents that cannot read a PDF themselves.
//
//   .think/text/report.pdf.txt     the text of report.pdf, page by page
//   .think/text/index.json         { "report.pdf": "<hash of the pdf it came from>" }
//
// Derived, never committed (.think/ is git-ignored in every canvas): rebuilt
// whenever a PDF block appears or changes, removed when it goes. Extraction
// runs in a worker thread, off the runtime's queue, one file at a time; `idle()`
// lets a turn wait for it, so the canvas agent never reads a stale or missing file.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { exists, readJson, writeAtomic, writeJson } from "./fsutil.js";
import { errorMessage, silentLogger, type Logger } from "./util.js";

export const TEXT_DIR = "text";
/** Where a PDF block's text lives, relative to the canvas folder. */
export function pdfTextRel(file: string): string {
  return `.think/${TEXT_DIR}/${file}.txt`;
}

/** Give up on a PDF that takes longer than this to read (the worker is stopped). */
const EXTRACT_TIMEOUT_MS = 60_000;
/** A PDF that needs more memory than this to read is given up on. */
const WORKER_HEAP_MB = 512;

/**
 * The text of a PDF, one `--- Page N ---` section per page. Read by pdf.js in
 * a worker thread of its own (pdf-text-worker.ts): pdf.js has no real worker
 * in Node, and a large PDF would otherwise hold up the whole server. Throws on
 * a file that is not a readable PDF.
 */
export function extractPdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  const self = fileURLToPath(import.meta.url);
  // Same extension as this module: .ts in development and tests, .js when built.
  const file = path.join(path.dirname(self), `pdf-text-worker${path.extname(self)}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: { data }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    const timer = setTimeout(() => {
      reject(new Error("reading the PDF took too long"));
      void worker.terminate();
    }, EXTRACT_TIMEOUT_MS);
    worker.once("message", (msg: { text: string; pages: number } | { error: string }) => {
      clearTimeout(timer);
      if ("error" in msg) reject(new Error(msg.error));
      else resolve(msg);
      void worker.terminate();
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the PDF reader stopped (code ${code})`)); // no-op once settled
    });
  });
}

/**
 * Keeps `.think/text/` in step with a canvas's PDF blocks. `sync()` is cheap
 * and may be called on every change; the work happens in the background.
 */
export class PdfTextStore {
  private readonly dir: string;
  private wanted = new Map<string, string>(); // file → hash
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly canvasDir: string,
    thinkDir: string,
    private readonly log: Logger = silentLogger,
  ) {
    this.dir = path.join(thinkDir, TEXT_DIR);
  }

  /** The PDF blocks now (file → content hash). */
  sync(pdfs: Map<string, string>): void {
    this.wanted = new Map(pdfs);
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once every PDF block's text is written (or failed). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.reconcile(new Map(this.wanted));
      } catch (err) {
        this.log.error("could not update PDF text", { error: errorMessage(err) });
      }
    } while (this.again);
  }

  private async reconcile(wanted: Map<string, string>): Promise<void> {
    const indexFile = path.join(this.dir, "index.json");
    const index = await readJson<Record<string, string>>(indexFile, {});
    let dirty = false;
    for (const file of Object.keys(index)) {
      if (wanted.has(file)) continue;
      await fs.rm(path.join(this.dir, `${file}.txt`), { force: true });
      delete index[file];
      dirty = true;
    }
    await fs.mkdir(this.dir, { recursive: true });
    for (const [file, hash] of wanted) {
      if (this.again) break; // something changed meanwhile: start over with the latest
      if (index[file] === hash && (await exists(path.join(this.dir, `${file}.txt`)))) continue;
      let text: string;
      try {
        const data = await fs.readFile(path.join(this.canvasDir, file));
        const r = await extractPdfText(data);
        text = `Text of ${file} (${r.pages} page${r.pages === 1 ? "" : "s"}), extracted by think. Layout, images and figures are not included.\n\n${r.text}`;
      } catch (err) {
        text = `think could not read the text of ${file}: ${errorMessage(err)}\n`;
        this.log.info("PDF text extraction failed", { file, error: errorMessage(err) });
      }
      await writeAtomic(path.join(this.dir, `${file}.txt`), text, path.dirname(this.dir));
      index[file] = hash;
      dirty = true;
    }
    if (dirty) await writeJson(indexFile, index);
  }
}
