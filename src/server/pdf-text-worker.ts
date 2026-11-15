// Reads the text of one PDF with pdf.js, in a worker thread (see
// extractPdfText in pdf-text.ts), then exits. Self-contained on purpose: it
// imports only packages, so it runs as plain TypeScript in development too.

import { createRequire } from "node:module";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/** Extracted text larger than this is cut: an agent reading it wants the gist, not 50 MB. */
const MAX_CHARS = 2_000_000;

// pdf.js's own data, read from the installed package (never fetched): character
// maps for CJK and other CID-keyed fonts, and the 14 standard fonts' metrics.
const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

async function extract(data: Uint8Array): Promise<{ text: string; pages: number }> {
  const { getDocument, VerbosityLevel } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data,
    cMapUrl: path.join(PDFJS_DIR, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(PDFJS_DIR, "standard_fonts") + path.sep,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const doc = await task.promise;
  const parts: string[] = [];
  let length = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
    }
    page.cleanup();
    const section = `--- Page ${i} ---\n${text.replace(/[ \t]+\n/g, "\n").trim()}\n`;
    parts.push(section);
    length += section.length;
    if (length > MAX_CHARS && i < doc.numPages) {
      parts.push(`(The text stops here, at page ${i} of ${doc.numPages}: the rest is too long to include. Read the PDF itself for more.)\n`);
      break;
    }
  }
  const pages = doc.numPages;
  await task.destroy();
  let text = parts.join("\n");
  if (!text.replace(/--- Page \d+ ---/g, "").trim()) {
    text += "\n(No text found: this PDF is probably scanned images. Read the PDF itself if you can.)\n";
  }
  return { text, pages };
}

extract(new Uint8Array((workerData as { data: Uint8Array }).data)).then(
  (r) => parentPort!.postMessage(r),
  (err: unknown) => parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) }),
);
