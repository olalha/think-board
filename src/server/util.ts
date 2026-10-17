import { createHash, randomBytes } from "node:crypto";

export function hashOf(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export function newId(prefix = ""): string {
  return prefix + randomBytes(6).toString("hex");
}

/**
 * Runs async jobs one at a time, in submission order. Every mutation of a
 * project (user edits, layout ops, watcher events, turn steps) goes through the
 * project's queue so they can never interleave.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(job, job);
    // Keep the chain alive whatever the job does; callers see its own outcome.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type Logger = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
};

export function consoleLogger(scope: string): Logger {
  const fmt = (level: string, msg: string, extra?: Record<string, unknown>) =>
    `${new Date().toISOString()} ${level} [${scope}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
  return {
    info: (m, e) => console.log(fmt("info", m, e)),
    warn: (m, e) => console.warn(fmt("warn", m, e)),
    error: (m, e) => console.error(fmt("error", m, e)),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
