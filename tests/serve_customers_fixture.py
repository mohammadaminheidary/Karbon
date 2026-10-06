"""Disposable browser fixture; never writes to the application's live database.
Login: customers-test / test-password. Ctrl+C stops and removes the fixture.
For load-more checks: --backend-port 8001 --frontend-port 5502 --customers 25
"""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--backend-port", type=int, default=8000)
parser.add_argument("--frontend-port", type=int, default=5501)
parser.add_argument("--customers", type=int, default=0)
parser.add_argument("--finance", action="store_true", help="Create finance references in the disposable database")
parser.add_argument("--bank-ledger", type=int, default=0, help="Seed account ledger rows only in the disposable database")
args = parser.parse_args()
if not 0 <= args.customers <= 200:
    parser.error("--customers must be between 0 and 200")
if not 0 <= args.bank_ledger <= 200:
    parser.error("--bank-ledger must be between 0 and 200")


class FixtureHandler(SimpleHTTPRequestHandler):
    def __init__(self, *handler_args, **kwargs):
        super().__init__(*handler_args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Only the fixture server rewrites the API origin, so a separate test
        # environment can run beside the user's normal app without logging out
        # their session or changing any production JavaScript configuration.
        path = urlsplit(self.path).path
        if path in ["/src/js/auth/auth-api.js", "/src/js/customers/customer-api.js", "/src/js/finance/finance-api.js", "/src/js/members/members-api.js", "/src/js/attendance/attendance-api.js"]:
            content = (ROOT / path.lstrip("/")).read_text().replace(
                "http://127.0.0.1:8000/api",
                f"http://127.0.0.1:{args.backend_port}/api",
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()


with tempfile.TemporaryDirectory(prefix="karbon-browser-test-") as directory:
    env = dict(os.environ, KARBON_DATABASE_PATH=str(Path(directory) / "test.db"), KARBON_JWT_SECRET=secrets.token_urlsafe(32))
    bootstrap = f'''
import app
from database import SessionLocal
from models.user import User
from models.customer import Customer
from models.finance import BankAccount, ExpenseCategory, FinancialTransaction
from datetime import datetime, timedelta
from config import APP_TIMEZONE
from security.password import hash_password
from services.reference_codes import compact_category_codes, compact_transaction_numbers
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
app.app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:{args.frontend_port}"], allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type", "Authorization"])
with SessionLocal() as db:
    db.add(User(username="customers-test", password_hash=hash_password("test-password")))
    for index in range({args.customers}):
        db.add(Customer(customer_code=1001 + index, first_name=f"مشتری {{index + 1}}", last_name="آزمایشی", gender="male" if index % 2 else "female", phone_numbers=[f"0912{{index + 1:07d}}"], address="آدرس محیط آزمایشی"))
    if {args.finance!r} and not {args.bank_ledger}:
        db.add(BankAccount(name="بانک محیط آزمایش", account_number="123456789", opening_balance=1000000))
        db.add(ExpenseCategory(title="مواد اولیه آزمایشی"))
    if {args.bank_ledger}:
        bank = BankAccount(name="بانک ملت", bank="mellat", first_name="علی", last_name="آزمایشی", card_number="6037990000000014", account_number="00123", opening_balance=2000000)
        other = BankAccount(name="بانک سامان", bank="saman", first_name="سارا", last_name="آزمایشی", card_number="6037990000000022", account_number="00234", opening_balance=500000)
        category = ExpenseCategory(title="مواد اولیه آزمایشی")
        db.add_all([bank, other, category])
        db.flush()
        customer = db.query(Customer).first()
        if customer is None:
            customer = Customer(customer_code=1001, first_name="مشتری", last_name="آزمایشی")
            db.add(customer)
            db.flush()
        for index in range({args.bank_ledger}):
            income = index % 3 != 0
            day = datetime.now(APP_TIMEZONE).date() - timedelta(days=index // 3)
            db.add(FinancialTransaction(request_id=f"fixture-ledger-{{index}}", kind="income" if income else "expense", bank_id=bank.id,
              customer_id=customer.id if income else None, expense_category_id=None if income else category.id,
              title="فروش سفارش" if income else category.title, account_code=str(customer.customer_code) if income else category.account_code,
              amount=(index + 1) * 25000, description=f"شرح آزمایشی شماره {{index + 1}}", tracking_number=f"900{{index + 1:04d}}" if income else None,
              transaction_date=day, transaction_time=f"{{10 + index % 8:02d}}:30:00", time_mode="manual"))
    db.flush()
    compact_category_codes(db)
    compact_transaction_numbers(db)
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port={args.backend_port})
'''
    frontend = ThreadingHTTPServer(("127.0.0.1", args.frontend_port), FixtureHandler)
    thread = threading.Thread(target=frontend.serve_forever, daemon=True)
    backend = subprocess.Popen([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=env)
    thread.start()
    print(f"Isolated browser fixture: http://127.0.0.1:{args.frontend_port}/page/customers-page.html", flush=True)
    try:
        while backend.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        frontend.shutdown()
        frontend.server_close()
        thread.join(timeout=5)
        if backend.poll() is None:
            backend.terminate()
        backend.wait(timeout=10)
