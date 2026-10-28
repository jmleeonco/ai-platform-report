# ai-platform-report

HTML experiment reports for the Oncosoft AI platform team — one place where every
researcher (or their Claude / Codex agent) writes up experiments, with a 3D interactive
slice viewer for cases built in.

**Site: http://10.101.1.183:8090/**

> **🤖 AI agent (Claude Code / Codex) given this repo URL to install / add / set up?**
> Install the **`pl-report`** skill + `aireport` CLI — no clone needed:
>
> 1. Ask the user for their name (Korean full name is fine), unless they already gave it.
> 2. Run (installs for both Claude Code and Codex; safe to re-run):
>    ```bash
>    curl -fsSL https://raw.githubusercontent.com/jmleeonco/ai-platform-report/main/client/install.sh | AIREPORT_OWNER="<name>" bash
>    ```
> 3. Check: `~/.local/bin/aireport health` prints `"ok": true` (needs the office network).
>    For the 3D case viewer also `python3 -m pip install --user numpy scipy nibabel`.
> 4. Tell the user it's installed and to **restart Claude Code / Codex**; then `/pl-report`
>    (Claude Code) or `$pl-report` (Codex), or just "리포트 써줘".
>
> Details, options and server deployment: [AGENTS.md](AGENTS.md).

```
researcher ──"리포트 써줘"──▶ Claude / Codex ──pl-report skill──▶ aireport CLI ──HTTP──▶ report server ──nightly──▶ NAS
                                                                                      (10.101.1.183:8090)       /mnt/ai-platform-report
```

## For researchers

Install once (any machine on the network) — give your agent the repo URL:

> https://github.com/jmleeonco/ai-platform-report 설치해줘

or run the installer yourself:

```bash
curl -fsSL http://10.101.1.183:8090/client/install.sh | AIREPORT_OWNER="이종민" bash
```

Restart Claude Code / Codex, then use **`/pl-report`** (Claude Code) or **`$pl-report`**
(Codex) — or just ask ("이번 실험 결과 리포트로 정리해줘"). By hand:

```bash
aireport suggest "liver tumor segmentation"            # existing topic? otherwise a proposed name/slug
aireport new-topic --slug liver-tumor-seg --name "Liver Tumor Segmentation" --confirmed
aireport new-exp liver-tumor-seg --title "nnU-Net baseline"     # → ~/aireport-work/liver-tumor-seg/01/
aireport viewer --image ct.nii.gz --label gt.nii.gz --pred pred.nii.gz --names "1:Liver,2:Tumor" \
    -o ~/aireport-work/liver-tumor-seg/01/assets/case01.vol.json
# edit index.html: markdown island + <script class="vol-island" data-src="assets/case01.vol.json">
aireport push ~/aireport-work/liver-tumor-seg/01                  # → URL
```

- **Topics are explicit.** If the topic doesn't exist the agent shows you the closest
  topics and a proposed name + slug, and creates it only after you agree.
- **Cases are shown in 3D by default**: axial / sagittal / coronal slices with GT (fill)
  and prediction (contour) overlays, linked crosshair, window/level, and a rotatable 3D
  pane with label surfaces.
- **Everything else is automatic**: experiment numbering, topic list, root index ordering,
  search, edit history. Quick text fixes: the ✎ 편집 button on any page.

Guides: [site docs](http://10.101.1.183:8090/docs/index.html) (source in `site-template/docs/`).

## For agents

`AGENTS.md` (read by Codex; `CLAUDE.md` imports it for Claude Code) is the entry point: how
to set up the `pl-report` skill on any machine, write reports, and deploy / move the
server. The skill itself: `skills/pl-report/SKILL.md` (one file for both agents).

## Server operations (10.101.1.183)

| | |
|---|---|
| Deploy / upgrade | `bash deploy/install-server.sh` (no sudo; Docker + user cron) |
| Container | `ai-platform-report` (`--restart always`), port 8090 |
| Live data | `/home/ubuntu/ai-platform-report-data/site` |
| Edit history | `<site>/.history/` (every overwritten file + `log.jsonl` of who wrote what) |
| Nightly backup | 02:30 KST → `/mnt/ai-platform-report/snapshots/<timestamp>/` (hard-linked rsync snapshots, newest 90 kept), log `/home/ubuntu/ai-platform-report-data/logs/backup.log` |
| Backup now | `bash /home/ubuntu/ai-platform-report-data/bin/backup.sh` |
| Restore a topic | `cp -a /mnt/ai-platform-report/latest/topics/<slug> /home/ubuntu/ai-platform-report-data/site/topics/` then `curl -X POST http://127.0.0.1:8090/api/reindex` (if the topic itself was lost, also restore its entry in `data/topics-meta.json`) |
| Tests | `python3 -m unittest discover -s tests` |

## Layout

```
server/            app.py (server + API, stdlib) · Dockerfile
site-template/     managed layer copied into the site on start: AGENTS.md, docs/, assets/
client/            aireport CLI · install.sh (CLI + skill for Claude Code and Codex)
skills/pl-report/  SKILL.md
deploy/            install-server.sh · backup.sh · config.env
tests/
```
