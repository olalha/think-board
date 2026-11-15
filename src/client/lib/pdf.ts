// pdf.js for PDF blocks: loaded on first use (it is large), with its worker
// bundled by Vite from the installed package — never from a CDN. Open
// documents are shared between blocks and kept briefly after the last one
// lets go, so scrolling a PDF block off screen and back doesn't parse it again.
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");

let lib: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  lib ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  // A failed load (offline mid-deploy) may be retried later.
  lib.catch(() => {
    lib = null;
  });
  return lib;
}

interface Entry {
  doc: Promise<PDFDocumentProxy>;
  destroy: () => void;
  users: number;
  lastUsed: number;
}

const docs = new Map<string, Entry>();
/** Documents kept open with no block showing them. */
const KEEP_UNUSED = 4;

function evict(): void {
  const unused = [...docs].filter(([, e]) => e.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [url, e] of unused.slice(0, Math.max(0, unused.length - KEEP_UNUSED))) {
    docs.delete(url);
    e.destroy();
  }
}

/** Open the PDF at `url` (shared); call `release` when done with it. */
export function openPdf(url: string): { doc: Promise<PDFDocumentProxy>; release: () => void } {
  let e = docs.get(url);
  if (!e) {
    let task: { destroy(): Promise<void> } | null = null;
    let dead = false;
    const doc = loadPdfJs().then((pdfjs) => {
      if (dead) throw new Error("closed");
      const t = pdfjs.getDocument({ url, withCredentials: true });
      task = t;
      return t.promise;
    });
    const entry: Entry = {
      doc,
      users: 0,
      lastUsed: Date.now(),
      destroy: () => {
        dead = true;
        void task?.destroy();
      },
    };
    // A failed load is not cached: the next block to ask tries again.
    doc.catch(() => {
      if (docs.get(url) === entry) docs.delete(url);
    });
    docs.set(url, entry);
    e = entry;
  }
  const entry = e;
  entry.users++;
  let released = false;
  return {
    doc: entry.doc,
    release: () => {
      if (released) return;
      released = true;
      entry.users--;
      entry.lastUsed = Date.now();
      evict();
    },
  };
}
