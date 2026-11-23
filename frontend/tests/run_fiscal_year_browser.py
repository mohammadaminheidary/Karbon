"""Run fiscal-year browser checks with the same disposable API as the fiscal tests."""
import os
from pathlib import Path
import subprocess
import sys
from threading import Thread
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend/tests"))
sys.path.insert(0, str(ROOT / "frontend"))
from serve_frontend import DevelopmentHandler, FrontendServer
from test_fiscal_years import FiscalFixture, PASSPHRASE


def verify():
    with FiscalFixture() as fixture:
        bank, product = fixture.references()
        customer = fixture.customer("مانده مرورگر", ["09120000111"])
        order = fixture.order(customer, product, number="BROWSER-ORDER", total=10_000_000, paid=7_000_000)

        class Handler(DevelopmentHandler):
            def log_message(self, *args):
                pass

            def proxy(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
                request = Request(fixture.base + self.path, body, method=self.command, headers={
                    key: self.headers[key] for key in ("Authorization", "Content-Type") if key in self.headers
                })
                try:
                    response = urlopen(request, timeout=90)
                except HTTPError as error:
                    response = error
                with response:
                    content = response.read()
                    self.send_response(response.status)
                    self.send_header("Content-Type", response.headers["Content-Type"])
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)

            def do_GET(self):
                path = urlsplit(self.path).path
                if path.startswith("/api/"):
                    return self.proxy()
                if path.startswith("/src/js/") and path.endswith(".js"):
                    source = Path(self.translate_path(path))
                    if source.is_file():
                        content = source.read_text().replace("http://127.0.0.1:8000/api",
                            f"http://127.0.0.1:{self.server.server_port}/api").encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/javascript; charset=utf-8")
                        self.end_headers()
                        self.wfile.write(content)
                        return
                super().do_GET()

            do_POST = proxy
            do_PUT = proxy
            do_DELETE = proxy

        with FrontendServer(("127.0.0.1", 0), Handler) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                env = dict(os.environ, KARBON_TEST_URL=f"http://127.0.0.1:{server.server_port}",
                           KARBON_FISCAL_TEST_TOKEN=fixture.token, KARBON_FISCAL_TEST_YEAR=str(fixture.year),
                           KARBON_FISCAL_TEST_CUSTOMER=str(customer["id"]), KARBON_FISCAL_TEST_BANK=str(bank["id"]),
                           KARBON_FISCAL_TEST_ORDER=str(order["id"]), KARBON_FISCAL_TEST_PASSPHRASE=PASSPHRASE)
                return subprocess.run(["node", str(ROOT / "frontend/tests/fiscal_year_browser.mjs")], env=env).returncode
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    sys.exit(verify())
