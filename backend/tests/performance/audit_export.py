"""Export only explicitly selected synthetic evidence; never export keys or tokens."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[3]
source = Path(os.environ['KARBON_PERF_DIR']).resolve()
target = root / 'docs/performance/followup-data'
target.mkdir(parents=True, exist_ok=True)


def compressed(origin, name=None):
    destination = target / ((name or origin.name) + '.gz')
    destination.write_bytes(gzip.compress(origin.read_bytes(), compresslevel=6, mtime=0))


for name in ['audit-summary.json', 'environment.json', 'query-plans.json', 'correctness.json']:
    shutil.copyfile(source / name, target / name)
for phase in ['before', 'after']:
    for suffix in ['audit-api', 'audit-api-gzip', 'audit-writes', 'pages', 'extras-pages', 'more-pages',
                   'picker', 'process', 'face', 'face-vectors', 'cpu-profile', 'trace']:
        compressed(source / f'{phase}-{suffix}.json')
    for response in sorted(source.glob(f'{phase}-audit-*-response*.json')):
        compressed(response)
    for name in ['pages','extras','more','picker','writes','process','face-vectors']:
        compressed(source/f'{phase}-{name}.log')
for name in ['backend-tests-final.log', 'frontend-tests-final.log', 'node-tests.log', 'dashboard-e2e-final.log',
             'fetching-e2e-final.log', 'refresh-e2e-final.log', 'startup-e2e-final.log', 'navigation-e2e-final.log',
             'face-e2e-final.log', 'warehouse-e2e-final.log', 'purchase-e2e-final.log', 'features-e2e-final.log']:
    compressed(source / name)
compressed(source / 'controlled-data/after-pages.json', 'controlled-original-assets-pages.json')
for name in ['before-profile-trace.json','before-profile-cpu-profile.json','full-diagnostic.json']:
    compressed(source / name)
compressed(source / 'base.db', 'synthetic-base.db')
shutil.copyfile(source / 'entry.diff', target / 'entry-baseline.patch')
for name in ['run.py', 'server.py']:
    shutil.copyfile(source / 'baseline/backend/tests/performance' / name, target / f'baseline-{name}')
compressed(source / 'baseline/frontend/src/output.css', 'baseline-output.css')
manifest = {f.name: {'bytes': f.stat().st_size, 'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}
    for f in sorted(target.iterdir()) if f.is_file() and f.name != 'manifest.json'}
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(f'Exported {len(manifest)} explicitly selected synthetic artifacts to {target}')
