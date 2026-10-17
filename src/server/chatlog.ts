// A chat transcript, persisted as JSON lines: the canvas agent's chat
// (.think/chat.jsonl) and each outside agent's tab (.think/guests/<name>.jsonl).
//
// Append-only: an entry that changes after it was written (a tool call that
// completes, a permission that gets answered, streamed text that finishes) is
// appended again with the same id, and loading folds later lines into the
// earlier position. Nothing is ever rewritten in place, so a crash can lose at
// most the entry being streamed — never history.

import fs from "node:fs/promises";
import type { ChatEntry } from "../shared/protocol.js";

export class ChatLog<E extends { id: string } = ChatEntry> {
  private entries: E[] = [];
  private index = new Map<string, number>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let text = "";
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.upsertMemory(JSON.parse(line) as E);
      } catch {
        // A torn final line from a crash: skip it.
      }
    }
  }

  all(): E[] {
    return this.entries.slice();
  }

  get(id: string): E | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.entries[i];
  }

  /** Record an entry (new or updated) in memory and on disk. */
  async put(entry: E): Promise<void> {
    this.upsertMemory(entry);
    await fs.appendFile(this.file, JSON.stringify(entry) + "\n");
  }

  /** Update in memory only — for streaming text, persisted later with put(). */
  putMemory(entry: E): void {
    this.upsertMemory(entry);
  }

  private upsertMemory(entry: E): void {
    const i = this.index.get(entry.id);
    if (i === undefined) {
      this.index.set(entry.id, this.entries.length);
      this.entries.push(entry);
    } else {
      this.entries[i] = entry;
    }
  }
}
