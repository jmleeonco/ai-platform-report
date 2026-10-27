---
name: ai-report
description: Write, update or publish an HTML experiment report on the AI Platform report server (http://10.101.1.183:8090) with the `aireport` CLI. Use whenever the user asks to write up / report / document / publish experiment results, an evaluation, or sample visualizations, or to edit an existing report there. Covers picking or explicitly confirming the topic, creating the page, the default 3D slice-overlay viewer for cases, and verifying over HTTP.
---

# AI Platform report — core rules

The report site's own `AGENTS.md` is the authority on format; this skill is only the rules
that always hold. The `aireport` CLI talks to the server over HTTP, so this works from any
machine — no NFS, SSH or local copy.

## Rules

1. **Read the guide first.** Run `aireport guide` (the server's AGENTS.md) before writing
   any HTML, and `aireport guide workflow` / `aireport guide volume-viewer` as needed. If
   `aireport` is not installed, follow `docs/setup.md` of the ai-platform-report repo (or
   `curl -fsSL http://10.101.1.183:8090/client/install.sh | bash`).

2. **Know who is writing.** If `aireport config` shows no `owner`, ask the user for their
   name (Korean full name is fine) and save it with `aireport config --owner "<name>"`.

3. **Topic: match it, or get an explicit yes for a new one.** Run
   `aireport suggest "<topic words>"`.
   - `EXISTS` → use that slug.
   - Otherwise **tell the user plainly** that the topic does not exist, list the closest
     existing topics, and propose the new topic's **name and slug**, e.g.
     *"No topic matches. Closest: `liver-seg` (Liver Segmentation). Create a new topic
     **Liver Tumor Segmentation** (`liver-tumor-segmentation`)?"*
     Create it with `aireport new-topic … --confirmed` only after the user agrees or gives
     another name. Never pass `--confirmed` on your own judgement, and never file the report
     under a loosely related existing topic without asking.

4. **Create pages through the server**: `aireport new-exp <slug> --title "<title>"`, or
   `aireport pull <slug>/<NN>` to edit an existing one. Edit only the local work dir it
   prints; never create topic/experiment folders or edit `index.html`, `data/`, `assets/`
   or `docs/` on the server.

5. **Sample visualization defaults to the 3D interactive slice overlay.** For every case you
   show, build a volume with `aireport viewer --image … --label … --pred … -o <dir>/assets/<case>.vol.json`
   and embed the printed `vol-island` line. Use static case screenshots only if the user
   asks or the data is 2D. Plots, curves and diagrams stay PNG/SVG. Case IDs must be
   de-identified.

6. **Content in islands.** Prose goes in the markdown island (headings from `###`, 4-space
   nesting); comparison numbers in a metrics island; page-specific styling stays inside the
   page.

7. **Verify before finishing — over HTTP.** `aireport check <dir>` (0 errors) →
   `aireport push <dir>` → fetch the printed URL and confirm it renders (with a headless
   browser if available: prose, tables and every viewer, no "⚠" boxes). Then give the user
   the URL. If push reports a server-side change, pull into another dir and merge — never
   `--force` over someone else's edit without asking.
