"""Verify the deployed asset graph, cache invalidation and HTTP representations."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve_frontend import FrontendServer, ProductionHandler

spec = importlib.util.spec_from_file_location('production_build', ROOT / 'scripts/build_production.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ProductionBuildTests(unittest.TestCase):
    def test_graph_hashes_deferred_imports_old_tabs_compression_and_private_paths(self):
        with tempfile.TemporaryDirectory(prefix='karbon-build-') as directory:
            root = Path(directory)
            files = {
                'src/js/entry.js': 'import { value } from "./shared.js"; window.load = () => import("./tool.js"); console.log(value);',
                'src/js/shared.js': 'export const value = 1;',
                'src/js/tool.js': 'export const tool = true;',
                'src/output.css': '@import "./shared.css";\n' + '@font-face {font-family: test; src: url("../assets/fonts/vazirmatn/Vazirmatn-Variable.woff2");}' * 10,
                'src/shared.css': '.field { color: blue; }',
                'assets/fonts/vazirmatn/Vazirmatn-Variable.woff2': 'synthetic-font',
                'assets/image/banks/test.svg': '<svg></svg>',
                'index.html': '<html><head><link href="./src/output.css"><script type="module" src="./src/js/entry.js"></script></head></html>',
                'page/login-page.html': '<script src="../src/js/entry.js"></script>',
            }
            for name, body in files.items():
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(body)
            builder.build(root)
            output = root / 'dist'
            manifest = json.loads((output / 'asset-manifest.json').read_text())
            for name, url in manifest.items():
                file = output / url.lstrip('/')
                self.assertIn(hashlib.sha256(file.read_bytes()).hexdigest()[:16], url)
            entry = (output / manifest['src/js/entry.js'].lstrip('/')).read_text()
            self.assertIn(manifest['src/js/shared.js'], entry)
            self.assertIn(manifest['src/js/tool.js'], entry)
            html = (output / 'index.html').read_text()
            self.assertIn(f'rel="modulepreload" href="{manifest["src/js/shared.js"]}"', html)
            self.assertNotIn(f'rel="modulepreload" href="{manifest["src/js/tool.js"]}"', html)
            self.assertIn(manifest['assets/fonts/vazirmatn/Vazirmatn-Variable.woff2'], (output / manifest['src/output.css'].lstrip('/')).read_text())
            self.assertIn(manifest['src/shared.css'], (output / manifest['src/output.css'].lstrip('/')).read_text())
            self.assertIn('rel="preload" as="font"', html)
            (root / 'src/js/shared.js').write_text('export const value = 2;')
            builder.build(root)
            updated = json.loads((output / 'asset-manifest.json').read_text())
            self.assertNotEqual(manifest['src/js/entry.js'], updated['src/js/entry.js'])
            self.assertTrue((output / manifest['src/js/entry.js'].lstrip('/')).is_file(), 'open tabs still need old chunks')
            self.assertEqual(gzip.decompress((output / 'index.html.gz').read_bytes()), (output / 'index.html').read_bytes())

            class Handler(ProductionHandler):
                def log_message(self, *_):
                    pass
            Handler.root = output
            server = FrontendServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                for method in ('GET', 'HEAD'):
                    with urlopen(Request(base + manifest['src/js/entry.js'], method=method)) as response:
                        self.assertIn('immutable', response.headers['Cache-Control'])
                        self.assertEqual(response.headers['Content-Type'], 'text/javascript')
                with urlopen(Request(base + '/index.html', headers={'Accept-Encoding': 'gzip'})) as response:
                    self.assertEqual(response.headers['Content-Encoding'], 'gzip')
                    self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                    self.assertEqual(gzip.decompress(response.read()), (output / 'index.html').read_bytes())
                with urlopen(Request(base + '/index.html', headers={'Accept-Encoding': 'gzip;q=0'})) as response:
                    self.assertIsNone(response.headers.get('Content-Encoding'))
                for name in ('/.env', '/../backend/config.py', '/test.db', '/index.html.gz'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + name)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
