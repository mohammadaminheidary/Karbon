"""Resolve the frontend's local HTML, stylesheet and ES-module dependencies."""
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import unittest
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CSS_REFERENCES = re.compile(r'''(?:url\(\s*["']?([^\s"')]+)|@import\s+["']([^"']+))''')
JS_IMPORTS = re.compile(r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']''')


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {"href", "src", "poster"} and value:
                self.paths.append(value)
            if key == "style" and value:
                self.paths.extend(a or b for a, b in CSS_REFERENCES.findall(value))


class AssetPathsTests(unittest.TestCase):
    def assert_resolves(self, source, value):
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or not parsed.path:
            return
        target = (ROOT / unquote(parsed.path).lstrip("/") if parsed.path.startswith("/")
                  else source.parent / unquote(parsed.path)).resolve()
        self.assertTrue(target.is_relative_to(ROOT), f"{source}: {value} escapes frontend")
        self.assertTrue(target.is_file(), f"{source}: missing {value}")

    def test_all_html_asset_links_and_navigation_targets(self):
        for source in [ROOT / "index.html", *ROOT.glob("page/*.html"), *ROOT.glob("src/templates/*.html")]:
            parser = References()
            parser.feed(source.read_text())
            for value in parser.paths:
                with self.subTest(file=source.relative_to(ROOT), reference=value):
                    self.assert_resolves(source, value)

    def test_css_imports_fonts_and_backgrounds(self):
        for source in ROOT.glob("src/*.css"):
            for a, b in CSS_REFERENCES.findall(source.read_text()):
                value = a or b
                if value == "tailwindcss":
                    self.assertTrue((ROOT / "node_modules/tailwindcss/package.json").is_file())
                else:
                    with self.subTest(file=source.relative_to(ROOT), reference=value):
                        self.assert_resolves(source, value)

    def test_js_module_graph_and_syntax(self):
        for source in ROOT.glob("src/js/**/*.js"):
            text = source.read_text()
            with self.subTest(file=source.relative_to(ROOT)):
                result = subprocess.run(["node", "--input-type=module", "--check"],
                                        input=text, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                for value in JS_IMPORTS.findall(text):
                    self.assert_resolves(source, value)


if __name__ == "__main__":
    unittest.main()
