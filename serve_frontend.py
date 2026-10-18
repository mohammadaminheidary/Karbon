"""Serve local development assets without retaining stale browser copies."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


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


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 5501), DevelopmentHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
