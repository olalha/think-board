# Configuration reference

The app's defaults live in its `config/` folder (`/opt/think/config` in the
Docker image). **Overrides go in the data folder**, `ROOT/config/`, and win
file by file: `names.txt` is replaced whole, while `think.json` and
`providers.json` are merged key by key over the defaults (a `null` removes a
key — e.g. `{ "codex": null }` hides the Codex provider). Prompt templates work
the same way: a file in `ROOT/prompts/` replaces the app's template of that
name. Everything is re-read when it changes on disk; no restart needed.

Each file carries a `"format"` (currently 1); a file in a newer format than
the running think is read as far as it can be, with a warning in the log.

(Not to be confused with each canvas's own `think.json` — its name and
settings, managed from the app: see docs/architecture.md, "Canvas format".)

## `config/think.json`

| Key | Default | Meaning |
|---|---|---|
| `gridSize` | `20` | grid in px; positions and sizes snap to it |
| `html.liveZoomThreshold` | `0.45` | HTML blocks mount a live iframe only at or above this zoom (and on screen) |
| `validation.maxAttempts` | `2` | automatic validation follow-ups per turn |
| `git.defaultAutosaveSeconds` | `60` | autosave for new canvases (and canvases upgraded from 0.2): how long after the first unsaved edit it becomes a point in History. `0` = only on Save now. Each canvas then keeps its own setting in its `think.json`; edits are always written to disk as you type, and committed before every agent turn and when the canvas closes |
| `agent.idleShutdownSeconds` | `60` | stop a canvas's agent this long after its last tab closes |
| `agent.defaultProvider` | `claude-code` | preselected provider for new canvases |
| `welcomeCanvas` | `true` | on a first start with no canvases, create *Welcome to think* from the app's `examples/welcome/` (once: `data/.welcomed` records it) |
| `cfAccess.teamDomain` / `cfAccess.audience` | empty (off) | verify `Cf-Access-Jwt-Assertion` on every request (defence in depth; the app fetches Cloudflare's keys, so it needs outbound HTTPS) |

The optional **app password** is not in this file: set it with
`bin/set-password` (see `docs/install.md`); it lives in `ROOT/.auth/`.

## `providers.json`

One entry per ACP agent; the key is the provider id.

| Field | Meaning |
|---|---|
| `label` | display name |
| `command`, `args` | starts the ACP agent over stdio; `{{app_dir}}` expands to the app directory |
| `env` | extra environment for the agent and its login terminal |
| `auth` | `login` (credentials in the provider's isolated home) or `api-key`. The app sets it too: Settings → Server & agents, or *Use the server's API key* in the chat (offered when the server has the key) |
| `apiKeyEnv` | with `api-key`: the server env var passed through (e.g. `ANTHROPIC_API_KEY`) |
| `credentialsFile` | path in the provider home whose existence means "logged in" (Settings display only; never read) |
| `usageCommand` | optional local command that prints plan usage (Claude: `/usage`); shown in Settings → Server & agents, no model call |
| `commands` | the agent's slash commands offered in the chat (names without `/`); omitted = all. Others are sent as ordinary text |
| `hiddenCommands` | with no `commands` list: slash commands to leave out |
| `permissionMode` | ACP session mode set after a session opens (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` for Claude) |
| `instructionsFile`, `instructionsTemplate` | the file the agent reads (`AGENTS.md`: Claude Code, Codex and Gemini all read it), and the template rendered into it |
| `sessionMeta` | `_meta` sent with session requests (Claude: `settingSources` restricted to project/local) |
| `loginMethods` | sign-in commands of the provider's own, run in the browser login terminal and listed first: `[{ "id", "name", "description", "command", "args", "env" }]` — for agents whose built-in sign-in needs a browser on the server (Codex: its CLI's `login --device-auth`) |
| `hiddenAuthMethods` | ids of the agent's own auth methods not to offer |
| `apiKeyMethod` | with `auth: "api-key"`: the agent's auth method to call once the key is set, for agents that want one chosen (Codex: `api-key`) |

The two shipped providers:

- **`claude-code`** — Claude Code through `@agentclientprotocol/claude-agent-acp`
  (which bundles Claude Code). Login: Claude Code's own sign-in in the terminal.
- **`codex`** — OpenAI Codex through `@agentclientprotocol/codex-acp` (which
  bundles the Codex CLI). Login: *Sign in with ChatGPT* runs `codex login
  --device-auth` (ChatGPT may ask you to allow device-code sign-in in its
  security settings); `NO_BROWSER=1` hides the adapter's browser sign-in, which
  cannot work on a server. It runs in `agent-full-access` mode — the agents'
  container is its sandbox. Its `/init` command is not offered (it would
  overwrite the generated `AGENTS.md`). No plan-usage meter.

Adding another ACP agent is a new entry here plus, if needed, its package in
`package.json`; the login flow, chat and permissions work unchanged.

## `names.txt`

The block-name pool for blocks **you** create, one per line, in order (`#`
comments allowed): the first unused name wins; after the pool is exhausted names
cycle with suffixes (`harry-2`, `bob-2`, …). The agent names its blocks
descriptively instead, and anyone can rename a block.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `THINK_ROOT` | `/projects` (Docker) | ROOT, the data folder: `data/`, `.agents/`, `guests/`, `.auth/`, overrides in `config/` and `prompts/` |
| `THINK_APP_DIR` | the checkout | the app (its `config/`, `prompts/`, `bin/`, `examples/`); the Docker image sets `/opt/think` |
| `PUID` / `PGID` | `1000` | Docker: the user the containers run as — the data folder's owner |
| `THINK_HOST` / `THINK_PORT` | `127.0.0.1` / `3091` | listen address (container: `0.0.0.0:8080`) |
| `THINK_SERVE_CLIENT` | on | `0` to skip serving `dist/client` (Vite dev) |
| `THINK_LOG_LEVEL` | `warn` | Fastify log level |
| `THINK_RUNNER_SOCKET` | unset | start agents through the runner at this Unix socket (the agents container); unset = start them locally |
| `THINK_GUESTS_DIR` | `ROOT/guests` | where the `think` command drops its requests |
| `THINK_PUBLIC_URL` | unset | the app's address as people open it (e.g. `https://think.example.com`): `think new` and `think url` print links with it |
| `THINK_COMMIT` | unset | commit shown next to the version (a Docker build argument) |

Per-browser preferences (theme, minimap, scrolling, editor font size, HTML
previews, delete confirmation, new-block mode, follow the agent, the side
panel) are in the app's Settings and stored in the browser.
