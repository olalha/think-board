// The environment an agent process (and its login terminal) runs with.
//
// Built from an allowlist, never by copying the server's environment: the
// agent sees PATH, a locale, the time zone, and a HOME of its own under ROOT/.agents/<id>/home
// — which is where its CLI keeps its credentials and settings, isolated from
// whatever else runs on the machine. In "api-key" mode the one named key is
// passed through as well. PATH starts with bin/canvas-agent/, which holds only
// the `think` command.

import fs from "node:fs";
import path from "node:path";
import type { Paths, ProviderConfig } from "../config.js";

export function providerHome(paths: Paths, provider: ProviderConfig): string {
  return path.join(paths.agentsDir, provider.id, "home");
}

export function ensureProviderHome(paths: Paths, provider: ProviderConfig): string {
  const home = providerHome(paths, provider);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The parent holds credentials; keep it private even if it pre-existed.
  fs.chmodSync(path.join(paths.agentsDir, provider.id), 0o700);
  return home;
}

export function agentEnv(paths: Paths, provider: ProviderConfig, extra: Record<string, string> = {}): Record<string, string> {
  const home = ensureProviderHome(paths, provider);
  const env: Record<string, string> = {
    PATH: `${path.join(paths.appDir, "bin", "canvas-agent")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    ...provider.env,
    ...extra,
  };
  if (provider.auth === "api-key" && provider.apiKeyEnv) {
    const key = process.env[provider.apiKeyEnv];
    if (key) env[provider.apiKeyEnv] = key;
  }
  return env;
}
