#!/usr/bin/env python3
"""AI Platform Report server — static HTML report site + a small write API.

Serves SITE_DIR as a static site and owns all bookkeeping, so authors (humans,
Claude, Codex) only ever write page *content*:

    index.html                 GENERATED  topic cards, newest edit first + search box
    data/topics-meta.json      GENERATED via API   per-topic metadata (single source)
    data/search-index.json     GENERATED  one entry per topic and per experiment
    topics/<slug>/index.html   topic page: overview island is authored, the
                               experiment list between EXP-LIST markers is GENERATED
    topics/<slug>/<NN>/        one experiment: index.html + assets/
    assets/ docs/ AGENTS.md client/   MANAGED  copied from the image on every start
    .history/                  previous version of every overwritten/deleted file + log.jsonl

Write API (JSON in/out; optional X-Report-Token when REPORT_TOKEN is set;
X-Report-Author is recorded in .history/log.jsonl):

    GET    /api/health
    GET    /api/topics                       all topics + their experiments
    GET    /api/topics/<slug>
    GET    /api/suggest?q=<text>             existing-topic matches + a proposed new slug/name
    GET    /api/files/<slug>/<NN>            files of one experiment (for `aireport pull`)
    POST   /api/topics                       {slug, name, owner, cat, status, kw[], branch, overview}
    PATCH  /api/topics/<slug>                any of {name, owner, cat, status, kw, branch}
    POST   /api/topics/<slug>/experiments    {title, owner, markdown?} → allocates the next NN
    POST   /api/reindex
    PUT    /topics/<slug>/...                upload/overwrite a page or asset (raw body)
    DELETE /topics/<slug>/<NN>/<file>        remove an asset (never an index.html)

Every write bumps the topic's `edited` date (KST) and regenerates the indexes.
Stdlib only. Run:  SITE_DIR=/path/to/site PORT=8090 python3 app.py
"""
import argparse
import datetime as dt
import difflib
import html
import json
import os
import re
import shutil
import sys
import threading
import time
import unicodedata
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP = Path(__file__).resolve().parent


def _bundled(name):
    # inside the image everything sits next to app.py; in a repo checkout it is one level up
    return APP / name if (APP / name).exists() else APP.parent / name


SITE = Path(os.environ.get("SITE_DIR", "/site")).resolve()
TEMPLATE = Path(os.environ.get("TEMPLATE_DIR", _bundled("site-template")))
CLIENT = Path(os.environ.get("CLIENT_DIR", _bundled("client")))
SKILLS = Path(os.environ.get("SKILLS_DIR", _bundled("skills")))
PORT = int(os.environ.get("PORT", "8090"))
PUBLIC_URL = os.environ.get("PUBLIC_URL", "https://plreport.oncosoft.io").rstrip("/")
TOKEN = os.environ.get("REPORT_TOKEN", "")
MAX_BODY = int(os.environ.get("MAX_UPLOAD_MB", "300")) * 1024 * 1024
SITE_TITLE = os.environ.get("SITE_TITLE", "AI Platform Reports")

KST = dt.timezone(dt.timedelta(hours=9))  # Korea has no DST
STATUSES = ["시작 전", "진행 중", "완료", "일시정지", "중단"]
STATUS_CLASS = {"완료": "done", "진행 중": "progress", "시작 전": "todo", "일시정지": "paused", "중단": "stopped"}
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
NN_RE = re.compile(r"^\d{2,3}$")
UPLOAD_EXT = {".html", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".json", ".csv", ".tsv", ".txt",
              ".md", ".pdf", ".mp4", ".webm", ".js", ".css", ".gz", ".npz", ".zip"}
META_FIELDS = ("name", "owner", "cat", "status", "kw", "branch")
EXP_BEGIN, EXP_END = "<!-- EXP-LIST:BEGIN", "<!-- EXP-LIST:END -->"

LOCK = threading.RLock()


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


# ----------------------------------------------------------------------------- utils
def today():
    return dt.datetime.now(KST).strftime("%Y.%m.%d")


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    os.replace(tmp, path)


