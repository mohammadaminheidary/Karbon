"""The static frontend must not expose biometric databases, keys, or backend."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve_frontend import DevelopmentHandler


class QuietHandler(DevelopmentHandler):
    def log_message(self, *_):
        pass


class PrivateFilesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def test_private_paths_block_get_and_head(self):
        for path in ("/.git/config", "/backend/requirements.txt", "/data/karbon.db", "/face.key", "/backup.db-wal", "/src/%2e%2e/backend/requirements.txt", "/%2eenv"):
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(self.base + path, method=method), timeout=5)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()

    def test_pages_and_camera_module_remain_accessible(self):
        for path in ("/index.html", "/page/attendance-page.html", "/src/js/attendance/face-camera.js", "/src/face-attendance.css"):
            with self.subTest(path=path), urlopen(self.base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
