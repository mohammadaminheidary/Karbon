"""Build public assets with content hashes and precompressed HTTP representations.

No bundler/runtime dependency: native ES modules (including dynamic imports) stay
separate. Dependencies are rewritten before hashing, so a child change invalidates
its parents. Only explicitly public inputs enter dist/.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
IMPORT = re.compile(r'''((?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'])([^"']+)(["'])''')
CSS = re.compile(r'''(url\(\s*["']?)([^\s"')]+)(["']?\s*\))''')
CSS_IMPORT = re.compile(r'''(@import\s+["'])([^"']+)(["'])''')
HTML = re.compile(r'''((?:src|href)=["'])([^"']+)(["'])''')


class ModuleEntries(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.entries = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module' and attrs.get('src'):
            self.entries.append(attrs['src'])


def build(root=ROOT):
    root = Path(root).resolve()
    output = root / 'dist'
    # Keep immutable chunks for already-open documents and deferred imports.
    (output / 'assets/build').mkdir(parents=True, exist_ok=True)
    manifest, visiting, dependencies = {}, set(), {}
    sources = {p.resolve() for pattern in ('src/js/**/*.js', 'src/*.css', 'assets/**/*.woff2', 'assets/**/*.webp', 'assets/**/*.svg')
               for p in root.glob(pattern) if p.name != 'input.css'}
    api_base = os.environ.get('KARBON_API_BASE_URL', 'http://127.0.0.1:8000/api')

    def write(destination, body):
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.tmp')
        temporary.write_bytes(body)
        temporary.replace(destination)
        if destination.suffix in {'.html', '.js', '.css', '.svg', '.json'}:
            compressed = gzip.compress(body, compresslevel=9, mtime=0)
            sidecar = destination.with_name(destination.name + '.gz')
            if len(compressed) < len(body):
                temporary = sidecar.with_name(sidecar.name + '.tmp')
                temporary.write_bytes(compressed)
                temporary.replace(sidecar)
            else:
                sidecar.unlink(missing_ok=True)

    def target(source, value):
        url = urlsplit(value)
        if url.scheme or url.netloc or not url.path:
            return None
        path = root / url.path.lstrip('/') if url.path.startswith('/') else source.parent / url.path
        return path.resolve()

    def asset(source):
        if source in manifest:
            return manifest[source]
        if source in visiting:
            raise ValueError(f'Cyclic asset imports require a bundler: {source}')
        visiting.add(source)
        body = source.read_bytes()
        if source.suffix in {'.js', '.css'}:
            text = body.decode()
            if source.suffix == '.js':
                text = text.replace('http://127.0.0.1:8000/api', api_base)

            def replace(match):
                child = target(source, match[2])
                if source.suffix == '.js' and child in sources and not re.match(r'import\s*\(', match[0]):
                    dependencies.setdefault(source, set()).add(child)
                return match[1] + asset(child) + match[3] if child in sources else match[0]

            for regex in ([IMPORT] if source.suffix == '.js' else [CSS, CSS_IMPORT]):
                text = regex.sub(replace, text)
            body = text.encode()
        digest = hashlib.sha256(body).hexdigest()[:16]
        name = f'/assets/build/{source.stem}.{digest}{source.suffix}'
        write(output / name.lstrip('/'), body)
        manifest[source] = name
        visiting.remove(source)
        return name

    for source in sorted(sources):
        asset(source)
    for source in [root / 'index.html', *sorted((root / 'page').glob('*.html'))]:
        def replace_html(match):
            child = target(source, match[2])
            return match[1] + manifest[child] + match[3] if child in manifest else match[0]
        destination = output / source.relative_to(root)
        text = source.read_text()
        preload = set()
        def collect(entry):
            for child in dependencies.get(entry, ()):
                if child not in preload:
                    preload.add(child)
                    collect(child)
        for value in ModuleEntries(text).entries:
            collect(target(source, value))
        links = ''.join(f'<link rel="modulepreload" href="{manifest[child]}" />\n' for child in sorted(preload))
        text = HTML.sub(replace_html, text).replace('</head>', links + '</head>')
        font = root / 'assets/fonts/vazirmatn/Vazirmatn-Variable.woff2'
        if font in manifest:
            # It is used on every page. Start it before nested CSS imports and
            # the module graph, avoiding a late font-dependent layout pass.
            font_link = f'<link rel="preload" as="font" type="font/woff2" href="{manifest[font]}" crossorigin />\n'
            text = text.replace('<head>', '<head>\n' + font_link)
        write(destination, text.encode())
    # Bank logos are also selected by runtime code; these stable paths revalidate.
    for source in (root / 'assets/image/banks').iterdir():
        if source.is_file():
            write(output / source.relative_to(root), source.read_bytes())
    for source in (root / 'assets/fonts').glob('**/*.txt'):
        write(output / source.relative_to(root), source.read_bytes())
    write(output / 'asset-manifest.json', json.dumps({str(k.relative_to(root)): v for k, v in manifest.items()}, indent=2).encode())
    print(f'Production build: {len(manifest)} versioned assets → {output}')


if __name__ == '__main__':
    build()
