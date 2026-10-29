import os
from pathlib import Path
# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
exec(open(Path(__file__).with_name('bench.py')).read().split('paths=')[0])
import base64,io
from PIL import Image
rows=[]
for i in range(5):
 data,row=call('/faces/status',token=token);rows.append({'lane':'status','available':data.get('available'),**row})
buf=io.BytesIO();Image.new('RGB',(640,480),(120,120,120)).save(buf,format='JPEG');img='data:image/jpeg;base64,'+base64.b64encode(buf.getvalue()).decode()
for i in range(10):
 data,row=call('/faces/guide',{'image':img,'angle':'front','consent':True},token);rows.append({'lane':'blank_guide','code':data.get('code'),**row})
(out/(phase+'-face.json')).write_text(json.dumps(rows,indent=2));print(rows[0]);print('warm status median',statistics.median(r['ms'] for r in rows[1:5]));print('blank guide median',statistics.median(r['ms'] for r in rows[5:]))
