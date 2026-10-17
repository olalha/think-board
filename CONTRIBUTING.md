# Contributing

Thanks for taking an interest. think is a small project, so a short note first
saves everyone time:

- **Bugs:** open an issue with what you did, what you expected and what
  happened, plus your think version (Settings → Server & agents) and how you
  run it.
- **Ideas and larger changes:** open an issue to talk it through before you
  write the code.
- **Small fixes** (typos, docs, an obvious bug): a pull request is fine.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Set up and run think from source: [docs/development.md](docs/development.md).
3. Make the change, with tests for what it changes in behaviour. If users will
   notice it, add a line under `## Unreleased` in `CHANGELOG.md`. Don't change
   the version: the maintainer decides releases (see "Versioning and releases"
   in [docs/development.md](docs/development.md)).
4. Run the checks — CI runs the same ones:
   ```bash
   npm run typecheck && npm test && npm run e2e
   ```
5. Open a pull request that says what changed and why. Pull requests are
   squash-merged, so its title becomes the commit message.

## Conventions

- `AGENTS.md` collects the project's conventions (also for coding agents): read
  it before your first change.
- Text that agents see lives in `prompts/`, never in code.
- WebSocket messages are defined in `src/shared/protocol.ts`; unknown message
  types must stay ignorable.
- A change to what a canvas folder holds needs a format migration
  (`src/server/migrations.ts`) and a test.
- Keep docs in step with the code: a changed command, setting or behaviour
  updates its page in `docs/` in the same pull request.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
