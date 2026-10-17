// Paths and configuration.
//
// ROOT is the one location setting: canvases live in ROOT/data/<slug>, each
// agent provider's isolated home in ROOT/.agents/<provider>. The app itself is
// the checkout this code runs from, or wherever THINK_APP_DIR says (the Docker
// image: /opt/think).
//
// Config files and prompt templates ship with the app (app/config, app/prompts).
// Files in ROOT/config and ROOT/prompts override them — file by file, and for
// think.json and providers.json key by key — so a pulled image can be tuned
// without rebuilding it. All are re-read when they change on disk.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./fsutil.js";

export interface Paths {
  root: string;
  appDir: string;
  dataDir: string;
  agentsDir: string;
  /** Requests from outside agents (the `think` command); mounted into the server only. */
  guestsDir: string;
  configDir: string;
  promptsDir: string;
  /** Overrides for configDir / promptsDir, kept with the data (ROOT/config, ROOT/prompts). */
  userConfigDir: string;
  userPromptsDir: string;
  /** Built client (production). */
  clientDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = path.resolve(env.THINK_ROOT ?? "/projects");
  const appDir = path.resolve(env.THINK_APP_DIR ?? packageDir());
  return {
    root,
    appDir,
    dataDir: path.join(root, "data"),
    agentsDir: path.join(root, ".agents"),
    guestsDir: path.resolve(env.THINK_GUESTS_DIR ?? path.join(root, "guests")),
    configDir: path.join(appDir, "config"),
    promptsDir: path.join(appDir, "prompts"),
    userConfigDir: path.join(root, "config"),
    userPromptsDir: path.join(root, "prompts"),
    clientDir: path.resolve(env.THINK_CLIENT_DIR ?? path.join(appDir, "dist", "client")),
  };
}

/** The folder holding the package.json of the running code: the checkout (from src/ or dist/). */
function packageDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export interface ThinkConfig {
  gridSize: number;
  htmlLiveZoom: number;
  validationMaxAttempts: number;
  /** A new (or newly upgraded) canvas's autosave setting; each canvas keeps its own in think.json. */
  defaultAutosaveSeconds: number;
  agentIdleShutdownSeconds: number;
  defaultProvider: string;
  /** Create the welcome canvas (the app's examples/welcome) on a first start with no canvases. */
  welcomeCanvas: boolean;
  /** Optional Cloudflare Access JWT check (defence in depth). */
  cfAccess: { teamDomain: string; audience: string } | null;
}

export interface ProviderConfig {
  id: string;
  label: string;
  /** Command that starts the provider's ACP agent over stdio. */
  command: string;
  args: string[];
  /** Extra environment for the agent (and its login terminal). */
  env: Record<string, string>;
  /**
   * "login": credentials come from logging in inside the provider's isolated
   * home (ROOT/.agents/<id>/home). "api-key": the key named by `apiKeyEnv` is
   * passed from the server's own environment instead.
   */
  auth: "login" | "api-key";
  apiKeyEnv?: string;
  /** ACP session mode applied after a session starts, if the agent offers it. */
  permissionMode?: string;
  /** Instructions file the agent reads in its working directory. */
  instructionsFile: string;
  /** Template in prompts/ rendered into that file on project open. */
  instructionsTemplate: string;
  /** `_meta` sent with session/new, session/resume and session/load. */
  sessionMeta?: Record<string, unknown>;
  /**
   * Path (relative to the provider home) whose existence means "logged in".
   * Only ever checked for existence — never read — to show login state in Settings.
   */
  credentialsFile?: string;
  /** A local command that prints plan usage (claude-agent-acp: "/usage"). Optional. */
  usageCommand?: string;
  /**
   * Which of the agent's slash commands the chat offers (names without the
   * slash). Coding agents offer dozens meant for software projects; a canvas
   * needs a few. Omitted: all of them, minus `hiddenCommands`. A command not
   * offered is sent as ordinary text, so the agent never runs it.
   */
  commands?: string[];
  hiddenCommands: string[];
  /**
   * Login methods of the provider's own, run in the browser login terminal —
   * for agents whose built-in methods need a browser on the same machine (e.g.
   * Codex: its CLI's device-code sign-in). Listed before the agent's own.
   */
  loginMethods: { id: string; name: string; description?: string; command: string; args: string[]; env?: Record<string, string> }[];
  /** The agent's own auth methods not to offer (ones that cannot work in a container). */
  hiddenAuthMethods: string[];
  /** In "api-key" mode: the agent's auth method to call with the key set (when the agent wants one chosen). */
  apiKeyMethod?: string;
}

