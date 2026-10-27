# ai-platform-report — instructions for coding agents (Claude Code, Codex)

This repo is the **AI Platform report system**: a small HTML report server
(http://10.101.1.183:8090), the `aireport` CLI, and the **`pl-report` skill** that teaches
Claude / Codex to write reports with it. `CLAUDE.md` just imports this file.

| The user says… | Do |
|---|---|
| "set up pl-report / the report skill / this repo" | [Set up the skill](#set-up-the-pl-report-skill-any-machine) |
| "write / update a report", "리포트 써줘" | [Write a report](#write-a-report) |
| "deploy / upgrade / move the server" | [Server](#server-only-on-the-server-host) |
| "change the viewer / CLI / server" | [Rules when changing this repo](#rules-when-changing-this-repo) |

## Set up the pl-report skill (any machine)

Needs `python3` (3.8+) and network access to the server; nothing else for the CLI.
From the repo root:

```bash
bash client/install.sh                         # copies; LINK=1 bash client/install.sh symlinks (git pull updates)
aireport config --owner "<the user's name>"    # ask the user; Korean full name is fine (e.g. 이종민)
aireport health                                # must print the server status
python3 -m pip install --user numpy scipy nibabel   # only for `aireport viewer` (3D case viewer); add SimpleITK for NRRD/MHA/DICOM
```

What it installs:

| | |
|---|---|
| `~/.local/bin/aireport` | the CLI (make sure `~/.local/bin` is on `PATH`) |
| `~/.claude/skills/pl-report/SKILL.md` | Claude Code skill → `/pl-report` |
| `${CODEX_HOME:-~/.codex}/skills/pl-report/SKILL.md` | Codex skill → `$pl-report` |
| `~/.config/aireport/config.json` | server URL + owner name |

Options (env): `SKILL_TARGETS="claude"` (only one agent), `BIN_DIR=…`, `AIREPORT_URL=…`
(another server), `AIREPORT_OWNER=…`. The installer removes an older install of the same
skill under its previous name `ai-report`. Re-running it is safe (that's also how to update).

Done when: `aireport health` answers, `aireport config` shows the owner, and the skill file
exists for each agent. Tell the user to **restart their agent session** so `/pl-report` is
picked up. No repo checkout? `curl -fsSL http://10.101.1.183:8090/client/install.sh | AIREPORT_OWNER="<name>" bash`.

## Write a report

Follow `skills/pl-report/SKILL.md` (the installed skill) — in short: `aireport guide`,
`aireport suggest` (new topics need the user's explicit OK), `aireport new-exp`, write,
`aireport viewer` for cases (3D slice overlay is the default), `aireport check`,
`aireport push`, verify the URL.

## Server (only on the server host)

The live server is **10.101.1.183** (container `ai-platform-report`, port 8090, data in
`/home/ubuntu/ai-platform-report-data/site`, nightly 02:30 KST snapshot to the NAS at
`/mnt/ai-platform-report`). Deploy only when the user asks, and only on that host (or on
a new host the user names).

Upgrade after `git pull` (no sudo — docker group + user crontab; idempotent):

```bash
python3 -m unittest discover -s tests      # must pass
bash deploy/install-server.sh              # build image, restart container, (re)install nightly NAS backup
curl -s http://127.0.0.1:8090/api/health   # {"ok": true, ...}
```

Topics are never touched by a deploy; managed files (`site-template/` → site `assets/`,
`docs/`, `AGENTS.md`, `client/` incl. the skill) are re-copied on every start, so clients
installing with `curl …/client/install.sh` get the new CLI and skill right away.

**New host** (prerequisites: Docker with the user in the `docker` group, `rsync`, `flock`,
`crontab`, and the NAS mounted over NFS at the backup dir — `backup.sh` refuses to write to
a non-NFS dir so a missing mount can't fill the local disk):

1. Put host-specific values in `deploy/config.local.env` (git-ignored; overrides
   `deploy/config.env`): at least `PUBLIC_URL=http://<host>:8090`, and `DATA_ROOT` /
   `SITE_DIR` / `BACKUP_DIR` if the paths differ.
2. `bash deploy/install-server.sh`, then check `crontab -l` shows the
   `# >>> ai-platform-report` block and `ls $BACKUP_DIR/snapshots` has a first snapshot.
3. To move existing reports, copy the old `SITE_DIR` (or a NAS snapshot:
   `$BACKUP_DIR/latest/`) into the new `SITE_DIR` before step 2.

Restore / backup-now / logs: see the operations table in `README.md`.

## Layout

| Path | What |
|---|---|
| `server/app.py` | the server: static files + write API + all index generation (stdlib) |
| `server/Dockerfile` | image (python:3.12-slim, no pip) |
| `site-template/` | managed layer copied into the site: `AGENTS.md` + `docs/` (format authority for report authors), `assets/` (CSS, markdown-it, components) |
| `site-template/assets/components/volume-viewer.js` | the 3D slice overlay viewer |
| `client/aireport` | CLI (stdlib; `viewer` needs numpy + nibabel/SimpleITK) |
| `client/install.sh` | installs CLI + skill for Claude Code and Codex |
| `skills/pl-report/SKILL.md` | the skill (same file for both agents) |
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
