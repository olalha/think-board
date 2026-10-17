import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** Validates Mermaid source in a long-lived worker (see mermaid-worker.ts). */
export class MermaidValidator {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (error: string | null) => void>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const self = fileURLToPath(import.meta.url);
    // Same extension as this module: .ts under tsx in development, .js when built.
    const file = path.join(path.dirname(self), `mermaid-worker${path.extname(self)}`);
    const worker = new Worker(file);
    worker.unref();
    worker.on("message", (msg: { id: number; error: string | null }) => {
      this.pending.get(msg.id)?.(msg.error);
      this.pending.delete(msg.id);
    });
    const fail = (why: string) => {
      for (const resolve of this.pending.values()) resolve(`Mermaid validator unavailable: ${why}`);
      this.pending.clear();
      this.worker = null;
    };
    worker.on("error", (err) => fail(err.message));
    worker.on("exit", (code) => fail(`worker exited with code ${code}`));
    this.worker = worker;
    return worker;
  }

  /** null when the source parses; otherwise mermaid's error message. */
  validate(source: string): Promise<string | null> {
    const worker = this.ensure();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, source });
    });
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
