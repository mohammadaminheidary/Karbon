"""The critical navigation and action positions must work without JavaScript."""
from collections import Counter
from html.parser import HTMLParser
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_navigation", ROOT / "scripts/build_navigation.py")
navigation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(navigation)


class Structure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.actions, self.active, self.ids = [], [], [], Counter()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids[attrs["id"]] += 1
        if tag == "a" and attrs.get("aria-current") == "page":
            self.active.append(attrs.get("href"))
        if tag == "button" and "orders-create" in attrs.get("class", "").split():
            self.actions.append(any("navbar-title-island" in parent.get("class", "").split() for _, parent in self.stack))
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append((tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break


class NavigationMarkupTests(unittest.TestCase):
    def test_every_page_has_one_static_navbar_and_correct_action_positions(self):
        for path in navigation.PAGES:
            with self.subTest(page=path):
                parser = Structure()
                parser.feed((ROOT / path).read_text())
                for identity in ["navbarHost", "mainNavbar", "logoutButton"]:
                    self.assertEqual(parser.ids[identity], 1)
                expected = "/page/banks-page.html" if "bank-transactions" in path else f"/{path}"
                self.assertEqual(parser.active, [expected])
                self.assertTrue(all(parser.actions), "an action button would move after JS starts")
                self.assertEqual(len(parser.ids), sum(parser.ids.values()), "duplicate element IDs")

    def test_generated_navigation_is_current_and_idempotent(self):
        template = (ROOT / "src/templates/navbar.html").read_text()
        for path, title in navigation.PAGES.items():
            with self.subTest(page=path):
                source = (ROOT / path).read_text()
                self.assertEqual(navigation.render_page(source, path, title, template), source)


if __name__ == "__main__":
    unittest.main()
