"""Run real Chromium reporting checks against 15 disposable 1,000-row datasets."""
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend/tests'))
sys.path.insert(0,str(ROOT/'frontend'))
from test_reports import ReportsIntegrationTests
from serve_frontend import DevelopmentHandler, ProductionHandler, FrontendServer

production="--production" in sys.argv
base_handler=ProductionHandler if production else DevelopmentHandler

fixture=ReportsIntegrationTests
fixture.setUpClass()
class Handler(base_handler):
    def log_message(self,*args): pass
    def proxy(self):
        body=self.rfile.read(int(self.headers.get('Content-Length',0))) or None
        r=Request(fixture.base.removesuffix('/api')+self.path,data=body,method=self.command,
                  headers={k:self.headers[k] for k in ['Authorization','Content-Type'] if k in self.headers})
        try: response=urlopen(r,timeout=180)
        except HTTPError as error: response=error
        with response:
            content=response.read();self.send_response(response.status)
            self.send_header('Content-Type',response.headers.get('Content-Type','application/json'))
            self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
    def do_GET(self):
        if self.path.startswith('/api/'): return self.proxy()
        path=urlsplit(self.path).path
        if path.startswith('/assets/build/' if production else '/src/js/') and path.endswith('.js'):
            file=ROOT/'frontend'/('dist' if production else '.')/path.lstrip('/')
            content=file.read_text().replace('http://127.0.0.1:8000/api',f'http://127.0.0.1:{self.server.server_port}/api').encode()
            self.send_response(200);self.send_header('Content-Type','text/javascript; charset=utf-8');self.end_headers();self.wfile.write(content);return
        super().do_GET()
    def do_POST(self): self.proxy()
    do_PUT=do_POST
    do_DELETE=do_POST
server=FrontendServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
    env=dict(os.environ,KARBON_TEST_URL=f'http://127.0.0.1:{server.server_port}',KARBON_REPORT_TOKEN=fixture.token)
    result=subprocess.run(['node',str(ROOT/'frontend/tests/reports_browser.mjs')],env=env)
    raise SystemExit(result.returncode)
finally:
    server.shutdown();server.server_close();thread.join();fixture.tearDownClass()
