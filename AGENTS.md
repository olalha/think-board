# think — notes for coding agents

Self-hosted agentic brainstorming canvas. Start with `README.md`, then `docs/`
(`architecture.md` is the map). How to run, test and release: `docs/development.md`.

- **Data folder (ROOT):** canvases in `ROOT/data`, agent homes in `ROOT/.agents`,
  outside-agent requests in `ROOT/guests`, the optional app password in `ROOT/.auth`.
  Develop against a scratch ROOT **outside `$HOME`** (e.g. `THINK_ROOT=/tmp/think-dev`):
  Claude Code's parent-directory walk would otherwise load your own `~/.claude/CLAUDE.md`
  into canvas agents.
- **Never** read or print anything under `ROOT/.agents/` (agent credentials).
- Text sent to agents lives only in `prompts/`; do not hard-code agent-facing text.
- Protocol changes go in `src/shared/protocol.ts`; unknown message types must stay ignorable.
- Before committing: `npm run typecheck && npm test && npm run e2e`. Changes reach `main`
  through pull requests; CI runs the same checks.
- **Versions and releases:** follow "Versioning and releases" in `docs/development.md`.
  A user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`. Merging a
  version bump into `main` releases it, so bump the version only in a pull request whose
  release (and number) the maintainer agreed to. Never merge your own pull requests.
- The `think` command (`bin/think`) is how both canvas agents and outside agents work on a
  canvas beyond editing block files; its `help` texts are the command reference agents read
  (the canvas's `AGENTS.md`, from `prompts/project-agents.md`, points there). Changing a
  command? Update its help in `bin/think`, `docs/outside-agents.md` and, if the routine
  changes, `prompts/project-agents.md`; keep `skills/think-canvas/SKILL.md` lean (it points
  at AGENTS.md), and reinstall it where you use it (`bin/think skill --install`).
- Agents never run git: think commits canvas-agent turns and outside agents' locks
  (`commitWork` in `src/server/changes.ts`).
- Changing what a canvas folder holds (a file's shape, a new file)? Bump `CANVAS_FORMAT`
  (`src/server/think-file.ts`) and add a step to `src/server/migrations.ts` with a test.
  The welcome canvas (`examples/welcome/`) is checked by `test/welcome.test.ts`.
- The containers run as `PUID:PGID`; a `docker exec` runs as root unless given `-u think` —
  use that for anything that writes into ROOT.
- Drawing tests in a browser: the drawing editor owns the keyboard while open; press
  keys only with it open, and never near the chat's Send button.
- Touch screens: React Flow marks every draggable node `nopan`, so on touch only the
  selected node is draggable (by its title bar — `flowNodes` in `BoardCanvas.tsx`);
  everything else pans. Test phones with `isMobile` + `hasTouch` emulation, not just a
  narrow window: layout-viewport bugs (content wider than the screen) only show there.
- Tooltips: any element with `data-tip` (placement `data-tip-pos`) gets one from
  `components/Tooltips.tsx` — a single layer above everything, mouse and keyboard only,
  never on touch. Don't add CSS `::after` tooltips: scrolling panels clip them.
- Touch screens size the app to the visible area (`lib/viewport.ts`, `--app-h`); use
  `var(--app-h, 100dvh)` rather than `100vh` for anything as tall as the screen.
- The dev API server must be restarted after server changes when it runs without watch —
  and, when it serves the built client (`THINK_SERVE_CLIENT=1`), after every client build:
  it caches the files.
