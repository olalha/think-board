// Outside agents ("guests"): any agent on the machine can work on a canvas —
// it is a folder of files — and the `think` command (bin/think) lets it do so
// as a first-class participant: join the canvas (a tab in its chat), take the
// lock, change the layout with the same commands the canvas's own agent uses,
// post in its tab, and leave — think commits its edits under its name.
//
// The command talks to the server through files in ROOT/guests/ (see
// requests.ts), a folder mounted into the server's container only — never
// the agents' container. A request:
//   {"op": "<command>", "canvas": "<slug>"?, "as": "<name>", "args": […], "opts": {…}}
//   {"op": "create", "name": "<canvas name>", "description": "…", "as": "<name>"}
// Without "canvas", the canvas is the one the named agent has joined.

import fs from "node:fs/promises";
import path from "node:path";
import type { ConfigStore, Paths } from "./config.js";
import { CANVAS_COMMANDS, toCommandRequest } from "./commands.js";
import { guestNameProblem, readRoster } from "./guest-room.js";
import type { ProjectManager } from "./manager.js";
import { SLUG_RE, type ProjectStore } from "./projects.js";
import { RequestDir } from "./requests.js";
import type { Logger } from "./util.js";

interface GuestRequest {
  op: string;
  canvas?: string;
  as?: string;
  args?: string[];
  opts?: Record<string, string | boolean>;
  n?: number;
  name?: string;
  description?: string;
}

type Reply = { ok: boolean; message: string };

/** Commands that need no name (anyone on the machine may look). */
const ANONYMOUS = new Set(["ping", "create", "status", "url", "chat"]);

export class GuestBridge {
  private requests: RequestDir | null = null;

  constructor(
    private readonly paths: Paths,
    private readonly store: ProjectStore,
    private readonly manager: ProjectManager,
    private readonly config: ConfigStore,
    private readonly log: Logger,
    /** The app's address as people open it (THINK_PUBLIC_URL), for links; "" when unknown. */
    private readonly publicUrl = "",
  ) {}

  /** The link to a canvas, or null when the app's address is not configured. */
  private link(slug: string): string | null {
    return this.publicUrl ? `${this.publicUrl.replace(/\/+$/, "")}/p/${slug}` : null;
  }

  async start(): Promise<void> {
    // Requests left from before a restart get answered too.
    this.requests = new RequestDir(this.paths.guestsDir, (req) => this.run(req as GuestRequest), this.log);
    await this.requests.start();
  }

  async stop(): Promise<void> {
    await this.requests?.stop();
  }

  private async run(req: GuestRequest): Promise<Reply> {
    if (!req || typeof req.op !== "string") return { ok: false, message: "That request is not one the think command sends (is it up to date?)." };
    const as = typeof req.as === "string" ? req.as.trim() : "";
    if (req.op === "ping") return { ok: true, message: "think is running." };
    if (!ANONYMOUS.has(req.op) || as) {
      const problem = guestNameProblem(as);
      if (problem) return { ok: false, message: problem };
    }
    if (req.op === "create") {
      if (typeof req.name !== "string" || !req.name.trim()) return { ok: false, message: "A canvas needs a name." };
      const meta = await this.store.create(req.name, this.config.get().defaultProvider, typeof req.description === "string" ? req.description : undefined);
      this.log.info("guest created a canvas", { canvas: meta.slug, by: as || "someone" });
      return { ok: true, message: `${meta.slug}\n${this.link(meta.slug) ?? ""}` };
    }

    // Which canvas: the one named, else the one this agent has joined.
    let slug = typeof req.canvas === "string" ? req.canvas.trim() : "";
    if (slug) {
      if (!SLUG_RE.test(slug) || !(await this.store.exists(slug))) return { ok: false, message: `There is no canvas "${slug}". Run: think list` };
    } else {
      if (!as || req.op === "join") return { ok: false, message: "Which canvas? (think list)" };
      const found = await this.joinedCanvases(as);
      if (found.joined.length > 1) return { ok: false, message: `You (${as}) are on ${found.joined.length} canvases (${found.joined.join(", ")}) — add --canvas <name>.` };
      if (found.joined.length === 1) slug = found.joined[0];
      else if (found.notice) slug = found.notice;
      else return { ok: false, message: `You (${as}) have not joined a canvas. Start with: think join <canvas> --as ${as}   (think list shows them)` };
    }
    this.log.info("guest request", { op: req.op, canvas: slug, by: as || "someone" });

    // Disconnected by the user: told once, on the next call (a join goes through, saying so).
    if (as && req.op !== "join" && !ANONYMOUS.has(req.op)) {
      const rt = this.manager.peek(slug) ?? ((await this.hasNotice(slug, as)) ? await this.manager.get(slug) : undefined);
      const notice = rt ? await rt.guestNotice(as) : null;
      if (notice) return { ok: false, message: notice };
    }

    try {
      return await this.dispatch(req, slug, as);
    } finally {
      // A canvas opened only for this request closes again after the idle grace period.
      this.manager.peek(slug)?.idleCheck();
    }
  }

