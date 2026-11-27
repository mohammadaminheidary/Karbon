"""Exercise year-end closing over real HTTP, SQLite and verified backups."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, ExitStack
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import unittest
from urllib.error import URLError
from urllib.parse import urlencode
from uuid import uuid4
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import jdatetime
from openpyxl import load_workbook
from pypdf import PdfReader

import test_backup
from test_finance import bank_payload


ROOT = Path(__file__).resolve().parents[2]
API = "/settings/fiscal-years"
PASSWORD = "fiscal-test-password"
PASSPHRASE = "عبارت عبور آزمایشی پایانی"
BOOTSTRAP = """
import os
from pathlib import Path
from time import monotonic, sleep

import app
import uvicorn
from database import SessionLocal
from models.user import User
from security.password import hash_password
from services import backup_service, fiscal_year_export

root = Path(os.environ["FISCAL_FIXTURE"])
backup_service.BACKUP_DIRECTORY = root / "backups"
backup = backup_service.create_archive
render = fiscal_year_export.render_exports

def controlled_backup(passphrase, **options):
    if (root / "fail-backup").exists():
        raise OSError("fixture backup failure")
    archive = backup(passphrase, **options)
    hold = root / "hold-backup"
    if hold.exists():
        (root / "backup-verified").touch()
        deadline = monotonic() + 15
        while hold.exists() and monotonic() < deadline:
            sleep(.02)
    return archive

def controlled_export(snapshot):
    if (root / "fail-export").exists():
        raise OSError("fixture export failure")
    return render(snapshot)

