# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
import sys, os, time, contextvars, json, threading
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'backend'))
assert Path(os.environ['KARBON_DATABASE_PATH']).resolve().parent == Path(os.environ['KARBON_PERF_DIR']).resolve()
import app
from database import engine
from sqlalchemy import event
stats=contextvars.ContextVar('stats',default=None)
@event.listens_for(engine,'before_cursor_execute')
def before(conn,cursor,statement,parameters,context,many):
    context.perf_start=time.perf_counter()
@event.listens_for(engine,'after_cursor_execute')
def after(conn,cursor,statement,parameters,context,many):
    s=stats.get()
    if s is not None:
        s['count']+=1;s['ms']+=(time.perf_counter()-context.perf_start)*1000
        s['queries'].append([statement,(time.perf_counter()-context.perf_start)*1000])
@app.app.middleware('http')
async def metrics(request,call_next):
    s={'count':0,'ms':0.,'queries':[]};t=stats.set(s);start=time.process_time()
    try:
        response=await call_next(request)
        response.headers['x-perf-count']=str(s['count']);response.headers['x-perf-sql-ms']=str(s['ms'])
        response.headers['x-perf-cpu-ms']=str((time.process_time()-start)*1000)
        with open(os.environ['PERF_LOG'],'a') as f:f.write(json.dumps({'path':str(request.url.path),**s})+'\n')
        return response
    finally:stats.reset(t)
from fastapi.middleware.cors import CORSMiddleware
app.app.add_middleware(CORSMiddleware,allow_origins=['http://127.0.0.1:5529'],allow_methods=['*'],allow_headers=['*'])
if __name__=='__main__':
 import uvicorn
 uvicorn.run(app.app,host='127.0.0.1',port=8029,log_level='error')