const CONFIG_DEFAULTS: ThinkConfig = {
  gridSize: 20,
  htmlLiveZoom: 0.45,
  validationMaxAttempts: 2,
  defaultAutosaveSeconds: 60,
  agentIdleShutdownSeconds: 60,
  defaultProvider: "claude-code",
  welcomeCanvas: true,
  cfAccess: null,
};

interface Cached<T> {
  mtimeMs: number;
  value: T;
}

/**
 * Reads files (the app's, then the user's override — whichever exist) through
 * a cache keyed on their mtimes; `parse` gets the texts in that order.
 */
function cachedRead<T>(cache: Map<string, Cached<T>>, files: string[], parse: (texts: string[]) => T, fallback: () => T): T {
  const found: { file: string; mtimeMs: number }[] = [];
  for (const file of files) {
    try {
      found.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* not there: fine */
    }
  }
  if (!found.length) return fallback();
  const key = files.join("\0");
  const stamp = found.map((f) => `${f.file}@${f.mtimeMs}`).join("|");
  const hit = cache.get(key) as (Cached<T> & { stamp?: string }) | undefined;
  if (hit && hit.stamp === stamp) return hit.value;
  const value = parse(found.map((f) => fs.readFileSync(f.file, "utf8")));
  cache.set(key, { mtimeMs: 0, value, stamp } as Cached<T>);
  return value;
}

/** `over` on top of `base`, recursively for plain objects; `null` in `over` removes a key. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

const mergeJson = (texts: string[]) => JSON.stringify(texts.map((t) => JSON.parse(t) as Record<string, unknown>).reduce(deepMerge));

export class ConfigStore {
  private configCache = new Map<string, Cached<ThinkConfig>>();
  private providerCache = new Map<string, Cached<Record<string, ProviderConfig>>>();
  private namesCache = new Map<string, Cached<string[]>>();

  constructor(readonly paths: Paths) {}

  private files(name: string): string[] {
    return [path.join(this.paths.configDir, name), path.join(this.paths.userConfigDir, name)];
  }

  get(): ThinkConfig {
    return cachedRead(this.configCache, this.files("think.json"), (texts) => parseThinkConfig(mergeJson(texts)), () => ({
      ...CONFIG_DEFAULTS,
    }));
  }

  /** The providers: the app's, with ROOT/config/providers.json merged over them (null removes one). */
  providers(): Record<string, ProviderConfig> {
    return cachedRead(this.providerCache, this.files("providers.json"), (texts) => parseProviders(mergeJson(texts), this.paths), () => ({}));
  }

  provider(id: string): ProviderConfig | undefined {
    return this.providers()[id];
  }

  /**
   * Switch a provider between its own sign-in and the API key from the server's
   * environment (Settings, or the chat's login card): writes its `auth` into
   * ROOT/config/providers.json — the same override a person could write by
   * hand; everything else in that file is kept.
   */
  async setProviderAuth(id: string, auth: "login" | "api-key"): Promise<void> {
    const dir = this.paths.userConfigDir;
    const file = path.join(dir, "providers.json");
    let raw: Record<string, unknown> = { format: CONFIG_FORMAT };
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      /* no overrides yet */
    }
    if (text !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* reported below */
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config/providers.json in the data folder is not valid JSON — fix or remove it first.");
      }
      raw = parsed as Record<string, unknown>;
    }
    const entry = raw[id];
    raw[id] = { ...(entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}), auth };
    fs.mkdirSync(dir, { recursive: true });
    await writeAtomic(file, JSON.stringify(raw, null, 2) + "\n", dir);
  }

  /** The block-name pool, in order (config/names.txt, one name per line). */
  namePool(): string[] {
    return cachedRead(this.namesCache, this.files("names.txt"), (texts) => parseNamePool(texts[texts.length - 1]), () => []);
  }
}

/** The config format this build reads; files carry it as "format" (additive changes keep it). */
export const CONFIG_FORMAT = 1;

function checkFormat(raw: Record<string, any>, file: string): void {
  if (typeof raw.format === "number" && raw.format > CONFIG_FORMAT) {
    console.warn(`${file} is in config format ${raw.format}; this think reads format ${CONFIG_FORMAT} — some settings may be ignored.`);
  }
}

