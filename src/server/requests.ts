// A folder that carries requests from the `think` command to the server. The
// command writes req-<id>.json (a temp file, then a rename, so it appears
// whole); the server answers in res-<id>.txt: the first line "ok" or "error",
// then the message for the caller. The command waits for the answer.
//
// Two kinds exist:
//   ROOT/guests/          agents on the machine (outside agents)
//   <canvas>/.think/cli/  that canvas's own agent, while the canvas is open —
//                         the agents' container sees only the canvases, never
//                         ROOT/guests, so a canvas agent cannot act on others.
// Access is whoever can write the folder: no port, no token.

import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { errorMessage, type Logger } from "./util.js";

export type RequestHandler = (req: unknown) => Promise<{ ok: boolean; message: string }>;

const REQ_RE = /^req-[\w.-]+\.json$/;

export class RequestDir {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    readonly dir: string,
    private readonly handler: RequestHandler,
    private readonly log: Logger,
  ) {}

  /** Start answering. Requests already waiting are answered too (`leftovers: false` drops them instead). */
  async start(opts: { leftovers?: boolean } = {}): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const f of await fs.readdir(this.dir)) {
      if (REQ_RE.test(f)) {
        if (opts.leftovers === false) await fs.rm(path.join(this.dir, f), { force: true });
        else void this.handle(path.join(this.dir, f));
      } else if (f.startsWith("res-") || f.startsWith(".req-")) await fs.rm(path.join(this.dir, f), { force: true }).catch(() => {});
    }
    this.watcher = chokidar.watch(this.dir, { depth: 0, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 } });
    this.watcher.on("add", (p) => {
      if (REQ_RE.test(path.basename(p))) void this.handle(p);
    });
    this.watcher.on("error", (err) => this.log.warn("request folder watcher error", { dir: this.dir, error: errorMessage(err) }));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  private async handle(file: string): Promise<void> {
    const id = path.basename(file).replace(/^req-/, "").replace(/\.json$/, "");
    let ok = false;
    let message = "";
    try {
      const text = await fs.readFile(file, "utf8");
      await fs.rm(file, { force: true });
      let req: unknown;
      try {
        req = JSON.parse(text);
      } catch {
        throw new Error("That request is not valid JSON (is the think command up to date?).");
      }
      ({ ok, message } = await this.handler(req));
    } catch (err) {
      await fs.rm(file, { force: true }).catch(() => {});
      message = errorMessage(err);
    }
    const res = path.join(this.dir, `res-${id}.txt`);
    try {
      await fs.writeFile(`${res}.tmp`, `${ok ? "ok" : "error"}\n${message}\n`);
      await fs.rename(`${res}.tmp`, res);
    } catch (err) {
      this.log.warn("could not answer a think request", { dir: this.dir, error: errorMessage(err) });
      return;
    }
    // Answers nobody collected are tidied away.
    const t = setTimeout(() => {
      this.timers.delete(t);
      void fs.rm(res, { force: true }).catch(() => {});
    }, 120_000);
    t.unref();
    this.timers.add(t);
  }
}
