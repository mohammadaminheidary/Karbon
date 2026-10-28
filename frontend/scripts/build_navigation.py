"""Render the shared navigation into HTML so the shell never depends on JS.

Run after editing src/templates/navbar.html or a page's marked action buttons.
--check verifies that committed HTML matches the template without modifying it.
"""
import argparse
import html
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PAGES = {
    "index.html": "داشبورد",
    "page/customers-page.html": "مشتریان",
    "page/orders-page.html": "سفارشات",
    "page/finance-page.html": "مالی",
    "page/attendance-page.html": "ورودی اعضا",
    "page/daily-tasks-page.html": "کارهای روزانه",
    "page/documents-page.html": "ثبت سند",
    "page/banks-page.html": "بانک ها",
    "page/bank-transactions-page.html": "تراکنش‌های حساب",
    "page/settings-page.html": "تنظیمات",
    "page/warehouse-page.html": "انبار",
}
NAVIGATION = re.compile(r"<!-- navigation:start -->[\s\S]*?<!-- navigation:end -->")
ACTIONS = re.compile(r"<!-- navbar-actions:start -->([\s\S]*?)<!-- navbar-actions:end -->")


def render_page(source, path, title, template):
    current = NAVIGATION.search(source)
    if not current:
        raise ValueError(f"Navigation marker missing: {path}")
    actions = ACTIONS.search(current.group())
    if not actions:
        raise ValueError(f"Action markers missing: {path}")
    active_path = "/page/banks-page.html" if "bank-transactions" in path else f"/{path}"
    navbar = template.replace(
        f'<a href="{active_path}" class="navbar-item"',
        f'<a href="{active_path}" aria-current="page" class="navbar-item"',
    ).replace(
        '<span class="navbar-page-title" aria-live="polite"></span>',
        f'<span class="navbar-page-title" aria-live="polite" title="{html.escape(title)}">{html.escape(title)}</span>',
    )
    action_markup = actions.group(1).strip()
    if action_markup:
        navbar = navbar.replace("navbar-info navbar-title-island", "navbar-info navbar-title-island orders-title-island", 1)
    navbar = navbar.replace(
        "  </section>",
        "    <!-- navbar-actions:start -->\n" + action_markup + "\n    <!-- navbar-actions:end -->\n  </section>",
        1,
    )
    rendered = '<!-- navigation:start -->\n<div id="navbarHost">\n' + navbar.rstrip() + '\n</div>\n<!-- navigation:end -->'
    return source[:current.start()] + rendered + source[current.end():]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    template = (ROOT / "src/templates/navbar.html").read_text()
    changed = []
    for path, title in PAGES.items():
        file = ROOT / path
        source = file.read_text()
        rendered = render_page(source, path, title, template)
        if rendered != source:
            changed.append(path)
            if not args.check:
                # A browser can request these files while the dev server runs.
                # Replace complete files instead of exposing a truncated write.
                temporary = file.with_suffix(".html.tmp")
                temporary.write_text(rendered)
                temporary.replace(file)
    if args.check and changed:
        raise SystemExit("Regenerate navigation: " + ", ".join(changed))


if __name__ == "__main__":
    main()
