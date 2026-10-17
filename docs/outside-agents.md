# The `think` command: one way of working for every agent

A canvas is a folder of files, so any agent can work on it. Two kinds do:

- **the canvas's own agent** — started by the app, isolated in the agents'
  container, talking with the user in the canvas chat;
- **outside agents** — any agent on the machine (Claude Code in a tmux
  session, Codex…), working on a canvas for its own user.

Both work the same way: **they edit block files directly**, like any file, and
**use `bin/think` for everything else about the canvas** — placing blocks,
moving, links, frames, views, comments, pointing at blocks — plus, for outside
agents, joining the canvas, the lock and a tab in its chat. The server checks
every command (protected blocks, the grid, a valid layout), writes the result
atomically, and **commits the agents' work itself**: agents never run git.

The canvas's `AGENTS.md` (from `prompts/project-agents.md`) is the one guide
both kinds follow. It sends them to `think help` and `think <command> --help`
for the commands, so the command reference lives in one place — the script —
and never goes stale in a prompt.

## The commands

`think help` prints the current list; the short version:

```
The canvas (both kinds of agent)
  read · add · move · link · unlink · frame · unframe · rename · remove ·
  view add|remove · comments · comment done|add · show · summary

Outside agents (with --as NAME on every command)
  list · new · join · lock · unlock · say · leave · status · url · path · chat · skill
```

## Outside agents, step by step

- `think join <canvas> --as NAME [--about "Claude Code in a terminal"] ["why"]`:
  the agent appears as a tab in the canvas chat (name, the about line, whether
  it is editing). `AGENTS.md` is written for it to read. Later commands act on
  the canvas it joined (`--canvas` picks one when it joined several).
- `--as NAME` is required: the name the user knows the agent by (its session's
  name). Lowercase letters, digits and hyphens; `user`, `agent`, `think`, `you`
  and the like are refused. It is the tab's name, the author in History, and
  the name on comments it marks done.
- `think lock ["what for"]`: the user's pending edits are committed as theirs,
  then the canvas is locked for the agent. Every open tab shows **“NAME is
  working on this canvas — …”** with **Take over**; the canvas agent can't
  start a turn meanwhile. Commands that change the canvas need the lock;
  reading doesn't. `think lock <canvas> …` joins first.
- While locked, its file edits and commands stream live to every tab, with a
  highlight ring on the blocks it touches (as the canvas agent's edits have).
- `think unlock ["summary"]`: think commits its edits under its name
  (`NAME <guest@think>`) — its summary (or think's own) as the subject, then
  the full list of changes: blocks, layout, frames, links, views, comments.
  Its tab gets a line saying what changed; History shows the session as one
  moment; the canvas agent's next message starts with a summary of it.
- `think say "…"`: a message in the agent's own tab — never in the canvas
  agent's chat, never shown to the canvas agent. The user can't reply there:
  the tab's composer only drafts a reply to copy into wherever the user talks
  to that agent.
- `think leave ["summary"]`: unlocks first (committing), then the tab says
  "left" and goes. Joining again under the same name brings the tab back, with
  the earlier lines folded.
- A lock lapses after 30 minutes without changes; *Take over* ends it at once;
  **Disconnect** (the tab's menu) ends it and removes the agent. Either way its
  edits so far are committed under its name. After a disconnect, the agent's
  next `think` call is told so, once.

## The canvas's own agent

`think` is on its PATH (`bin/canvas-agent/`, which holds only that), and works
during its turn. Its name is always `agent`; `join`, `lock`, `say` and `leave`
are refused with an explanation. `think summary "…"` heads the commit think
makes of the turn. Commits the agent makes itself (older sessions were told to)
are still accepted.

## How it works

The command writes a request file and waits for the answer file
(`src/server/requests.ts`). A refusal (the canvas is busy, the block is
protected, no such block) comes back on stderr with a non-zero exit.

- **Outside agents** use `ROOT/guests/` (`src/server/guests.ts`). That folder is
  mounted into the app's container only, so the ability to write it (the user
  who owns ROOT) is the permission. No port, no token.
- **The canvas agent** uses its own canvas's `.think/cli/`, watched while the
  canvas is open (the agents' container sees only the canvases, never
  `ROOT/guests/`). think sets `THINK_CANVAS` and `THINK_CANVAS_DIR` in its
  environment; with those set, the script uses that channel. Requests there are
  answered only during that canvas's agent turn.

The commands themselves are `src/server/commands.ts` (who may do what, the
messages) and `src/server/canvas-ops.ts` (the layout operations, pure
functions); the tabs are `src/server/guest-room.ts`
(`.think/guests.json` and `.think/guests/<name>.jsonl`, never committed).

Without the lock an outside agent can still edit files (the watcher picks
everything up), but nothing then stops a collision with a turn, and its edits
are recorded as the user's. Hand edits to `canvas.json` keep working too: the
commands are the easy, checked way, not the only one.

## The skill

`skills/think-canvas/SKILL.md` is deliberately short: what think is, how to
find a canvas and join it, then *read the canvas's `AGENTS.md`* and `think
help`. `think skill --install` puts it where each agent on the machine looks
for skills: Claude Code's `~/.claude/skills/` and Codex's
`$CODEX_HOME/skills/` (`~/.codex/skills/`), whichever are there — Claude
Code's when neither is; `--install DIR` puts it into DIR instead. For any
other agent, `think skill` prints it (paste it into that agent's instructions).

When think runs from its Docker image, the command lives in the data folder
(`ROOT/cli/bin/think`, written by the server at start); link it onto your
PATH — see `docs/install.md`.
