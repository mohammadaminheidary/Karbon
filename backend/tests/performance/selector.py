import os
from pathlib import Path
# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
exec(open(Path(__file__).with_name('bench.py')).read().split('paths=')[0])
rows=[]
for i in range(43):
 data,row=call('/customers/options?limit=100',token=token)
 if i>=3:rows.append(row)
(out/(phase+'-selector-light.json')).write_text(json.dumps(rows,indent=2));print('selector',statistics.median(r['ms'] for r in rows),'queries',rows[0]['queries'],'bytes',rows[0]['bytes'])
