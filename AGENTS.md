# ai-platform-report — instructions for coding agents (Claude Code, Codex)

This repo is the **AI Platform report system**: a small HTML report server
(http://10.101.1.183:8090), the `aireport` CLI, and the `ai-report` skill that teaches
Claude / Codex to write reports with it. `CLAUDE.md` just imports this file.

## If the user asks you to set up the report skill / `aireport`

Run, from the repo root:

```bash
bash client/install.sh            # or: LINK=1 bash client/install.sh  (symlink → updates with git pull)
aireport config --owner "<the user's name>"   # ask for it; Korean full name is fine
aireport health
```

That installs `~/.local/bin/aireport`, `~/.claude/skills/ai-report/SKILL.md` and
`~/.codex/skills/ai-report/SKILL.md`. Tell the user to restart their agent session so the
skill is picked up. No repo checkout? `curl -fsSL http://10.101.1.183:8090/client/install.sh | bash`.

## If the user asks you to write a report

Follow `skills/ai-report/SKILL.md` (the installed skill) — in short: `aireport guide`,
`aireport suggest` (new topics need the user's explicit OK), `aireport new-exp`, write,
`aireport viewer` for cases (3D slice overlay is the default), `aireport check`,
`aireport push`, verify the URL.

## If the user asks you to deploy / upgrade the server (only on 10.101.1.183)

```bash
python3 -m unittest discover -s tests      # must pass
bash deploy/install-server.sh              # build image, restart container, (re)install nightly NAS backup
```

No sudo is needed (docker group + user crontab). Settings in `deploy/config.env`
(machine-specific overrides in git-ignored `deploy/config.local.env`). Topics are never
touched by a deploy; managed files (`site-template/` → site `assets/`, `docs/`,
`AGENTS.md`, `client/`) are re-copied on every start.

## Layout

| Path | What |
|---|---|
| `server/app.py` | the server: static files + write API + all index generation (stdlib) |
| `server/Dockerfile` | image (python:3.12-slim, no pip) |
| `site-template/` | managed layer copied into the site: `AGENTS.md` + `docs/` (format authority for report authors), `assets/` (CSS, markdown-it, components) |
| `site-template/assets/components/volume-viewer.js` | the 3D slice overlay viewer |
| `client/aireport` | CLI (stdlib; `viewer` needs numpy + nibabel/SimpleITK) |
| `client/install.sh` | installs CLI + skill for Claude Code and Codex |
| `skills/ai-report/SKILL.md` | the skill (same file for both agents) |
| `deploy/` | `install-server.sh`, `backup.sh`, `config.env` |
| `tests/` | `python3 -m unittest discover -s tests` |

## Rules when changing this repo

- Keep the server and CLI **stdlib-only** (the CLI's `viewer`/`phantom` may import numpy lazily).
- The experiment-page template lives in `server/app.py` (`experiment_page`); docs that
  show it (`site-template/docs/create-experiment.md`) must stay in sync.
- Components render **after** their island and mark output `data-rendered`; never consume
  the island (the browser editor must be able to save the page back).
- Volume JSON format changes need a new `format` tag and must keep reading old files.
- Run the tests; for viewer/UI changes also load a page in a headless browser
  (`aireport phantom` gives a demo volume) and look at it in light and dark.
- Never commit patient data — use `aireport phantom` for examples and tests.