def slugify(text):
    s = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)[:48].strip("-")


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", str(text).lower())).strip()


def tokens(text):
    return {t for t in re.findall(r"\w+", norm(text)) if len(t) > 1}


def meta_path():
    return SITE / "data" / "topics-meta.json"


def load_meta():
    try:
        return json.loads(meta_path().read_text("utf-8"))
    except FileNotFoundError:
        return {}


def save_meta(meta):
    atomic_write(meta_path(), json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


def log_event(action, path, author="", ip=""):
    rec = {"t": dt.datetime.now(KST).isoformat(timespec="seconds"), "action": action, "path": path,
           "author": author, "ip": ip}
    logf = SITE / ".history" / "log.jsonl"
    logf.parent.mkdir(parents=True, exist_ok=True)
    with LOCK, open(logf, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def keep_history(path):
    if not path.is_file():
        return
    rel = path.relative_to(SITE)
    stamp = dt.datetime.now(KST).strftime("%Y%m%d-%H%M%S-%f")
    dest = SITE / ".history" / rel.parent / f"{rel.name}.{stamp}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)


# ------------------------------------------------------------------ page parsing
TITLE_RE = re.compile(r'<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>(.*?)</h1>', re.S | re.I)
MD_RE = re.compile(r'<script[^>]*type="text/markdown"[^>]*>(.*?)</script>', re.S | re.I)
OWNER_RE = re.compile(r'<meta\s+name="report-owner"\s+content="([^"]*)"', re.I)


def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def md_plain(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", s)              # images
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)           # links → text
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"[#*_`>|]+", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def read_page(path):
    try:
        text = path.read_text("utf-8", errors="replace")
    except FileNotFoundError:
        return None
    m = TITLE_RE.search(text)
    o = OWNER_RE.search(text)
    return {"title": strip_tags(m.group(1)) if m else "",
            "owner": html.unescape(o.group(1)) if o else "",
            "text": md_plain(" ".join(MD_RE.findall(text)))[:6000]}


def experiments(slug):
    out = []
    tdir = SITE / "topics" / slug
    if not tdir.is_dir():
        return out
    for d in sorted(tdir.iterdir()):
        if not (d.is_dir() and NN_RE.match(d.name)):
            continue
        page = read_page(d / "index.html")
        if page is None:
            continue
        title = page["title"] or f"실험 {int(d.name)}"
        short = re.sub(r"^\s*실험\s*\d+\s*[:：]\s*", "", title)
        out.append({"nn": d.name, "num": int(d.name), "title": title, "short": short,
                    "owner": page["owner"], "text": page["text"],
                    "url": f"topics/{slug}/{d.name}/index.html"})
    return out


# ----------------------------------------------------------------- templates
def page_head(title, depth, extra=""):
    pre = "../" * depth
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
{extra}<title>{esc(title)}</title>
<link rel="stylesheet" href="{pre}assets/report.css">
"""


def exp_list_html(slug, exps):
    rows = []
    for e in exps:
        owner = f'<span class="exp-sub">{esc(e["owner"])}</span>' if e["owner"] else ""
        rows.append(f'    <a class="exp-row" href="{e["nn"]}/index.html">\n'
                    f'      <span class="exp-num">실험 {e["num"]}</span>\n'
                    f'      <span class="exp-title">{esc(e["short"])}</span>{owner}\n'
                    f'    </a>')
    if not rows:
        rows.append('    <p class="placeholder">아직 실험이 없습니다 — <code>aireport new-exp '
                    f'{esc(slug)} --title "…"</code></p>')
    return (f"{EXP_BEGIN} (generated by the report server on every write — do not edit by hand) -->\n"
            '  <h2 class="section">Experiments</h2>\n'
            '  <div class="exp-list">\n' + "\n".join(rows) + "\n  </div>\n  " + EXP_END)


def topic_page(slug, m, overview):
    body = overview.strip() if overview and overview.strip() else "### Background\n- …\n### Objectives\n- …"
    return page_head(f"{m['name']} · {SITE_TITLE}", 2) + f"""</head>
<body>
<div class="wrap">
  <nav class="breadcrumb"><a href="../../index.html">Research Topics</a> › <span class="bc-topic">{esc(m['name'])}</span></nav>
  <h1 class="page-title">{esc(m['name'])}</h1>
  <p class="page-subtitle"><span class="badge">0 experiments</span></p>

  <!-- topic overview: markdown, headings start at ### (docs/markdown-rules.md) -->
  <script type="text/markdown" data-md>
{body}
  </script>

  {exp_list_html(slug, [])}

  <footer class="foot"></footer>
</div>
<script src="../../assets/markdown-it.min.js" defer></script>
<script src="../../assets/components/report-islands.js" defer></script>
<script src="../../assets/components/exp-sort.js" defer></script>
<script src="../../assets/components/editor.js" defer></script>
</body>
</html>
"""


DEFAULT_EXP_MD = """### 결론
- (한두 줄 요약: 무엇을 확인했고 결론은 무엇인가)
### 실험 내용
- **목적**: …
- **데이터**: …
- **방법**: …
### 결과
- …
### 샘플 시각화
- 케이스별 3D 슬라이스 오버레이 뷰어 (`aireport viewer` 로 생성, 아래 vol-island 참고)
### 다음 단계
- …"""


def experiment_page(slug, m, nn, title, owner, markdown):
    num = int(nn)
    full = f"실험 {num}: {title}"
    md = (markdown or DEFAULT_EXP_MD).strip("\n")
    md = md.replace("</script", "<\\/script")
    owner_badge = f'<span class="badge">{esc(owner)}</span> ' if owner else ""
    extra = (f'<meta name="report-owner" content="{esc(owner)}">\n'
             f'<meta name="report-created" content="{today()}">\n')
    return page_head(f"{full} · {m['name']}", 3, extra) + f"""<style>
  /* hover-zoom: each figure scales to fit within the viewport on hover */
  .prose img {{ cursor: zoom-in; transform-origin: center;
    transition: transform .25s ease, box-shadow .25s ease; }}
  .prose img:hover {{ box-shadow: 0 10px 36px rgba(0,0,0,.45); position: relative; z-index: 10; }}
</style>
</head>
<body>
<div class="wrap">
  <nav class="breadcrumb">
    <a href="../../../index.html">Research Topics</a> ›
    <a class="bc-topic" href="../index.html">{esc(m['name'])}</a> ›
    <span>{esc(full)}</span>
  </nav>
  <h1 class="page-title">{esc(full)}</h1>
  <p class="page-subtitle">{owner_badge}<span class="badge neutral">{today()}</span></p>

  <!-- prose: CommonMark, headings start at ###, 4-space nesting (docs/markdown-rules.md) -->
  <script type="text/markdown" data-md>
{md}
  </script>

  <!-- optional metrics table: schema in assets/components/report-islands.js header
  <script type="application/json" class="metrics-island">
  {{ "experiments": [{{"id": "a", "name": "Baseline"}}], "metrics": [{{"key": "dsc", "label": "DSC"}}],
    "rows": [{{"roi": "Liver", "a": {{"dsc": 0.95}}}}] }}
  </script>
  -->

  <!-- sample visualization — DEFAULT: 3D interactive slice overlay (docs/volume-viewer.md).
       Make the data with:  aireport viewer --image ct.nii.gz --label gt.nii.gz --pred pred.nii.gz -o assets/case01.vol.json
  <script type="application/json" class="vol-island" data-src="assets/case01.vol.json"></script>
  -->

  <footer class="foot"></footer>
</div>
<script src="../../../assets/markdown-it.min.js" defer></script>
<script src="../../../assets/components/report-islands.js" defer></script>
<script src="../../../assets/components/volume-viewer.js" defer></script>
<script src="../../../assets/components/editor.js" defer></script>
<script>
  /* per-image hover-zoom: fit within viewport (min of width-fit / height-fill);
     images already larger than the viewport zoom to a fixed 1.6x */
  (function () {{
    var FILL = 0.96;
    document.addEventListener("mouseover", function (e) {{
      var img = e.target; if (img.tagName !== "IMG" || !img.closest(".prose")) return;
      var bw = img.offsetWidth, bh = img.offsetHeight; if (!bw || !bh) return;
      var sw = (document.documentElement.clientWidth * FILL) / bw;
      var sh = (document.documentElement.clientHeight * FILL) / bh;
      var s = Math.min(sw, sh);
      img.style.transform = "scale(" + (s > 1 ? s : 1.6) + ")";
    }}, true);
    document.addEventListener("mouseout", function (e) {{
      var img = e.target; if (img.tagName === "IMG" && img.closest(".prose")) img.style.transform = "";
    }}, true);
  }})();
</script>
</body>
</html>
"""


def edited_key(v):
    d = re.sub(r"\D", "", str(v or ""))
    return int(d[:8]) if d else -1


def index_page(meta, exps_by_slug):
    slugs = sorted(meta, key=lambda s: (-edited_key(meta[s].get("edited")), meta[s].get("name", s).lower()))
    n_exp = sum(len(v) for v in exps_by_slug.values())
    cards = []
    for slug in slugs:
        m, exps = meta[slug], exps_by_slug.get(slug, [])
        status = m.get("status") or ""
        head = f'<span class="status status-{STATUS_CLASS.get(status, "todo")}">{esc(status)}</span>' if status else ""
        latest = max(exps, key=lambda e: e["num"]) if exps else None
        desc = f'<p class="card-desc">최근: {esc(latest["title"])}</p>' if latest else ""
        bits = []
        if m.get("cat"):
            bits.append(f'<span>분류 <b>{esc(m["cat"])}</b></span>')
        if m.get("owner"):
            bits.append(f'<span>담당 <b>{esc(m["owner"])}</b></span>')
        bits.append(f'<span>실험 <b>{len(exps)}</b></span>')
        if m.get("edited"):
            bits.append(f'<span>편집 {esc(m["edited"])}</span>')
        if m.get("branch"):
            bits.append(f'<span class="card-branch">⎇ {esc(m["branch"])}</span>')
        tags = "".join(f'<span class="tag">{esc(k)}</span>' for k in (m.get("kw") or [])[:8])
        cards.append(
            f'  <a class="card" href="topics/{slug}/index.html" data-slug="{slug}" data-edited="{esc(m.get("edited", ""))}">\n'
            f'    <div class="card-head"><h2 class="card-title">{esc(m.get("name", slug))}</h2>{head}</div>\n'
            f'    {desc}<div class="card-meta">{"".join(bits)}</div>\n'
            + (f'    <div class="card-tags">{tags}</div>\n' if tags else "") + "  </a>")
    if not cards:
        cards.append('  <p class="placeholder">아직 토픽이 없습니다. 에이전트에게 "리포트 써줘"라고 하거나 '
                     '<code>aireport new-topic</code> 으로 시작하세요 — <a href="docs/index.html">작성 가이드</a></p>')
    return page_head(SITE_TITLE, 0) + f"""</head>
<body>
<!-- GENERATED by the report server (server/app.py) on every write — do not edit by hand. -->
<div class="wrap">
  <h1 class="page-title">{esc(SITE_TITLE)}</h1>
  <p class="page-subtitle">{len(meta)} topics · {n_exp} experiments · <a href="docs/index.html">작성 가이드 / setup</a></p>
  <div class="search-bar">
    <input id="search" type="search" placeholder="Loading search…" autocomplete="off">
    <span id="search-count" class="search-count"></span>
  </div>
  <div id="search-results" class="search-results" hidden></div>
  <div class="card-grid">
{chr(10).join(cards)}
  </div>
  <footer class="foot"></footer>
</div>
<script src="assets/components/search.js" defer></script>
</body>
</html>
"""


# ------------------------------------------------------------------ indexing
def set_exp_list(slug, exps):
    path = SITE / "topics" / slug / "index.html"
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        return
    a, b = text.find(EXP_BEGIN), text.find(EXP_END)
    if a < 0 or b < a:
        return  # hand-made topic page without markers: leave it alone
    new = text[:a] + exp_list_html(slug, exps) + text[b + len(EXP_END):]
    if new != text:
        atomic_write(path, new)


def reindex():
    with LOCK:
        meta = load_meta()
        exps_by_slug, entries = {}, []
        for slug, m in meta.items():
            exps = experiments(slug)
            exps_by_slug[slug] = exps
            set_exp_list(slug, exps)
            overview = read_page(SITE / "topics" / slug / "index.html") or {"text": ""}
            entries.append({"k": "topic", "p": "", "t": m.get("name", slug), "u": f"{slug}/index.html",
                            "x": " ".join([overview["text"]] + [e["title"] for e in exps])[:8000]})
            for e in exps:
                entries.append({"k": "exp", "p": m.get("name", slug), "t": e["title"],
                                "u": f"{slug}/{e['nn']}/index.html", "x": e["text"]})
        atomic_write(SITE / "data" / "search-index.json", json.dumps(entries, ensure_ascii=False))
        atomic_write(SITE / "index.html", index_page(meta, exps_by_slug))
        return {"topics": len(meta), "experiments": sum(len(v) for v in exps_by_slug.values())}


def touch(slug):
    with LOCK:
        meta = load_meta()
        if slug in meta:
            meta[slug]["edited"] = today()
            save_meta(meta)


# -------------------------------------------------------------------- topics
def suggest(q, meta=None):
    meta = load_meta() if meta is None else meta
    q = (q or "").strip()
    qn, qs, qt = norm(q), slugify(q), tokens(q)
    exact, scored = None, []
    for slug, m in meta.items():
        name = m.get("name", slug)
        if qs and qs == slug or qn and qn in (norm(name), norm(slug)):
            exact = slug
        hay = tokens(" ".join([slug, name, m.get("cat", ""), " ".join(m.get("kw") or [])]))
        overlap = len(qt & hay) / len(qt) if qt else 0.0
        ratio = max(difflib.SequenceMatcher(None, qn, norm(name)).ratio(),
                    difflib.SequenceMatcher(None, qs, slug).ratio() if qs else 0.0)
        sub = 0.85 if qn and (qn in norm(name) or (qs and qs in slug) or norm(name) in qn) else 0.0
        score = round(max(ratio, 0.9 * overlap, sub), 3)
        if score >= 0.35 or slug == exact:
            scored.append({"slug": slug, "name": name, "score": 1.0 if slug == exact else score,
                           "owner": m.get("owner", ""), "status": m.get("status", ""), "edited": m.get("edited", "")})
    scored.sort(key=lambda r: -r["score"])
    proposed = None
    if not exact:
        slug = qs
        if slug in meta:  # same slug, different wording — still not new
            slug = ""
        proposed = {"slug": slug or None, "name": q,
                    "note": "" if slug else "could not derive an ASCII slug — propose an English kebab-case slug"}
    return {"query": q, "exact": exact, "matches": scored[:6], "proposed": proposed}


def clean_meta_fields(body, partial):
    out = {}
    for k in META_FIELDS:
        if k not in body:
            continue
        v = body[k]
        if k == "kw":
            if isinstance(v, str):
                v = [x.strip() for x in v.split(",")]
            v = [str(x).strip() for x in (v or []) if str(x).strip()]
        else:
            v = str(v or "").strip()
        if k == "status" and v and v not in STATUSES:
            raise ApiError(400, f"status must be one of {STATUSES}")
        if k == "name" and not v and not partial:
            raise ApiError(400, "name is required")
        out[k] = v
    return out


def create_topic(body, author):
    slug = str(body.get("slug") or "").strip()
    if not SLUG_RE.match(slug) or len(slug) > 48:
        raise ApiError(400, "slug must be lowercase ASCII kebab-case (e.g. liver-tumor-seg), ≤48 chars",
                       proposed=slugify(slug or body.get("name", "")))
    fields = clean_meta_fields(body, partial=False)
    if "name" not in fields:
        raise ApiError(400, "name is required")
    with LOCK:
        meta = load_meta()
        if slug in meta or (SITE / "topics" / slug).exists():
            raise ApiError(409, f"topic '{slug}' already exists", topic=slug)
        m = {"name": fields["name"], "status": fields.get("status") or "진행 중", "owner": fields.get("owner", ""),
             "cat": fields.get("cat", ""), "kw": fields.get("kw", []), "branch": fields.get("branch", ""),
             "created": today(), "edited": today()}
        atomic_write(SITE / "topics" / slug / "index.html", topic_page(slug, m, body.get("overview", "")))
        meta[slug] = m
        save_meta(meta)
        reindex()
    log_event("create-topic", f"topics/{slug}/", author)
    return {"slug": slug, "meta": m, "url": f"{PUBLIC_URL}/topics/{slug}/index.html"}


def rename_in_pages(slug, name):
    """Topic renamed: patch the h1/title on the topic page and the breadcrumb on its experiments."""
    tdir = SITE / "topics" / slug
    pages = [tdir / "index.html"] + [d / "index.html" for d in tdir.iterdir() if d.is_dir() and NN_RE.match(d.name)]
    for p in pages:
        if not p.is_file():
            continue
        t = p.read_text("utf-8")
        n = re.sub(r'(<(?:a|span) class="bc-topic"[^>]*>).*?(</(?:a|span)>)', lambda m: m.group(1) + esc(name) + m.group(2), t)
        if p.parent == tdir:
            n = TITLE_RE.sub(lambda m: m.group(0).replace(m.group(1), esc(name)), n, count=1)
            n = re.sub(r"<title>.*?</title>", f"<title>{esc(name)} · {esc(SITE_TITLE)}</title>", n, count=1)
        if n != t:
            keep_history(p)
            atomic_write(p, n)


def patch_topic(slug, body, author):
    fields = clean_meta_fields(body, partial=True)
    with LOCK:
        meta = load_meta()
        if slug not in meta:
            raise ApiError(404, f"topic '{slug}' does not exist", suggestions=suggest(slug, meta))
        renamed = "name" in fields and fields["name"] and fields["name"] != meta[slug].get("name")
        meta[slug].update({k: v for k, v in fields.items() if not (k == "name" and not v)})
        meta[slug]["edited"] = today()
        save_meta(meta)
        if renamed:
            rename_in_pages(slug, fields["name"])
        reindex()
    log_event("patch-topic", f"topics/{slug}/", author)
    return {"slug": slug, "meta": meta[slug]}


def create_experiment(slug, body, author):
    title = re.sub(r"^\s*실험\s*\d+\s*[:：]\s*", "", str(body.get("title") or "").strip())
    if not title:
        raise ApiError(400, "title is required")
    with LOCK:
        meta = load_meta()
        if slug not in meta:
            raise ApiError(404, f"topic '{slug}' does not exist — pick an existing topic or create it "
                                "(ask the user to confirm the new topic name first)", suggestions=suggest(slug, meta))
        tdir = SITE / "topics" / slug
        nums = [int(d.name) for d in tdir.iterdir() if d.is_dir() and NN_RE.match(d.name)] if tdir.is_dir() else []
        nn = f"{(max(nums) if nums else 0) + 1:02d}"
        owner = str(body.get("owner") or "").strip()
        page = experiment_page(slug, meta[slug], nn, title, owner, body.get("markdown"))
        atomic_write(tdir / nn / "index.html", page)
        (tdir / nn / "assets").mkdir(exist_ok=True)
        meta[slug]["edited"] = today()
        save_meta(meta)
        reindex()
    path = f"topics/{slug}/{nn}/index.html"
    log_event("create-experiment", path, author)
    return {"slug": slug, "nn": nn, "path": path, "url": f"{PUBLIC_URL}/{path}"}


def topic_info(slug, meta):
    exps = experiments(slug)
    return dict(meta[slug], slug=slug, url=f"{PUBLIC_URL}/topics/{slug}/index.html",
                experiments=[{k: e[k] for k in ("nn", "title", "owner")} | {"url": f"{PUBLIC_URL}/{e['url']}"}
                             for e in exps])


# ------------------------------------------------------------- file writes
def resolve_write_path(urlpath):
    """Validate a PUT/DELETE target and return (slug, nn|None, absolute Path)."""
    rel = unquote(urlsplit(urlpath).path).lstrip("/")
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        raise ApiError(400, "invalid path")
    if len(parts) < 3 or parts[0] != "topics":
        raise ApiError(403, "writes are only allowed under topics/<slug>/")
    slug = parts[1]
    if slug not in load_meta():
        raise ApiError(404, f"topic '{slug}' does not exist — create it via the API first", suggestions=suggest(slug))
    nn = None
    if len(parts) == 3:
        if parts[2] != "index.html":
            raise ApiError(403, "only index.html may be written directly under topics/<slug>/")
    else:
        nn = parts[2]
        if not NN_RE.match(nn) or not (SITE / "topics" / slug / nn / "index.html").is_file():
            raise ApiError(404, f"experiment topics/{slug}/{nn}/ does not exist — create it with "
                                f"POST /api/topics/{slug}/experiments first")
    ext = Path(parts[-1]).suffix.lower()
    if ext not in UPLOAD_EXT:
        raise ApiError(415, f"file type {ext or '(none)'} not allowed; allowed: {' '.join(sorted(UPLOAD_EXT))}")
    target = (SITE / rel).resolve()
    if SITE not in target.parents:
        raise ApiError(400, "invalid path")
    return slug, nn, target


def put_file(urlpath, data, author, ip):
    slug, nn, target = resolve_write_path(urlpath)
    if target.suffix.lower() == ".html" and target.name == "index.html" and b"<html" not in data[:4096].lower():
        raise ApiError(400, "index.html body does not look like an HTML document")
    with LOCK:
        keep_history(target)
        atomic_write(target, data)
        touch(slug)
        reindex()
    rel = target.relative_to(SITE).as_posix()
    log_event("put", rel, author, ip)
    return {"ok": True, "path": rel, "bytes": len(data), "url": f"{PUBLIC_URL}/{rel}"}


def delete_file(urlpath, author, ip):
    slug, nn, target = resolve_write_path(urlpath)
    if target.name == "index.html":
        raise ApiError(403, "pages are not deleted through the API; ask the site admin")
    if not target.is_file():
        raise ApiError(404, "no such file")
    with LOCK:
        keep_history(target)
        target.unlink()
        touch(slug)
        reindex()
    rel = target.relative_to(SITE).as_posix()
    log_event("delete", rel, author, ip)
    return {"ok": True, "deleted": rel}


# ------------------------------------------------------------ managed files
def sync_managed():
    """Copy the managed layer (shared assets, docs, client bundle) into the site and seed data files."""
    SITE.mkdir(parents=True, exist_ok=True)
    for name in ("assets", "docs"):
        src = TEMPLATE / name
        if src.is_dir():
            shutil.copytree(src, SITE / name, dirs_exist_ok=True)
    shutil.copy2(TEMPLATE / "AGENTS.md", SITE / "AGENTS.md")
    cdir = SITE / "client"
    cdir.mkdir(exist_ok=True)
    for f in ("aireport", "install.sh", "install.ps1"):
        if (CLIENT / f).is_file():
            text = (CLIENT / f).read_text("utf-8").replace("__AIREPORT_URL__", PUBLIC_URL)
            atomic_write(cdir / f, text)
    skill = SKILLS / "pl-report" / "SKILL.md"
    if skill.is_file():
        atomic_write(cdir / "SKILL.md", skill.read_text("utf-8"))
    (SITE / "topics").mkdir(exist_ok=True)
    if not meta_path().exists():
        save_meta({})


# ------------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "aireport/1"
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{
        ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".md": "text/markdown; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8", "": "text/plain; charset=utf-8",
        ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8"})

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        if self.command != "GET" or os.environ.get("ACCESS_LOG"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- helpers
    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body_bytes(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ApiError(413, f"body larger than {MAX_BODY // 1048576} MB")
        return self.rfile.read(n) if n else b""

    def body_json(self):
        raw = self.body_bytes()
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
        except ValueError as e:
            raise ApiError(400, f"invalid JSON body: {e}")
        if not isinstance(obj, dict):
            raise ApiError(400, "JSON body must be an object")
        return obj

    def author(self):
        return unquote(self.headers.get("X-Report-Author", ""))[:80]

    def check_token(self):
        if not TOKEN:
            return
        got = self.headers.get("X-Report-Token") or self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if got != TOKEN:
            raise ApiError(401, "missing or wrong X-Report-Token")

    def guarded(self, fn):
        try:
            fn()
        except ApiError as e:
            self.send_json(e.status, dict({"error": e.message}, **e.extra))
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 — report, never crash the server
            self.log_error("internal error: %r", e)
            self.send_json(500, {"error": f"internal error: {e}"})

    # ---- GET / HEAD
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            return self.guarded(lambda: self.api_get(path))
        if any(seg.startswith(".") for seg in unquote(path).split("/") if seg):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if any(seg.startswith(".") for seg in unquote(urlsplit(self.path).path).split("/") if seg):
            return self.send_error(404)
        return super().do_HEAD()

    def api_get(self, path):
        qs = parse_qs(urlsplit(self.path).query)
        meta = load_meta()
        if path == "/api/health":
            return self.send_json(200, {"ok": True, "site": str(SITE), "public_url": PUBLIC_URL,
                                        "topics": len(meta), "today": today(), "auth": bool(TOKEN)})
        if path == "/api/topics":
            return self.send_json(200, {s: topic_info(s, meta) for s in sorted(meta)})
        if path == "/api/suggest":
            return self.send_json(200, suggest(qs.get("q", [""])[0], meta))
        m = re.fullmatch(r"/api/files/([^/]+)/(\d{2,3})", path)
        if m:
            base = SITE / "topics" / m.group(1) / m.group(2)
            if not (base / "index.html").is_file():
                raise ApiError(404, f"experiment topics/{m.group(1)}/{m.group(2)}/ does not exist")
            files = sorted(p.relative_to(base).as_posix() for p in base.rglob("*")
                           if p.is_file() and not any(x.startswith(".") for x in p.relative_to(base).parts))
            return self.send_json(200, {"files": files})
        m = re.fullmatch(r"/api/topics/([^/]+)", path)
        if m:
            slug = m.group(1)
            if slug not in meta:
                raise ApiError(404, f"topic '{slug}' does not exist", suggestions=suggest(slug, meta))
            return self.send_json(200, topic_info(slug, meta))
        raise ApiError(404, "unknown endpoint")

    # ---- writes
    def do_POST(self):
        def run():
            self.check_token()
            path = urlsplit(self.path).path
            if path == "/api/topics":
                return self.send_json(201, create_topic(self.body_json(), self.author()))
            m = re.fullmatch(r"/api/topics/([^/]+)/experiments", path)
            if m:
                return self.send_json(201, create_experiment(m.group(1), self.body_json(), self.author()))
            if path == "/api/reindex":
                return self.send_json(200, reindex())
            raise ApiError(404, "unknown endpoint")
        self.guarded(run)

    def do_PATCH(self):
        def run():
            self.check_token()
            m = re.fullmatch(r"/api/topics/([^/]+)", urlsplit(self.path).path)
            if not m:
                raise ApiError(404, "unknown endpoint")
            self.send_json(200, patch_topic(m.group(1), self.body_json(), self.author()))
        self.guarded(run)

    def do_PUT(self):
        def run():
            self.check_token()
            self.send_json(200, put_file(self.path, self.body_bytes(), self.author(), self.client_address[0]))
        self.guarded(run)

    def do_DELETE(self):
        def run():
            self.check_token()
            self.send_json(200, delete_file(self.path, self.author(), self.client_address[0]))
        self.guarded(run)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sync-only", action="store_true", help="copy managed files + reindex, then exit")
    args = ap.parse_args()
    sync_managed()
    stats = reindex()
    print(f"[aireport] site={SITE} topics={stats['topics']} experiments={stats['experiments']} url={PUBLIC_URL}", flush=True)
    if args.sync_only:
        return
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    print(f"[aireport] listening on :{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
