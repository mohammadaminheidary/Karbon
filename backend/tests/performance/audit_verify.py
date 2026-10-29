"""Compare synthetic responses and committed write invariants without mutation."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3

out = Path(os.environ['KARBON_PERF_DIR']).resolve()
environment = json.loads((out/'environment.json').read_text())
assert hashlib.sha256((out/'base.db').read_bytes()).hexdigest() == environment['base_sha256'], 'Synthetic base changed'


def read(phase, name, compressed=False):
    value = json.loads((out/f"{phase}-audit-{name}-response{'-gzip' if compressed else ''}.json").read_text())
    if name.startswith('dashboard'):
        value.pop('generated_at', None)
    return value


names = [name.name.removeprefix('before-audit-').removesuffix('-response.json') for name in sorted(out.glob('before-audit-*-response.json'))]
for name in names:
    a, b = read('before',name), read('after',name)
    if name == 'dashboard_initial':
        a.pop('product_sales')
        a['customers'].pop('debtors')
    assert a == b, f'Contract/totals mismatch: {name}'
    for phase in ['before','after']:
        assert read(phase,name) == read(phase,name,True), f'Compression changed data: {phase}/{name}'

queries = {
    'customers': 'SELECT COUNT(*) FROM customers',
    'orders': 'SELECT COUNT(*) FROM orders',
    'items': 'SELECT COUNT(*) FROM order_items',
    'payments': 'SELECT COUNT(*) FROM order_payments',
    'financial_transactions': 'SELECT COUNT(*) FROM financial_transactions',
    'net_money': "SELECT SUM(CASE WHEN kind='income' THEN amount ELSE -amount END) FROM financial_transactions WHERE deleted_at IS NULL",
    'order_totals': 'SELECT SUM(subtotal-discount) FROM orders WHERE deleted_at IS NULL',
    'stock_product_1': 'SELECT stock FROM products WHERE id=1',
    'dangling_payments': 'SELECT COUNT(*) FROM order_payments p LEFT JOIN orders o ON o.id=p.order_id LEFT JOIN financial_transactions t ON t.id=p.transaction_id WHERE o.id IS NULL OR t.id IS NULL',
}
states = {}
for phase in ['before','after']:
    with sqlite3.connect(f'file:{out/ (phase+".db")}?mode=ro',uri=True) as db:
        states[phase] = {name:db.execute(query).fetchone()[0] for name,query in queries.items()}
assert states['before'] == states['after'], 'Committed write invariants differ'
assert states['after']['orders']==1043 and states['after']['financial_transactions']==5486
assert states['after']['stock_product_1']==9957 and states['after']['dangling_payments']==0
result = dict(unchanged_base_sha256=environment['base_sha256'],equal_contracts=names,
    ignored='dashboard.generated_at only; initial view intentionally omits the two deferred detail lists',
    compression_roundtrip='All 16 paths in both phases match identity data',write_states=states)
(out/'correctness.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
