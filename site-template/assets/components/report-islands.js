/* Single-File HTML + Data Islands renderer for experiment reports.
 *
 * An experiment page embeds its content as inert <script> "data islands"
 * (W3C HTML §4.12: a <script> with a non-executable type is a data block,
 * ignored by the JS engine, readable via .textContent). This renderer reads
 * them on load — no build step, no fetch (works over file://). It is the
 * source of truth for both island formats below — keep this header in sync.
 *
 *   <script type="text/markdown" data-md> … </script>
 *     → CommonMark prose, rendered in place via vendored markdown-it into a
 *       <div class="prose">. markdown-it.min.js must load (defer) BEFORE this
 *       file. Authoring rules (4-space nesting, %20 in image names, headings
 *       start at ###): see docs/markdown-rules.md.
 *
 *   <script type="application/json" class="metrics-island"> … </script>
 *     (attribute `data-metrics` also accepted) → interactive metrics table,
 *     inserted right after the island. JSON schema:
 *
 *       {
 *         "experiments": [ { "id": "exp_a", "name": "Baseline" }, … ],   // column groups
 *         "metrics":     [ { "key": "dsc", "label": "DSC",
 *                            "better": "higher", "decimals": 4 }, … ],
 *         "rows":        [ { "roi": "Lung",
 *                            "exp_a": { "dsc": 0.95, "hd95": 2.1 }, … }, … ],
 *         "total":       null,                 // null → column-mean Total row;
 *                                              // or { "exp_a": { … }, … } to supply it
 *         "caption":     "optional **markdown** caption"
 *       }
 *
 *     Mounted as a .report-block holding a collapsible filter box (a native
 *     <details class="controls-details"> whose <summary> toggles the Metric /
 *     Experiment checkbox .controls), the full-width .metrics table beneath it,
 *     and an optional full-width caption last. Collapsed by default to minimize
 *     footprint; the checkboxes stay in the DOM while collapsed so filtering,
 *     highlighting, and resize wiring all keep working.
 *
 *     Behavior (all automatic): metric + experiment filter checkboxes; per-row
 *     best (★) / second-best (underline); `better` controls direction
 *     (hd95/hd/dist/asd default lower-is-better); empty cells skipped; "inf"
 *     ranks worst; ties bold all; a single experiment gets no highlighting.
 */
