// The outside agents on one canvas — the ones that joined with `think join`
// (or took the lock) — and the lines in their tabs.
//
//   .think/guests.json           who joined, what they said they are, who left
//   .think/guests/<name>.jsonl   each one's tab: its messages (`think say`) and
//                                what it did — apart from the canvas agent's
//                                chat, and never shown to the canvas agent
//
// Both live in .think/ (the app's private state, not committed), so a canvas
// copied elsewhere carries no guests.

import fs from "node:fs/promises";
import path from "node:path";
import type { GuestEntry, GuestInfo } from "../shared/protocol.js";
import { ChatLog } from "./chatlog.js";
import { readJson, writeJson } from "./fsutil.js";
import { newId } from "./util.js";

export interface RosterEntry {
  name: string;
  about?: string;
  note?: string;
  state: "joined" | "left";
  joinedAt: number;
  leftAt?: number;
  /** It left because the user disconnected it. */
  disconnected?: boolean;
  /** Disconnected, and not told yet: its next `think` call is. */
  notice?: boolean;
}

interface RosterFile {
  format: 1;
  guests: RosterEntry[];
}

const ROSTER = "guests.json";
/** Names the app itself uses (in History, comments and the chat). */
const RESERVED = new Set(["user", "agent", "think", "you", "app", "guest"]);

/** Why a name cannot be an outside agent's (null: it can). */
export function guestNameProblem(name: string): string | null {
  if (!name) return "Say who you are with --as <name> — the name your user knows you by (your session's name, e.g. planner).";
  if (name.length > 40) return `--as ${name}: at most 40 characters.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `--as ${name}: names are lowercase letters, digits and hyphens${slug ? ` (e.g. ${slug})` : ""}.`;
  }
  if (RESERVED.has(name)) return `--as ${name}: that name is the app's own — use the name your user knows you by (your session's name, e.g. planner).`;
  return null;
}

/** A canvas's roster, read without opening the canvas (for the `think` command's requests). */
export async function readRoster(thinkDir: string): Promise<RosterEntry[]> {
  const f = await readJson<Partial<RosterFile>>(path.join(thinkDir, ROSTER), {});
  return Array.isArray(f.guests) ? f.guests.filter((g) => g && typeof g.name === "string") : [];
}

export class GuestRoom {
  private roster = new Map<string, RosterEntry>();
  private logs = new Map<string, ChatLog<GuestEntry>>();

  constructor(private readonly thinkDir: string) {}

  async load(): Promise<void> {
    this.roster = new Map((await readRoster(this.thinkDir)).map((g) => [g.name, g]));
    for (const name of this.roster.keys()) await this.log(name);
  }

  get(name: string): RosterEntry | undefined {
    return this.roster.get(name);
  }

  isJoined(name: string): boolean {
    return this.roster.get(name)?.state === "joined";
  }

  joined(): string[] {
    return [...this.roster.values()].filter((g) => g.state === "joined").map((g) => g.name);
  }

  /** Join (or come back). Returns whether it was there before, and whether the user had disconnected it. */
  async join(name: string, about?: string, note?: string): Promise<{ already: boolean; wasDisconnected: boolean }> {
    const prev = this.roster.get(name);
    const already = prev?.state === "joined";
    const wasDisconnected = !!prev?.disconnected && prev.state === "left";
    const entry: RosterEntry = {
      name,
      state: "joined",
      joinedAt: already ? prev!.joinedAt : Date.now(),
      ...(about?.trim() ? { about: about.trim().slice(0, 120) } : prev?.about ? { about: prev.about } : {}),
      ...(note?.trim() ? { note: note.trim().slice(0, 300) } : already && prev?.note ? { note: prev.note } : {}),
    };
    this.roster.set(name, entry);
    await this.log(name);
    await this.save();
    return { already, wasDisconnected };
  }

  /** What it said it is doing ("" clears it: the lock ended). */
  async setNote(name: string, note: string): Promise<void> {
    const g = this.roster.get(name);
    if (!g) return;
    if (note.trim()) g.note = note.trim().slice(0, 300);
    else delete g.note;
    await this.save();
  }

  async leave(name: string, disconnected: boolean): Promise<void> {
    const g = this.roster.get(name);
    if (!g) return;
    g.state = "left";
    g.leftAt = Date.now();
    delete g.note;
    if (disconnected) {
      g.disconnected = true;
      g.notice = true;
    } else {
      delete g.disconnected;
      delete g.notice;
    }
    await this.save();
  }

  async clearNotice(name: string): Promise<void> {
    const g = this.roster.get(name);
    if (!g?.notice) return;
    delete g.notice;
    await this.save();
  }

  /** Add a line to an outside agent's tab. */
  async add(name: string, line: { kind: "say"; text: string } | { kind: "activity"; event: Extract<GuestEntry, { kind: "activity" }>["event"]; text: string; rev?: string }): Promise<GuestEntry> {
    const entry = { ...line, id: newId(line.kind === "say" ? "gs-" : "ga-"), ts: Date.now() } as GuestEntry;
    await (await this.log(name)).put(entry);
    return entry;
  }

  info(working: string | null): GuestInfo[] {
    return [...this.roster.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((g) => ({
        name: g.name,
        ...(g.about ? { about: g.about } : {}),
        state: g.state,
        working: g.state === "joined" && g.name === working,
        ...(g.note ? { note: g.note } : {}),
        joinedAt: g.joinedAt,
        ...(g.leftAt ? { leftAt: g.leftAt } : {}),
        ...(g.disconnected ? { disconnected: true } : {}),
      }));
  }

  /** The latest lines of every tab, for a tab that opens the canvas. */
  threads(limit = 200): Record<string, GuestEntry[]> {
    return Object.fromEntries([...this.logs].map(([name, log]) => [name, log.all().slice(-limit)]));
  }

  private async log(name: string): Promise<ChatLog<GuestEntry>> {
    let log = this.logs.get(name);
    if (!log) {
      await fs.mkdir(path.join(this.thinkDir, "guests"), { recursive: true });
      log = new ChatLog<GuestEntry>(path.join(this.thinkDir, "guests", `${name}.jsonl`));
      await log.load();
      this.logs.set(name, log);
    }
    return log;
  }

  private async save(): Promise<void> {
    await writeJson(path.join(this.thinkDir, ROSTER), { format: 1, guests: [...this.roster.values()] } satisfies RosterFile);
  }
}
