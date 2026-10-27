/* volume-viewer.js — dependency-free 3D slice viewer with segmentation overlays.
 *
 * THE DEFAULT WAY TO SHOW SAMPLES (cases) IN A REPORT. Four linked panes:
 * Axial / Sagittal / Coronal slices with the label overlay, plus a 3D pane that
 * places the three current slices in space together with the label surfaces.
 *
 * Markup — a data island anywhere in the page. The island stays in the page (so
 * editor.js can save it untouched); the viewer is inserted right after it as a
 * <div class="volv" data-rendered> block, which editor.js strips on save.
 *
 *   <script type="application/json" class="vol-island" data-src="assets/case01.vol.json"></script>
 *   <script type="application/json" class="vol-island" data-height="560">{ …inline volume JSON… }</script>
 *
 *   data-src     relative URL of a volume JSON file (normally under the page's assets/).
 *                Fetched lazily when the viewer scrolls into view (needs http, not file://).
 *   data-height  total viewer height in px (default 620).
 *   (no data-src) → the island's own text is the volume JSON (works over file://).
 *
 * Volume JSON ("aireport-volume/1") — produce it with `aireport viewer`, never by hand:
 *   {
 *     "format": "aireport-volume/1",
 *     "case": "case01",                     // shown in the toolbar
 *     "caption": "optional plain text",      // shown under the viewer
 *     "shape": [nx, ny, nz],                 // voxel index = i + nx*(j + ny*k)
 *     "spacing": [sx, sy, sz],               // mm
 *     "orientation": "RAS",                  // +i → Right, +j → Anterior, +k → Superior
 *     "image": { "dtype": "uint8", "encoding": "gzip+base64" | "base64", "data": "…",
 *                "range": [lo, hi],          // uint8 0..255 maps linearly to lo..hi (HU for CT)
 *                "modality": "CT" | "MR" | "PT" | "other",
 *                "window": [center, width] },// initial window, same units as range
 *     "overlays": [                          // 0..n label maps on the same grid, drawn in order
 *       { "name": "GT", "style": "fill" | "contour", "dtype": "uint8",
 *         "encoding": "gzip+base64", "data": "…",
 *         "labels": { "1": { "name": "Liver", "color": "#e6194b" }, … } }, …
 *     ],
 *     "cursor": [i, j, k]                    // optional initial crosshair (voxel)
 *   }
 *
 * Interaction
 *   2D panes: wheel / ↑↓ = scroll slices · click-drag = move crosshair (links all panes)
 *             right-drag (or Alt-drag) = window/level · Ctrl/⌘-wheel = zoom · Shift-drag = pan
 *   3D pane:  drag = rotate · wheel = zoom
 *   ⤢ on a pane header = maximise that pane · "Reset" restores everything.
 *   Toolbar: per-overlay show + fill/contour, overlay opacity, window presets,
 *            3D toggles (slices / hide air / surfaces). Legend chips toggle single labels.
 * Display convention is radiological (patient right on screen left, anterior up).
 * Light/dark themes follow report.css variables.
 */
