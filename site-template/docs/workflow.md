# Workflow — writing a report with `aireport`

All steps work from any machine that can reach the server; nothing needs NFS or SSH.
Install the CLI first if `aireport` is missing ([setup.md](setup.md)).

## 0. Who are you?

The author name is recorded on every write and becomes the default page owner. Set it once
(Korean full name is fine):

```bash
aireport config --owner "이종민"
```

## 1. Find — or explicitly agree on — the topic

```bash
aireport suggest "liver tumor segmentation"
```

| Output | What to do |
|---|---|
| `EXISTS: topic 'x'` | Use slug `x`. |
| `NOT FOUND` + closest matches | Ask the user whether one of the matches is the right topic. |
| `NOT FOUND` + `proposed NEW topic` | Tell the user **explicitly**: "No topic matches. Create a new topic named *Liver Tumor Segmentation* with slug `liver-tumor-segmentation`?" — wait for yes or a different name. |

Only then:

```bash
aireport new-topic --slug liver-tumor-segmentation --name "Liver Tumor Segmentation" \
    --cat 실험 --kw "liver,tumor,nnU-Net" --confirmed     # optional: --overview-file overview.md
```

`--confirmed` asserts the user approved the name and slug. Slugs are lowercase ASCII
kebab-case; for a Korean topic name propose an English slug (name can stay Korean).
`aireport topics` lists everything; `aireport set <slug> --status 완료` updates metadata
(`status` ∈ 시작 전 / 진행 중 / 완료 / 일시정지 / 중단).

## 2. Create the experiment page

```bash
aireport new-exp liver-tumor-segmentation --title "nnU-Net baseline"
```

The server allocates the next number (`실험 N`), writes the skeleton, and the CLI downloads it
to a local work dir (default `~/aireport-work/<slug>/<NN>/`, override with `--dir`).
To edit an existing page instead: `aireport pull <slug>/<NN>`.

## 3. Write

In the work dir:

- `index.html` — fill the markdown island (`### 결론`, `### 실험 내용`, `### 결과`, …) per
  [markdown-rules.md](markdown-rules.md). Add a metrics island for comparison tables
  (schema: header of `assets/components/report-islands.js`).
- `assets/` — figures (real PNG/JPG), and **one `.vol.json` per showcased case**:

  ```bash
  aireport viewer --image ct.nii.gz --label gt.nii.gz --pred pred.nii.gz \
      --names "1:Liver,2:Tumor" --case LTS-017 -o ~/aireport-work/<slug>/<NN>/assets/LTS-017.vol.json
  ```

  then paste the printed `<script type="application/json" class="vol-island" …>` line where
  the case belongs in the page. Details: [volume-viewer.md](volume-viewer.md).

## 4. Check, push, verify

```bash
aireport check ~/aireport-work/<slug>/<NN>     # islands parse, refs exist, markdown rules
aireport push  ~/aireport-work/<slug>/<NN>     # assets first, page last; prints the URL
```

`push` uploads only changed files, refuses if `check` finds errors, and refuses if someone
changed the page on the server since your pull (browser editor) — pull into another dir and
merge in that case. Then open the URL and confirm it renders (prose, tables, viewers) in
light and dark. The topic's `edited` date, the root grid order, the topic's experiment list
and search are updated by the server automatically.

## Browser editing

Every page has a **✎ 편집** button: markdown and metrics islands are editable in place and
saved straight back to the server (previous version kept in `.history/`). Use it for quick
fixes; use `aireport` for anything involving files.
