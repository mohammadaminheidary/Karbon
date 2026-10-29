"""Exercise the real root launcher using isolated data and its public ports."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.name == "posix", "Process-group checks require POSIX")
class LauncherTests(unittest.TestCase):
    def setUp(self):
        for port in (8000, 5501):
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    self.skipTest(f"Port {port} is occupied; leave existing servers untouched")
        self.temp = tempfile.TemporaryDirectory(prefix="karbon-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.log = (self.directory / "launcher.log").open("w+")
        self.addCleanup(self.log.close)
        env = dict(os.environ, KARBON_DATABASE_PATH=str(self.directory / "test.db"),
                   KARBON_JWT_SECRET="isolated-launcher-test-secret", BROWSER="/usr/bin/true")
        self.process = subprocess.Popen([sys.executable, str(ROOT / "start.py"), *(["--production"] if self._testMethodName.startswith("test_production") else [])],
                                        cwd=self.directory, env=env, stdout=self.log, stderr=self.log)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            self.log.seek(0)
            if "Karbon is running:" in self.log.read():
                break
            if self.process.poll() is not None:
                self.fail(self.output())
            time.sleep(0.1)
        else:
            self.fail("Launcher readiness timed out\n" + self.output())
        # Record the launcher-owned server/reloader process IDs.
        rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True)
        self.children = [int(pid) for pid, parent in (row.split() for row in rows.splitlines())
                         if int(parent) == self.process.pid]
        self.assertEqual(len(self.children), 2, self.output())

    def output(self):
        self.log.seek(0)
        return self.log.read()

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)

    def assert_stopped(self, expected_code=0):
        self.assertEqual(self.process.wait(timeout=15), expected_code, self.output())
        for pid in self.children:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        for port in (8000, 5501):
            with socket.socket() as sock:
                self.assertNotEqual(sock.connect_ex(("127.0.0.1", port)), 0)

    def test_absolute_launcher_build_assets_cors_and_ctrl_c_cleanup(self):
        with urlopen("http://127.0.0.1:8000/", timeout=5) as response:
            self.assertEqual(json.load(response)["status"], "running")
        for path in ("/page/login-page.html", "/index.html", "/page/settings-page.html",
                     "/src/output.css", "/src/js/page/settings.js",
                     "/assets/image/banks/melli.svg", "/assets/fonts/vazirmatn/Vazirmatn-Variable.woff2"):
            with self.subTest(path=path), urlopen("http://127.0.0.1:5501" + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
        request = Request("http://127.0.0.1:8000/api/customers", method="OPTIONS", headers={
            "Origin": "http://127.0.0.1:5501", "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization"})
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:5501")
        self.process.send_signal(signal.SIGINT)
        self.assert_stopped()

    def test_sigterm_stops_both_servers_and_reload_worker(self):
        self.process.terminate()
        self.assert_stopped()

    def test_production_launcher_serves_versioned_compressed_assets(self):
        import re
        with urlopen("http://127.0.0.1:5501/index.html") as response:
            html = response.read().decode()
            self.assertEqual(response.headers["Cache-Control"], "no-cache")
        asset = re.search(r'src="(/assets/build/[^\"]+\.js)"', html)[1]
        with urlopen(Request("http://127.0.0.1:5501" + asset, headers={"Accept-Encoding": "gzip"})) as response:
            self.assertIn("immutable", response.headers["Cache-Control"])
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.process.terminate()
        self.assert_stopped()

    def test_server_failure_stops_the_other_server(self):
        rows = subprocess.check_output(["ps", "-axo", "pid=,args="], text=True)
        frontend = next(pid for pid in self.children if any(
            row.strip().startswith(f"{pid} ") and "serve_frontend.py" in row for row in rows.splitlines()))
        os.kill(frontend, signal.SIGTERM)
        self.assert_stopped(expected_code=1)
        self.assertIn("Frontend exited", self.output())


if __name__ == "__main__":
    unittest.main()
