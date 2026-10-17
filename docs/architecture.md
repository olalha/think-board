# Architecture

think is one Node process (Fastify + ws) serving a React client, plus one ACP
agent process per open canvas — started in a separate, internet-only container
(see Isolation). The filesystem is the single source of truth:
a block *is* a file, the layout *is* `canvas.json`, and every canvas folder is
its own git repository.

A fresh install opens with the canvas **Welcome to think** (from
`examples/welcome/`), a short tour for people; this page is the reference.

## Components

```
browser ──WebSocket/HTTP──▶ Fastify server ──▶ ProjectManager ──▶ ProjectRuntime (one per open canvas)
                                                                   ├─ chokidar watcher (top-level files only)
                                                                   ├─ canvas model: parse · lint · reconcile
                                                                   ├─ git (plain CLI)
                                                                   ├─ MermaidValidator (jsdom worker thread)
                                                                   ├─ ChatLog (.think/chat.jsonl)
                                                                   ├─ GuestRoom (outside agents' tabs: .think/guests*)
                                                                   └─ AgentHost ──ACP/stdio──▶ agent process
                                                                         (via the runner socket → "agents" container)
canvas agent ─── bin/think ── files in <canvas>/.think/cli/ ─▶ runtime.command (during its turn)
outside agents ─ bin/think ── files in ROOT/guests/ ──▶ GuestBridge ──▶ runtime.guestJoin / guestLock / command / guestSay …
```

| Module | Responsibility |
|---|---|
| `src/server/app.ts` | HTTP routes, the WebSocket endpoint, optional Cloudflare Access JWT check, static client |
| `src/server/manager.ts` | one runtime per open project; opens on first tab, closes after the idle grace period |
| `src/server/runtime.ts` | everything live about a project: file index, watcher, lock, user mutations, turns, post-turn steps |
| `src/server/canvas-model.ts` | `canvas.json` schema (zod), lint rules, reconciliation and auto-placement |
| `src/server/think-file.ts` | a canvas's committed `think.json`: format version, name, provider, its own settings |
| `src/server/migrations.ts` | canvas format upgrades, run on open, committed as the app |
| `src/server/comments.ts` | `comments.json`: comments on blocks, frames and the canvas |
| `src/shared/drawing.ts`, `src/server/drawings.ts` | drawings on images: the model, its SVG, validation and rendering |
| `src/server/agent/host.ts` | spawns the ACP agent, initialize, session resume/load/new, permission mode, auth state |
| `src/server/agent/login.ts` | the provider-agnostic login terminal (node-pty) |
| `src/server/agent/process.ts`, `runner.ts` | start processes locally or in the agents container over a Unix socket |
| `src/server/changes.ts` | what changed between two commits, in words (change notes, History) |
| `src/server/history.ts` | History: commits grouped into moments, snapshots of the past |
| `src/server/requests.ts` | the `think` command's request folders (request and answer files) |
| `src/server/commands.ts`, `canvas-ops.ts` | the `think` command's canvas commands: who may, the messages; the layout operations (pure) |
| `src/server/guests.ts` | requests from outside agents (`ROOT/guests/`): which canvas, joining, the lock |
| `src/server/guest-room.ts` | outside agents on a canvas: who joined, and each one's tab |
| `src/server/auth.ts` | the optional app password |
| `src/server/agent/env.ts` | the agent's environment allowlist and isolated HOME |
| `src/server/templates.ts` | prompt templates, read at use time |
| `src/shared/protocol.ts` | the WebSocket message types — the one place to extend the protocol |
| `src/client/blocks/renderers.tsx` | pure block renderers (also used by `/render/<project>/<block>`) |
| `src/client/canvas/*` | React Flow canvas, nodes, edges, menus, shortcuts |
| `src/client/chat/*` | chat panel, transcript entries, login dialog |

## Sync

- Every mutation of a project runs through one serial queue, so edits, layout
  ops, watcher events and turn steps never interleave.
- The watcher debounces per path and waits for writes to settle. The server's
  own writes are recognised by content hash (the in-memory hash is updated
  before writing) and never echoed.
- Writes are atomic (temp file in `.think/` + rename).
- `canvas.json` is rewritten only when its *meaning* changes, never because of
  formatting — an agent's own JSON style never causes a rewrite or a commit.
