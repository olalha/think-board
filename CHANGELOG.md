# Changelog

Notable changes to think. Versions follow [Semantic Versioning](https://semver.org);
before 1.0, a minor version may change things that are not backwards compatible.
How versions and releases work: "Versioning and releases" in
[docs/development.md](docs/development.md).

## Unreleased

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
