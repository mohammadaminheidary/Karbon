"""Serve local development assets without retaining stale browser copies."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse
import re
import os


class DevelopmentHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).resolve().parent), **kwargs)

    def send_head(self):
        path = Path(unquote(urlsplit(self.path).path))
        root = Path(__file__).resolve().parent
        target = Path(self.translate_path(self.path)).resolve()
        relative_parts = target.relative_to(root).parts if target.is_relative_to(root) else ()
        # Private storage and keys must never be reachable through the static
        # server, including installations using a database inside the checkout.
        private_suffixes = {".db", ".db-wal", ".db-shm", ".key", ".sqlite", ".sqlite3", ".bak"}
        if (not target.is_relative_to(root)
                or any(part.startswith(".") or part in {"backend", "data"} for part in (*path.parts[1:], *relative_parts))
                or path.suffix.lower() in private_suffixes
                or target.suffix.lower() in private_suffixes):
            self.send_error(404)
            return None
        return super().send_head()

    def do_GET(self):
        # Always return the current file, including requests from an old cache.
        if "If-Modified-Since" in self.headers:
            del self.headers["If-Modified-Since"]
        super().do_GET()

    def end_headers(self):
        # Revalidate development assets while allowing the browser to retain
        # whole documents (including filters, scroll and DOM) in its history cache.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class ProductionHandler(SimpleHTTPRequestHandler):
    """Serve only build output. HTML revalidates; hashed assets are immutable."""
    root = Path(__file__).resolve().parent / "dist"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.root), **kwargs)

    def send_head(self):
        target = Path(self.translate_path(self.path)).resolve()
        if target.is_dir():
            target /= "index.html"
        if not target.is_relative_to(self.root.resolve()) or any(part.startswith(".") for part in target.relative_to(self.root.resolve()).parts) or not target.is_file():
            self.send_error(404)
            return None
        # Only files emitted by the build may be served (never sidecar downloads).
        if target.suffix not in {".html", ".js", ".css", ".woff2", ".webp", ".svg", ".json", ".txt"}:
            self.send_error(404)
            return None
        compressed = target.with_name(target.name + ".gz")
        accepts_gzip = any(token.strip().split(";", 1)[0] == "gzip" and not re.search(r";\s*q=0(?:\.0*)?\s*$", token)
                           for token in self.headers.get("Accept-Encoding", "").split(","))
        body = compressed if accepts_gzip and compressed.is_file() and compressed.stat().st_mtime_ns >= target.stat().st_mtime_ns else target
        stream = body.open("rb")
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if re.search(r"\.[a-f0-9]{16}\.", target.name) else "no-cache")
        self.send_header("Vary", "Accept-Encoding")
        if body != target:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        return stream


class FrontendServer(ThreadingHTTPServer):
    # Module graphs can open several connections while the previous document is
    # closing. Avoid the default queue of five at the boundary where intermittent
    # TCP resets were observed during module loading.
    request_queue_size = 128
    daemon_threads = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--port", type=int, default=5501)
    args = parser.parse_args()
    if args.production and not ProductionHandler.root.is_dir():
        parser.error("Production assets are missing. Run npm --prefix frontend run build.")
    with FrontendServer(("127.0.0.1", args.port), ProductionHandler if args.production else DevelopmentHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
