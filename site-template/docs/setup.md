# Setup — `aireport` CLI + `pl-report` skill (Claude Code & Codex)

## One line, from any machine on the network

```bash
curl -fsSL https://plreport.oncosoft.io/client/install.sh | AIREPORT_OWNER="이종민" bash
```

This installs:

| What | Where |
|---|---|
| `aireport` CLI (Python 3 stdlib) | `~/.local/bin/aireport` |
| skill for Claude Code | `~/.claude/skills/pl-report/SKILL.md` → `/pl-report`, or just ask "리포트 써줘" |
| skill for Codex | `~/.codex/skills/pl-report/SKILL.md` → `$pl-report`, or just ask |
| config | `~/.config/aireport/config.json` (server URL, your name) |

`aireport viewer` additionally needs `pip install numpy nibabel scipy` (or SimpleITK for
NRRD/MHA/DICOM); everything else is stdlib.

## From the git repo

```bash
git clone https://github.com/jmleeonco/ai-platform-report.git && cd ai-platform-report
bash client/install.sh                 # copies; LINK=1 bash client/install.sh symlinks (git pull updates)
```

Or tell your agent: *"Set up the pl-report skill from this repo"* — the repo's `AGENTS.md`
tells Claude / Codex exactly what to run.

## Check it works

```bash
aireport health          # server reachable?
aireport topics          # what exists
aireport guide           # the format guide your agent reads
```

Environment overrides: `AIREPORT_URL`, `AIREPORT_OWNER`, `AIREPORT_TOKEN` (if the server
requires one), `AIREPORT_WORKDIR` (default `~/aireport-work`).
