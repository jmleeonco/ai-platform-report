# AI Platform Reports — Agent Guide

Static, three-level HTML report site for the AI platform team, served by the report
server at **http://10.101.1.183:8090/**. **No build step, no framework** — each page is one
`.html` whose content lives in inert data islands; shared JS/CSS renders them.

You (Claude, Codex, or a human) only write **page content**. The server owns the
bookkeeping — topic metadata, the root card grid, each topic's experiment list, the search
index, the edit history — and regenerates it on every write. Never hand-edit those.

## Contents

| Doc | What it covers |
|---|---|
| [docs/workflow.md](docs/workflow.md) | **Start here.** The `aireport` flow: find/confirm the topic → create the experiment → write → check → push → verify. |
| [docs/architecture.md](docs/architecture.md) | Three levels, directory tree, what is generated / authored / managed, asset-path rules. |
| [docs/create-experiment.md](docs/create-experiment.md) | The experiment-page skeleton, page-local custom design rules, the pre-finish checklist. |
| [docs/markdown-rules.md](docs/markdown-rules.md) | CommonMark rules for the prose island (4-space nesting, `###` headings, images). |
| [docs/volume-viewer.md](docs/volume-viewer.md) | **Sample visualization = 3D interactive slice overlay by default.** `aireport viewer` options, sizes, privacy. |
| [docs/components.md](docs/components.md) | The reusable JS in `assets/components/` (self-documenting headers: metrics-island schema, volume JSON schema). |
| [docs/setup.md](docs/setup.md) | Installing the `aireport` CLI + `pl-report` skill for Claude Code and Codex. |

## The rules that matter most

1. **Topic first, and never invent one silently.** Run `aireport suggest "<topic words>"`.
   If it reports `EXISTS`, use that slug. Otherwise show the user the closest existing topics
   **and** the proposed new name + slug, and create it (`aireport new-topic … --confirmed`)
   only after they explicitly say yes (or give a different name).
2. **Create pages through the server** (`aireport new-exp <slug> --title …`) so the
   experiment number is allocated atomically — never `mkdir topics/<slug>/<NN>` yourself.
3. **Per-case sample visualization defaults to the 3D interactive slice overlay viewer**
   (`aireport viewer` → `assets/<case>.vol.json` → `<script class="vol-island" data-src=…>`).
   Static PNG screenshots of cases are the exception (only when asked, or for 2D-only data);
   PNGs remain right for plots, curves and diagrams.
4. **Author markdown, not HTML**, inside the prose island ([markdown-rules](docs/markdown-rules.md)).
   Numbers that compare experiments go in a metrics island, not a hand-written table.
5. **Never edit shared assets** (`assets/`, `docs/`, `AGENTS.md`, `index.html`,
   `data/`) — they are managed or generated and will be overwritten. Page-specific design
   stays inside that page ([create-experiment](docs/create-experiment.md#custom-design-per-page-only)).
6. **De-identified data only.** Case IDs must be anonymized study IDs, never patient names,
   hospital MRNs or birth dates — in prose, captions, file names and `--case`.
7. **Verify over HTTP before you say "done"**: `aireport check <dir>`, `aireport push <dir>`,
   then load the printed URL (curl at minimum; a headless browser if you have one) and
   confirm the islands render. Report the URL to the user.
