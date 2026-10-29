# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
import os,sys,time,json,shutil,statistics,importlib.util
from pathlib import Path
TMP=Path(os.environ['KARBON_PERF_DIR']).resolve();os.environ['KARBON_DATABASE_PATH']=str(TMP/'reference.db');os.environ['KARBON_JWT_SECRET']='isolated-performance-only';sys.path.insert(0,str(Path(__file__).resolve().parents[3] / 'backend'))
from database import engine,SessionLocal
from sqlalchemy import event,text
import services.reference_codes as after
spec=importlib.util.spec_from_file_location('before',TMP/'reference_before.py');before=importlib.util.module_from_spec(spec);spec.loader.exec_module(before)
count=[0]
@event.listens_for(engine,'before_cursor_execute')
def query(*args):count[0]+=1
result={}
for phase,module in [('before',before),('after',after)]:
 result[phase]={}
 for scenario in ['no_change','gap']:
  rows=[]
  for i in range(8):
   engine.dispose();shutil.copyfile(TMP/'base.db',TMP/'reference.db')
   with SessionLocal() as db:
    db.execute(text('BEGIN IMMEDIATE'))
    if scenario=='gap':db.execute(text('UPDATE financial_transactions SET deleted_at=CURRENT_TIMESTAMP WHERE id=1'))
    count[0]=0;start=time.perf_counter();module.compact_transaction_numbers(db);elapsed=(time.perf_counter()-start)*1000
    rows.append({'ms':elapsed,'queries':count[0]})
    vals=db.execute(text('SELECT transaction_number FROM financial_transactions WHERE deleted_at IS NULL ORDER BY id')).scalars().all();assert vals==list(range(1,len(vals)+1));db.rollback()
  result[phase][scenario]=rows
  print(phase,scenario,statistics.median(r['ms'] for r in rows),rows[0]['queries'])
(TMP/'reference-results.json').write_text(json.dumps(result,indent=2))
