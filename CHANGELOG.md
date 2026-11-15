# Changelog

Notable changes to think. Versions follow [Semantic Versioning](https://semver.org);
before 1.0, a minor version may change things that are not backwards compatible.
How versions and releases work: "Versioning and releases" in
[docs/development.md](docs/development.md).

## 0.7.2

- **Security:** @hono/node-server 2.1.8 and hono 4.13.18 (used by the agent adapters' MCP
  support); `npm audit --omit=dev` is clean again.

## 0.7.1

- **Canvas format 4.** Opening a canvas upgrades it (committed as the app);
  an older think then refuses it rather than dropping PDF blocks and block
  titles from its layout.
- Blocks can have free-text titles (any characters, emoji too): renaming to text keeps it as
  the title and renames the file to match; `[[block-name]]` links in Markdown blocks follow
  every rename, and the agent is told about links to blocks that do not exist.
- Renaming a block in the canvas takes any title and shows the file name it gives; in a
  Markdown block's raw editor, `@` or `[[` picks a block to link, and links render as chips
  that fly to the block (struck through when no block has that name), in chat replies too.
- The canvas's own agent can ask the user questions with `think ask`: a card in the chat
  with options, an "Other" answer and Skip; the agent waits for the answers.
- **Fix:** text pasted just after creating a block, or with a fresh block
  selected, goes into that block instead of also becoming a new one.
- **Fix:** the font size setting (now "Text size", 12–17) also sizes rendered
  blocks and chat replies; before, it changed only the raw editor.
- **Fix:** a slash command's report (`/context`) shows once; Claude Code's
  adapter sent it twice. Its later sections (tools, skills…) are folded.
- Each chat reply has a copy button that copies its Markdown.
- **Copy content** in a block's menu: a Markdown block copies as formatted
  text from the rendered view and as Markdown from the raw view.
- `think link` takes `--from-side` and `--to-side` (top, right, bottom or left) to choose
  where an arrow attaches to each block, on a new or an existing link.
- Pressing Z again on a very tall or wide block zooms in on its start so the text is
  readable; a third press fits it whole again.
- Drag the ends of a selected arrow to attach it to another side or another block.
- A **Files** tab in the side panel keeps reference material that isn't a block
  (spreadsheets, documents, archives, data) in the canvas's `files/` folder: upload or drop
  files, preview text, CSV and images, download, rename, delete. The agent reads them and
  can leave exports there.
- **PDF blocks:** drop, paste or upload a PDF (up to 25 MB) to read it on the canvas; agents
  read it too, Codex through its extracted text.

## 0.6.4

- **Security:** Node 24.22.3 in both containers (fixes for HTTP/2 and TLS).
- **Security:** fast-uri 3.1.9 and 4.2.3 (used by the server's request
  validation), undici 8.12.3 (used by jsdom), and @fastify/static 10.1.10 with
  glob 14 and minimatch 11 (`npm audit --omit=dev` is now clean).
- The newest agent adapters: Claude Code's 0.106.0 (agent SDK 0.3.322) and
  Codex's 2.6.0, with think's Agent Client Protocol library at 2.6.0.

## 0.6.3

- **Security:** Node 24.22.1 in both containers (the Brotli fix), pinned in the
  Dockerfile, and the newest agent adapters: Claude Code's agent SDK 0.3.311
  and Codex's adapter 2.3.0, on version 2 of the Agent Client Protocol library.
- **Security:** DOMPurify 3.4.17, which sanitises HTML before the app shows it.

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
