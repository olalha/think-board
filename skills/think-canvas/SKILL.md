---
name: think-canvas
description: Work on a think canvas (the brainstorming app's boards) — start one, add or rearrange blocks, frames and links, answer comments, report back in its chat — with the `think` command. Use when asked to put something on a think canvas, start a board, map something out on a board, or read what was discussed there.
---

# Working on a think canvas

think is a self-hosted brainstorming app. A canvas is a folder of block files
(Markdown, Mermaid, HTML, images) that people see as a board; you work on it
like the canvas's own agent does, from outside the app.

1. **Find the canvas:** `think list`, and `think path <canvas>` for its folder.
   To start one: `think new "Name" "what it is for"` (prints the folder and a
   link — give the link to your user).
2. **Join it:** `think join <canvas> --as <your name> --about "<what you are>"`.
   Your name is the one your user knows you by (e.g. your session's name,
   `planner`); add `--as <your name>` to every think command.
3. **Read the canvas's `AGENTS.md`** (in its folder) and follow it: it is the
   guide to working on a canvas — the same one the canvas's own agent follows.
4. **`think help`** lists the commands; `think <command> --help` explains one.

The command is `{{THINK}}`.
