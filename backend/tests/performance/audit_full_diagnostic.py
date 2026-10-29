"""Alternate baseline/current processes to investigate legacy full-report variance."""
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

out = Path(os.environ['KARBON_PERF_DIR']).resolve()
roots = {'before': Path(sys.argv[1]).resolve(), 'after': Path(__file__).resolve().parents[3]}
code = r'''
import sys,time,json
from datetime import datetime,timedelta
sys.path.insert(0,sys.argv[1]);import app
from database import SessionLocal
from config import APP_TIMEZONE
from services.dashboard_service import dashboard
from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
end=datetime.now(APP_TIMEZONE).date();start=end-timedelta(days=29);rows=[]
with SessionLocal() as db:
 for i in range(43):
  t=time.perf_counter();v=dashboard(db,start,end);a=time.perf_counter();encoded=jsonable_encoder(v);b=time.perf_counter();JSONResponse(encoded);c=time.perf_counter()
  if i>=3:rows.append(dict(service_ms=(a-t)*1000,encoding_ms=(b-a)*1000,json_ms=(c-b)*1000))
print(json.dumps(rows))
'''
results = []
for cycle in range(4):
    for phase in (['before','after'] if cycle%2==0 else ['after','before']):
        database = out/f'full-diagnostic-{phase}.db'
        shutil.copyfile(out/'base.db',database)
        env = dict(os.environ,KARBON_DATABASE_PATH=str(database),KARBON_JWT_SECRET='isolated-performance-only',
            KARBON_FACE_KEY_PATH=str(out/'diagnostic-face.key'),PYTHONDONTWRITEBYTECODE='1')
        completed = subprocess.run([sys.executable,'-B','-c',code,str(roots[phase]/'backend')],env=env,capture_output=True,text=True,check=True)
        rows = json.loads(completed.stdout.splitlines()[-1])
        results.append(dict(cycle=cycle,phase=phase,rows=rows))
        print(cycle,phase,{key:round(statistics.median(r[key] for r in rows),3) for key in rows[0]},flush=True)
(out/'full-diagnostic.json').write_text(json.dumps(results,indent=2))
