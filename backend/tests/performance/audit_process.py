"""Process-cold dashboard/startup and service/serialization timings on copies only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import Request, urlopen

import psutil

phase = sys.argv[1]
root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).resolve().parents[3]
out = Path(os.environ['KARBON_PERF_DIR']).resolve()
rows = []
for i in range(5):
    database = out / f'startup-{phase}-{i}.db'
    shutil.copyfile(out / 'base.db', database)
    env = dict(os.environ, KARBON_DATABASE_PATH=str(database), KARBON_JWT_SECRET='isolated-performance-only',
        PYTHONDONTWRITEBYTECODE='1', PERF_LOG=str(out/f'startup-{phase}-sql.jsonl'))
    code = f"import sys; sys.path.insert(0, {str(root/'backend/tests/performance')!r}); import server; import uvicorn; uvicorn.run(server.app.app, host='127.0.0.1', port=8031, log_level='error')"
    start = time.perf_counter()
    with (out/f'{phase}-startup.log').open('a') as log:
        process = subprocess.Popen([sys.executable, '-B', '-c', code], env=env, stdout=log, stderr=log)
        try:
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Startup subprocess failed; inspect log')
                try:
                    with urlopen('http://127.0.0.1:8031/', timeout=.1):
                        break
                except OSError:
                    if time.perf_counter() - start > 20:
                        raise
                    time.sleep(.01)
            row = {'startup_ms': (time.perf_counter()-start)*1000}
            p = psutil.Process(process.pid)
            row['rss_start_mb'] = p.memory_info().rss/1048576
            login = Request('http://127.0.0.1:8031/api/login', data=b'{"username":"customers-test","password":"test-password"}', headers={'Content-Type':'application/json'})
            with urlopen(login) as response:
                token = json.load(response)['token']
            samples = []
            for n in range(11):
                start = time.perf_counter()
                with urlopen(Request('http://127.0.0.1:8031/api/dashboard?days=30', headers={'Authorization':'Bearer '+token})) as response:
                    body = response.read()
                    samples.append({'ms':(time.perf_counter()-start)*1000, 'bytes':len(body), 'queries':int(response.headers['x-perf-count']),
                        'sql_ms':float(response.headers['x-perf-sql-ms']), 'cpu_ms':float(response.headers['x-perf-cpu-ms'])})
            row['first_dashboard'] = samples[0]
            row['warm_dashboard'] = samples[1:]
            row['rss_dashboard_mb'] = p.memory_info().rss/1048576
            idle_start = sum(p.cpu_times()[:2])
            time.sleep(.3)
            row['idle_cpu_ms_over_300ms'] = (sum(p.cpu_times()[:2])-idle_start)*1000
            rows.append(row)
        finally:
            process.terminate()
            process.wait(timeout=10)

# Service preparation, FastAPI encoding and JSON serialization are separate from
# HTTP measurements. Cursor timing excludes row fetch, ORM and Python work.
database = out / f'preparation-{phase}.db'
shutil.copyfile(out / 'base.db', database)
code = r'''
import sys,time,json
from datetime import datetime,timedelta
sys.path.insert(0, sys.argv[1])
import app
from database import SessionLocal,engine
from sqlalchemy import event
from config import APP_TIMEZONE
from services.dashboard_service import dashboard
from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
stats=[0.0]
@event.listens_for(engine, 'before_cursor_execute')
def before(conn,cursor,statement,parameters,context,many): context.started=time.perf_counter()
@event.listens_for(engine, 'after_cursor_execute')
def after(conn,cursor,statement,parameters,context,many): stats[0]+=(time.perf_counter()-context.started)*1000
results={}
with SessionLocal() as db:
    end=datetime.now(APP_TIMEZONE).date();start=end-timedelta(days=29)
    for view in (['full','summary'] if sys.argv[2]=='after' else ['full']):
        rows=[]
        for i in range(13):
            stats[0]=0;t=time.perf_counter();data=dashboard(db,start,end,view) if view=='summary' else dashboard(db,start,end);service=(time.perf_counter()-t)*1000
            t=time.perf_counter();encoded=jsonable_encoder(data);encoding=(time.perf_counter()-t)*1000
            t=time.perf_counter();response=JSONResponse(encoded);serialization=(time.perf_counter()-t)*1000
            if i>=3: rows.append(dict(service_ms=service,cursor_ms=stats[0],encoding_ms=encoding,json_ms=serialization,bytes=len(response.body)))
        results[view]=rows
print(json.dumps(results))
'''
env = dict(os.environ, KARBON_DATABASE_PATH=str(database), KARBON_JWT_SECRET='isolated-performance-only', PYTHONDONTWRITEBYTECODE='1')
completed = subprocess.run([sys.executable,'-B','-c',code,str(root/'backend'),phase], env=env, capture_output=True, text=True, check=True)
preparation = json.loads(completed.stdout.splitlines()[-1])
(out/f'{phase}-process.json').write_text(json.dumps({'startup':rows,'preparation':preparation['full'],'initial_preparation':preparation.get('summary',preparation['full'])},indent=2))
print(phase, 'startup trials', len(rows), 'preparation trials', len(preparation['full']))