backup_service.create_archive = controlled_backup
fiscal_year_export.render_exports = controlled_export
with SessionLocal() as db:
    for name in ("admin", "fiscal-user"):
        db.add(User(username=name, password_hash=hash_password("fiscal-test-password")))
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port=int(os.environ["FISCAL_PORT"]), log_level="warning")
"""


def until(predicate, timeout=25):
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        result = predicate()
        if result:
            return result
        sleep(.05)
    raise AssertionError("Fiscal fixture did not reach its expected state")


class FiscalFixture(ExitStack):
    def __enter__(self):
        self.root = Path(self.enter_context(TemporaryDirectory(prefix="karbon-fiscal-test-")))
        self.database = self.root / "test.db"
        self.year = jdatetime.date.fromgregorian(date=datetime.now(ZoneInfo("Asia/Tehran")).date()).year
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        env = dict(os.environ, FISCAL_FIXTURE=str(self.root), FISCAL_PORT=str(port),
                   KARBON_DATABASE_PATH=str(self.database), KARBON_TIMEZONE="Asia/Tehran",
                   KARBON_JWT_SECRET="disposable-fiscal-year-tests")
        log = self.enter_context((self.root / "server.log").open("w+"))
        app = subprocess.Popen([sys.executable, "-B", "-c", BOOTSTRAP], cwd=ROOT / "backend",
                               env=env, stdout=log, stderr=log)

        def stop():
            if app.poll() is None:
                app.terminate()
                app.wait(timeout=10)

        self.callback(stop)

        def healthy():
            if app.poll() is not None:
                log.seek(0)
                raise RuntimeError(log.read())
            try:
                return self.call("GET", "/health", token="")[0] == 200
            except URLError:
                return False

        try:
            until(healthy)
            self.token = self.login("admin")
            self.operator = self.login("fiscal-user")
        except BaseException:
            self.close()
            raise
        return self

    def call(self, method, path, body=None, *, token=None):
        if token is None:
            token = self.token
        return test_backup.BackupIntegrationTests.call(self.base, "/api" + path, method, body, token)[:2]

    def login(self, user):
        status, data = self.call("POST", "/login", {"username": user, "password": PASSWORD}, token="")
        if status != 200:
            raise AssertionError(data)
        return data["token"]

    def post(self, path, body):
        status, data = self.call("POST", path, body)
        if status != 201:
            raise AssertionError((path, status, data))
        return data

    def flag(self, name):
        return self.root / name

    def references(self):
        bank = self.post("/banks", bank_payload(1, opening_balance=5_000_000))
        category = self.call("GET", "/settings/inventory-options")[1]["categories"][0]
        product = self.post("/products", {"name": "کالای آزمایشی کاربن", "price": 25000, "stock": 2000,
                                          "category_id": category["id"], "unit": "عدد"})
        return bank, product

    def customer(self, first, phones=()):
        return self.post("/customers", {"first_name": first, "last_name": "آزمایشی", "phone_numbers": list(phones)})

    def order(self, customer, product, *, number, total, paid=0, rows=1, year=None, due=None):
        year = year or self.year
        return self.post("/orders", {
            "request_id": str(uuid4()), "customer_id": customer["id"], "order_number": number,
            "invoice_date": f"{year}/06/12", "payment_date": due or f"{year}/07/01",
            "items": [{"product_id": product["id"], "quantity": 1,
                       "unit_price": total // rows + (index < total % rows)} for index in range(rows)],
            "payments": [{"method": "cash", "amount": paid}] if paid else [],
        })

    def preview(self, year):
        status, data = self.call("GET", f"{API}/{year}/preview")
        if status != 200:
            raise AssertionError(data)
        return data

    def confirm(self, year, preview, *, token=None):
        return self.call("POST", f"{API}/{year}/close", {
            "confirm": True, "passphrase": PASSPHRASE, "digest": preview["digest"],
        }, token=token)

    def reopen(self, year, version=1, *, confirm=True, token=None):
        return self.call("POST", f"{API}/{year}/reopen", {"version": version, "confirm": confirm}, token=token)

    def exports(self, year, status):
        def complete():
            _, data = self.call("GET", API)
            return next((row for row in data["years"] if row["year"] == year and row["export_status"] == status), None)
        return until(complete)


class FiscalYearTests(unittest.TestCase):
    def test_purchase_payment_carries_payable_and_preserves_closed_invoice(self):
        with FiscalFixture() as f:
            bank, product = f.references()
            prior_day, next_day = f"{f.year}/08/01", f"{f.year + 1}/01/01"
            payment = {"request_id": str(uuid4()), "method": "transfer", "bank_id": bank["id"],
                       "transaction_date": prior_day, "amount": 400}
            purchase = f.post("/purchases", {
                "request_id": str(uuid4()), "purchase_date": prior_day, "category_id": product["category_id"],
                "product_id": product["id"], "quantity": 2, "purchase_price": 500, "payments": [payment],
            })
            path = f'/purchases/{purchase["id"]}'
            preview = f.preview(f.year)
            self.assertEqual(preview["summary"]["expense"], 400)
            self.assertEqual(f.confirm(f.year, preview)[0], 200)
            issued = f'{API}/{f.year}/records/purchases/{purchase["id"]}/issued?version=1'
            status, archive = f.call("GET", issued)
            self.assertEqual(status, 200, archive)
            self.assertEqual((archive["paid"], archive["remaining"]), (400, 600))
            self.assertEqual(f.call("GET", "/purchases/obligations")[1]["amount"], 600)
            locked = f'{path}/payments/{purchase["payments"][0]["id"]}'
            self.assertEqual(f.call("DELETE", locked, {"password": PASSWORD, "confirmed": True})[0], 409)
            next_payment = {**payment, "request_id": str(uuid4()), "transaction_date": next_day, "amount": 600}
            self.assertEqual(f.post(f"{path}/payments", next_payment)["payment_status"], "settled")
            live = f.call("GET", path)[1]
            self.assertEqual([row["editable"] for row in live["payments"]], [False, True])
            self.assertEqual(f.call("GET", "/purchases/obligations")[1]["count"], 0)
            self.assertEqual(f.call("GET", issued)[1], archive)
            self.assertEqual(f.preview(f.year + 1)["summary"]["expense"], 600)

    def test_general_receipts_reconcile_across_rollover_and_preserve_closed_archive(self):
        with FiscalFixture() as f:
            bank, product = f.references()
            customer = f.customer("مشتری")
            order = f.order(customer, product, number="RECEIPTS", total=1000, paid=500)
            receipt = {"request_id": str(uuid4()), "kind": "income", "customer_id": customer["id"],
                       "bank_id": bank["id"], "amount": 200, "transaction_date": f"{f.year}/08/01"}
            first = f.post("/finance/transactions", receipt)
            preview = f.preview(f.year)
            self.assertEqual((preview["summary"]["receivables"], preview["summary"]["income"]), (300, 700))
            self.assertEqual(f.confirm(f.year, preview)[0], 200)
            archive_path = f"{API}/{f.year}/records/orders/{order['id']}?version=1"
            status, archive = f.call("GET", archive_path)
            self.assertEqual(status, 200, archive)
            self.assertEqual((archive["paid"], archive["remaining"]), (700, 300))
            self.assertEqual({p["transaction_id"]: p["amount"] for p in archive["payments"]}[first["id"]], 200)

            next_year = f.year + 1
            second = f.post("/finance/transactions", {**receipt, "request_id": str(uuid4()), "amount": 500,
                                                       "transaction_date": f"{next_year}/01/01"})
            self.assertEqual(second["invoice_allocations"][0]["amount"], 300)
            carryovers = f.call("GET", f"{API}/customers/{customer['id']}/carryovers")[1]
            self.assertEqual((carryovers["invoices"][0]["amount"], carryovers["invoices"][0]["outstanding"]), (300, 0))
            settlement = {"request_id": str(uuid4()), "method": "cash", "amount": 1,
                          "transaction_date": f"{next_year}/01/01"}
            self.assertEqual(f.call("POST", f"/orders/{order['id']}/payments", settlement)[0], 409)

            new_order = f.order(customer, product, number="USES-CREDIT", total=150, year=next_year)
            self.assertEqual((new_order["paid"], new_order["remaining"]), (150, 0))
            status, history = f.call("GET", f"/customers/{customer['id']}/payments")
            self.assertEqual(status, 200, history)
            self.assertEqual(history["fiscal_year"], next_year)
            self.assertEqual(history["summary"], {"invoiced": 1150, "paid": 1200, "outstanding": 0, "credit": 50})
            self.assertEqual([row["id"] for row in history["items"]],
                             [second["id"], first["id"], order["payments"][0]["transaction_id"]])
            following = f.preview(next_year)
            summary = following["summary"]
            self.assertEqual((summary["receivables"], summary["credits"], summary["income"]), (0, 50, 500))
            self.assertEqual(f.confirm(next_year, following)[0], 200)
            f.exports(next_year, "ready")
            status, exported = f.call("GET", f"{API}/{next_year}/exports/data")
            self.assertEqual(status, 200, exported)
            with ZipFile(BytesIO(exported)) as archive_zip, closing(load_workbook(BytesIO(
                archive_zip.read(f"karbon-{next_year}.xlsx"),
            ))) as book:
                def rows(sheet):
                    headers, *values = list(book[sheet].values)
                    return [dict(zip(headers, row)) for row in values]

                payment = next(row for row in rows("payments") if row["transaction_id"] == second["id"])
                self.assertEqual((payment["amount"], payment["unapplied"]), (500, 50))
                self.assertEqual({row["order_id"]: row["amount"] for row in rows("allocations")
                                  if row["transaction_id"] == second["id"]}, {order["id"]: 300, new_order["id"]: 150})
            self.assertEqual(f.call("GET", archive_path), (200, archive))

    def test_purchase_archive_keeps_original_issuance_after_reopen_and_edit(self):
        with FiscalFixture() as f:
            _, product = f.references()
            supplier = f.customer("تأمین‌کننده")
            rows = [{"product_id": product["id"], "category_id": product["category_id"],
                     "quantity": 5, "purchase_price": 700}]
            body = {"request_id": str(uuid4()), "purchase_date": f"{f.year}/06/12",
                    "supplier_id": supplier["id"], "rows": rows}
            receipt = f.post("/purchases", body)
            path = f'/purchases/{receipt["id"]}'
            archive = f'{API}/{f.year}/records{path}/issued?version=1'
            self.assertEqual(f.confirm(f.year, f.preview(f.year))[0], 200)
            status, original = f.call("GET", archive)
            self.assertEqual(status, 200, original)
            self.assertEqual(original["items"][0]["quantity"], 5)
            self.assertEqual(f.reopen(f.year)[0], 200)
            edit = {**body, "request_id": str(uuid4()), "revision": 1, "rows": [{**rows[0], "quantity": 7}]}
            self.assertEqual(f.call("PUT", path, edit)[0], 200)
            self.assertEqual(f.call("GET", f"{path}/invoice")[1]["items"][0]["quantity"], 7)
            self.assertEqual(f.call("GET", archive), (200, original))

    def test_jalali_leap_cutoff_and_preflight(self):
        with FiscalFixture() as f:
            bank, product = f.references()
            customer = f.customer("مشتری")
            year = 1403
            f.order(customer, product, number="LEAP-ONE", total=10, year=year, due=f"{year}/12/30")
            f.order(customer, product, number="LEAP-NEXT", total=200, paid=100, year=year + 1, due=f"{year}/12/30")
            preview = f.preview(year)
            self.assertEqual(preview["period"]["end_jalali"], "1403/12/30")
            self.assertEqual(preview["summary"]["net_sales"], 10)
            self.assertEqual(preview["summary"]["credits"], 100)
            self.assertEqual(preview["next_activity"]["orders"], 1)
            years = f.call("GET", API)[1]
            self.assertEqual(years["active_year"], 1403)
            self.assertTrue(all(y["status"] != "closed" for y in years["years"]))
            self.assertEqual(next(y["end_jalali"] for y in years["years"] if y["year"] == 1404), "1404/12/29")
            malformed = {"confirm": "yes", "digest": "invalid", "passphrase": "fixture-secret-passphrase"}
            status, error = f.call("POST", f"{API}/{year}/close", malformed)
            self.assertEqual(status, 422)
            self.assertNotIn(malformed["passphrase"], json.dumps(error))
            self.assertEqual(f.confirm(year, preview)[0], 200)
            self.assertEqual(f.preview(year + 1)["summary"]["credits"], 0)
            self.assertEqual(f.reopen(year)[0], 409)
            self.assertEqual(f.call("GET", f"{API}/customers/{customer['id']}/carryovers")[1]["credit"], 100)
            payment = {"request_id": str(uuid4()), "kind": "income", "amount": 100, "customer_id": customer["id"],
                       "bank_id": bank["id"], "transaction_date": "1403/12/30", "time_mode": "auto"}
            self.assertEqual(f.call("POST", "/finance/transactions", payment)[0], 409)
            self.assertEqual(f.post("/finance/transactions", {**payment, "transaction_date": "1404/01/01"})[
                "jalali_date"], "1404/01/01")
            self.assertEqual(f.call("POST", "/finance/transactions", {
                **payment, "request_id": str(uuid4()), "transaction_date": "1404/12/30",
            })[0], 422)

    def restore_archive(self, f, filename):
        _, content = f.call("GET", f"/settings/backup/download/{filename}")
        status, validation, _ = test_backup.BackupIntegrationTests.call(
            f.base, "/api/settings/backup/validate", "POST", content, f.token, {
                "Content-Type": "application/zip",
                "X-Karbon-Backup-Passphrase": base64.b64encode(PASSPHRASE.encode()).decode(),
            },
        )
        self.assertEqual(status, 200, validation)
        self.assertEqual(f.call("POST", "/settings/backup/restore", {
            "passphrase": PASSPHRASE, "confirm": True, "validation_id": validation["validation_id"],
        })[0], 200)
        f.token = f.login("admin")

    def test_restore_backup_from_before_fiscal_years(self):
        with FiscalFixture() as f:
            _, product = f.references()
            customer = f.customer("مشتری قبل از مهاجرت")
            order = f.order(customer, product, number="LEGACY-FISCAL", total=2000, paid=1700)
            original = f.call("GET", f"/orders/{order['id']}/invoice")[1]
            with closing(sqlite3.connect(f.database)) as db, db:
                # Recreate the schema recorded by an earlier release of the
                # encrypted backup format, with all business tables intact.
                names = db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'fiscal_*'").fetchall()
                for (name,) in names:
                    db.execute(f'DROP TABLE "{name}"')
            backup = f.post("/settings/backup", {"passphrase": PASSPHRASE})
            self.restore_archive(f, backup["filename"])
            years = f.call("GET", API)[1]
            self.assertEqual(years["active_year"], f.year)
            self.assertTrue(all(row["status"] != "closed" for row in years["years"]))
            self.assertEqual(f.call("GET", f"/orders/{order['id']}/invoice")[1], original)
            self.assertEqual(f.call("GET", f"/customers/{customer['id']}")[1]["permanent_id"], customer["permanent_id"])
            self.assertEqual(f.preview(f.year)["summary"]["receivables"], 300)

    def test_restore_prior_fiscal_archive_preserves_original_download(self):
        with FiscalFixture() as f:
            _, product = f.references()
            customer = f.customer("مشتری نسخه نخست")
            f.order(customer, product, number="FISCAL-V1", total=1000, paid=300)
            year = f.year
            self.assertEqual(f.confirm(year, f.preview(year))[0], 200)
            f.exports(year, "ready")
            report_path = f"{API}/{year}/exports/data"
            original = f.call("GET", report_path)[1]
            with closing(sqlite3.connect(f.database)) as db, db:
                db.executescript("""
                    CREATE TEMP TABLE saved_snapshots AS SELECT * FROM fiscal_snapshots;
                    CREATE TEMP TABLE saved_exports AS SELECT * FROM fiscal_exports;
                    ALTER TABLE fiscal_years ADD COLUMN export_status VARCHAR(12);
                    UPDATE fiscal_years SET export_status = (
                        SELECT export_status FROM saved_snapshots WHERE year = fiscal_years.year);
                    DROP TABLE fiscal_exports;
                    DROP TABLE fiscal_snapshots;
                    CREATE TABLE fiscal_snapshots (
                        year INTEGER PRIMARY KEY REFERENCES fiscal_years(year), digest VARCHAR(64) NOT NULL,
                        backup_filename VARCHAR(100) NOT NULL, data JSON NOT NULL);
                    CREATE TABLE fiscal_exports (
                        year INTEGER REFERENCES fiscal_snapshots(year), kind VARCHAR(20), content BLOB NOT NULL,
                        PRIMARY KEY (year, kind));
                    INSERT INTO fiscal_snapshots SELECT year,digest,backup_filename,data FROM saved_snapshots;
                    INSERT INTO fiscal_exports SELECT year,kind,content FROM saved_exports;
                    CREATE UNIQUE INDEX ux_fiscal_year_active ON fiscal_years((1)) WHERE closed_at IS NULL;
                    DROP TRIGGER fiscal_freeze_closed_year;
                    CREATE TRIGGER fiscal_freeze_closed_year
                        BEFORE UPDATE OF year,start_date,end_date,closed_at ON fiscal_years WHEN OLD.closed_at IS NOT NULL
                        BEGIN SELECT RAISE(ABORT, 'closed fiscal period'); END;
                    DROP TRIGGER fiscal_freeze_fiscal_bank_openings_delete;
                    CREATE TRIGGER fiscal_freeze_fiscal_bank_openings_delete BEFORE DELETE ON fiscal_bank_openings
                        BEGIN SELECT RAISE(ABORT, 'immutable fiscal record'); END;
                """)
            backup = f.post("/settings/backup", {"passphrase": PASSPHRASE})
            self.restore_archive(f, backup["filename"])
            self.assertEqual(f.call("GET", report_path + "?version=1"), (200, original))
            self.assertEqual(f.reopen(year), (200, {"active_year": year}))
            self.assertEqual(f.call("GET", report_path + "?version=1"), (200, original))

    def test_reopen_unused_successor_then_close_again(self):
        with FiscalFixture() as f:
            bank, product = f.references()
            year = f.year
            buyer = f.customer("خریدار بازگشایی")
            order = f.order(buyer, product, number="REOPEN-ONE", total=1000, paid=300)
            oid = order["id"]
            issued = f.call("GET", f"/orders/{oid}/invoice")[1]
            preview = f.preview(year)
            self.assertEqual(f.confirm(year, preview)[0], 200)
            f.exports(year, "ready")
            before = f.call("GET", API)[1]
            self.assertEqual(before["reopen"], {"year": year, "version": 1, "blocked": False})
            backups = list((f.root / "backups").glob("*.zip"))
            paths = [f"{API}/{year}/exports/{kind}?version=1" for kind in ("summary", "carryover", "data")]
            outputs = [f.call("GET", path)[1] for path in paths]
            self.assertEqual(f.reopen(year, token=f.operator)[0], 403)
            self.assertEqual(f.reopen(year, confirm=False)[0], 422)

            with closing(sqlite3.connect(f.database)) as db, db:
                db.execute("""CREATE TRIGGER abort_reopen BEFORE DELETE ON fiscal_bank_openings
                    BEGIN SELECT RAISE(ABORT, 'test rollback'); END""")
            self.assertEqual(f.reopen(year)[0], 409)
            self.assertEqual(f.call("GET", API)[1]["active_year"], year + 1)
            with closing(sqlite3.connect(f.database)) as db, db:
                db.execute("DROP TRIGGER abort_reopen")
            self.assertEqual(f.reopen(year), (200, {"active_year": year}))
            self.assertEqual(f.reopen(year), (200, {"active_year": year}))
            self.assertEqual(next(row["status"] for row in f.call("GET", API)[1]["years"] if row["year"] == year + 1), "parked")
            self.assertEqual(list((f.root / "backups").glob("*.zip")), backups)
            self.assertEqual(f.call("GET", "/orders")[1]["items"][0]["id"], oid)
            self.assertEqual(f.confirm(year, preview)[0], 409)  # Old confirmation cannot close the reopened year.
            posting = {"request_id": str(uuid4()), "kind": "income", "bank_id": bank["id"], "amount": 100,
                       "customer_id": buyer["id"], "transaction_date": f"{year+1}/01/01", "time_mode": "auto"}
            self.assertEqual(f.call("POST", "/finance/transactions", posting)[0], 409)
            with closing(sqlite3.connect(f.database)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM fiscal_invoice_openings WHERE year=?", (year+1,)).fetchone()[0], 0)
            password = {"password": PASSWORD, "confirmed": True}
            self.assertEqual(f.call("DELETE", f"/orders/{oid}/invoice", password)[0], 200)
            version_one = f"{API}/{year}/records/invoices/{oid}"
            self.assertEqual(f.call("GET", version_one + "?version=1")[1]["remaining"], 700)
            self.assertEqual(f.call("GET", version_one + "/issued?version=1"), (200, issued))
            replacement = f.order(buyer, product, number="REOPEN-TWO", total=2000, paid=500)
            bank_balance = {a["id"]: a["closing_balance"] for a in f.preview(year)["accounts"]}
            self.assertEqual(f.confirm(year, f.preview(year))[1]["version"], 2)
            f.exports(year, "ready")
            self.assertEqual(f.call("GET", version_one)[0], 404)
            self.assertEqual(f.call("GET", version_one + "?version=1")[0], 200)
            self.assertEqual([f.call("GET", path)[1] for path in paths], outputs)
            self.assertEqual({a["id"]: a["opening_balance"] for a in f.call("GET", "/banks")[1]}, bank_balance)
            carryovers = f.call("GET", f"{API}/customers/{buyer['id']}/carryovers")[1]["invoices"]
            self.assertEqual([(row["order_id"], row["amount"]) for row in carryovers], [(replacement["id"], 1500)])
            self.assertEqual(f.reopen(year, 1)[0], 409)
            entry = f.post("/finance/transactions", posting)
            self.assertEqual(f.call("DELETE", f"/finance/transactions/{entry['id']}", password)[0], 200)
            self.assertEqual(f.call("GET", API)[1]["reopen"], {"year": year, "version": 2, "blocked": True})
            code, data = f.reopen(year, 2)
            self.assertEqual(code, 409)
            self.assertIn("سال مالی بعدی شروع شده", data["detail"])
            self.assertEqual(f.call("GET", API)[1]["active_year"], year + 1)

    def test_inventory_adjustment_starts_successor(self):
        with FiscalFixture() as f:
            _, product = f.references()
            self.assertEqual(f.confirm(f.year, f.preview(f.year))[0], 200)
            self.assertFalse(f.call("GET", API)[1]["reopen"]["blocked"])
            changes = {key: product[key] for key in ("revision", "name", "unit", "category_id", "price")}
            self.assertEqual(f.call("PUT", f"/products/{product['id']}", {**changes, "stock": product["stock"] + 1})[0], 200)
            self.assertTrue(f.call("GET", API)[1]["reopen"]["blocked"])
            self.assertEqual(f.reopen(f.year)[0], 409)

    def test_atomic_rollover_settlement_and_frozen_downloads(self):
        with FiscalFixture() as f:
            year = f.year
            previous = year - 1
            bank, product = f.references()
            aged = f.customer("بدهکار قدیمی")
            aged_order = f.order(aged, product, number="ORIGINAL-AGED", total=2_000_000, year=previous)
            initial = f.preview(previous)
            self.assertFalse(initial["inventory"]["available"])
            self.assertTrue(initial["inventory"]["reason"])
            self.assertEqual(f.confirm(previous, initial)[0], 200)
            f.exports(previous, "ready")
            self.assertEqual(f.call("GET", f"{API}/customers/{aged['id']}/carryovers")[1]["invoices"][0]["amount"], 2_000_000)
            settled = f.customer("تسویه کامل")
            partial = f.customer("مانده بخشی", ["09120000001", "02144440000"])
            multiple = f.customer("چند فاکتور")
            credit = f.customer("بستانکار")
            full_order = f.order(settled, product, number="SETTLED", total=1_000_000, paid=1_000_000)
            self.assertEqual(f.call("POST", f"/orders/{full_order['id']}/complete")[0], 200)
            original = f.order(partial, product, number="PARTIAL-005", total=10_000_000, paid=7_000_000, rows=55)
            f.order(multiple, product, number="TWO-FIRST", total=4_000_000)
            f.order(multiple, product, number="TWO-FUTURE-DUE", total=5_000_000, due=f"{year+1}/02/01")
            invoice_path = f"/orders/{original['id']}/invoice"
            issued = f.call("GET", invoice_path)[1]
            receipt = {
                "request_id": str(uuid4()), "kind": "income", "amount": 600_000, "customer_id": credit["id"],
                "bank_id": bank["id"], "tracking_number": "800104", "transaction_date": f"{year}/08/01", "time_mode": "auto",
            }
            credit_receipt = f.post("/finance/transactions", receipt)
            expense_category = f.post("/settings/expense-categories", {"title": "هزینه آزمایشی"})
            expense = {"request_id": str(uuid4()), "kind": "expense", "amount": 200_000,
                       "bank_id": bank["id"], "expense_category_id": expense_category["id"],
                       "transaction_date": f"{year}/04/01", "time_mode": "auto"}
            f.post("/finance/transactions", expense)
            account = f.post("/settings/document-accounts", {"title": "پرداخت اداری", "kind": "expense"})
            document_body = {"request_id": str(uuid4()), "date": f"{year}/05/01", "description": "سند آزمایشی",
                             "rows": [{"kind": "expense", "bank_id": bank["id"], "document_account_id": account["id"],
                                       "amount": 100_000}]}
            document = f.post("/documents", document_body)
            purchase = {"request_id": str(uuid4()), "purchase_date": f"{year}/09/01",
                        "rows": [{"product_id": product["id"], "category_id": product["category_id"],
                                  "quantity": 100, "purchase_price": 30_000}]}
            f.post("/purchases", purchase)
            preview = f.preview(year)
            self.assertEqual(preview["summary"]["settled_customers"], 1)
            self.assertEqual(preview["summary"]["carryover_customers"], 4)
            self.assertEqual(preview["summary"]["open_invoices"], 4)
            self.assertEqual(preview["summary"]["receivables"], 14_000_000)
            self.assertEqual(preview["summary"]["credits"], 600_000)
            self.assertEqual(preview["summary"]["not_due"], 5_000_000)
            self.assertEqual(preview["summary"]["purchase_value"], 3_000_000)
            self.assertEqual(preview["inventory"]["rows"][0]["quantity"], 1941)
            self.assertFalse(any(preview["next_activity"].values()))
            self.assertEqual(f.call("GET", f"{API}/{year}/preview", token=f.operator)[0], 403)
            self.assertEqual(f.confirm(year, preview, token=f.operator)[0], 403)
            f.flag("fail-backup").touch()
            self.assertEqual(f.confirm(year, preview)[0], 409)
            f.flag("fail-backup").unlink()
            self.assertEqual(f.call("GET", API)[1]["active_year"], year)

            # Change the ledger after a real verified backup. A concurrent
            # confirmation cannot acquire the close lock.
            hold = f.flag("hold-backup")
            hold.touch()
            with ThreadPoolExecutor(max_workers=2) as threads:
                first = threads.submit(f.confirm, year, preview)
                try:
                    until(f.flag("backup-verified").exists)
                    self.assertEqual(f.confirm(year, preview)[0], 409)
                    f.post("/finance/transactions", {**expense, "request_id": str(uuid4()), "amount": 20_000})
                finally:
                    hold.unlink()
                code, failure = first.result()
                self.assertEqual(code, 409, failure)
                self.assertIn("اطلاعات سال تغییر", failure["detail"])
            preview = f.preview(year)
            with closing(sqlite3.connect(f.database)) as db, db:
                db.execute(f"""CREATE TRIGGER fail_fiscal_opening BEFORE INSERT ON fiscal_invoice_openings
                    WHEN NEW.year={year+1} BEGIN SELECT RAISE(ABORT, 'test rollback'); END""")
            self.assertEqual(f.confirm(year, preview)[0], 409)
            with closing(sqlite3.connect(f.database)) as db, db:
                self.assertIsNone(db.execute("SELECT closed_at FROM fiscal_years WHERE year=?", (year,)).fetchone()[0])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM fiscal_snapshots WHERE year=?", (year,)).fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM fiscal_bank_openings WHERE year=?", (year+1,)).fetchone()[0], 0)
                db.execute("DROP TRIGGER fail_fiscal_opening")
            f.flag("fail-export").touch()
            self.assertEqual(f.confirm(year, preview)[0], 200)
            f.exports(year, "failed")
            number_of_backups = len(list((f.root / "backups").glob("*.zip")))
            self.assertEqual(f.confirm(year, preview)[0], 200)
            self.assertEqual(len(list((f.root / "backups").glob("*.zip"))), number_of_backups)
            self.assertEqual(f.call("GET", f"{API}/{year}/exports/summary")[0], 409)
            self.assertEqual(f.call("GET", API)[1]["active_year"], year + 1)
            dashboard = f.call("GET", "/dashboard?view=summary")[1]
            self.assertEqual(dashboard["orders"]["total"], 0)
            self.assertEqual(dashboard["orders"]["sales"], "0")
            self.assertEqual(dashboard["finance"]["transactions"], 0)
            self.assertEqual(dashboard["purchases"], {"count": 0, "value": "0"})
            self.assertEqual(f.call("GET", "/orders")[1]["items"], [])
            purchase_history = f.call("GET", "/purchases?history=true")[1]["items"]
            self.assertEqual(len(purchase_history), 1)
            self.assertFalse(purchase_history[0]["editable"])
            self.assertEqual(f.call("GET", f'/purchases/{purchase_history[0]["id"]}')[0], 200)
            self.assertEqual(f.call("GET", "/documents")[1]["items"], [])
            accounts = f.call("GET", "/banks")[1]
            self.assertEqual({b["id"]: b["opening_balance"] for b in accounts},
                             {b["id"]: b["closing_balance"] for b in preview["accounts"]})
            self.assertTrue(all((b["income"], b["expense"]) == (0, 0) for b in accounts))
            self.assertEqual(f.call("GET", f"{API}/customers/{settled['id']}/carryovers")[1]["receivable"], 0)
            self.assertEqual(f.call("GET", f"{API}/customers/{credit['id']}/carryovers")[1]["credit"], 600_000)
            self.assertEqual(len(f.call("GET", f"{API}/customers/{multiple['id']}/carryovers")[1]["invoices"]), 2)
            self.assertEqual(f.call("GET", f"{API}/customers/{aged['id']}/carryovers")[1]["invoices"][0]["order_id"], aged_order["id"])
            archive = f"{API}/{year}/records"
            found = f.call("GET", f"{archive}/orders?{urlencode({'q': original['order_number']})}", token=f.operator)[1]
            self.assertEqual(found["items"][0]["id"], original["id"])
            order_path = f"{archive}/invoices/{original['id']}"
            archived = f.call("GET", order_path)[1]
            self.assertEqual(len(archived["items"]), 55)
            self.assertEqual(archived["remaining"], 3_000_000)
            self.assertEqual(f.call("GET", f"{archive}/customers/{partial['id']}")[1]["closing"]["receivable"], 3_000_000)
            self.assertEqual(f.call("GET", f"{archive}/transactions?q=800104")[1]["total"], 1)
            self.assertEqual(f.call("GET", f"{API}/{year}/exports/data", token=f.operator)[0], 403)
            self.assertEqual(f.call("GET", f"{API}/{year}", token="")[0], 401)
            self.assertEqual(f.call("POST", f"/orders/{original['id']}/complete")[0], 409)
            password = {"password": PASSWORD, "confirmed": True}
            self.assertEqual(f.call("DELETE", invoice_path, password)[0], 409)
            self.assertEqual(f.call("DELETE", f"/documents/{document['id']}", password)[0], 409)
            self.assertEqual(f.call("PUT", f"/documents/{document['id']}", {
                **document_body, "request_id": str(uuid4()), "revision": document["revision"], "date": f"{year+1}/01/01",
            })[0], 409)
            self.assertEqual(f.call("POST", "/purchases", {**purchase, "request_id": str(uuid4())})[0], 409)
            self.assertEqual(f.call("POST", "/finance/transactions", {**receipt, "request_id": str(uuid4())})[0], 409)
            tx_path = f"/finance/transactions/{credit_receipt['id']}"
            self.assertEqual(f.call("DELETE", tx_path, password)[0], 409)
            self.assertEqual(f.call("PUT", tx_path, {k: v for k, v in receipt.items() if k != "request_id"})[0], 409)

            payment_path = f"/orders/{original['id']}/payments"
            payment = {"request_id": str(uuid4()), "amount": 1_000_000, "method": "transfer",
                       "bank_id": bank["id"], "transaction_date": f"{year+1}/01/01", "tracking_number": "901109"}
            self.assertEqual(f.call("POST", payment_path, {**payment, "transaction_date": f"{year}/12/29"})[0], 409)
            with ThreadPoolExecutor(max_workers=2) as threads:
                first, second = threads.map(lambda _: f.post(payment_path, payment), range(2))
            self.assertEqual(first, second)
            self.assertEqual(first["outstanding"], 2_000_000)
            copy = f.call("GET", f"{API}/customers/{partial['id']}/carryovers")[1]["invoices"][0]
            self.assertEqual((copy["paid"], copy["amount"], copy["outstanding"]), (7_000_000, 3_000_000, 2_000_000))
            self.assertEqual(f.call("POST", payment_path, {**payment, "request_id": str(uuid4()), "amount": 2_000_001})[0], 409)
            now = f.call("GET", "/dashboard?view=summary")[1]
            self.assertEqual(now["orders"]["sales"], "0")
            self.assertEqual(now["finance"]["income"], "1000000")
            self.assertEqual(f.call("GET", invoice_path)[1], issued)
            self.assertEqual(f.call("GET", order_path)[1], archived)
            self.assertEqual(f.call("GET", f"{archive}/transactions?q=901109")[1]["total"], 0)

            f.flag("fail-export").unlink()
            self.assertEqual(f.call("POST", f"{API}/{year}/exports")[0], 202)
            f.exports(year, "ready")
            exports = {}
            for kind in ("summary", "carryover", "data"):
                status, body = f.call("GET", f"{API}/{year}/exports/{kind}")
                self.assertEqual(status, 200)
                exports[kind] = body
            self.assert_exports(f, year, exports, preview)
            final_receipt = f.post(payment_path, {**payment, "request_id": str(uuid4()), "amount": 2_000_000,
                                                 "tracking_number": "901110"})
            self.assertEqual(final_receipt["outstanding"], 0)
            self.assertEqual(f.call("POST", f"{API}/{year}/exports")[0], 202)
            for kind, body in exports.items():
                self.assertEqual(sha256(f.call("GET", f"{API}/{year}/exports/{kind}")[1]).digest(), sha256(body).digest())
            with closing(sqlite3.connect(f.database)) as db, db:
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(db.execute("SELECT year FROM fiscal_years WHERE closed_at IS NULL").fetchall(), [(year+1,)])
                self.assertEqual(db.execute("SELECT order_number, invoice_code FROM orders WHERE id=?", (original["id"],)).fetchone(),
                                 (original["order_number"], original["invoice_code"]))
                self.assertEqual(db.execute("SELECT COUNT(*) FROM fiscal_invoice_openings WHERE year=?", (year+1,)).fetchone()[0], 4)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM order_payments WHERE order_id=?", (original["id"],)).fetchone()[0], 3)
                with self.assertRaisesRegex(sqlite3.IntegrityError, "closed fiscal period"):
                    db.execute("UPDATE orders SET status='completed' WHERE id=?", (original["id"],))
                with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable fiscal record"):
                    db.execute("UPDATE fiscal_snapshots SET data='{}' WHERE year=?", (year,))

    def assert_exports(self, f, year, exports, preview):
        for kind, minimum_pages in [("summary", 6), ("carryover", 3)]:
            pdf = PdfReader(BytesIO(exports[kind]))
            self.assertGreaterEqual(len(pdf.pages), minimum_pages)
            text = "".join(page.extract_text() for page in pdf.pages)
            self.assertGreater(len(text), 1800)
            for key in ("receivables", "credits"):
                amount = f"{preview['summary'][key]:,}".translate(str.maketrans("0123456789,", "۰۱۲۳۴۵۶۷۸۹٬"))
                self.assertTrue(amount in text or amount[::-1] in text, (kind, key, amount))
            self.assertIn("PARTIAL-005", text)
            self.assertGreater(text.count("بهای واحد"), 2)
        with ZipFile(BytesIO(exports["data"])) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["amount_unit"], "toman")
            self.assertEqual(manifest["period"], preview["period"])
            with closing(load_workbook(BytesIO(archive.read(f"karbon-{year}.xlsx")))) as book:
                def rows(sheet):
                    headers, *values = list(book[sheet].values)
                    return [dict(zip(headers, row)) for row in values]

                summary = {row["metric"]: row["value"] for row in rows("summary")}
                self.assertEqual(summary, preview["summary"])
                self.assertEqual(sum(row["amount"] for row in rows("closing_invoices")), summary["receivables"])
                self.assertEqual(sum(row["credit"] for row in rows("closing_customer_accounts")), summary["credits"])
                self.assertEqual(len(rows("closing_customer_accounts")), summary["carryover_customers"])
                self.assertEqual(len(rows("closing_invoices")), summary["open_invoices"])
                self.assertEqual(sum(o["total"] for o in rows("orders") if o["in_period"]), summary["net_sales"])
                self.assertEqual(sum(t["amount"] for t in rows("transactions") if t["kind"] == "income" and t["in_period"]), summary["income"])
                self.assertEqual(sum(p["total"] for p in rows("purchase_items")), summary["purchase_value"])
                self.assertTrue(book["invoices"].sheet_view.rightToLeft)
        if output := os.getenv("KARBON_FISCAL_QA_DIR"):
            for kind, body in exports.items():
                suffix = "zip" if kind == "data" else "pdf"
                (Path(output) / f"{year}-{kind}.{suffix}").write_bytes(body)