(function () {
  "use strict";
  if (window.__volumeViewerLoaded) return;
  window.__volumeViewerLoaded = true;

  var PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6",
    "#bfef45", "#fabed4", "#469990", "#dcbeff", "#9a6324", "#fffac8", "#800000", "#aaffc3",
    "#808000", "#ffd8b1", "#000075"];
  var CT_PRESETS = [["Soft tissue", 40, 400], ["Lung", -600, 1500], ["Bone", 400, 1800], ["Brain", 40, 80]];
  // plane: fixed axis, column axis, row axis (all display axes are flipped: radiological view)
  var PLANES = {
    axial:    { f: 2, ca: 0, ra: 1, label: "Axial",    tag: ["R", "L", "A", "P"], color: "#e5484d" },
    sagittal: { f: 0, ca: 1, ra: 2, label: "Sagittal", tag: ["A", "P", "S", "I"], color: "#e8b100" },
    coronal:  { f: 1, ca: 0, ra: 2, label: "Coronal",  tag: ["R", "L", "S", "I"], color: "#30a46c" }
  };
  var ORDER = ["axial", "sagittal", "coronal"];
  var AXIS_PLANE = ["sagittal", "coronal", "axial"]; // plane whose fixed axis is 0 / 1 / 2

  /* ------------------------------ decoding ------------------------------ */
  function b64ToBytes(s) {
    var bin = atob(s.replace(/\s+/g, "")), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function decodeField(f, expected, what) {
    if (!f || typeof f.data !== "string") throw new Error(what + ": missing data");
    if ((f.dtype || "uint8") !== "uint8") throw new Error(what + ": only uint8 is supported");
    var bytes = b64ToBytes(f.data), enc = f.encoding || "gzip+base64";
    if (enc === "gzip+base64") {
      if (typeof DecompressionStream === "undefined") throw new Error("this browser has no DecompressionStream — please update it");
      var ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(ds).arrayBuffer());
    } else if (enc !== "base64") throw new Error(what + ": unknown encoding " + enc);
    if (bytes.length !== expected) throw new Error(what + ": expected " + expected + " voxels, got " + bytes.length);
    return bytes;
  }
  function hexRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return [230, 25, 75];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  async function loadVolume(D) {
    if (!D || !D.shape || D.shape.length !== 3) throw new Error("volume JSON needs shape [nx, ny, nz]");
    var n = D.shape.map(Number), N = n[0] * n[1] * n[2];
    var sp = (D.spacing || [1, 1, 1]).map(Number);
    var img = await decodeField(D.image, N, "image");
    var range = (D.image.range || [0, 255]).map(Number);
    var ovs = [];
    for (var o = 0; o < (D.overlays || []).length; o++) {
      var od = D.overlays[o], data = await decodeField(od, N, "overlay " + (od.name || o));
      var labels = {}, ids = Object.keys(od.labels || {});
      if (!ids.length) { // derive ids from the data when the JSON gives none
        var seen = {}; for (var q = 0; q < N; q++) if (data[q]) seen[data[q]] = 1;
        ids = Object.keys(seen);
      }
      ids.forEach(function (id) {
        var L = (od.labels || {})[id] || {};
        labels[id] = { name: L.name || ("label " + id), rgb: hexRgb(L.color || PALETTE[(Math.max(1, +id || 1) - 1) % PALETTE.length]), on: true };
      });
      ovs.push({ name: od.name || ("overlay " + (o + 1)), style: od.style || (o === 0 ? "fill" : "contour"), on: true, data: data, labels: labels });
    }
    return { n: n, sp: sp, img: img, range: range, modality: (D.image.modality || "other").toUpperCase(),
      window: D.image.window, ovs: ovs, caseName: D.case || "", caption: D.caption || "", cursor: D.cursor };
  }

  /* ------------------------------- styles ------------------------------- */
  function injectStyles() {
    if (document.getElementById("volv-style")) return;
    var css = document.createElement("style"); css.id = "volv-style";
    css.textContent = [
      ".volv{--vv-bg:#0b0d10;--vv-panel:var(--card-bg,#fff);--vv-fg:var(--fg,#1f2328);--vv-muted:var(--muted,#59636e);--vv-border:var(--border,#d1d9e0);",
      "border:1px solid var(--vv-border);border-radius:10px;overflow:hidden;margin:14px 0;background:var(--vv-panel);color:var(--vv-fg);font-size:12.5px}",
      ".volv-bar{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--vv-border)}",
      ".volv-bar label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}",
      ".volv-bar select,.volv-bar button{font:inherit;font-size:12px;padding:2px 6px;border:1px solid var(--vv-border);border-radius:6px;background:var(--vv-panel);color:var(--vv-fg);cursor:pointer}",
      ".volv-bar input[type=range]{width:80px;vertical-align:middle}",
      ".volv-case{font-weight:700}.volv-grp{display:inline-flex;gap:8px;align-items:center;padding-left:10px;border-left:1px solid var(--vv-border)}",
      ".volv-grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;background:var(--vv-border)}",
      ".volv-grid.max{grid-template-columns:1fr;grid-template-rows:1fr}.volv-grid.max .volv-pane:not(.on){display:none}",
      ".volv-pane{position:relative;background:var(--vv-bg);min-height:0;min-width:0;overflow:hidden}",
      ".volv-pane canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}",
      ".volv-pane.p2d canvas{cursor:crosshair}.volv-pane.p3d canvas{cursor:grab}.volv-pane.p3d canvas:active{cursor:grabbing}",
      ".volv-ph{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:center;padding:3px 7px;",
      "font-size:11.5px;color:#e6e8eb;background:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,0));pointer-events:none;z-index:1}",
      ".volv-ph b{font-weight:700}.volv-ph button{pointer-events:auto;background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:12px;line-height:1;padding:3px 6px}",
      ".volv-legend{display:flex;flex-wrap:wrap;gap:6px;padding:7px 10px;border-top:1px solid var(--vv-border)}",
      ".volv-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--vv-border);border-radius:999px;cursor:pointer;user-select:none}",
      ".volv-chip i{width:10px;height:10px;border-radius:3px;display:inline-block}.volv-chip.off{opacity:.38;text-decoration:line-through}",
      ".volv-chip small{color:var(--vv-muted)}",
      ".volv-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:5px 10px;border-top:1px solid var(--vv-border);color:var(--vv-muted);font-size:11.5px}",
      ".volv-read{font-variant-numeric:tabular-nums}",
      ".volv-msg{padding:28px;text-align:center;color:var(--vv-muted)}.volv-msg.err{color:#cf222e;text-align:left}",
      "@media (max-width:640px){.volv-grid{grid-template-columns:1fr;grid-template-rows:repeat(4,300px)}}"
    ].join("");
    document.head.appendChild(css);
  }

  /* ------------------------------- viewer ------------------------------- */
  function Viewer(host, V, height) {
    var n = V.n, sp = V.sp, nxy = n[0] * n[1];
    var stride = [1, n[0], nxy];
    var half = [n[0] * sp[0] / 2, n[1] * sp[1] / 2, n[2] * sp[2] / 2];
    var isCT = V.modality === "CT";
    var st = {
      cur: V.cursor && V.cursor.length === 3 ? V.cursor.slice() : [n[0] >> 1, n[1] >> 1, n[2] >> 1],
      win: V.window ? V.window.slice() : (isCT ? [40, 400] : [(V.range[0] + V.range[1]) / 2, V.range[1] - V.range[0]]),
      opacity: 0.45, slices3d: true, surf3d: true, air3d: true,
      yaw: -0.55, pitch: 0.35, zoom3: 1, view: {}, max: null
    };
    var initWin = st.win.slice();
    ORDER.forEach(function (k) { st.view[k] = { zoom: 1, panX: 0, panY: 0 }; });
    if (!V.ovs.length) st.surf3d = false;
    clampCursor();

    host.innerHTML = "";
    host.style.removeProperty("min-height");
    var bar = div("volv-bar"), grid = div("volv-grid"), legend = div("volv-legend"), foot = div("volv-foot");
    host.appendChild(bar); host.appendChild(grid);
    if (V.ovs.length) host.appendChild(legend);
    host.appendChild(foot);
    grid.style.height = height + "px";

    // ---- panes ----
    var panes = {};
    ORDER.concat(["3d"]).forEach(function (key) {
      var p = div("volv-pane " + (key === "3d" ? "p3d" : "p2d"));
      var head = div("volv-ph");
      var title = document.createElement("span");
      var mx = document.createElement("button"); mx.type = "button"; mx.title = "maximise / restore"; mx.textContent = "⤢";
      head.appendChild(title); head.appendChild(mx);
      var cv = document.createElement("canvas"); cv.tabIndex = 0;
      p.appendChild(cv); p.appendChild(head); grid.appendChild(p);
      mx.addEventListener("click", function () { st.max = st.max === key ? null : key; layoutMax(); });
      panes[key] = { el: p, cv: cv, ctx: cv.getContext("2d"), title: title, key: key };
    });
    panes["3d"].title.innerHTML = "<b>3D</b> &nbsp;drag rotate · wheel zoom";

    // ---- per-plane slice buffers (texture res) ----
    var tex = {};
    ORDER.forEach(function (k) {
      var P = PLANES[k], w = n[P.ca], h = n[P.ra];
      var gc = document.createElement("canvas"); gc.width = w; gc.height = h;
      var oc = document.createElement("canvas"); oc.width = w; oc.height = h;
      tex[k] = { w: w, h: h, gray: new Uint8Array(w * h), gc: gc, oc: oc,
        gimg: gc.getContext("2d").createImageData(w, h), oimg: oc.getContext("2d").createImageData(w, h), dirty: true };
    });

    // ---- toolbar ----
    if (V.caseName) bar.appendChild(span("volv-case", V.caseName));
    V.ovs.forEach(function (ov) {
      var g = span("volv-grp", "");
      var lab = document.createElement("label"), cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = true;
      cb.addEventListener("change", function () { ov.on = cb.checked; changedOverlay(); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + ov.name));
      var sel = document.createElement("select");
      ["fill", "contour"].forEach(function (s) { var o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o); });
      sel.value = ov.style;
      sel.addEventListener("change", function () { ov.style = sel.value; changedOverlay(); });
      g.appendChild(lab); g.appendChild(sel); bar.appendChild(g);
    });
    if (V.ovs.length) {
      var og = span("volv-grp", ""), ol = document.createElement("label");
      ol.innerHTML = 'opacity <input type="range" min="0" max="1" step="0.05">';
      var orng = ol.querySelector("input"); orng.value = st.opacity;
      orng.addEventListener("input", function () { st.opacity = +orng.value; markDirty(); });
      og.appendChild(ol); bar.appendChild(og);
    }
    var wg = span("volv-grp", ""), wsel = document.createElement("select");
    var presets = (isCT ? CT_PRESETS.slice() : []);
    presets.unshift(["Initial", initWin[0], initWin[1]]);
    presets.push(["Full range", (V.range[0] + V.range[1]) / 2, V.range[1] - V.range[0]]);
    presets.forEach(function (p, i) { var o = document.createElement("option"); o.value = i; o.textContent = p[0]; wsel.appendChild(o); });
    wsel.addEventListener("change", function () { var p = presets[+wsel.value]; st.win = [p[1], p[2]]; markDirty(); });
    wg.appendChild(document.createTextNode("window ")); wg.appendChild(wsel); bar.appendChild(wg);
    var tg = span("volv-grp", "3D:");
    tg.appendChild(toggle("slices", "slices3d"));
    tg.appendChild(toggle("hide air", "air3d"));
    if (V.ovs.length) tg.appendChild(toggle("surfaces", "surf3d"));
    bar.appendChild(tg);
    var rb = document.createElement("button"); rb.type = "button"; rb.textContent = "Reset";
    rb.addEventListener("click", reset);
    bar.appendChild(rb);

    // ---- legend ----
    function buildLegend() {
      legend.innerHTML = "";
      V.ovs.forEach(function (ov) {
        Object.keys(ov.labels).forEach(function (id) {
          var L = ov.labels[id], c = span("volv-chip" + (L.on ? "" : " off"), "");
          c.innerHTML = '<i style="background:rgb(' + L.rgb.join(",") + ')"></i>' + esc(L.name) + (V.ovs.length > 1 ? " <small>" + esc(ov.name) + "</small>" : "");
          c.title = "click to show / hide";
          c.addEventListener("click", function () { L.on = !L.on; c.classList.toggle("off", !L.on); changedOverlay(); });
          legend.appendChild(c);
        });
      });
    }
    buildLegend();
    var read = span("volv-read", ""), hint = span("", "wheel: slice · drag: crosshair · right-drag: window/level · Ctrl-wheel: zoom · Shift-drag: pan");
    foot.appendChild(read); foot.appendChild(hint);
    if (V.caption) { var cap = div("volv-foot"); cap.textContent = V.caption; host.appendChild(cap); }

    // ---- overlay lookup tables (rgb + visibility per label value) ----
    var lut;
    function buildLut() {
      lut = V.ovs.map(function (ov) {
        var t = new Int16Array(256 * 3).fill(-1);
        Object.keys(ov.labels).forEach(function (id) {
          var L = ov.labels[id], v = +id;
          if (v > 0 && v < 256 && L.on) { t[v * 3] = L.rgb[0]; t[v * 3 + 1] = L.rgb[1]; t[v * 3 + 2] = L.rgb[2]; }
        });
        return t;
      });
    }
    buildLut();

    /* -------------------------- slice rendering -------------------------- */
    function grayLut() {
      var lo = st.win[0] - st.win[1] / 2, w = Math.max(1e-6, st.win[1]), r0 = V.range[0], rs = (V.range[1] - V.range[0]) / 255;
      var g = new Uint8Array(256);
      for (var v = 0; v < 256; v++) g[v] = Math.max(0, Math.min(255, Math.round(((r0 + v * rs) - lo) / w * 255)));
      return g;
    }
    function sliceGeom(k) {
      var P = PLANES[k], s = st.cur[P.f];
      return { start: s * stride[P.f] + (n[P.ca] - 1) * stride[P.ca] + (n[P.ra] - 1) * stride[P.ra], dc: -stride[P.ca], dr: -stride[P.ra] };
    }
    function renderSlice(k, glut) {
      var T = tex[k], G = sliceGeom(k), w = T.w, h = T.h, gd = T.gimg.data, od = T.oimg.data, op = st.opacity;
      var c, r, p, idx, rowIdx = G.start;
      for (r = 0; r < h; r++, rowIdx += G.dr) {
        for (c = 0, idx = rowIdx; c < w; c++, idx += G.dc) {
          p = r * w + c;
          var g = glut[V.img[idx]];
          T.gray[p] = g;
          gd[p * 4] = gd[p * 4 + 1] = gd[p * 4 + 2] = g; gd[p * 4 + 3] = 255;
          od[p * 4 + 3] = 0;
        }
      }
      for (var o = 0; o < V.ovs.length; o++) {
        var ov = V.ovs[o]; if (!ov.on) continue;
        var t = lut[o], D = ov.data, contour = ov.style === "contour";
        for (r = 0, rowIdx = G.start; r < h; r++, rowIdx += G.dr) {
          for (c = 0, idx = rowIdx; c < w; c++, idx += G.dc) {
            var v = D[idx]; if (!v || t[v * 3] < 0) continue;
            var a = op;
            if (contour) { // boundary in-plane: any 4-neighbour differs (or the slice edge)
              var edge = c === 0 || r === 0 || c === w - 1 || r === h - 1 ||
                D[idx - G.dc] !== v || D[idx + G.dc] !== v || D[idx - G.dr] !== v || D[idx + G.dr] !== v;
              if (!edge) continue;
              a = Math.min(1, 0.35 + op * 1.3);
            }
            p = (r * w + c) * 4;
            var pa = od[p + 3] / 255, na = a + pa * (1 - a);
            od[p] = (t[v * 3] * a + od[p] * pa * (1 - a)) / na;
            od[p + 1] = (t[v * 3 + 1] * a + od[p + 1] * pa * (1 - a)) / na;
            od[p + 2] = (t[v * 3 + 2] * a + od[p + 2] * pa * (1 - a)) / na;
            od[p + 3] = na * 255;
          }
        }
      }
      T.gc.getContext("2d").putImageData(T.gimg, 0, 0);
      T.oc.getContext("2d").putImageData(T.oimg, 0, 0);
      T.dirty = false;
    }

    /* ---------------------------- 2D panes ---------------------------- */
    function paneXform(k) { // texture pixel → canvas pixel
      var P = PLANES[k], T = tex[k], cv = panes[k].cv, vw = st.view[k];
      var tw = T.w * sp[P.ca], th = T.h * sp[P.ra];
      var s = Math.min(cv.width / tw, cv.height / th) * 0.96 * vw.zoom;
      var px = sp[P.ca] * s, py = sp[P.ra] * s;
      return { px: px, py: py, ox: (cv.width - T.w * px) / 2 + vw.panX, oy: (cv.height - T.h * py) / 2 + vw.panY };
    }
    function draw2d(k) {
      var P = PLANES[k], T = tex[k], pn = panes[k], ctx = pn.ctx, cv = pn.cv, X = paneXform(k), dpr = cv.width / Math.max(1, cv.clientWidth);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0b0d10"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(T.gc, X.ox, X.oy, T.w * X.px, T.h * X.py);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(T.oc, X.ox, X.oy, T.w * X.px, T.h * X.py);
      // crosshair: lines show where the other two planes cut this one
      var cAt = X.ox + (n[P.ca] - 1 - st.cur[P.ca] + 0.5) * X.px, rAt = X.oy + (n[P.ra] - 1 - st.cur[P.ra] + 0.5) * X.py;
      ctx.lineWidth = Math.max(1, dpr); ctx.globalAlpha = 0.75; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeStyle = PLANES[AXIS_PLANE[P.ca]].color;
      ctx.beginPath(); ctx.moveTo(cAt, X.oy); ctx.lineTo(cAt, X.oy + T.h * X.py); ctx.stroke();
      ctx.strokeStyle = PLANES[AXIS_PLANE[P.ra]].color;
      ctx.beginPath(); ctx.moveTo(X.ox, rAt); ctx.lineTo(X.ox + T.w * X.px, rAt); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // orientation letters
      ctx.fillStyle = "rgba(230,232,235,.85)"; ctx.font = (11 * dpr) + "px sans-serif"; ctx.textBaseline = "middle";
      ctx.textAlign = "left"; ctx.fillText(P.tag[0], 6 * dpr, cv.height / 2);
      ctx.textAlign = "right"; ctx.fillText(P.tag[1], cv.width - 6 * dpr, cv.height / 2);
      ctx.textAlign = "center"; ctx.fillText(P.tag[2], cv.width / 2, 26 * dpr); ctx.fillText(P.tag[3], cv.width / 2, cv.height - 10 * dpr);
      // 10 mm scale bar
      var sb = 10 / sp[P.ca] * X.px;
      if (sb > 12 * dpr) {
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2 * dpr; ctx.beginPath();
        ctx.moveTo(cv.width - 12 * dpr - sb, cv.height - 22 * dpr); ctx.lineTo(cv.width - 12 * dpr, cv.height - 22 * dpr); ctx.stroke();
        ctx.textAlign = "right"; ctx.fillText("10 mm", cv.width - 12 * dpr, cv.height - 32 * dpr);
      }
      pn.title.innerHTML = '<span><b style="color:' + P.color + '">' + P.label + "</b> &nbsp;" + (st.cur[P.f] + 1) + " / " + n[P.f] + "</span>";
    }

    /* ---------------------------- 3D pane ---------------------------- */
    var surf = null; // { pos: Float32Array(3m), nrm: Float32Array(3m), col: Uint8Array(3m), m }
    function buildSurfaces() {
      var MAX = 80000, pts = [], cnt = 0;
      V.ovs.forEach(function (ov, o) {
        if (!ov.on) return;
        var D = ov.data, t = lut[o];
        for (var k = 0; k < n[2]; k++) for (var j = 0; j < n[1]; j++) {
          var base = k * nxy + j * n[0];
          for (var i = 0; i < n[0]; i++) {
            var idx = base + i, v = D[idx];
            if (!v || t[v * 3] < 0) continue;
            var xm = i > 0 && D[idx - 1] === v, xp = i < n[0] - 1 && D[idx + 1] === v;
            var ym = j > 0 && D[idx - n[0]] === v, yp = j < n[1] - 1 && D[idx + n[0]] === v;
            var zm = k > 0 && D[idx - nxy] === v, zp = k < n[2] - 1 && D[idx + nxy] === v;
            if (xm && xp && ym && yp && zm && zp) continue; // interior voxel
            pts.push(i, j, k, (xm ? 1 : 0) - (xp ? 1 : 0), (ym ? 1 : 0) - (yp ? 1 : 0), (zm ? 1 : 0) - (zp ? 1 : 0), o, v);
            cnt++;
          }
        }
      });
      var step = Math.max(1, Math.ceil(cnt / MAX)), m = Math.ceil(cnt / step);
      var pos = new Float32Array(m * 3), nrm = new Float32Array(m * 3), col = new Uint8Array(m * 3), q = 0;
      for (var a = 0; a < cnt; a += step, q++) {
        var b = a * 8, nx = pts[b + 3] * sp[1] * sp[2], ny = pts[b + 4] * sp[0] * sp[2], nz = pts[b + 5] * sp[0] * sp[1];
        var nl = Math.hypot(nx, ny, nz) || 1, t2 = lut[pts[b + 6]], v2 = pts[b + 7];
        pos[q * 3] = (pts[b] + 0.5) * sp[0] - half[0]; pos[q * 3 + 1] = (pts[b + 1] + 0.5) * sp[1] - half[1]; pos[q * 3 + 2] = (pts[b + 2] + 0.5) * sp[2] - half[2];
        nrm[q * 3] = nx / nl; nrm[q * 3 + 1] = ny / nl; nrm[q * 3 + 2] = nz / nl;
        col[q * 3] = t2[v2 * 3]; col[q * 3 + 1] = t2[v2 * 3 + 1]; col[q * 3 + 2] = t2[v2 * 3 + 2];
      }
      surf = { pos: pos, nrm: nrm, col: col, m: q, step: step };
    }
    function rot() { // world (x=R, y=A, z=S) → view (sx right, sy down, d toward viewer); viewed from the front
      var cy = Math.cos(st.yaw), sy = Math.sin(st.yaw), cp = Math.cos(st.pitch), spn = Math.sin(st.pitch);
      // yaw about S, then pitch about the screen x-axis
      return function (x, y, z, out) {
        var x1 = x * cy - y * sy, y1 = x * sy + y * cy;
        var y2 = y1 * cp - z * spn, z2 = y1 * spn + z * cp;
        out[0] = -x1; out[1] = -z2; out[2] = y2; return out;
      };
    }
    var buf3 = null;
    function draw3d() {
      var pn = panes["3d"], cv = pn.cv, ctx = pn.ctx, W = cv.width, H = cv.height;
      if (!W || !H) return;
      if (!buf3 || buf3.W !== W || buf3.H !== H) buf3 = { W: W, H: H, img: ctx.createImageData(W, H), z: new Float32Array(W * H) };
      var R = rot(), tmp = [0, 0, 0], data = buf3.img.data, zb = buf3.z;
      var ext = Math.hypot(half[0], half[1], half[2]) * 2;
      var s = Math.min(W, H) / ext * 1.02 * st.zoom3, cx = W / 2, cy = H / 2;
      var bg = [11, 13, 16];
      for (var p = 0, L = W * H; p < L; p++) { data[p * 4] = bg[0]; data[p * 4 + 1] = bg[1]; data[p * 4 + 2] = bg[2]; data[p * 4 + 3] = 255; zb[p] = -1e30; }
      function scr(x, y, z) { R(x, y, z, tmp); return [cx + tmp[0] * s, cy + tmp[1] * s, tmp[2]]; }

      if (st.slices3d) ORDER.forEach(function (k) {
        var P = PLANES[k], T = tex[k], f = P.f, ca = P.ca, ra = P.ra;
        // world of texture corner (c, r): along ca = half - c*sp, along ra = half - r*sp, along f = slice centre
        function world(c, r) { var w = [0, 0, 0]; w[ca] = half[ca] - c * sp[ca]; w[ra] = half[ra] - r * sp[ra]; w[f] = (st.cur[f] + 0.5) * sp[f] - half[f]; return w; }
        var o = world(0, 0), u = world(1, 0), v = world(0, 1);
        var O = scr(o[0], o[1], o[2]), U = scr(u[0], u[1], u[2]), Vv = scr(v[0], v[1], v[2]);
        var ux = U[0] - O[0], uy = U[1] - O[1], ud = U[2] - O[2], vx = Vv[0] - O[0], vy = Vv[1] - O[1], vd = Vv[2] - O[2];
        var det = ux * vy - uy * vx; if (Math.abs(det) < 1e-9) return;
        var ia = vy / det, ib = -vx / det, ic = -uy / det, id = ux / det; // inverse of [u v]
        var xs = [O[0], O[0] + ux * T.w, O[0] + vx * T.h, O[0] + ux * T.w + vx * T.h], ys = [O[1], O[1] + uy * T.w, O[1] + vy * T.h, O[1] + uy * T.w + vy * T.h];
        var x0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), x1 = Math.min(W - 1, Math.ceil(Math.max.apply(null, xs)));
        var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(H - 1, Math.ceil(Math.max.apply(null, ys)));
        var gray = T.gray, od = T.oimg.data, tw = T.w, th = T.h, air = st.air3d ? 6 : -1;
        for (var Y = y0; Y <= y1; Y++) {
          var dy = Y + 0.5 - O[1];
          for (var X = x0; X <= x1; X++) {
            var dx = X + 0.5 - O[0], c = ia * dx + ib * dy, r = ic * dx + id * dy;
            if (c < 0 || r < 0 || c >= tw || r >= th) continue;
            var depth = O[2] + c * ud + r * vd, pi = Y * W + X;
            if (depth <= zb[pi]) continue;
            var ti = (r | 0) * tw + (c | 0), g = gray[ti], oa = od[ti * 4 + 3] / 255, q4 = pi * 4;
            if (g <= air && oa === 0) continue; // "hide air": dark, unlabeled texels are see-through
            zb[pi] = depth;
            data[q4] = g + (od[ti * 4] - g) * oa; data[q4 + 1] = g + (od[ti * 4 + 1] - g) * oa; data[q4 + 2] = g + (od[ti * 4 + 2] - g) * oa;
          }
        }
      });

      if (st.surf3d && surf && surf.m) {
        var pos = surf.pos, nrm = surf.nrm, col = surf.col, vs = (sp[0] + sp[1] + sp[2]) / 3 * Math.cbrt(surf.step);
        var ps = Math.max(1, Math.round(vs * s * 1.15)), hp = ps >> 1, nv = [0, 0, 0];
        for (var a = 0; a < surf.m; a++) {
          R(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], tmp);
          var sx0 = Math.round(cx + tmp[0] * s) - hp, sy0 = Math.round(cy + tmp[1] * s) - hp, d = tmp[2];
          R(nrm[a * 3], nrm[a * 3 + 1], nrm[a * 3 + 2], nv);
          var shade = 0.28 + 0.72 * Math.abs(nv[2] * 0.8 - nv[1] * 0.6);
          var cr = col[a * 3] * shade, cg = col[a * 3 + 1] * shade, cb = col[a * 3 + 2] * shade;
          for (var yy = sy0; yy < sy0 + ps; yy++) {
            if (yy < 0 || yy >= H) continue;
            for (var xx = sx0; xx < sx0 + ps; xx++) {
              if (xx < 0 || xx >= W) continue;
              var pj = yy * W + xx; if (d <= zb[pj]) continue;
              zb[pj] = d; data[pj * 4] = cr; data[pj * 4 + 1] = cg; data[pj * 4 + 2] = cb;
            }
          }
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(buf3.img, 0, 0);
      // bounding box + orientation triad (drawn on top)
      var dpr = W / Math.max(1, cv.clientWidth);
      var corners = [];
      for (var b = 0; b < 8; b++) corners.push(scr(b & 1 ? half[0] : -half[0], b & 2 ? half[1] : -half[1], b & 4 ? half[2] : -half[2]));
      ctx.strokeStyle = "rgba(200,205,212,.35)"; ctx.lineWidth = dpr; ctx.beginPath();
      [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(function (e) {
        ctx.moveTo(corners[e[0]][0], corners[e[0]][1]); ctx.lineTo(corners[e[1]][0], corners[e[1]][1]);
      });
      ctx.stroke();
      var tx = 34 * dpr, ty = H - 34 * dpr, TL = 20 * dpr;
      ctx.font = "bold " + (10 * dpr) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      [[1, 0, 0, "R", "#e5484d"], [0, 1, 0, "A", "#30a46c"], [0, 0, 1, "S", "#4f8ef7"]].forEach(function (ax) {
        R(ax[0], ax[1], ax[2], tmp);
        ctx.strokeStyle = ctx.fillStyle = ax[4]; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + tmp[0] * TL, ty + tmp[1] * TL); ctx.stroke();
        ctx.fillText(ax[3], tx + tmp[0] * (TL + 8 * dpr), ty + tmp[1] * (TL + 8 * dpr));
      });
      if (surf && surf.step > 1 && st.surf3d) {
        ctx.fillStyle = "rgba(200,205,212,.6)"; ctx.textAlign = "right"; ctx.font = (10 * dpr) + "px sans-serif";
        ctx.fillText("surface points subsampled 1/" + surf.step, W - 8 * dpr, H - 10 * dpr);
      }
    }

    /* ---------------------------- scheduling ---------------------------- */
    var raf = 0, need3d = true;
    function markDirty() { ORDER.forEach(function (k) { tex[k].dirty = true; }); need3d = true; schedule(); }
    function changedOverlay() { buildLut(); surf = null; markDirty(); }
    function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
    function frame() {
      raf = 0;
      var glut = null;
      ORDER.forEach(function (k) {
        if (tex[k].dirty) { glut = glut || grayLut(); renderSlice(k, glut); need3d = true; }
        if (panes[k].el.offsetParent !== null) draw2d(k);
      });
      if (need3d && panes["3d"].el.offsetParent !== null) {
        if (st.surf3d && !surf) buildSurfaces();
        draw3d(); need3d = false;
      }
    }
    function sizeAll() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      Object.keys(panes).forEach(function (k) {
        var cv = panes[k].cv, r = k === "3d" ? Math.min(dpr, 1.5) : dpr;
        var w = Math.max(1, Math.round(cv.clientWidth * r)), h = Math.max(1, Math.round(cv.clientHeight * r));
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      });
      need3d = true; schedule();
    }
    function layoutMax() {
      grid.classList.toggle("max", !!st.max);
      Object.keys(panes).forEach(function (k) { panes[k].el.classList.toggle("on", st.max === k); });
      sizeAll();
    }
    function clampCursor() { for (var a = 0; a < 3; a++) st.cur[a] = Math.max(0, Math.min(n[a] - 1, Math.round(st.cur[a]))); }
    function setSlice(k, s) {
      var P = PLANES[k], v = Math.max(0, Math.min(n[P.f] - 1, s));
      if (v === st.cur[P.f]) return;
      st.cur[P.f] = v; tex[k].dirty = true; need3d = true; schedule();
    }
    function moveCursor(axis, v) {
      v = Math.max(0, Math.min(n[axis] - 1, v));
      if (v === st.cur[axis]) return;
      st.cur[axis] = v; tex[AXIS_PLANE[axis]].dirty = true; need3d = true; schedule();
    }
    function reset() {
      st.cur = V.cursor && V.cursor.length === 3 ? V.cursor.slice() : [n[0] >> 1, n[1] >> 1, n[2] >> 1]; clampCursor();
      st.win = initWin.slice(); wsel.value = 0;
      ORDER.forEach(function (k) { st.view[k] = { zoom: 1, panX: 0, panY: 0 }; });
      st.yaw = -0.55; st.pitch = 0.35; st.zoom3 = 1; st.max = null; layoutMax(); markDirty();
    }
    function toggle(label, key) {
      var l = document.createElement("label"), c = document.createElement("input");
      c.type = "checkbox"; c.checked = st[key];
      c.addEventListener("change", function () { st[key] = c.checked; need3d = true; schedule(); });
      l.appendChild(c); l.appendChild(document.createTextNode(" " + label));
      return l;
    }

    /* ---------------------------- interaction ---------------------------- */
    function texAt(k, e) { // client event → texture coords (float)
      var cv = panes[k].cv, rc = cv.getBoundingClientRect(), dpr = cv.width / Math.max(1, rc.width), X = paneXform(k);
      return [((e.clientX - rc.left) * dpr - X.ox) / X.px, ((e.clientY - rc.top) * dpr - X.oy) / X.py, dpr];
    }
    function readout(k, e) {
      var P = PLANES[k], t = texAt(k, e), c = Math.floor(t[0]), r = Math.floor(t[1]);
      if (c < 0 || r < 0 || c >= tex[k].w || r >= tex[k].h) { read.textContent = ""; return; }
      var ijk = st.cur.slice(); ijk[P.ca] = n[P.ca] - 1 - c; ijk[P.ra] = n[P.ra] - 1 - r;
      var idx = ijk[0] + n[0] * ijk[1] + nxy * ijk[2];
      var val = V.range[0] + V.img[idx] * (V.range[1] - V.range[0]) / 255;
      var labs = V.ovs.map(function (ov) { var v = ov.data[idx]; return v ? ov.name + ": " + ((ov.labels[v] || {}).name || v) : ""; }).filter(Boolean);
      read.textContent = "voxel (" + ijk.join(", ") + ")  value " + (Math.abs(val) >= 100 ? Math.round(val) : val.toFixed(1)) + (isCT ? " HU" : "") + (labs.length ? "  ·  " + labs.join("  ·  ") : "");
    }
    ORDER.forEach(function (k) {
      var P = PLANES[k], cv = panes[k].cv, drag = null;
      function setCross(e) {
        var t = texAt(k, e);
        moveCursor(P.ca, n[P.ca] - 1 - Math.floor(t[0]));
        moveCursor(P.ra, n[P.ra] - 1 - Math.floor(t[1]));
      }
      cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
      cv.addEventListener("pointerdown", function (e) {
        cv.focus({ preventScroll: true });
        var mode = (e.button === 2 || e.altKey) ? "wl" : (e.shiftKey || e.button === 1) ? "pan" : "cross";
        drag = { mode: mode, x: e.clientX, y: e.clientY, win: st.win.slice() };
        cv.setPointerCapture(e.pointerId);
        if (mode === "cross") setCross(e);
        e.preventDefault();
      });
      cv.addEventListener("pointermove", function (e) {
        readout(k, e);
        if (!drag) return;
        var dpr = cv.width / Math.max(1, cv.clientWidth);
        if (drag.mode === "cross") setCross(e);
        else if (drag.mode === "pan") {
          st.view[k].panX += (e.clientX - drag.x) * dpr; st.view[k].panY += (e.clientY - drag.y) * dpr;
          drag.x = e.clientX; drag.y = e.clientY; schedule();
        } else {
          var span = V.range[1] - V.range[0], dx = (e.clientX - drag.x) / 300 * span, dy = (e.clientY - drag.y) / 300 * span;
          st.win = [drag.win[0] - dy, Math.max(span / 500, drag.win[1] + dx)];
          ORDER.forEach(function (q) { tex[q].dirty = true; }); need3d = true; schedule();
        }
      });
      cv.addEventListener("pointerup", function () { drag = null; });
      cv.addEventListener("pointercancel", function () { drag = null; });
      cv.addEventListener("pointerleave", function () { if (!drag) read.textContent = ""; });
      cv.addEventListener("wheel", function (e) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          st.view[k].zoom = Math.max(0.5, Math.min(12, st.view[k].zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); schedule();
        } else setSlice(k, st.cur[P.f] + (e.deltaY < 0 ? 1 : -1) * (Math.abs(e.deltaY) > 150 ? 3 : 1));
      }, { passive: false });
      cv.addEventListener("keydown", function (e) {
        var d = { ArrowUp: 1, ArrowRight: 1, PageUp: 5, ArrowDown: -1, ArrowLeft: -1, PageDown: -5 }[e.key];
        if (d) { setSlice(k, st.cur[P.f] + d); e.preventDefault(); }
      });
    });
    (function () {
      var cv = panes["3d"].cv, drag = null;
      cv.addEventListener("pointerdown", function (e) { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); e.preventDefault(); });
      cv.addEventListener("pointermove", function (e) {
        if (!drag) return;
        st.yaw += (e.clientX - drag[0]) * 0.01;
        st.pitch = Math.max(-1.55, Math.min(1.55, st.pitch + (e.clientY - drag[1]) * 0.01));
        drag = [e.clientX, e.clientY]; need3d = true; schedule();
      });
      cv.addEventListener("pointerup", function () { drag = null; });
      cv.addEventListener("pointercancel", function () { drag = null; });
      cv.addEventListener("wheel", function (e) {
        e.preventDefault(); st.zoom3 = Math.max(0.3, Math.min(10, st.zoom3 * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); need3d = true; schedule();
      }, { passive: false });
    })();

    if (window.ResizeObserver) new ResizeObserver(sizeAll).observe(grid); else window.addEventListener("resize", sizeAll);
    sizeAll(); markDirty();
  }

  function div(cls) { var d = document.createElement("div"); d.className = cls; return d; }
  function span(cls, text) { var s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; return s; }

  /* ------------------------------- mount ------------------------------- */
  function mount(island) {
    if (island.__volv) return;
    island.__volv = true;
    var height = parseInt(island.getAttribute("data-height") || "620", 10);
    var host = div("volv");
    host.setAttribute("data-rendered", "");
    host.style.minHeight = "120px";
    host.innerHTML = '<div class="volv-msg">Loading volume…</div>';
    island.parentNode.insertBefore(host, island.nextSibling);
    var src = island.getAttribute("data-src");
    function fail(err) {
      host.innerHTML = '<div class="volv-msg err">⚠ volume viewer: ' + esc(err && err.message || err) +
        (src ? "<br><small>source: " + esc(src) + (location.protocol === "file:" ? " — data-src needs the page to be served over http" : "") + "</small>" : "") + "</div>";
    }
    function start() {
      var p = src
        ? fetch(src, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " for " + src); return r.json(); })
        : Promise.resolve().then(function () { return JSON.parse(island.textContent); });
      p.then(loadVolume).then(function (V) { Viewer(host, V, height); }).catch(fail);
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) {
        if (es.some(function (x) { return x.isIntersecting; })) { io.disconnect(); start(); }
      }, { rootMargin: "400px" });
      io.observe(host);
    } else start();
  }
  function init() {
    injectStyles();
    document.querySelectorAll('script[type="application/json"].vol-island').forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
