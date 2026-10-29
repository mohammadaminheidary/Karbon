# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
import os,json,time,statistics,sys,math,sqlite3
from pathlib import Path
from urllib.request import Request,urlopen
try:
    import psutil
except ImportError:
    psutil = None
from datetime import datetime
from zoneinfo import ZoneInfo
import jdatetime
phase=sys.argv[1];out=Path(os.environ['KARBON_PERF_DIR']).resolve();base='http://127.0.0.1:8029/api';today=datetime.now(ZoneInfo('Asia/Tehran')).date()
def call(path,body=None,token=None):
 start=time.perf_counter()
 with urlopen(Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})) as r:
  data=r.read();ms=(time.perf_counter()-start)*1000
  return json.loads(data),dict(ms=ms,bytes=len(data),queries=int(r.headers.get('x-perf-count',0)),sql_ms=float(r.headers.get('x-perf-sql-ms',0)),cpu_ms=float(r.headers.get('x-perf-cpu-ms',0)))
token=call('/login',{'username':'customers-test','password':'test-password'})[0]['token']
(out/(phase+'-token')).write_text(token)
paths={'dashboard':'/dashboard?days=30','customers':'/customers?limit=12','orders':'/orders?limit=20','finance':'/finance/day?date='+today.isoformat(),'banks':'/banks','bank_activity':'/banks/1/activity?period=month','bank_ledger':'/banks/1/transactions','selector':'/customers?limit=100'}
results={}
for name,path in paths.items():
 rows=[]
 for i in range(43):
  data,row=call(path,token=token)
  if i==0:(out/(phase+'-'+name+'-response.json')).write_text(json.dumps(data,ensure_ascii=False,sort_keys=True))
  if i>=3:rows.append(row)
 results[name]=rows
 print(name,'median',round(statistics.median(r['ms'] for r in rows),2),'queries',rows[0]['queries'],flush=True)
# Initial browser comparisons run before writes. Order creation measured separately below only on request.
if len(sys.argv)>2:
 pass
pids=[p for p in psutil.process_iter(['cmdline']) if str(Path(__file__).with_name('server.py')) in ' '.join(p.info['cmdline'] or [])] if psutil else []
results['server_rss_mb']=[p.memory_info().rss/1048576 for p in pids]
(out/(phase+'-api.json')).write_text(json.dumps(results,indent=2))
