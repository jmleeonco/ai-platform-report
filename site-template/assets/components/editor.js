/* editor.js — optional Notion-like visual editing overlay for report pages.
 *
 * The data islands stay the source of truth. report-islands.js renders them for
 * reading; this file lets a human EDIT them visually and write the page back —
 * with no build step, no dependencies, and no framework. It loads (defer) AFTER
 * report-islands.js, reuses the same vendored markdown-it for live preview, and
 * touches the live DOM only with elements tagged [data-ed] (all stripped on save).
 *
 * Activation
 *   A small "✎ 편집" button sits bottom-right. Click it (or open the page with
 *   ?edit=1) to enter edit mode. Read mode is otherwise untouched.
 *
 * What you can edit
 *   <script type="text/markdown" data-md>      → inline markdown editor + live preview.
 *   <script type="application/json" .metrics-island> → a spreadsheet-like grid
 *       (add/remove experiment columns + ROI rows, edit cells, set better/decimals,
 *       caption). No hand-typed JSON, so a stray comma can't break the island.
 *       If the existing JSON is already invalid, a raw textarea with live JSON
 *       validation appears instead — the recovery path.
 *
 * Saving (one code path, auto-escalates by environment — best available wins)
 *   1. served by the report server (server/app.py) → PUT the page back to its own
 *      URL; the server writes it IN PLACE (previous version kept in .history/),
 *      bumps the topic's edited date and re-indexes. (A read-only
 *      `python -m http.server` answers PUT with 501, so this tier self-skips.)
 *   2. else File System Access API (localhost, plain http.server) → pick the file
 *      once, then overwrite it in place.
 *   3. else file:// → re-serialize and DOWNLOAD as the same filename; replace the
 *      original on disk by hand. Keeps the no-server reading path intact.
 *   Serialization re-escapes any literal </script> inside an island to <\/script>
 *   so edited content can never collapse the island boundary in the saved file.
 */
