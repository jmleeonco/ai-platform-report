# Create an experiment page

Don't copy a skeleton by hand — `aireport new-exp <slug> --title "…"` creates
`topics/<slug>/<NN>/index.html` from the server's template and pulls it locally. This is
what it contains and what you fill in:

```html
<head>
  <meta name="report-owner" content="이종민">        <!-- shown in the topic's list -->
  <title>실험 N: title · Topic</title>
  <link rel="stylesheet" href="../../../assets/report.css">
  <style> /* hover-zoom for figures (page-local) */ </style>
</head>
<body>
<div class="wrap">
  <nav class="breadcrumb">…</nav>
  <h1 class="page-title">실험 N: title</h1>       <!-- the server reads the title from here -->

  <script type="text/markdown" data-md>
### 결론
- …
### 실험 내용
- **목적**: …
### 결과
- …
### 샘플 시각화
- …
  </script>

  <!-- optional --> <script type="application/json" class="metrics-island">{…}</script>
  <!-- default for cases --> <script type="application/json" class="vol-island" data-src="assets/case01.vol.json"></script>

  <footer class="foot"></footer>
</div>
<script src="../../../assets/markdown-it.min.js" defer></script>
<script src="../../../assets/components/report-islands.js" defer></script>
<script src="../../../assets/components/volume-viewer.js" defer></script>
<script src="../../../assets/components/editor.js" defer></script>
</body>
```

- Keep the `<h1 class="page-title">` as `실험 N: <title>`; to rename the experiment, edit it.
- Islands can be repeated and interleaved with each other (e.g. prose → viewer → prose →
  metrics). A vol-island placed between two markdown islands appears exactly there.
- Write `결론` first: one or two lines a reader can act on.

## Custom design (per-page only)

A page may need a wider column, a figure grid, a bespoke chart. **Do it inside that page's
`.html` only** — page-local CSS in the `<head>` `<style>`, page-local JS in a `<script>`
before `</body>`, inline `<svg>`, a `<canvas>`, or a library in the page's own `assets/`.
**Never** edit `assets/report.css` or `assets/components/*` for one page (they are managed
and shared; your change would be overwritten and would restyle every report).

```html
<style>
  .wrap { max-width: 1400px; }                                  /* this page only */
  .fig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .note-card { border: 1px solid var(--border); background: var(--card-bg);
    border-radius: 8px; padding: 12px 16px; }                   /* theme vars → light/dark */
</style>
```

Something many pages want is a candidate for a new shared component — propose it as a
change in the git repo (`site-template/assets/components/`), see [components.md](components.md).

## Verify before finishing

- `aireport check <dir>` → 0 errors; then `aireport push <dir>`.
- Open the printed URL: prose hierarchy correct, figures load, every vol-island shows the
  four panes (no "⚠ volume viewer" box), metrics table renders, both light and dark.
- Give the user the URL.
