# Development

## Run it from source

Node 24 (see `.nvmrc`) and git. Then:

```bash
npm ci
THINK_ROOT=/tmp/think-dev npm run dev:server   # API on 127.0.0.1:3091 (tsx watch)
npm run dev:client                             # Vite on 127.0.0.1:3090, proxies /api and /ws
```

Open http://127.0.0.1:3090. `THINK_ROOT` is the data folder (canvases in
`THINK_ROOT/data`); a first start creates the welcome canvas there. The app
itself is this checkout (`THINK_APP_DIR` changes that).

**Keep the data folder outside your home directory** (as `/tmp/think-dev`
above). Claude Code looks for `CLAUDE.md` files in every folder above the one it
works in, so a canvas under `$HOME` would give the canvas agents your own
instructions from `~/.claude/CLAUDE.md`. In Docker this cannot happen: the
canvases are at `/projects/data` in the container.

To sign an agent in from a shell instead of the app:
`THINK_ROOT=/tmp/think-dev bin/agent-login` (Claude Code) or `… bin/agent-login
codex`.

Without `THINK_RUNNER_SOCKET` the server starts agents itself, as local
processes. To try the runner (the agents' container) locally, start
`node --import tsx src/server/agent/runner.ts` with a short
`THINK_RUNNER_SOCKET` path (Unix socket paths are limited to ~107 characters)
and give the server the same.

## Tests

```bash
npm run typecheck
npm test                  # unit + runtime integration tests, with a scripted ACP agent
npm run e2e               # end to end in Chromium (npx playwright install chromium once)
```

No test calls a real model: `test/fixtures/fake-agent.mjs` is a scripted ACP
agent that reacts to keywords in the prompt. CI runs all of the above, plus a
Docker build, on every pull request.

Keep tests on what think promises — the `think` command and its replies, the
layout operations, what gets committed, History — rather than on how things
look, and keep the end-to-end tests to a few journeys. A change in behaviour
changes its tests in the same pull request.

## Screenshots

```bash
npm run screenshots       # rewrites docs/images/ from a fresh think
```

`scripts/screenshots.mjs` starts think on a throwaway data folder with the
welcome canvas and a scripted agent turn (`FAKE_SCENE`), then photographs it.
Run it when the UI changes visibly.

## Versioning and releases

think follows [Semantic Versioning](https://semver.org). The version lives in
`package.json`; each release is a git tag `vX.Y.Z`, a GitHub release and a
published image.

**Merging is what releases.** A pull request that changes the version in
`package.json` releases that version when it is merged into `main`. Any other
pull request releases nothing: its changes wait, listed under `## Unreleased` at
the top of `CHANGELOG.md`, for the next one.

- **Every user-visible change** adds a line under `## Unreleased` (creating the
  heading if it is missing). Refactors, tests and CI changes don't.
- **To release,** the pull request — the change itself when it should ship right
  away, or a release pull request of its own — runs
  `npm version X.Y.Z --no-git-tag-version` (`package.json` and
  `package-lock.json`) and turns `## Unreleased` into `## X.Y.Z`. Its title says
  so: “Release 0.7.0: …”.
- **The maintainer agrees on the number** and approves the release by merging.

**Which number goes up**, from what the release contains:

| | Before 1.0 | From 1.0 |
|---|---|---|
| Fixes only | patch: 0.6.**1** | patch: 1.2.**1** |
| New features | minor: 0.**7**.0 | minor: 1.**3**.0 |
| Anything incompatible — a canvas format change, a changed `think` command, setting, environment variable or data folder layout | minor: 0.**7**.0 | major: **2**.0.0 |

**What the merge sets off** (`.github/workflows/release.yml`): when the version
in `package.json` on `main` has no release yet, the workflow checks that
`CHANGELOG.md` has its `## X.Y.Z` section, builds the image for amd64 and arm64,
pushes `ghcr.io/olalha/think-board:X.Y.Z`, `:X.Y` and `:latest`, and creates the
GitHub release `vX.Y.Z` (and with it the tag) with that section as its notes. If
the build fails, fix it in a pull request without changing the version — the
merge retries — or use *Run workflow* on the Release workflow.

Nobody pushes release tags by hand, and only merged code is ever released. A
released version is never changed: its tag can't be moved or deleted, and a
mistake gets a new patch release.

## Operations

- Logs: `docker compose logs -f think agents`.
- The containers run as `PUID:PGID`; their entrypoint drops root before
  starting. A `docker exec` does not go through it — use
  `docker exec -u think …` for anything that writes into the data folder.
- An idle canvas has no agent process; a canvas stops its agent 60 s after its
  last tab closes (after any running turn finishes).
- Restarting the container mid-turn is safe: the turn is lost, and its changes
  are committed as the agent's on the next open.
- A canvas's `.think/` (the chat log, turns, outside agents' tabs) is
  git-ignored: a copy of the git repository carries the canvas, not the chat.
