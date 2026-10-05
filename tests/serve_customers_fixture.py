"""Disposable browser fixture; never writes to the application's live database.
Login: customers-test / test-password. Ctrl+C stops and removes the fixture.
For load-more checks: --backend-port 8001 --frontend-port 5502 --customers 25
"""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--backend-port", type=int, default=8000)
parser.add_argument("--frontend-port", type=int, default=5501)
parser.add_argument("--customers", type=int, default=0)
args = parser.parse_args()
if not 0 <= args.customers <= 200:
    parser.error("--customers must be between 0 and 200")


class FixtureHandler(SimpleHTTPRequestHandler):
    def __init__(self, *handler_args, **kwargs):
        super().__init__(*handler_args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Only the fixture server rewrites the API origin, so a separate test
        # environment can run beside the user's normal app without logging out
        # their session or changing any production JavaScript configuration.
        path = urlsplit(self.path).path
        if path in ["/src/js/auth/auth-api.js", "/src/js/customers/customer-api.js"]:
            content = (ROOT / path.lstrip("/")).read_text().replace(
                "http://127.0.0.1:8000/api",
                f"http://127.0.0.1:{args.backend_port}/api",
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()


with tempfile.TemporaryDirectory(prefix="karbon-browser-test-") as directory:
    env = dict(os.environ, KARBON_DATABASE_PATH=str(Path(directory) / "test.db"), KARBON_JWT_SECRET=secrets.token_urlsafe(32))
    bootstrap = f'''
import app
from database import SessionLocal
from models.user import User
from models.customer import Customer
from security.password import hash_password
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
app.app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:{args.frontend_port}"], allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type", "Authorization"])
with SessionLocal() as db:
    db.add(User(username="customers-test", password_hash=hash_password("test-password")))
    for index in range({args.customers}):
        db.add(Customer(customer_code=1001 + index, first_name=f"مشتری {{index + 1}}", last_name="آزمایشی", gender="male" if index % 2 else "female", phone_numbers=[f"0912{{index + 1:07d}}"], address="آدرس محیط آزمایشی"))
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port={args.backend_port})
'''
    frontend = ThreadingHTTPServer(("127.0.0.1", args.frontend_port), FixtureHandler)
    thread = threading.Thread(target=frontend.serve_forever, daemon=True)
    backend = subprocess.Popen([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=env)
    thread.start()
    print(f"Isolated browser fixture: http://127.0.0.1:{args.frontend_port}/page/customers-page.html", flush=True)
    try:
        while backend.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        frontend.shutdown()
        frontend.server_close()
        thread.join(timeout=5)
        if backend.poll() is None:
            backend.terminate()
        backend.wait(timeout=10)
