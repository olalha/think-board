# Changelog

Notable changes to think. Versions follow [Semantic Versioning](https://semver.org);
before 1.0, a minor version may change things that are not backwards compatible.
How versions and releases work: "Versioning and releases" in
[docs/development.md](docs/development.md).

## 0.6.3

- **Security:** Node 24.22.1 in both containers (the Brotli fix), pinned in the
  Dockerfile, and the newest agent adapters: Claude Code's agent SDK 0.3.311
  and Codex's adapter 2.3.0, on version 2 of the Agent Client Protocol library.

## 0.6.2

- **Switch a canvas's agent:** the chat's ⋯ menu (*Switch to …*) and the login
  card (*Or use another agent*) hand a canvas to another provider, such as Codex
  instead of Claude Code. The switch starts a new conversation; nothing of the
  old one is passed on. So a Codex user can use the welcome canvas without a
  Claude login.
- **Docs:** think has no user accounts, which the install guide, README and
  SECURITY.md now say next to the advice to put authentication in front.

## 0.6.1

- **Security:** the `think` command for agents on the host is no longer copied
  into the data folder, which the app's container can write. Install it from the
  image or a checkout ("Let agents on this machine use it" in
  [docs/install.md](docs/install.md)); think removes the old copy (`think-data/cli`)
  at start. The command now finds `./think-data` on its own.

## 0.6.0

The first public release.

- **Welcome canvas:** a fresh install opens with *Welcome to think*, a short tour
  with one of each block, a frame, links, a comment and saved views
  (`welcomeCanvas` in `config/think.json` turns it off).
- **Runs anywhere:** `docker compose up` from a checkout serves
  http://localhost:8080 with its data in `./think-data`; `deploy/compose.yml`
  runs the published image, `ghcr.io/olalha/think-board`, for amd64 and arm64.
- **Docs:** installing (reverse proxies, Dokploy and Coolify, the password, agent
  sign-in), development and releases.
- History shows agent replies as plain text.
