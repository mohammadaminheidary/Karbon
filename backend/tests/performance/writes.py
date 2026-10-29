import os
from pathlib import Path
# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
exec(open(Path(__file__).with_name('bench.py')).read().split('paths=')[0])
from uuid import uuid4
rows=[]
for i in range(43):
 data,row=call('/orders',{'request_id':str(uuid4()),'customer_id':1,'invoice_date':jdatetime.date.fromgregorian(date=today).strftime('%Y/%m/%d'),'payment_date':jdatetime.date.fromgregorian(date=today).strftime('%Y/%m/%d'),'items':[{'product_id':1,'quantity':1,'unit_price':10000}],'payments':[{'method':'pos','bank_id':1,'amount':5000}],'discount':0},token)
 if i>=3:rows.append(row)
(out/(phase+'-writes.json')).write_text(json.dumps(rows,indent=2))
print('order create',statistics.median(r['ms'] for r in rows),'queries',rows[0]['queries'])
