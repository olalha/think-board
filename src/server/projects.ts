// Project folders: listing and creation.
//
// A project is ROOT/data/<slug>/, its own git repository. Its name and
// settings are in the committed think.json (see think-file.ts); app-private
// state lives in its .think/ folder, which — like the generated instructions
// file — is git-ignored.

import fs from "node:fs/promises";
import path from "node:path";
import { parseBlockFile } from "../shared/blocks.js";
import { emptyCanvas, serializeCanvas } from "../shared/canvas.js";
import type { ConfigStore, Paths } from "./config.js";
import { exists, readJson, writeAtomic, writeJson } from "./fsutil.js";
import { commitAll, commitPaths, head, initRepo, showFile } from "./git.js";
import { migrate } from "./migrations.js";
import { CANVAS_FORMAT, NewerFormatError, parseThinkFile, readThinkFile, serializeThinkFile, THINK_FILE, type ThinkFile } from "./think-file.js";

/** Lines every canvas's .gitignore carries (app state, generated instructions). */
const GITIGNORE = [".think/", "AGENTS.md", "CLAUDE.md"];
const WELCOME_NAME = "Welcome to think";
const COMMENTS_TEMPLATE = "comments.json";

/**
 * Installed as .git/hooks/pre-commit in every canvas: scratch files over 5 MB
 * in work/ are left out of git (and remembered in .git/info/exclude), so an
 * agent's `git add -A` never drags a large download into the history.
 */
export const PRE_COMMIT_HOOK = `#!/bin/sh
# think: keep scratch files over 5 MB (in work/) out of git.
git diff --cached --name-only --diff-filter=AM -- work/ | while IFS= read -r f; do
  size=$(git cat-file -s ":$f" 2>/dev/null || echo 0)
  if [ "$size" -gt 5242880 ]; then
    git rm -q --cached -- "$f"
    printf '/%s\\n' "$f" >> "$(git rev-parse --git-dir)/info/exclude"
    echo "think: left $f out of git (larger than 5 MB)" >&2
  fi
done
exit 0
`;

export const README_PLACEHOLDER = "_What is this canvas about? Describe it here — or ask the agent to write it._";

export function readmeFor(name: string, description?: string): string {
  return `# ${name}\n\n${description?.trim() || README_PLACEHOLDER}\n`;
}

