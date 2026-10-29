"""Synthetic encrypted vectors only: separate model, SQL, decryption and matching.

No photographs or recognition-accuracy claims. Run in a fresh process per phase.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import time
from datetime import datetime, timezone
from unittest.mock import patch

phase = sys.argv[1]
root = Path(sys.argv[2]).resolve() if len(sys.argv)>2 else Path(__file__).resolve().parents[3]
out = Path(os.environ['KARBON_PERF_DIR']).resolve()
database = out/f'face-vectors-{phase}.db'
shutil.copyfile(out/'base.db', database)
os.environ['KARBON_DATABASE_PATH'] = str(database)
os.environ['KARBON_FACE_KEY_PATH'] = str(out/f'face-vectors-{phase}.key')
os.environ.pop('KARBON_FACE_KEY', None)
sys.path.insert(0,str(root/'backend'))
import app
import numpy as np
import psutil
from database import SessionLocal, engine
from models.member_face import MemberFace
from security.face_templates import encrypt_template
from services import face_service as faces
from sqlalchemy import event

process = psutil.Process()
rss_before = process.memory_info().rss/1048576
t=time.perf_counter();faces.engine.load();model_ms=(time.perf_counter()-t)*1000
rss_after = process.memory_info().rss/1048576
rng=np.random.default_rng(20261029)
features=rng.normal(size=(30,3,128)).astype('<f4')
features /= np.linalg.norm(features,axis=2,keepdims=True)
with SessionLocal() as db:
    db.query(MemberFace).delete()
    now=datetime.now(timezone.utc)
    db.add_all([MemberFace(member_id=i+1, encrypted_template=encrypt_template(i+1,features[i].tobytes()),
        model_version=faces.MODEL_VERSION,consented_at=now,updated_at=now) for i in range(30)])
    db.commit()
    cursor_ms=[0.0];decrypt_ms=[0.0]
    original=faces.decrypt_template
    def decrypt(*args):
        t=time.perf_counter()
        try:return original(*args)
        finally:decrypt_ms[0]+=(time.perf_counter()-t)*1000
    @event.listens_for(engine,'before_cursor_execute')
    def before(conn,cursor,statement,parameters,context,many):context.started=time.perf_counter()
    @event.listens_for(engine,'after_cursor_execute')
    def after(conn,cursor,statement,parameters,context,many):cursor_ms[0]+=(time.perf_counter()-context.started)*1000
    rows=[]
    with patch.object(faces,'decrypt_template',decrypt):
        for i in range(43):
            cursor_ms[0]=decrypt_ms[0]=0.0
            t=time.perf_counter();templates=faces.read_templates(db);total=(time.perf_counter()-t)*1000
            t=time.perf_counter()
            scores=np.stack([(features[0]@template.T).max(axis=1) for _,template in templates])
            winners=scores.argmax(axis=0);winner=int(winners[0]);best=scores[winner]
            runner=np.delete(scores,winner,axis=0).max(axis=0)
            assert np.all(winners==winner) and float(best.min())>=faces.MATCH_THRESHOLD and float((best-runner).min())>=faces.MATCH_MARGIN
            matching=(time.perf_counter()-t)*1000
            if i>=3:rows.append(dict(read_validate_ms=total,cursor_ms=cursor_ms[0],decrypt_ms=decrypt_ms[0],matching_ms=matching))
    busy=[]
    with faces.engine.session():
        for _ in range(10):
            t=time.perf_counter()
            try:
                with faces.engine.session():raise AssertionError('concurrency guard missing')
            except faces.FaceError as error:
                assert error.code=='BUSY' and error.status==429
                busy.append((time.perf_counter()-t)*1000)
(out/f'{phase}-face-vectors.json').write_text(json.dumps(dict(templates=30,model_ms=model_ms,rss_before_mb=rss_before,rss_after_mb=rss_after,rows=rows,busy_ms=busy),indent=2))
print(phase,'synthetic template profile complete')
