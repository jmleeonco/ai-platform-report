"""Server + CLI tests. Stdlib only (the viewer test is skipped without numpy).

    python3 -m unittest discover -s tests -v
"""
import concurrent.futures
import http.client
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TMP = tempfile.TemporaryDirectory()
os.environ["SITE_DIR"] = os.path.join(TMP.name, "site")
os.environ["PUBLIC_URL"] = "http://test"

spec = importlib.util.spec_from_file_location("app", REPO / "server" / "app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
CLI = REPO / "client" / "aireport"
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("aireport_cli", SourceFileLoader("aireport_cli", str(CLI))))
cli.__loader__.exec_module(cli)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.sync_managed()
        app.reindex()
        cls.srv = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, raw=False):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        c.request(method, path, body=data, headers={"X-Report-Author": "tester"})
        r = c.getresponse()
        payload = r.read()
        c.close()
        return r.status, (payload if raw else (json.loads(payload) if payload else {}))

    def topic(self, slug, name=None):
        s, r = self.req("POST", "/api/topics", {"slug": slug, "name": name or slug.replace("-", " ").title()})
        self.assertEqual(s, 201, r)
        return r

    def test_managed_files_served(self):
        for p in ("/index.html", "/AGENTS.md", "/assets/components/volume-viewer.js", "/client/aireport",
                  "/client/SKILL.md", "/docs/index.html", "/data/search-index.json"):
            s, _ = self.req("GET", p, raw=True)
            self.assertEqual(s, 200, p)
        s, body = self.req("GET", "/client/aireport", raw=True)
        self.assertIn(b'DEFAULT_URL = "http://test"', body)

    def test_topic_suggest_and_create(self):
        self.topic("kidney-seg", "Kidney Segmentation")
        _, r = self.req("GET", "/api/suggest?q=kidney%20segmentation")
        self.assertEqual(r["exact"], "kidney-seg")
        self.assertIsNone(r["proposed"])
        _, r = self.req("GET", "/api/suggest?q=kidney%20stone%20detection")
        self.assertIsNone(r["exact"])
        self.assertEqual(r["matches"][0]["slug"], "kidney-seg")
        self.assertEqual(r["proposed"]["slug"], "kidney-stone-detection")
        _, r = self.req("GET", "/api/suggest?q=%EC%8B%A0%EC%9E%A5")  # Korean only → no ASCII slug
        self.assertIsNone(r["proposed"]["slug"])
        s, r = self.req("POST", "/api/topics", {"slug": "kidney-seg", "name": "dup"})
        self.assertEqual(s, 409)
        s, r = self.req("POST", "/api/topics", {"slug": "Bad Slug", "name": "x"})
        self.assertEqual(s, 400)
        self.assertEqual(r["proposed"], "bad-slug")

    def test_experiment_flow_and_indexes(self):
        self.topic("liver-seg")
        s, r = self.req("POST", "/api/topics/liver-seg/experiments", {"title": "실험 9: baseline", "owner": "홍길동"})
        self.assertEqual((s, r["nn"]), (201, "01"))
        page = Path(os.environ["SITE_DIR"], "topics/liver-seg/01/index.html").read_text("utf-8")
        self.assertIn("<h1 class=\"page-title\">실험 1: baseline</h1>", page)  # number comes from the server
        self.assertIn("volume-viewer.js", page)
        s, r = self.req("POST", "/api/topics/liver-sg/experiments", {"title": "x"})
        self.assertEqual(s, 404)
        self.assertEqual(r["suggestions"]["matches"][0]["slug"], "liver-seg")
        # page edit → title change is reflected in the topic list + search index
        s, _ = self.req("PUT", "/topics/liver-seg/01/index.html", page.replace("실험 1: baseline", "실험 1: tuned").encode())
        self.assertEqual(s, 200)
        _, topic_html = self.req("GET", "/topics/liver-seg/index.html", raw=True)
        self.assertIn("tuned".encode(), topic_html)
        _, idx = self.req("GET", "/data/search-index.json")
        self.assertTrue(any(e["t"] == "실험 1: tuned" for e in idx))
        hist = list(Path(os.environ["SITE_DIR"], ".history/topics/liver-seg/01").glob("index.html.*"))
        self.assertEqual(len(hist), 1)
        # assets: upload, type guard, delete
        self.assertEqual(self.req("PUT", "/topics/liver-seg/01/assets/a.png", b"\x89PNG....")[0], 200)
        self.assertEqual(self.req("PUT", "/topics/liver-seg/01/assets/a.exe", b"x")[0], 415)
        self.assertEqual(self.req("DELETE", "/topics/liver-seg/01/assets/a.png")[0], 200)
        self.assertEqual(self.req("DELETE", "/topics/liver-seg/01/index.html")[0], 403)
        _, files = self.req("GET", "/api/files/liver-seg/01")
        self.assertEqual(files["files"], ["index.html"])

    def test_write_guards(self):
        self.topic("guard-topic")
        for path in ("/index.html", "/assets/report.css", "/data/topics-meta.json", "/AGENTS.md",
                     "/topics/guard-topic/01/../../../index.html", "/topics/guard-topic/.x/a.png",
                     "/topics/nope/index.html", "/topics/guard-topic/07/index.html",
                     "/topics/guard-topic/notes.html"):
            s, _ = self.req("PUT", path, b"<html></html>")
            self.assertGreaterEqual(s, 400, path)
        self.assertEqual(self.req("GET", "/.history/log.jsonl", raw=True)[0], 404)

    def test_concurrent_numbering(self):
        self.topic("race")
        with concurrent.futures.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(lambda i: self.req("POST", "/api/topics/race/experiments", {"title": f"t{i}"}), range(8)))
        self.assertEqual(sorted(r["nn"] for _, r in res), [f"{i:02d}" for i in range(1, 9)])

    def test_rename_and_patch(self):
        self.topic("rename-me", "Old Name")
        self.req("POST", "/api/topics/rename-me/experiments", {"title": "a"})
        s, r = self.req("PATCH", "/api/topics/rename-me", {"name": "New Name", "status": "완료", "kw": "a, b"})
        self.assertEqual(s, 200, r)
        self.assertEqual(r["meta"]["kw"], ["a", "b"])
        exp = Path(os.environ["SITE_DIR"], "topics/rename-me/01/index.html").read_text("utf-8")
        self.assertIn('class="bc-topic" href="../index.html">New Name</a>', exp)
        self.assertEqual(self.req("PATCH", "/api/topics/rename-me", {"status": "bogus"})[0], 400)

    def test_cli_check(self):
        d = Path(TMP.name, "chk")
        (d / "assets").mkdir(parents=True)
        (d / "assets" / "fig.png").write_bytes(b"GIF89a")  # not a real PNG
        (d / "index.html").write_text(
            '<html><script type="text/markdown" data-md>\n## h2\n\t- tab\n![x](assets/fig.png)\n![y](assets/missing.png)\n</script>'
            '<script type="application/json" class="vol-island" data-src="assets/none.vol.json"></script></html>', "utf-8")
        self.assertGreaterEqual(cli.run_check(d, quiet=True), 4)  # tab, fake png, missing png, missing volume (+ no viewer js)

    def test_install_script(self):
        home = Path(TMP.name, "home")
        legacy = home / ".claude" / "skills" / "ai-report"
        legacy.mkdir(parents=True)
        (legacy / "SKILL.md").write_text("---\nname: ai-report\n---\nuse aireport\n")
        foreign = home / ".codex" / "skills" / "ai-report"  # someone else's skill with the old name: keep it
        foreign.mkdir(parents=True)
        (foreign / "SKILL.md").write_text("---\nname: ai-report\n---\nunrelated\n")
        env = dict(os.environ, HOME=str(home), AIREPORT_URL=self.url, AIREPORT_OWNER="tester")
        for k in ("CODEX_HOME", "XDG_CONFIG_HOME"):
            env.pop(k, None)
        subprocess.run(["bash", str(REPO / "client" / "install.sh")], env=env, check=True, capture_output=True)
        skill = (REPO / "skills" / "pl-report" / "SKILL.md").read_text("utf-8")
        self.assertIn("name: pl-report", skill)
        for agent in (".claude", ".codex"):
            self.assertEqual((home / agent / "skills" / "pl-report" / "SKILL.md").read_text("utf-8"), skill)
        self.assertFalse(legacy.exists())
        self.assertTrue(foreign.exists())
        self.assertTrue(os.access(home / ".local" / "bin" / "aireport", os.X_OK))
        cfg = json.loads((home / ".config" / "aireport" / "config.json").read_text())
        self.assertEqual((cfg["url"], cfg["owner"]), (self.url, "tester"))
        bin_ = str(home / ".local" / "bin" / "aireport")
        env.pop("AIREPORT_OWNER")
        for args in (["config", "--owner", "이종민"], ["config"], ["health"]):  # the steps AGENTS.md tells agents to run
            subprocess.run([bin_, *args], env=env, check=True, capture_output=True)
        self.assertEqual(json.loads((home / ".config" / "aireport" / "config.json").read_text())["owner"], "이종민")
        _, served = self.req("GET", "/client/SKILL.md", raw=True)
        self.assertEqual(served.decode(), skill)


@unittest.skipUnless(importlib.util.find_spec("numpy"), "numpy not installed")
class ViewerTest(unittest.TestCase):
    def test_phantom_roundtrip(self):
        import base64
        import gzip
        import numpy as np
        out = Path(TMP.name, "ph.vol.json")
        subprocess.run([sys.executable, str(CLI), "phantom", "-o", str(out)], check=True, capture_output=True)
        v = json.loads(out.read_text())
        self.assertEqual(v["format"], "aireport-volume/1")
        n = v["shape"]
        img = np.frombuffer(gzip.decompress(base64.b64decode(v["image"]["data"])), np.uint8)
        self.assertEqual(img.size, n[0] * n[1] * n[2])
        gt = np.frombuffer(gzip.decompress(base64.b64decode(v["overlays"][0]["data"])), np.uint8).reshape(n, order="F")
        liver = np.argwhere(gt == 1).mean(0)
        self.assertGreater(liver[0], n[0] / 2)  # RAS: liver on the patient's right = high i


if __name__ == "__main__":
    unittest.main()