/** The README's first paragraph (not the title), for the project list. */
export function readmeDescription(text: string): string {
  const para = text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && p !== README_PLACEHOLDER);
  if (!para) return "";
  const plain = para.replace(/[*_`>#]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return plain.length > 220 ? plain.slice(0, 217).trimEnd() + "…" : plain;
}

export type ProjectMeta = ThinkFile;

export interface ProjectState {
  /** HEAD recorded at the end of the agent's last turn (or at creation). */
  lastAgentHead: string | null;
  /** Set while a turn runs; still set on startup means the server died mid-turn. */
  turnInProgress: boolean;
  /** ACP session to resume. */
  sessionId: string | null;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  provider: string;
  blocks: number;
  updatedAt: string | null;
  /** First paragraph of the canvas's README. */
  description: string;
  /** Set when this build cannot open the canvas (e.g. a newer format). */
  problem?: string;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export class UserError extends Error {}

export class ProjectStore {
  constructor(
    readonly paths: Paths,
    readonly config: ConfigStore,
  ) {}

  dir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new UserError(`invalid project slug "${slug}"`);
    return path.join(this.paths.dataDir, slug);
  }

  thinkDir(slug: string): string {
    return path.join(this.dir(slug), ".think");
  }

  async exists(slug: string): Promise<boolean> {
    return SLUG_RE.test(slug) && exists(path.join(this.dir(slug), ".git"));
  }

  /** Settings a canvas gets when its think.json does not say. */
  defaultSettings(): ThinkFile["settings"] {
    return { autosaveSeconds: this.config.get().defaultAutosaveSeconds };
  }

  /**
   * The canvas's think.json. Before its first open by this version (format
   * 1, no think.json yet) the old .think/project.json stands in. A broken
   * think.json falls back to its last committed version (the runtime then
   * writes that back).
   */
  async meta(slug: string): Promise<ProjectMeta> {
    const r = await readThinkFile(this.dir(slug), this.defaultSettings());
    if (r.ok) return r.file;
    if (!("missing" in r)) {
      const committed = await showFile(this.dir(slug), "HEAD", THINK_FILE).catch(() => null);
      const c = committed ? parseThinkFile(committed.toString("utf8"), this.defaultSettings()) : null;
      if (c?.ok) return c.file;
    }
    const old = await readJson<Partial<ProjectMeta>>(path.join(this.thinkDir(slug), "project.json"), {});
    return {
      format: 1,
      name: old.name ?? slug,
      provider: old.provider ?? this.config.get().defaultProvider,
      createdAt: old.createdAt ?? "",
      settings: this.defaultSettings(),
    };
  }

  /** Write think.json and commit it (only it) as the app. Callers serialise. */
  async writeMeta(slug: string, meta: ProjectMeta, message: string): Promise<void> {
    const dir = this.dir(slug);
    await writeAtomic(path.join(dir, THINK_FILE), serializeThinkFile(meta), this.thinkDir(slug));
    await commitPaths(dir, [THINK_FILE], { message });
  }

  /** Rename a canvas that is not open (an open one renames through its runtime). */
  async rename(slug: string, name: string): Promise<void> {
    if (!(await this.exists(slug))) throw new UserError(`There is no project "${slug}".`);
    await this.migrate(slug);
    const meta = await this.meta(slug);
    if (meta.name === name) return;
    await this.writeMeta(slug, { ...meta, name }, `think: renamed the canvas to “${name}”`);
  }

  async readState(slug: string): Promise<ProjectState> {
    const s = await readJson<Partial<ProjectState>>(path.join(this.thinkDir(slug), "state.json"), {});
    return { lastAgentHead: s.lastAgentHead ?? null, turnInProgress: s.turnInProgress ?? false, sessionId: s.sessionId ?? null };
  }

  async writeState(slug: string, state: ProjectState): Promise<void> {
    await writeJson(path.join(this.thinkDir(slug), "state.json"), state);
  }

  async list(): Promise<ProjectSummary[]> {
    await fs.mkdir(this.paths.dataDir, { recursive: true });
    const entries = await fs.readdir(this.paths.dataDir, { withFileTypes: true });
    const out: ProjectSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      if (!(await exists(path.join(this.paths.dataDir, e.name, ".git")))) continue;
      const meta = await this.meta(e.name);
      const problem = meta.format > CANVAS_FORMAT ? new NewerFormatError(meta.format).message : undefined;
      const files = await fs.readdir(path.join(this.paths.dataDir, e.name));
      let updatedAt: string | null = null;
      try {
        updatedAt = (await fs.stat(path.join(this.paths.dataDir, e.name, "canvas.json"))).mtime.toISOString();
      } catch {
        /* no canvas yet */
      }
      let description = "";
      try {
        description = readmeDescription(await fs.readFile(path.join(this.paths.dataDir, e.name, "README.md"), "utf8"));
      } catch {
        /* no README yet */
      }
      out.push({
        slug: e.name,
        name: meta.name,
        provider: meta.provider,
        blocks: files.filter((f) => parseBlockFile(f)).length,
        updatedAt,
        description,
        ...(problem ? { problem } : {}),
      });
    }
    out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return out;
  }

  /**
   * Folder, git init, empty canvas.json, .gitignore, initial commit. With a
   * template folder, its files (blocks, canvas.json, comments.json, README.md)
   * are copied in first, so they are part of that commit.
   */
  async create(name: string, providerId: string, description?: string, template?: string): Promise<ProjectMeta & { slug: string }> {
    const trimmed = name.trim().slice(0, 100);
    const slug = slugify(trimmed);
    if (!slug) throw new UserError("Give the project a name containing letters or digits.");
    const provider = this.config.provider(providerId);
    if (!provider) throw new UserError(`Unknown agent provider "${providerId}".`);
    const dir = this.dir(slug);
    await fs.mkdir(this.paths.dataDir, { recursive: true });
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new UserError(`A project called "${slug}" already exists.`);
      throw err;
    }
    await initRepo(dir);
    const ignored = new Set([...GITIGNORE, provider.instructionsFile]);
    await fs.writeFile(path.join(dir, ".gitignore"), [...ignored].join("\n") + "\n");
    await fs.writeFile(path.join(dir, "canvas.json"), serializeCanvas(emptyCanvas()));
    await fs.writeFile(path.join(dir, "README.md"), readmeFor(trimmed, typeof description === "string" ? description.slice(0, 2000) : undefined));
    await fs.mkdir(path.join(dir, "work"), { recursive: true });
    if (template) await copyTemplate(template, dir);
    await installHooks(dir);
    const meta: ProjectMeta = { format: CANVAS_FORMAT, name: trimmed, provider: provider.id, createdAt: new Date().toISOString(), settings: this.defaultSettings() };
    await fs.writeFile(path.join(dir, THINK_FILE), serializeThinkFile(meta));
    await fs.mkdir(this.thinkDir(slug), { recursive: true });
    await commitAll(dir, { message: `init: create project "${trimmed}"` });
    await this.writeState(slug, { lastAgentHead: await head(dir), turnInProgress: false, sessionId: null });
    return { slug, ...meta };
  }

  /**
   * The welcome canvas, made once from the app's examples/welcome on a first
   * start: when there are no canvases yet and `welcomeCanvas` is on. A marker,
   * data/.welcomed, records that the question was settled, so deleting every
   * canvas later does not bring it back. Returns its slug, or null.
   */
  async ensureWelcome(): Promise<string | null> {
    const marker = path.join(this.paths.dataDir, ".welcomed");
    if (await exists(marker)) return null;
    const template = path.join(this.paths.appDir, "examples", "welcome");
    let slug: string | null = null;
    if ((await this.list()).length === 0 && this.config.get().welcomeCanvas && (await exists(template))) {
      slug = (await this.create(WELCOME_NAME, this.config.get().defaultProvider, undefined, template)).slug;
    }
    await fs.writeFile(marker, "");
    return slug;
  }

  /**
   * Bring a canvas made by an older version up to date, on every open: the
   * format migrations (migrations.ts), then the idempotent basics — .gitignore
   * lines, a README, work/, the pre-commit hook. Commits what it changed, as
   * the app. Throws NewerFormatError for a canvas this build cannot read.
   */
  async migrate(slug: string): Promise<void> {
    const dir = this.dir(slug);
    const r = await readThinkFile(dir, this.defaultSettings());
    const format = r.ok ? r.file.format : "missing" in r ? 1 : CANVAS_FORMAT;
    if (format > CANVAS_FORMAT) throw new NewerFormatError(format);
    const touched: string[] = [];
    if (format < CANVAS_FORMAT) {
      touched.push(...(await migrate({ dir, thinkDir: this.thinkDir(slug), slug, defaults: { provider: this.config.get().defaultProvider, settings: this.defaultSettings() } }, format)));
    }

    const gi = path.join(dir, ".gitignore");
    let current = "";
    try {
      current = await fs.readFile(gi, "utf8");
    } catch {
      /* none */
    }
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE.filter((l) => !have.has(l));
    if (missing.length) {
      await fs.writeFile(gi, (current && !current.endsWith("\n") ? current + "\n" : current) + missing.join("\n") + "\n");
      touched.push(".gitignore");
    }
    const readme = path.join(dir, "README.md");
    if (!(await exists(readme))) {
      await fs.writeFile(readme, readmeFor((await this.meta(slug)).name));
      touched.push("README.md");
    }
    await fs.mkdir(path.join(dir, "work"), { recursive: true });
    await installHooks(dir);
    if (touched.length) {
      const message = format < CANVAS_FORMAT ? `think: upgraded the canvas to format ${CANVAS_FORMAT}` : "think: add README.md and update .gitignore";
      await commitPaths(dir, touched, { message });
    }
  }
}

/** A template canvas's files into a new canvas; its comments are dated now, like ones written in the app. */
async function copyTemplate(template: string, dir: string): Promise<void> {
  const now = new Date().toISOString();
  for (const f of await fs.readdir(template)) {
    if (f === COMMENTS_TEMPLATE) {
      const file = await readJson<{ comments?: { at?: string }[] }>(path.join(template, f), {});
      for (const c of file.comments ?? []) c.at = now;
      await writeJson(path.join(dir, f), file);
    } else {
      await fs.copyFile(path.join(template, f), path.join(dir, f));
    }
  }
}

async function installHooks(dir: string): Promise<void> {
  const hooks = path.join(dir, ".git", "hooks");
  await fs.mkdir(hooks, { recursive: true });
  const file = path.join(hooks, "pre-commit");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    /* none */
  }
  if (current !== PRE_COMMIT_HOOK) await fs.writeFile(file, PRE_COMMIT_HOOK, { mode: 0o755 });
}
