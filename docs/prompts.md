# Prompt templates

Everything the app adds to an agent's context comes from Markdown files in
`app/prompts/` — never from strings in code. Templates are read at use time,
so an edit applies to the next render without a restart (the container mounts
`prompts/` read-only over the image's copy). Placeholders are `{{name}}`; an
unknown placeholder is left in the output and logged, so a typo is visible.

| Template | When | Placeholders |
|---|---|---|
| `project-agents.md` | rendered to the provider's instructions file (`AGENTS.md`) when a canvas opens, when an outside agent joins or locks, and before every turn; git-ignored. The one guide for the canvas agent and outside agents alike; it points at `think help` rather than listing commands | `project_name`, `canvas_slug`, `name_pool`, `grid_size`, `instructions_file` |
| `turn-suffix.md` | appended to **every** user prompt (not to slash commands) | `protected_note` (empty unless blocks are protected) |
| `user-changes.md` | prepended when anyone but the agent committed since `lastAgentHead` (the user, outside agents, restores). Outside agents' messages live in their own tabs and are never sent | `last_agent_head`, `authors`, `summary` (bullet lines: blocks added/edited/renamed/deleted, README, layout in words), `commit_count` |
| `validation-errors.md` | sent alone as an automatic follow-up after a turn whose changes do not validate | `errors`, `attempt`, `max_attempts` |

The prompt is sent as separate text blocks: `[user-changes?] [your message]
[turn-suffix]`. The chat stores your message verbatim and the template text as
`injected`, shown behind the **+ injected context** marker. Automatic follow-ups
appear as a user entry marked as automatic.

Per provider, `instructionsTemplate` and `instructionsFile` in
`config/providers.json` choose which template renders to which file. Claude Code
reads `AGENTS.md` when a folder has no `CLAUDE.md` (the app removes a
`CLAUDE.md` it generated in older versions), so one file serves every agent.

A slash command the agent offers (and `config/providers.json` allows) is sent on
its own — no notes around it — because agents only recognise a command at the
very start of a message.
