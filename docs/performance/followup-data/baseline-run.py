# Diagnostic tooling: use only synthetic data in KARBON_PERF_DIR.
import os,sys,shutil,subprocess,time
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=(Path(__file__).resolve().parents[3] / 'frontend');TMP=Path(os.environ['KARBON_PERF_DIR']).resolve();phase=sys.argv[1]
assert phase in {'before', 'after'}, 'Use before or after'
TMP.mkdir(parents=True, exist_ok=True)
shutil.copyfile(TMP/'base.db',TMP/(phase+'.db'))
env=dict(os.environ,KARBON_DATABASE_PATH=str(TMP/(phase+'.db')),KARBON_JWT_SECRET='isolated-performance-only',PYTHONDONTWRITEBYTECODE='1',PERF_LOG=str(TMP/(phase+'-sql.jsonl')))
process=None
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def log_message(self,*a):pass
 def do_GET(self):
  if self.path.startswith('/api/'):
   return self.proxy()
  path=self.path.split('?')[0]
  if path.endswith('.js'):
   file=ROOT/path.lstrip('/')
   if file.is_file():
    body=file.read_bytes().replace(b'http://127.0.0.1:8000/api',b'http://127.0.0.1:5529/api')
    self.send_response(200);self.send_header('Content-Type','text/javascript');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  super().do_GET()
 def proxy(self):
  body=self.rfile.read(int(self.headers.get('Content-Length',0))) or None
  try:r=urlopen(Request('http://127.0.0.1:8029'+self.path,data=body,headers={k:self.headers[k] for k in ['Authorization','Content-Type'] if k in self.headers},method=self.command))
  except HTTPError as e:r=e
  with r:
   body=r.read();self.send_response(r.status)
   for k,v in r.headers.items():
    if k.lower() in ['content-type','x-perf-count','x-perf-sql-ms','x-perf-cpu-ms']:self.send_header(k,v)
   self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 do_POST=proxy;do_PUT=proxy;do_DELETE=proxy
server=ThreadingHTTPServer(('127.0.0.1',5529),Handler)
process=subprocess.Popen([sys.executable,str(Path(__file__).with_name('server.py'))],env=env)
print('ready '+phase,flush=True)
try:server.serve_forever()
except KeyboardInterrupt:pass
finally:server.server_close();process.terminate();process.wait()