- Clients keep a local copy of the layout for smooth dragging; server state
  always wins. Tabs reconnect with backoff, receive a fresh snapshot, and resend
  unconfirmed edits (edits made while offline are kept and sent then); closing
  a tab hands unsaved edits to `sendBeacon`.

## Saving

Two layers. Every edit reaches its file within ~0.5 s — the top bar says
*Saved*, *Saving…* or *Offline*. Separately, the user's edits become a point in
History (a git commit as `user`): a fixed time after the first unsaved edit
(the canvas's `settings.autosaveSeconds` in `think.json`, default 60; further
edits do not postpone it), on *Save now* (⌘/Ctrl+S or the status button), when
History is opened or refreshed, before every agent turn, and when the canvas
closes.

## Canvas format and upgrades

Each canvas folder records its format in the committed `think.json` (no
`think.json` = format 1, the 0.1–0.2 layout, whose name lived in the git-ignored
`.think/project.json`). Opening a canvas runs `migrations.ts` from its format up
to the current one and commits the result as the app (`think: upgraded the
canvas to format N`), so History shows the upgrade and git keeps the way back.
A canvas in a newer format than the running build is refused, not guessed at —
the list marks it "Needs a newer think". `think.json` is managed by the app: a
valid outside change to the name or settings is adopted, anything else (broken
JSON, another format or provider) is written back.

## Reconciliation (`canvas.json` vs the files)

Run on user actions, when files appear/disappear outside a turn, and at the end
of every turn (during a turn it runs in memory for display only):

- a file that vanished and one that appeared with the same (or mostly the same)
  content → a rename: the node keeps its place, size and connections;
- file without a node → placed on the nearest free grid slot next to the block
  most recently touched (by mtime) in the turn; otherwise near the centroid;
- node without a file → removed with its edges;
- groups (JSON Canvas `group` nodes) are kept and snapped; a block belongs to a
  group when it lies inside it; saved `views` are kept;
- everything snapped to the grid, sizes clamped to per-type minimums;
- invalid `canvas.json` → the last valid layout is kept (persisted in
  `.think/canvas-last-valid.json`), the error is shown and fed to the agent.

## A turn

1. The tab flushes pending edits (same socket, so they are applied first).
2. The server takes the lock (all user mutations are rejected server-side,
   except edits to protected blocks, which are held as drafts), commits the
   user's changes as `user`, renders `AGENTS.md`, remembers protected blocks.
3. The prompt is assembled from templates (see `docs/prompts.md`): when anyone
   but the agent changed the canvas since its last turn, a note describes what
   changed in words (layout summarised, not a raw `canvas.json` diff) and who.
   Slash commands the agent offers are sent on their own.
4. The agent runs; its file edits stream to every tab via the watcher, and its
   `think` commands (layout, frames, links, comments) are applied as it makes
   them (`.think/cli/`).
5. Post-turn: rescan the folder (never race the watcher) → undo changes to
   protected blocks → write the layout → **think commits the agent's work** as
   `agent` (its `think summary`, or think's own one-line summary, then the list
   of changes; agents never run git, though commits they make themselves are
   accepted) → validate changed `.mmd` files, `canvas.json` and stray
   top-level files → on problems send `validation-errors.md` as a follow-up
   (lock still held, capped; its fixes are committed the same way) → record
   `HEAD` as `lastAgentHead` and the turn in `.think/turns.jsonl` (History) →
   write the user's drafts → unlock.

`state.json.turnInProgress` survives a crash: on the next start the leftover
changes are committed as the agent and the stale lock is gone.

## Agents (ACP)

The server is the ACP client (`@agentclientprotocol/sdk`); the browser never
speaks ACP. Providers are configured in `config/providers.json`; Claude Code
runs through `@agentclientprotocol/claude-agent-acp`, which bundles its own
Claude Code binary. Sessions are resumed with `session/resume` (or `session/load`,
whose replay is discarded — the app keeps its own transcript); if neither works
a new session starts and the chat shows a divider.

**Login** is provider-agnostic: agents advertise auth methods; a `terminal`
method is "run the agent's command with these extra args". The server runs it
in a PTY inside the provider's home and streams it to xterm.js. "Not logged in"
is detected from the standard `auth_required` error and, for claude-agent-acp,
its `_auth/status_update` extension.

## History