  private async dispatch(req: GuestRequest, slug: string, as: string): Promise<Reply> {
    const text = (i: number) => (Array.isArray(req.args) && typeof req.args[i] === "string" ? req.args[i] : "");
    const opt = (k: string) => (req.opts && typeof req.opts[k] === "string" ? (req.opts[k] as string) : undefined);
    switch (req.op) {
      case "join":
        return (await this.manager.get(slug)).guestJoin(as, opt("about"), text(0));
      case "lock":
        return (await this.manager.get(slug)).guestLock(as, text(0).slice(0, 300), opt("about"));
      case "unlock": {
        const rt = this.manager.peek(slug);
        if (!rt) return { ok: true, message: "You did not hold the lock (it lapsed, the user took over, or think restarted) — anything you changed was committed then." };
        return rt.guestUnlock(as, text(0), "done");
      }
      case "leave":
        return (await this.manager.get(slug)).guestLeave(as, text(0));
      case "say":
        if (!text(0).trim()) return { ok: false, message: "Nothing to say." };
        return (await this.manager.get(slug)).guestSay(as, text(0));
      case "status": {
        const rt = this.manager.peek(slug);
        return { ok: true, message: rt ? rt.guestStatus() : `canvas: ${slug}\nnot open (no tab, no agent) — lock: free` };
      }
      case "url": {
        const url = this.link(slug);
        return url ? { ok: true, message: url } : { ok: false, message: `The app's address is not configured (THINK_PUBLIC_URL), so there is no link. The canvas is at /p/${slug} on it.` };
      }
      case "chat":
        return { ok: true, message: (await this.manager.get(slug)).chatText(Math.max(1, Math.min(200, Number(req.n) || 20))) || "(no messages yet)" };
      default: {
        if (!CANVAS_COMMANDS.has(req.op)) return { ok: false, message: `Unknown command “${req.op}” (think help).` };
        const cmd = toCommandRequest(req);
        if (!cmd) return { ok: false, message: "That request is not one the think command sends (is it up to date?)." };
        return (await this.manager.get(slug)).command({ kind: "guest", name: as }, cmd);
      }
    }
  }

  /** The canvases an outside agent has joined — and one whose user disconnected it and has not told it yet. */
  private async joinedCanvases(name: string): Promise<{ joined: string[]; notice: string | null }> {
    const joined: string[] = [];
    let notice: string | null = null;
    for (const p of await this.store.list()) {
      const open = this.manager.peek(p.slug);
      if (open) {
        if (open.isGuestJoined(name)) joined.push(p.slug);
        continue;
      }
      const g = (await readRoster(this.store.thinkDir(p.slug))).find((x) => x.name === name);
      if (g?.state === "joined") joined.push(p.slug);
      else if (g?.notice) notice ??= p.slug;
    }
    if (!joined.length && !notice) {
      // An open canvas's roster is authoritative, but it may hold the notice.
      for (const slug of this.manager.openSlugs()) if (await this.hasNotice(slug, name)) notice ??= slug;
    }
    return { joined, notice };
  }

  private async hasNotice(slug: string, name: string): Promise<boolean> {
    return (await readRoster(this.store.thinkDir(slug))).some((g) => g.name === name && g.notice);
  }
}

/**
 * Versions up to 0.6 copied the `think` command into ROOT/cli for the host to
 * run. The app's container can write the data folder, so a host running a
 * script from it runs whatever the container put there: remove that copy (only
 * the files think wrote) and say how to install the command instead.
 * Returns true when there was one.
 */
export async function retireCli(paths: Paths): Promise<boolean> {
  const cli = path.join(paths.root, "cli");
  const files = [path.join(cli, "bin", "think"), path.join(cli, "skills", "think-canvas", "SKILL.md")];
  let found = false;
  for (const file of files) {
    if (await fs.rm(file).then(() => true, () => false)) found = true;
  }
  // Then the folders, innermost first, if nothing else is in them.
  for (const dir of [path.join(cli, "bin"), path.join(cli, "skills", "think-canvas"), path.join(cli, "skills"), cli]) {
    await fs.rmdir(dir).catch(() => {});
  }
  return found;
}
