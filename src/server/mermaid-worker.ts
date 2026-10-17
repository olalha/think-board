// Mermaid syntax validation, isolated in a worker thread.
//
// mermaid.parse needs a DOM, so this worker installs jsdom globals (window,
// document, …). Doing that in the main server process would make every other
// library think it runs in a browser; in a worker the globals stay contained.
// The mermaid package is the very one the client bundles (one package.json,
// one pinned version), so the server and the browser agree on what parses.

import { parentPort } from "node:worker_threads";
import { JSDOM } from "jsdom";

type Request = { id: number; source: string };
type Response = { id: number; error: string | null; diagramType?: string };

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
for (const k of ["navigator", "Element", "HTMLElement", "SVGElement", "DOMParser", "XMLSerializer", "Node", "getComputedStyle"]) {
  try {
    if (!(k in g)) g[k] = (dom.window as unknown as Record<string, unknown>)[k];
  } catch {
    /* read-only global in this Node version — mermaid.parse does not need it */
  }
}

const ready = import("mermaid").then(({ default: mermaid }) => {
  mermaid.initialize({ startOnLoad: false });
  return mermaid;
});

function clean(message: string): string {
  return message.replace(/\s+$/g, "").slice(0, 2000);
}

parentPort!.on("message", async (req: Request) => {
  const mermaid = await ready;
  let res: Response;
  try {
    if (!req.source.trim()) throw new Error("The diagram is empty.");
    const r = await mermaid.parse(req.source);
    res = { id: req.id, error: null, diagramType: typeof r === "object" && r ? (r as { diagramType?: string }).diagramType : undefined };
  } catch (err) {
    res = { id: req.id, error: clean(err instanceof Error ? err.message : String(err)) };
  }
  parentPort!.postMessage(res);
});