Nothing extra is stored: History reads the canvas's git log and groups it into
moments — an agent turn (the commits between a turn's start and end, recorded
in `.think/turns.jsonl`, shown with the message that started it), a stretch of
the user's edits, a restore, an outside agent's session. A preview renders the
canvas at that commit (images via `/files/<file>?rev=<commit>`), with what the
moment added, changed or removed marked. Restoring writes the old content back
as a new commit (`restore: …`), so history is never rewritten and the agent
hears about it in its next change note.

## Drawings on images

An image block can be drawn on (its edit mode). Its *page* is a photo or a
plain colour (a blank page: the top bar's Image menu makes one), and the page
can change either way; with something drawn, the editor asks whether the
drawing moves onto the new page (scaled to fit) or starts fresh — one undo step
either way. A drawing is data — `shared/drawing.ts`:

- `ROOT/data/<canvas>/.drawings/<name>/drawing.json`: the shapes (pen and
  highlighter strokes as points, lines, arrows, rectangles, ellipses, text),
  rub-outs attached to the shapes they cross (so they move with them), a crop
  and a rotation — all in the original image's pixel coordinates. Committed.
- `.drawings/<name>/base.<ext>`: the original image, untouched. Committed. A
  photo chosen as the page later is `base-<hash>.<ext>`; an original stays
  while the editor's undo history can still go back to it (canvas format 3).
- `<name>.png`: the finished picture — what the preview and the agent see —
  rendered by the server (resvg) from the same SVG the editor shows
  (`drawingToSvg`), at most 2048 px on its long side.
- `.think/drawings/<name>.json`: the editor's undo history, so undo reaches
  into earlier sessions. App-private.

The editor saves a second after the last change, when drawing ends, before a
message goes to the agent, and (small drawings) through `sendBeacon` as the
tab closes. The picture is re-rendered on every save; the drawing follows
renames, deletion (and undo), History restores and copy/paste. If something
else replaces the image file (an agent, a person), the drawing no longer
fits it and is dropped — History keeps it. *Replace image…* in the app offers
a new picture or a blank page (a colour), and asks first when there is a
drawing: keep it on the new page, or start fresh. The agent sees only the finished
picture; its change note says which images were drawn on.

## Outside agents

Any agent on the machine can work on a canvas the way its own agent does:
edit the block files, and use the `think` command for the rest (see
`docs/outside-agents.md`). It joins the canvas — a tab of its own in the chat,
apart from the canvas agent's conversation — takes the lock (shown in the app,
with *Take over*), and think commits its edits under its name when the lock
ends. It reaches the server through files in `ROOT/guests/`, a folder the
agents' container never sees; the canvas agent reaches it through its own
canvas's `.think/cli/`, answered only during its turn.

## Isolation

- Two containers from one image (the app in `/opt/think`), running as
  `PUID:PGID` — the data folder's owner; the entrypoint drops root before
  anything starts — with `no-new-privileges`. **think** (the app) publishes its
  port on `127.0.0.1` only; a reverse proxy or tunnel in front, with
  authentication (an authenticating proxy, or the optional app password),
  makes it reachable. **agents** runs every canvas agent, login terminal and
  usage check; its network reaches the internet only — not the proxy, not
  the app, not other containers. The app starts processes there
  through a Unix socket on a shared volume.
- Mounted into both: `ROOT/data` and `ROOT/.agents` (rw). App only: the rest
  of ROOT — `guests/`, `.auth/`, the `config/` and `prompts/` overrides, `cli/`.
- Agents and login terminals start in a process group of their own and are
  stopped as a group, so a launcher (an npm bin that starts a native binary)
  never leaves the real agent running.
- Each provider's HOME is `ROOT/.agents/<provider>/home` (0700): its login,
  settings and transcripts. It is never an ancestor of a canvas folder, so
  Claude Code's parent-directory `CLAUDE.md` walk cannot pick up anything else.
- claude-agent-acp sessions use `settingSources: ["project","local"]`.
- The agent's environment is an allowlist (PATH, locale, time zone, HOME, provider env).
- Default permission mode is `bypassPermissions` (Claude) / `agent-full-access` (Codex); the agents container is the
  fence. Within it, an agent can technically read every canvas and the stored
  logins — only its instructions keep it in its own folder. Protected blocks
  are enforced by the app (changes undone after the turn), not by the OS.