(function () {
  if (window.__reportEditorLoaded) return;
  window.__reportEditorLoaded = true;

  var MD = window.markdownit
    ? window.markdownit({ html: true, linkify: true, typographer: false })
    : null;

  // ---- model: one entry per island, grouped by type (stable order) ----
  var islands = [];
  collectIslands();
  if (!islands.length) return; // nothing editable on this page

  injectStyles();
  var ui = makeToolbar();
  var editing = false;
  if (/[?&]edit=1(\b|&|$)/.test(location.search)) enterEdit();

  /* ------------------------------ collection ------------------------------ */
  function collectIslands() {
    qa('script[type="text/markdown"][data-md]').forEach(function (el, i) {
      islands.push({ el: el, type: "md", ti: i, content: dedent(el.textContent), panel: null });
    });
    qa('script[type="application/json"].metrics-island, script[type="application/json"][data-metrics]').forEach(function (el, i) {
      islands.push({ el: el, type: "metrics", ti: i, content: el.textContent.trim(), panel: null });
    });
  }

  /* ------------------------------- toolbar -------------------------------- */
  function makeToolbar() {
    var bar = el("div", "ed-bar", { "data-ed": "" });
    var edit = btn("✎ 편집", "ed-btn ed-primary", enterEdit);
    var saveBtn = btn("💾 저장", "ed-btn ed-primary", function () { save(); });
    var done = btn("✓ 종료", "ed-btn", exitEdit);
    saveBtn.style.display = "none";
    done.style.display = "none";
    bar._edit = edit; bar._save = saveBtn; bar._done = done;
    bar.appendChild(edit); bar.appendChild(saveBtn); bar.appendChild(done);
    document.body.appendChild(bar);
    return bar;
  }

  function enterEdit() {
    if (editing) return;
    editing = true;
    document.body.classList.add("ed-on");
    ui._edit.style.display = "none";
    ui._save.style.display = "";
    ui._done.style.display = "";
    islands.forEach(openPanel);
    toast("편집 모드 — 블록을 직접 고치고 저장하세요");
  }

  function exitEdit() {
    if (!editing) return;
    editing = false;
    document.body.classList.remove("ed-on");
    ui._edit.style.display = "";
    ui._save.style.display = "none";
    ui._done.style.display = "none";
    islands.forEach(closePanel);
  }

  /* ------------------------------- panels --------------------------------- */
  // The renderer inserted its output as the island's next element sibling.
  function rendered(isl) {
    var n = isl.el.nextElementSibling;
    return (n && (n.classList.contains("prose") || n.classList.contains("report-block"))) ? n : null;
  }

  function openPanel(isl) {
    if (isl.panel) return;
    var view = rendered(isl);
    if (view) view.style.display = "none";
    var panel = isl.type === "md" ? mdPanel(isl) : metricsPanel(isl);
    isl.panel = panel;
    var anchor = view || isl.el;
    anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  }

  function closePanel(isl) {
    if (isl.panel) { isl.panel.remove(); isl.panel = null; }
    var view = rendered(isl);
    if (view) {
      view.style.display = "";
      if (isl.type === "md" && MD) view.innerHTML = MD.render(isl.content); // reflect edits in read view
    }
  }

  /* --------------------------- markdown editor ---------------------------- */
  function mdPanel(isl) {
    var panel = el("div", "ed-panel", { "data-ed": "" });
    panel.appendChild(panelHead("마크다운", "text/markdown"));
    var split = el("div", "ed-split", { "data-ed": "" });
    var ta = el("textarea", "ed-ta", { "data-ed": "", spellcheck: "false" });
    ta.value = isl.content;
    var prev = el("div", "prose ed-prev", { "data-ed": "" });
    if (MD) prev.innerHTML = MD.render(isl.content);
    // size the raw editor to the rendered preview ("content view") height
    function fit() { var h = prev.getBoundingClientRect().height; if (h > 0) ta.style.height = h + "px"; }
    ta.addEventListener("input", function () {
      isl.content = ta.value;
      if (MD) prev.innerHTML = MD.render(ta.value);
    });
    // re-fit on initial layout, on every preview re-render, and on resize;
    // rAF is the fallback when ResizeObserver is unavailable.
    if (window.ResizeObserver) new ResizeObserver(fit).observe(prev);
    else requestAnimationFrame(fit);
    split.appendChild(ta);
    split.appendChild(prev);
    panel.appendChild(split);
    return panel;
  }

  /* ---------------------------- metrics editor ---------------------------- */
  function metricsPanel(isl) {
    var panel = el("div", "ed-panel", { "data-ed": "" });
    panel.appendChild(panelHead("메트릭 표", "metrics-island"));

    var spec;
    try { spec = JSON.parse(isl.content); }
    catch (e) { return rawJsonFallback(isl, panel, e.message); }

    spec.experiments = spec.experiments || [];
    spec.metrics = spec.metrics || [];
    spec.rows = spec.rows || [];

    var body = el("div", "ed-grid", { "data-ed": "" });
    panel.appendChild(body);

    function sync() { isl.content = JSON.stringify(spec, null, 2); }
    function rebuild() { sync(); body.innerHTML = ""; renderGrid(); }

    function renderGrid() {
      // --- experiments (columns) ---
      var expSec = section("실험 (열)");
      spec.experiments.forEach(function (x, i) {
        var row = el("div", "ed-line", { "data-ed": "" });
        row.appendChild(field("id", x.id, function (v) { x.id = v; sync(); }, "ed-mono"));
        row.appendChild(field("name", x.name, function (v) { x.name = v; sync(); }));
        row.appendChild(rm(function () { spec.experiments.splice(i, 1); rebuild(); }));
        expSec.appendChild(row);
      });
      expSec.appendChild(add("+ 실험", function () {
        spec.experiments.push({ id: "exp" + (spec.experiments.length + 1), name: "" });
        rebuild();
      }));
      body.appendChild(expSec);

      // --- metrics ---
      var mSec = section("지표");
      spec.metrics.forEach(function (m, i) {
        var row = el("div", "ed-line", { "data-ed": "" });
        row.appendChild(field("key", m.key, function (v) { m.key = v; sync(); }, "ed-mono"));
        row.appendChild(field("label", m.label, function (v) { m.label = v; sync(); }));
        row.appendChild(select("better", ["higher", "lower"], m.better || "higher", function (v) { m.better = v; sync(); }));
        row.appendChild(numField("decimals", m.decimals == null ? 4 : m.decimals, function (v) { m.decimals = v; sync(); }));
        row.appendChild(rm(function () { spec.metrics.splice(i, 1); rebuild(); }));
        mSec.appendChild(row);
      });
      mSec.appendChild(add("+ 지표", function () {
        spec.metrics.push({ key: "metric" + (spec.metrics.length + 1), label: "", better: "higher", decimals: 4 });
        rebuild();
      }));
      body.appendChild(mSec);

      // --- rows (ROI × exp×metric cells) ---
      var rSec = section("행 (ROI × 값)");
      var tbl = el("table", "ed-cells", { "data-ed": "" });
      var thead = "<thead><tr><th>ROI</th>";
      spec.experiments.forEach(function (x) {
        spec.metrics.forEach(function (m) {
          thead += "<th>" + esc(x.name || x.id) + "<br><span class='ed-sub'>" + esc(m.label || m.key) + "</span></th>";
        });
      });
      thead += "<th></th></tr></thead>";
      tbl.innerHTML = thead;
      var tbody = el("tbody", "", { "data-ed": "" });
      spec.rows.forEach(function (r, ri) {
        var tr = el("tr", "", { "data-ed": "" });
        tr.appendChild(cellInput(r.roi, "ed-mono", function (v) { r.roi = v; sync(); }));
        spec.experiments.forEach(function (x) {
          r[x.id] = r[x.id] || {};
          spec.metrics.forEach(function (m) {
            var cur = r[x.id][m.key];
            tr.appendChild(cellInput(cur == null ? "" : cur, "ed-num", function (v) {
              if (v === "") delete r[x.id][m.key];
              else { var n = parseFloat(v); r[x.id][m.key] = (/^inf$/i.test(v) ? "inf" : (isNaN(n) ? v : n)); }
              sync();
            }));
          });
        });
        var del = el("td", "", { "data-ed": "" });
        del.appendChild(rm(function () { spec.rows.splice(ri, 1); rebuild(); }));
        tr.appendChild(del);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      rSec.appendChild(tbl);
      rSec.appendChild(add("+ 행", function () {
        var r = { roi: "" };
        spec.experiments.forEach(function (x) { r[x.id] = {}; });
        spec.rows.push(r);
        rebuild();
      }));
      body.appendChild(rSec);

      // --- total mode + caption ---
      var meta = section("기타");
      var totWrap = el("label", "ed-fieldlabel", { "data-ed": "" });
      totWrap.textContent = "Total 행 자동 계산(열 평균)";
      var totChk = el("input", "", { "data-ed": "", type: "checkbox" });
      totChk.checked = (spec.total === null || spec.total === undefined);
      totChk.addEventListener("change", function () {
        if (totChk.checked) spec.total = null; else delete spec.total;
        sync();
      });
      totWrap.insertBefore(totChk, totWrap.firstChild);
      meta.appendChild(totWrap);
      if (spec.total && typeof spec.total === "object") {
        meta.appendChild(note("custom total 객체가 있어 그대로 보존됩니다 (체크 해제 시에도 유지)"));
      }
      var cap = el("textarea", "ed-ta ed-cap", { "data-ed": "", spellcheck: "false", placeholder: "caption (markdown)" });
      cap.value = spec.caption || "";
      cap.addEventListener("input", function () { spec.caption = cap.value; sync(); autoGrowOne(cap); });
      autoGrow(cap);
      meta.appendChild(cap);
      body.appendChild(meta);

      // --- JSON validity indicator ---
      var ok = el("div", "ed-ok", { "data-ed": "" });
      ok.textContent = "✓ JSON 유효 (저장 시 그대로 기록됩니다)";
      body.appendChild(ok);
    }

    renderGrid();
    sync();
    return panel;
  }

  function rawJsonFallback(isl, panel, errMsg) {
    panel.appendChild(note("⚠ 기존 JSON 파싱 실패: " + errMsg + " — 아래에서 직접 고치세요 (실시간 검증)."));
    var ta = el("textarea", "ed-ta ed-mono", { "data-ed": "", spellcheck: "false" });
    ta.value = isl.content;
    var status = el("div", "ed-ok", { "data-ed": "" });
    function check() {
      try { JSON.parse(ta.value); status.textContent = "✓ JSON 유효"; status.classList.remove("bad"); }
      catch (e) { status.textContent = "✗ " + e.message; status.classList.add("bad"); }
    }
    ta.addEventListener("input", function () { isl.content = ta.value; check(); autoGrowOne(ta); });
    autoGrow(ta);
    check();
    panel.appendChild(ta);
    panel.appendChild(status);
    return panel;
  }

  /* ------------------------------- saving --------------------------------- */
  function serialize() {
    var root = document.documentElement.cloneNode(true);
    // strip everything this editor injected
    qa("[data-ed]", root).forEach(function (n) { n.remove(); });
    // strip renderer-injected render blocks (they regenerate on next load)
    // (.prose / .report-block from report-islands.js; [data-rendered] from any other
    //  component, e.g. volume-viewer.js — components never consume their island)
    qa(".prose, .report-block, [data-rendered]", root).forEach(function (n) { n.remove(); });
    // strip standalone error callouts the renderer drops right after an island
    qa(".callout", root).forEach(function (n) {
      var p = n.previousElementSibling;
      if (p && p.tagName === "SCRIPT" && /markdown|json/.test(p.getAttribute("type") || "")) n.remove();
    });
    // write edited island contents back from the model
    var md = qa('script[type="text/markdown"][data-md]', root);
    var mx = qa('script[type="application/json"].metrics-island, script[type="application/json"][data-metrics]', root);
    islands.forEach(function (isl) {
      var target = (isl.type === "md" ? md : mx)[isl.ti];
      if (target) target.textContent = "\n" + guard(isl.content) + "\n";
    });
    return "<!DOCTYPE html>\n" + root.outerHTML + "\n";
  }

  async function save() {
    var html = serialize();
    var name = location.pathname.split("/").pop() || "index.html";

    // Tier 1 — the report server (server/app.py): true in-place save, no dialog ever.
    // A read-only `python -m http.server` answers PUT with 501 → res.ok false → fall through.
    if (/^https?:$/.test(location.protocol)) {
      try {
        var res = await fetch(location.pathname, {
          method: "PUT",
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: html
        });
        if (res.ok) { toast("저장됨 — 서버에 저장"); return; }
      } catch (e) { /* no writable server reachable → fall through */ }
    }

    // Tier 2 — File System Access API (localhost without the report server): pick the file once.
    if (window.showSaveFilePicker) {
      try {
        if (!window.__edHandle) {
          window.__edHandle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }]
          });
        }
        var w = await window.__edHandle.createWritable();
        await w.write(html);
        await w.close();
        toast("저장됨 — 선택한 파일에 덮어쓰기");
        return;
      } catch (e) {
        window.__edHandle = null;
        if (e && e.name === "AbortError") return; // user cancelled the picker
        // any other failure → fall through to download
      }
    }

    // Tier 3 — download (file:// double-click).
    download(name, html);
    toast("다운로드됨 — 원본 위치에 교체하세요");
  }

  function download(name, text) {
    var blob = new Blob([text], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    var a = el("a", "", { "data-ed": "", href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ------------------------------- helpers -------------------------------- */
  function qa(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function btn(label, cls, onclick) { var b = el("button", cls, { "data-ed": "", type: "button" }); b.textContent = label; b.addEventListener("click", onclick); return b; }
  function panelHead(label, tag) {
    var h = el("div", "ed-head", { "data-ed": "" });
    h.innerHTML = esc(label) + ' <span class="ed-tag">' + esc(tag) + "</span>";
    return h;
  }
  function section(title) {
    var s = el("div", "ed-sec", { "data-ed": "" });
    var h = el("div", "ed-sec-title", { "data-ed": "" });
    h.textContent = title;
    s.appendChild(h);
    return s;
  }
  function field(label, val, onchange, extra) {
    var w = el("label", "ed-f", { "data-ed": "" });
    w.appendChild(txt(label));
    var i = el("input", "ed-in " + (extra || ""), { "data-ed": "", type: "text", value: val == null ? "" : val });
    i.addEventListener("input", function () { onchange(i.value); });
    w.appendChild(i);
    return w;
  }
  function numField(label, val, onchange) {
    var w = el("label", "ed-f", { "data-ed": "" });
    w.appendChild(txt(label));
    var i = el("input", "ed-in ed-num", { "data-ed": "", type: "number", min: "0", step: "1", value: val });
    i.addEventListener("input", function () { onchange(i.value === "" ? 4 : parseInt(i.value, 10)); });
    w.appendChild(i);
    return w;
  }
  function select(label, opts, val, onchange) {
    var w = el("label", "ed-f", { "data-ed": "" });
    w.appendChild(txt(label));
    var s = el("select", "ed-in", { "data-ed": "" });
    opts.forEach(function (o) {
      var op = el("option", "", { value: o });
      op.textContent = o;
      if (o === val) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener("change", function () { onchange(s.value); });
    w.appendChild(s);
    return w;
  }
  function cellInput(val, cls, onchange) {
    var td = el("td", "", { "data-ed": "" });
    var i = el("input", "ed-cell " + (cls || ""), { "data-ed": "", type: "text", value: val == null ? "" : val });
    i.addEventListener("input", function () { onchange(i.value); });
    td.appendChild(i);
    return td;
  }
  function rm(onclick) { return btn("✕", "ed-x", onclick); }
  function add(label, onclick) { var b = btn(label, "ed-add", onclick); return b; }
  function note(text) { var n = el("div", "ed-note", { "data-ed": "" }); n.textContent = text; return n; }
  function txt(s) { var n = el("span", "ed-lab", { "data-ed": "" }); n.textContent = s; return n; }
  function autoGrow(ta) { autoGrowOne(ta); ta.addEventListener("input", function () { autoGrowOne(ta); }); }
  function autoGrowOne(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 4, 640) + "px"; }
  function guard(s) { return String(s).replace(/<\/(script)/gi, "<\\/$1"); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function dedent(s) {
    var lines = s.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "").split("\n");
    var ind = lines.filter(function (l) { return l.trim(); }).map(function (l) { return (/^\s*/.exec(l)[0] || "").length; });
    var min = ind.length ? Math.min.apply(null, ind) : 0;
    return lines.map(function (l) { return l.slice(min); }).join("\n");
  }
  function toast(msg) {
    var t = el("div", "ed-toast", { "data-ed": "" });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  /* -------------------------------- styles -------------------------------- */
  function injectStyles() {
    var css =
      ".ed-bar{position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;gap:8px;}" +
      ".ed-btn{font:600 0.85em/1 inherit;padding:10px 14px;border-radius:999px;border:1px solid var(--border);" +
      "background:var(--card-bg);color:var(--fg);box-shadow:var(--shadow);cursor:pointer;}" +
      ".ed-btn:hover{border-color:var(--accent);}" +
      ".ed-primary{background:var(--accent);color:#fff;border-color:var(--accent);}" +
      ".ed-panel{border:1px dashed var(--accent);border-radius:10px;margin:10px 0 18px;padding:10px 12px;background:var(--stripe);}" +
      ".ed-head{font-weight:700;font-size:0.85em;color:var(--muted);margin-bottom:8px;}" +
      ".ed-tag{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:0.92em;color:var(--accent);" +
      "background:var(--accent-soft);padding:1px 7px;border-radius:999px;margin-left:6px;}" +
      ".ed-split{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;}" +
      ".ed-split>*{flex:1 1 320px;min-width:0;}" +
      ".ed-ta{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em;line-height:1.5;" +
      "padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);resize:vertical;}" +
      ".ed-split>.ed-ta{min-height:40px;}" +
      ".ed-ta:focus,.ed-in:focus,.ed-cell:focus{outline:none;border-color:var(--accent);}" +
      ".ed-prev{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:4px 14px;}" +
      ".ed-cap{margin-top:6px;}" +
      ".ed-sec{margin:12px 0;}" +
      ".ed-sec-title{font-weight:700;font-size:0.8em;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:6px;}" +
      ".ed-line{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin:6px 0;}" +
      ".ed-f{display:flex;flex-direction:column;gap:2px;}" +
      ".ed-lab{font-size:0.72em;color:var(--muted);}" +
      ".ed-in{font:inherit;font-size:0.85em;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}" +
      ".ed-mono{font-family:ui-monospace,Menlo,monospace;}" +
      ".ed-num{width:88px;text-align:right;}" +
      ".ed-cells{border-collapse:collapse;font-size:0.82em;display:block;overflow-x:auto;max-width:100%;}" +
      ".ed-cells th,.ed-cells td{border:1px solid var(--border);padding:3px 5px;text-align:center;}" +
      ".ed-cells thead th{background:var(--head-bg);font-weight:700;white-space:nowrap;}" +
      ".ed-sub{font-weight:500;color:var(--muted);font-size:0.85em;}" +
      ".ed-cell{font:inherit;font-size:0.95em;width:84px;padding:3px 5px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--fg);text-align:center;}" +
      ".ed-cell:hover{border-color:var(--border);}" +
      ".ed-cell.ed-num{text-align:right;}" +
      ".ed-x{border:1px solid var(--border);background:var(--bg);color:var(--muted);border-radius:6px;cursor:pointer;padding:3px 8px;font-size:0.85em;}" +
      ".ed-x:hover{border-color:#cf222e;color:#cf222e;}" +
      ".ed-add{display:inline-block;margin-top:6px;border:1px dashed var(--border);background:transparent;color:var(--accent);" +
      "border-radius:8px;cursor:pointer;padding:5px 12px;font:600 0.82em/1 inherit;}" +
      ".ed-add:hover{border-color:var(--accent);background:var(--accent-soft);}" +
      ".ed-fieldlabel{display:flex;align-items:center;gap:8px;font-size:0.85em;}" +
      ".ed-ok{margin-top:8px;font-size:0.8em;color:#1a7f37;font-weight:600;}" +
      ".ed-ok.bad{color:#cf222e;}" +
      ".ed-note{font-size:0.82em;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:6px 0;}" +
      ".ed-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%) translateY(8px);z-index:10000;" +
      "background:var(--fg);color:var(--bg);padding:9px 16px;border-radius:8px;font-size:0.85em;font-weight:600;" +
      "opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;box-shadow:var(--shadow);}" +
      ".ed-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}";
    var st = el("style", "", { "data-ed": "" });
    st.textContent = css;
    document.head.appendChild(st);
  }
})();
