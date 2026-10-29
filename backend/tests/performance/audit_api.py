"""Repeatable localhost API measurements against the isolated synthetic fixture."""
import json
import os
from pathlib import Path
import statistics
import sys
import time
import gzip
from datetime import datetime
from urllib.request import Request, urlopen
from uuid import uuid4
from zoneinfo import ZoneInfo

import jdatetime
import psutil

phase = sys.argv[1]
compressed = '--gzip' in sys.argv
suffix = '-gzip' if compressed else ''
out = Path(os.environ['KARBON_PERF_DIR']).resolve()
base = os.environ.get('KARBON_API_URL', 'http://127.0.0.1:8029/api')


def call(path, body=None, token=None):
    start = time.perf_counter()
    with urlopen(Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                         headers={'Content-Type': 'application/json', **({'Accept-Encoding': 'gzip'} if compressed else {}), **({'Authorization': 'Bearer ' + token} if token else {})}), timeout=30) as response:
        content = response.read()
        wire_bytes = len(content)
        if response.headers.get('Content-Encoding') == 'gzip':
            content = gzip.decompress(content)
        return json.loads(content), dict(ms=(time.perf_counter()-start)*1000, bytes=len(content),
            wire_bytes=wire_bytes,
            queries=int(response.headers.get('x-perf-count', 0)), sql_ms=float(response.headers.get('x-perf-sql-ms', 0)),
            cpu_ms=float(response.headers.get('x-perf-cpu-ms', 0)))


token = call('/login', {'username': 'customers-test', 'password': 'test-password'})[0]['token']
today = datetime.now(ZoneInfo('Asia/Tehran')).date()
paths = {
    'dashboard': '/dashboard?days=30', 'customers': '/customers?limit=12', 'orders': '/orders?limit=20',
    'dashboard_initial': '/dashboard?days=30' + ('&view=summary' if phase != 'before' else ''),
    'finance': '/finance/day?date=' + today.isoformat(), 'banks': '/banks',
    'bank_activity': '/banks/1/activity?period=month', 'bank_ledger': '/banks/1/transactions',
    'selector': '/customers/options?limit=100', 'inventory': '/products?include_inactive=true',
    'tasks': '/tasks', 'settings_invoices': '/settings/invoices', 'documents': '/documents',
    'members': '/members', 'categories': '/settings/expense-categories',
    'inventory_options': '/settings/inventory-options',
}
results = {}
for name, path in paths.items():
    rows = []
    for i in range(43):
        data, row = call(path, token=token)
        if i == 0:
            (out/(phase+'-audit-'+name+'-response'+suffix+'.json')).write_text(json.dumps(data, ensure_ascii=False, sort_keys=True))
        if i >= 3:
            rows.append(row)
    results[name] = rows
    print(name, 'p50', round(statistics.median(r['ms'] for r in rows), 3), 'SQL', rows[0]['queries'], flush=True)
results['rss_mb'] = [p.memory_info().rss/1048576 for p in psutil.process_iter(['cmdline'])
    if '/tests/performance/server.py' in ' '.join(p.info['cmdline'] or [])]
(out/(phase+'-audit-api'+suffix+'.json')).write_text(json.dumps(results, indent=2))

# Write trials run separately, after every read/browser benchmark, on a fresh copy.
if '--writes' in sys.argv:
    jalali = jdatetime.date.fromgregorian(date=today).strftime('%Y/%m/%d')
    for name in ('order_write', 'finance_write'):
        rows = []
        for i in range(43):
            if name == 'order_write':
                data = dict(request_id=str(uuid4()), customer_id=1, invoice_date=jalali, payment_date=jalali,
                    items=[dict(product_id=1, quantity=1, unit_price=30000)], payments=[dict(method='pos', bank_id=1, amount=10000)])
                endpoint = '/orders'
            else:
                data = dict(request_id=str(uuid4()), kind='income', customer_id=1, bank_id=1, amount=10000,
                    transaction_date=jalali, time_mode='auto')
                endpoint = '/finance/transactions'
            _, row = call(endpoint, data, token)
            if i >= 3:
                rows.append(row)
        results[name] = rows
        print(name, statistics.median(r['ms'] for r in rows), flush=True)
    (out/(phase+'-audit-writes.json')).write_text(json.dumps({k:v for k,v in results.items() if k.endswith('_write')}, indent=2))