export function parseThinkConfig(text: string): ThinkConfig {
  const raw = JSON.parse(text) as Record<string, any>;
  checkFormat(raw, "think.json");
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const cf = raw.cfAccess;
  return {
    gridSize: Math.max(5, num(raw.gridSize, CONFIG_DEFAULTS.gridSize)),
    htmlLiveZoom: num(raw.html?.liveZoomThreshold, CONFIG_DEFAULTS.htmlLiveZoom),
    validationMaxAttempts: Math.max(0, num(raw.validation?.maxAttempts, CONFIG_DEFAULTS.validationMaxAttempts)),
    defaultAutosaveSeconds: Math.min(86400, Math.max(0, Math.round(num(raw.git?.defaultAutosaveSeconds, CONFIG_DEFAULTS.defaultAutosaveSeconds)))),
    agentIdleShutdownSeconds: Math.max(0, num(raw.agent?.idleShutdownSeconds, CONFIG_DEFAULTS.agentIdleShutdownSeconds)),
    defaultProvider: typeof raw.agent?.defaultProvider === "string" ? raw.agent.defaultProvider : CONFIG_DEFAULTS.defaultProvider,
    welcomeCanvas: typeof raw.welcomeCanvas === "boolean" ? raw.welcomeCanvas : CONFIG_DEFAULTS.welcomeCanvas,
    cfAccess:
      cf && typeof cf.teamDomain === "string" && cf.teamDomain && typeof cf.audience === "string" && cf.audience
        ? { teamDomain: cf.teamDomain, audience: cf.audience }
        : null,
  };
}

/** `{{app_dir}}` in a provider's command/args expands to the app directory. */
function expand(s: string, paths: Paths): string {
  return s.replaceAll("{{app_dir}}", paths.appDir);
}

export function parseProviders(text: string, paths: Paths): Record<string, ProviderConfig> {
  const raw = JSON.parse(text) as Record<string, any>;
  checkFormat(raw, "providers.json");
  const out: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(raw)) {
    if (id.startsWith("//") || id === "format" || typeof p !== "object" || p === null) continue;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`providers.json: invalid provider id "${id}"`);
    if (typeof p.command !== "string") throw new Error(`providers.json: provider "${id}" needs a command`);
    out[id] = {
      id,
      label: typeof p.label === "string" ? p.label : id,
      command: expand(p.command, paths),
      args: Array.isArray(p.args) ? p.args.map((a: unknown) => expand(String(a), paths)) : [],
      env: typeof p.env === "object" && p.env ? Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, String(v)])) : {},
      auth: p.auth === "api-key" ? "api-key" : "login",
      apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : undefined,
      permissionMode: typeof p.permissionMode === "string" ? p.permissionMode : undefined,
      instructionsFile: typeof p.instructionsFile === "string" ? p.instructionsFile : "AGENTS.md",
      instructionsTemplate: typeof p.instructionsTemplate === "string" ? p.instructionsTemplate : "project-agents.md",
      sessionMeta: typeof p.sessionMeta === "object" && p.sessionMeta ? p.sessionMeta : undefined,
      credentialsFile: typeof p.credentialsFile === "string" ? p.credentialsFile : undefined,
      usageCommand: typeof p.usageCommand === "string" ? p.usageCommand : undefined,
      commands: Array.isArray(p.commands) ? p.commands.map((c: unknown) => String(c).replace(/^\//, "")) : undefined,
      hiddenCommands: Array.isArray(p.hiddenCommands) ? p.hiddenCommands.map((c: unknown) => String(c).replace(/^\//, "")) : [],
      loginMethods: Array.isArray(p.loginMethods)
        ? p.loginMethods
            .filter((m: any) => m && typeof m.id === "string" && typeof m.command === "string")
            .map((m: any) => ({
              id: `think:${m.id}`,
              name: typeof m.name === "string" ? m.name : m.id,
              description: typeof m.description === "string" ? m.description : undefined,
              command: expand(m.command, paths),
              args: Array.isArray(m.args) ? m.args.map((a: unknown) => expand(String(a), paths)) : [],
              env: typeof m.env === "object" && m.env ? Object.fromEntries(Object.entries(m.env).map(([k, v]) => [k, String(v)])) : undefined,
            }))
        : [],
      hiddenAuthMethods: Array.isArray(p.hiddenAuthMethods) ? p.hiddenAuthMethods.map(String) : [],
      apiKeyMethod: typeof p.apiKeyMethod === "string" ? p.apiKeyMethod : undefined,
    };
  }
  return out;
}

export function parseNamePool(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
}