(function () {
  // Vendored markdown-it (CommonMark), loaded via <script src> before this file.
  var MD = (typeof window !== "undefined" && window.markdownit)
    ? window.markdownit({ html: true, linkify: true, typographer: false })
    : null;

  document.querySelectorAll('script[type="text/markdown"][data-md]').forEach(renderMarkdownIsland);
  document.querySelectorAll('script[type="application/json"].metrics-island, script[type="application/json"][data-metrics]').forEach(renderMetricsIsland);

  /* ------------------------------ metrics ------------------------------ */
  function renderMetricsIsland(island) {
    var spec;
    try { spec = JSON.parse(island.textContent); }
    catch (e) { return mountError(island, "metrics-data JSON parse error: " + e.message); }

    var exps = spec.experiments || [];
    var metrics = spec.metrics || [];
    var rows = spec.rows || [];
    if (!exps.length || !metrics.length) return mountError(island, "metrics-data needs experiments[] and metrics[]");

    var total = spec.total || computeTotals(exps, metrics, rows);

    var host = document.createElement("div");
    host.className = "report-block";

    // ---- controls (collapsible filter box above the table) ----
    var controls = '<details class="controls-details">';
    controls += '<summary class="controls-summary">Filters</summary>';
    controls += '<div class="controls">';
    controls += '<div class="group"><span class="group-label">Metric</span>' +
      metrics.map(function (m) {
        return '<label class="chk"><input type="checkbox" data-metric="' + esc(m.key) + '" checked> ' + esc(m.label || m.key) + "</label>";
      }).join("") + "</div>";
    if (exps.length > 1) {
      controls += '<div class="group"><span class="group-label">Experiment</span>' +
        exps.map(function (x) {
          return '<label class="chk"><input type="checkbox" data-exp="' + esc(x.id) + '" checked> ' + esc(x.name || x.id) + "</label>";
        }).join("") + "</div>";
    }
    controls += "</div></details>";

    // ---- colgroup (one <col> per leaf column; carries resizable widths) ----
    var colgroup = "<colgroup><col class='col-roi'>";
    exps.forEach(function (x) {
      metrics.forEach(function (m) {
        colgroup += "<col data-exp='" + esc(x.id) + "' data-metric='" + esc(m.key) + "'>";
      });
    });
    colgroup += "</colgroup>";

    // ---- table ----
    var thead = "<thead><tr><th rowspan='2' class='roi' data-col='0'>ROI<span class='col-resizer'></span></th>";
    exps.forEach(function (x, i) {
      thead += "<th colspan='" + metrics.length + "' class='exp-group exp-" + tint(i) + "' data-exp='" + esc(x.id) + "'>" + esc(x.name || x.id) + "</th>";
    });
    thead += "</tr><tr>";
    var colIdx = 1;
    exps.forEach(function (x) {
      metrics.forEach(function (m) {
        thead += "<th data-exp='" + esc(x.id) + "' data-metric='" + esc(m.key) + "' data-col='" + colIdx + "'>" + esc(m.label || m.key) + "<span class='col-resizer'></span></th>";
        colIdx++;
      });
    });
    thead += "</tr></thead>";

    var tbody = "<tbody>";
    rows.forEach(function (r) { tbody += rowHtml(r.roi, r, exps, metrics, false); });
    tbody += rowHtml(total.roi || "Total", total, exps, metrics, true);
    tbody += "</tbody>";

    host.innerHTML = controls + '<div class="table-scroll"><table class="metrics">' + colgroup + thead + tbody + "</table></div>";
    if (spec.caption) host.insertAdjacentHTML("beforeend", '<div class="callout">' + (MD ? MD.renderInline(spec.caption) : esc(spec.caption)) + "</div>");

    island.parentNode.insertBefore(host, island.nextSibling);

    var state = { metric: {}, exp: {} };
    metrics.forEach(function (m) { state.metric[m.key] = true; });
    exps.forEach(function (x) { state.exp[x.id] = true; });
    host.querySelectorAll("input[data-metric]").forEach(function (inp) {
      inp.addEventListener("change", function () { state.metric[inp.dataset.metric] = inp.checked; applyFilter(host, state); });
    });
    host.querySelectorAll("input[data-exp]").forEach(function (inp) {
      inp.addEventListener("change", function () { state.exp[inp.dataset.exp] = inp.checked; applyFilter(host, state); });
    });
    setupColumnResize(host);
    highlight(host, exps, metrics);
    applyFilter(host, state);
  }

  // Freeze the natural column widths into <col> elements, switch to a fixed
  // layout (so widths are honored predictably), then let the header grips drag
  // each column wider/narrower. Width lives on the <col>, so every row follows.
  function setupColumnResize(host) {
    var table = host.querySelector("table.metrics");
    if (!table) return;
    var cols = [].slice.call(table.querySelectorAll("colgroup > col"));
    var heads = [].slice.call(table.querySelectorAll("th[data-col]"));
    if (!cols.length || !heads.length) return;

    heads.forEach(function (th) {
      var col = cols[+th.dataset.col];
      if (col) col.style.width = Math.round(th.getBoundingClientRect().width) + "px";
    });
    table.classList.add("resizable");

    var drag = null;
    heads.forEach(function (th) {
      var handle = th.querySelector(".col-resizer");
      if (!handle) return;
      handle.addEventListener("mousedown", function (e) {
        var col = cols[+th.dataset.col];
        if (!col) return;
        drag = { col: col, startX: e.clientX, startW: parseFloat(col.style.width) || th.getBoundingClientRect().width };
        document.body.classList.add("col-resizing");
        e.preventDefault(); e.stopPropagation();
      });
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      drag.col.style.width = Math.max(44, drag.startW + (e.clientX - drag.startX)) + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!drag) return;
      drag = null;
      document.body.classList.remove("col-resizing");
    });
  }

  function rowHtml(label, rec, exps, metrics, isTotal) {
    var tr = "<tr" + (isTotal ? " class='total'" : "") + "><td class='roi'>" + esc(label) + "</td>";
    exps.forEach(function (x) {
      var cell = rec[x.id] || {};
      metrics.forEach(function (m) {
        var v = cell[m.key];
        if (v === undefined || v === null || v === "") {
          tr += "<td data-exp='" + esc(x.id) + "' data-metric='" + esc(m.key) + "'></td>";
        } else {
          tr += "<td data-exp='" + esc(x.id) + "' data-metric='" + esc(m.key) + "' data-value='" + esc(v) + "'>" + esc(fmt(v, m)) + "</td>";
        }
      });
    });
    return tr + "</tr>";
  }

  function computeTotals(exps, metrics, rows) {
    var total = {};
    exps.forEach(function (x) {
      total[x.id] = {};
      metrics.forEach(function (m) {
        var vals = rows.map(function (r) { return (r[x.id] || {})[m.key]; })
          .map(parseVal).filter(function (n) { return Number.isFinite(n); });
        if (vals.length) total[x.id][m.key] = round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, m);
      });
    });
    return total;
  }

  function applyFilter(host, state) {
    var table = host.querySelector("table.metrics");
    table.querySelectorAll("[data-metric]").forEach(function (cell) {
      var m = cell.dataset.metric, e = cell.dataset.exp;
      var on = (m === undefined || state.metric[m]) && (e === undefined || state.exp[e]);
      cell.classList.toggle("hidden", !on);
    });
    var span = Object.keys(state.metric).reduce(function (n, m) { return n + (state.metric[m] ? 1 : 0); }, 0);
    table.querySelectorAll(".exp-group").forEach(function (th) {
      var e = th.dataset.exp;
      if (!state.exp[e] || span === 0) { th.classList.add("hidden"); }
      else { th.classList.remove("hidden"); th.colSpan = span; }
    });
    // collapse the <col> for filtered columns so they reserve no width (fixed layout)
    table.querySelectorAll("colgroup > col[data-metric]").forEach(function (col) {
      var on = state.metric[col.dataset.metric] && state.exp[col.dataset.exp];
      if (on) {
        if (col.dataset.savedw) { col.style.width = col.dataset.savedw; delete col.dataset.savedw; }
        col.style.visibility = "";
      } else {
        if (!col.dataset.savedw && col.style.width) col.dataset.savedw = col.style.width;
        col.style.width = "0";
        col.style.visibility = "collapse";
      }
    });
  }

  function highlight(host, exps, metrics) {
    if (exps.length < 2) return;
    host.querySelectorAll("table.metrics tbody tr").forEach(function (row) {
      metrics.forEach(function (m) {
        var lowerBetter = (m.better || "").toLowerCase() === "lower" || /hd95|hd|dist|asd|msd/i.test(m.key);
        var cells = [].slice.call(row.querySelectorAll("td[data-metric='" + m.key + "']"))
          .filter(function (c) { return c.dataset.value !== undefined && c.dataset.value !== ""; })
          .map(function (c) { return { c: c, v: parseVal(c.dataset.value) }; })
          .filter(function (o) { return Number.isFinite(o.v); });
        if (cells.length < 2) return;
        var distinct = cells.map(function (o) { return o.v; }).filter(function (v, i, a) { return a.indexOf(v) === i; })
          .sort(function (a, b) { return lowerBetter ? a - b : b - a; });
        var bestVal = distinct[0], secondVal = distinct[1];
        var bestCount = cells.filter(function (o) { return o.v === bestVal; }).length;
        cells.forEach(function (o) {
          o.c.classList.remove("best", "second");
          if (o.v === bestVal) o.c.classList.add("best");
          else if (bestCount === 1 && o.v === secondVal) o.c.classList.add("second");
        });
      });
    });
  }

  /* --------------------------- markdown island --------------------------- */
  // Uses the vendored markdown-it (CommonMark) — robust nested lists, images,
  // blank lines. Loaded via <script src="markdown-it.min.js"> before this file.
  function renderMarkdownIsland(island) {
    var src = dedent(island.textContent);
    var host = document.createElement("div");
    host.className = "prose";
    if (MD) {
      host.innerHTML = MD.render(src);
    } else {
      host.innerHTML = '<div class="callout" style="border-color:#d1242f">⚠ markdown-it not loaded — include &lt;script src="…/assets/markdown-it.min.js"&gt; before report-islands.js</div><pre></pre>';
      host.querySelector("pre").textContent = src;
    }
    island.parentNode.insertBefore(host, island.nextSibling);
  }

  /* ------------------------------ helpers ------------------------------ */
  function parseVal(s) { if (s === undefined || s === null) return NaN; if (/^inf$/i.test(String(s))) return Infinity; var n = parseFloat(s); return isNaN(n) ? NaN : n; }
  function round(n, m) { var d = (m && m.decimals != null) ? m.decimals : 4; return Number(n.toFixed(d)); }
  function fmt(v, m) { if (/^inf$/i.test(String(v))) return "inf"; var n = parseFloat(v); if (isNaN(n)) return v; var d = (m && m.decimals != null) ? m.decimals : 4; return n.toFixed(d); }
  function tint(i) { return ["a", "b", "c", "d"][i % 4]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function dedent(s) {
    var lines = s.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "").split("\n");
    var indents = lines.filter(function (l) { return l.trim(); }).map(function (l) { return (/^\s*/.exec(l)[0] || "").length; });
    var min = indents.length ? Math.min.apply(null, indents) : 0;
    return lines.map(function (l) { return l.slice(min); }).join("\n");
  }
  function mountError(island, msg) {
    var d = document.createElement("div");
    d.className = "callout"; d.style.borderColor = "#d1242f"; d.textContent = "⚠ " + msg;
    island.parentNode.insertBefore(d, island.nextSibling);
  }
})();
