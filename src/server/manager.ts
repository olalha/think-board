// Keeps one ProjectRuntime per open project. A runtime starts when the first
// tab opens the project and shuts itself down (agent included) a grace period
// after the last tab leaves, so a page reload does not kill the agent.

import type { LoginManager } from "./agent/login.js";
import type { ConfigStore, Paths } from "./config.js";
import type { MermaidValidator } from "./mermaid.js";
import { UserError, type ProjectStore } from "./projects.js";
import { ProjectRuntime } from "./runtime.js";
import type { Templates } from "./templates.js";
import { consoleLogger, type Logger } from "./util.js";

export interface ManagerDeps {
  paths: Paths;
  store: ProjectStore;
  config: ConfigStore;
  templates: Templates;
  mermaid: MermaidValidator;
  logins: LoginManager;
  logger?: (scope: string) => Logger;
}

export class ProjectManager {
  private runtimes = new Map<string, ProjectRuntime>();
  private opening = new Map<string, Promise<ProjectRuntime>>();

  constructor(private readonly deps: ManagerDeps) {}

  async get(slug: string): Promise<ProjectRuntime> {
    const live = this.runtimes.get(slug);
    if (live) return live;
    const pending = this.opening.get(slug);
    if (pending) return pending;
    const p = (async () => {
      if (!(await this.deps.store.exists(slug))) throw new UserError(`There is no project "${slug}".`);
      const runtime = new ProjectRuntime({
        slug,
        paths: this.deps.paths,
        store: this.deps.store,
        config: this.deps.config,
        templates: this.deps.templates,
        mermaid: this.deps.mermaid,
        logins: this.deps.logins,
        log: (this.deps.logger ?? consoleLogger)(`project:${slug}`),
        onClosed: () => {
          if (this.runtimes.get(slug) === runtime) this.runtimes.delete(slug);
        },
        onProviderLogin: (providerId) => this.onProviderLogin(providerId),
      });
      await runtime.open();
      this.runtimes.set(slug, runtime);
      return runtime;
    })().finally(() => this.opening.delete(slug));
    this.opening.set(slug, p);
    return p;
  }

  /** The runtime if the project is currently open — never opens one. */
  peek(slug: string): ProjectRuntime | undefined {
    return this.runtimes.get(slug);
  }

  openSlugs(): string[] {
    return [...this.runtimes.keys()];
  }

  /** A login finished somewhere: every open project on that provider retries its session. */
  private onProviderLogin(providerId: string): void {
    for (const r of this.runtimes.values()) {
      if (r.providerId === providerId) void r.onProviderLogin();
    }
  }

  /** A provider's settings changed (e.g. its sign-in mode): its agents restart with them. */
  providerChanged(providerId: string): void {
    this.onProviderLogin(providerId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((r) => r.close({ serverShutdown: true })));
    this.runtimes.clear();
  }
}
