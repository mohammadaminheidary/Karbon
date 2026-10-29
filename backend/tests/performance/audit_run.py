"""Run repeatable stages sequentially; own and clean up only the test servers.

Requires an already built application root and an isolated synthetic base.db.
Use --mode control for the unchanged original asset setup; --mode supplement
collects gzip negotiation and the remaining settings/purchase views only.
"""
import argparse
import base64
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
TOOLS = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['before','after'])
parser.add_argument('--root', type=Path, default=ROOT)
parser.add_argument('--mode', choices=['full','control','supplement','operations'], default='full')
parser.add_argument('--production', action='store_true')
args = parser.parse_args()
data = Path(os.environ['KARBON_PERF_DIR']).resolve()
assert any(data.is_relative_to(p.resolve()) for p in [Path('/private/tmp'),Path('/tmp'),Path(tempfile.gettempdir())]), 'Use an isolated temporary directory'
assert (data/'base.db').resolve().parent == data and (data/'base.db').is_file(), 'A synthetic base.db is required'
for port in [8029,5529]:
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1',port)) == 0:
            raise RuntimeError(f'Port {port} is occupied; leave existing servers untouched')
env = dict(os.environ, KARBON_PERF_DIR=str(data), KARBON_TIMEZONE='Asia/Tehran', PYTHONDONTWRITEBYTECODE='1',
           KARBON_PERF_PRODUCTION='1' if args.production else '0',
           KARBON_FACE_KEY=base64.urlsafe_b64encode(os.urandom(32)).decode(), KARBON_FACE_KEY_PATH=str(data/'face.key'))
core = 'dashboard,customers,orders,finance,banks,bank_ledger,inventory,tasks,settings,documents,attendance,login'
extras = 'settings_products,settings_invoices,settings_members,settings_banks,settings_inventory,settings_expenses,settings_document_accounts'
more = 'settings_appearance,settings_security,settings_backup,purchase'


def run(script, *arguments, routes=None, label=None):
    command = ['node' if script.endswith('.cjs') else sys.executable, *([] if script.endswith('.cjs') else ['-B']), str(TOOLS/script), *arguments]
    local_env = dict(env)
    if routes:
        local_env['KARBON_PERF_ROUTES'] = routes
    else:
        local_env.pop('KARBON_PERF_ROUTES',None)
    name = label or script.replace('.py','').replace('.cjs','')
    print(f'{args.phase}: {name}',flush=True)
    with (data/f'{args.phase}-{name}.log').open('w') as log:
        subprocess.run(command, cwd=ROOT, env=local_env, stdout=log, stderr=log, check=True)


with (data/f'{args.phase}-server.log').open('w') as log:
    server = subprocess.Popen([sys.executable,'-B',str(args.root.resolve()/'backend/tests/performance/run.py'),args.phase],
                              cwd=args.root.resolve(), env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic()+20
        while True:
            if server.poll() is not None:
                raise RuntimeError('Fixture failed; inspect the server log')
            try:
                with urlopen('http://127.0.0.1:8029/', timeout=.2):
                    break
            except OSError:
                if time.monotonic()>deadline:
                    raise
                time.sleep(.02)
        if args.mode=='control':
            run('audit_browser.cjs',args.phase,routes='dashboard',label='controlled-browser')
        else:
            if args.mode in {'full','operations'}:
                if args.mode=='operations':
                    run('audit_picker.cjs',args.phase,label='picker')
                    run('audit_api.py',args.phase,'--writes',label='writes')
                    run('face.py',args.phase,label='blank-face')
                    run('audit_process.py',args.phase,str(args.root.resolve()),label='process')
                    run('audit_face_templates.py',args.phase,str(args.root.resolve()),label='face-vectors')
                    print(f'{args.phase}: operations complete',flush=True)
                    # The finally block still owns and stops the fixture.
                    sys.exit(0)
                run('audit_api.py',args.phase)
            run('audit_api.py',args.phase,'--gzip',label='gzip-api')
            if args.mode=='full':
                run('audit_browser.cjs',args.phase,routes=core,label='pages')
                run('audit_browser.cjs',args.phase+'-extras',routes=extras,label='extras')
            run('audit_browser.cjs',args.phase+'-more',routes=more,label='more')
            if args.mode=='full':
                run('audit_picker.cjs',args.phase,label='picker')
                run('audit_api.py',args.phase,'--writes',label='writes')
                run('face.py',args.phase,label='blank-face')
                run('audit_process.py',args.phase,str(args.root.resolve()),label='process')
                run('audit_face_templates.py',args.phase,str(args.root.resolve()),label='face-vectors')
    finally:
        if server.poll() is None:
            server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # The child's normal finally block terminates its API worker.
            server.terminate()
            server.wait(timeout=5)
print(f'{args.phase}: complete',flush=True)
