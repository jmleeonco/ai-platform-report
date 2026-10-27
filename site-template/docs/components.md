# Reusable components

Shared JavaScript lives in **`assets/components/`**. Each file is dependency-free and is its
**own source of truth**: usage, options and data schemas are in the header comment at the
top of the file. Open the component to learn how to use it.

| Component | Island / markup | Notes |
|---|---|---|
| `report-islands.js` | `text/markdown data-md`, `.metrics-island` | metrics-island JSON schema in its header |
| `volume-viewer.js` | `.vol-island` | 3D slice overlay viewer; volume JSON schema in its header |
| `editor.js` | (all islands) | ✎ 편집 button; saves back to the server with PUT |
| `exp-sort.js` | `.exp-list` | topic page: latest experiment first, count badge |
| `search.js` | `#search` | root index search over `data/search-index.json` |

## Adding or changing a component

Components are **managed**: the server copies `site-template/assets/` from the git repo on
every start, so edits made on the server are lost. To add one:

1. Add `site-template/assets/components/your-component.js` in the repo, opening with a
   header comment documenting the markup it looks for and any JSON schema.
2. If it renders an island, insert output **after** the island, mark the output element
   with `data-rendered`, and never remove the island — `editor.js` strips `[data-rendered]`
   on save so the page round-trips cleanly.
3. Reference it from pages after any library it depends on (`defer` keeps order); if every
   new page should load it, add it to the experiment template in `server/app.py`.
4. Redeploy (`deploy/install-server.sh`).
