"""Bank profile, validation, persistence and additive migration checks."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import test_finance as finance_tests
import test_customers as customer_tests

ROOT = Path(__file__).resolve().parents[1]


class BanksIntegrationTests(unittest.TestCase):
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM financial_transactions")
            db.execute("DELETE FROM bank_accounts")

    def create(self, index=1, **changes):
        status, item = self.request("POST", "/banks", finance_tests.bank_payload(index, **changes))
        self.assertEqual(status, 201, item)
        return item

    def test_catalog_authentication_database_and_local_logos(self):
        self.assertEqual(self.request("GET", "/banks/catalog", authenticated=False)[0], 401)
        status, catalog = self.request("GET", "/banks/catalog")
        self.assertEqual(status, 200)
        self.assertGreater(len(catalog), 10)
        self.assertEqual(len({item["code"] for item in catalog}), len(catalog))
        self.assertEqual(next(item for item in catalog if item["code"] == "mellat")["name"], "بانک ملت")
        for bank in catalog:
            self.assertTrue((ROOT / bank["logo_url"].lstrip("/")).is_file())
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("UPDATE bank_directory SET name=? WHERE code='mellat'", ("نام ذخیره‌شده در دیتابیس",))
            db.commit()
        try:
            catalog = self.request("GET", "/banks/catalog")[1]
            self.assertEqual(next(item for item in catalog if item["code"] == "mellat")["name"], "نام ذخیره‌شده در دیتابیس")
        finally:
            with closing(sqlite3.connect(self.database)) as db, db:
                db.execute("UPDATE bank_directory SET name='بانک ملت' WHERE code='mellat'")

    def test_profile_normalization_persistence_multiple_accounts_and_timestamps(self):
        payload = finance_tests.bank_payload()
        persian = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
        saved = self.create(first_name="  علي  ", last_name="حيدري", card_number=" ".join(payload["card_number"][i:i+4] for i in range(0, 16, 4)).translate(persian),
                            sheba_number=payload["sheba_number"].lower().translate(persian), account_number=None)
        self.assertEqual(saved["first_name"], "علی")
        self.assertEqual(saved["last_name"], "حیدری")
        self.assertEqual(saved["card_number"], payload["card_number"])
        self.assertEqual(saved["sheba_number"], payload["sheba_number"])
        self.assertEqual(saved["account_number"], payload["sheba_number"])
        self.assertTrue(saved["profile_complete"])
        self.assertTrue(saved["created_at"])
        self.assertTrue(saved["updated_at"])
        self.assertEqual(saved["logo_url"], "/assets/image/banks/melli.svg")
        second = self.create(2, bank="mellat", opening_balance=5000)
        items = self.request("GET", "/banks")[1]
        self.assertEqual(len(items), 2)
        self.assertEqual({item["id"] for item in items}, {saved["id"], second["id"]})
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("SELECT first_name, last_name, bank, card_number, sheba_number, typeof(card_number), typeof(sheba_number) FROM bank_accounts WHERE id=?", (saved["id"],)).fetchone()
            self.assertEqual(row, ("علی", "حیدری", "melli", payload["card_number"], payload["sheba_number"], "text", "text"))
        time.sleep(0.01)
        update = {**payload, "first_name": "سارا", "bank": "saman", "account_number": None, "active": False}
        status, updated = self.request("PUT", f'/banks/{saved["id"]}', update)
        self.assertEqual(status, 200)
        self.assertEqual(updated["id"], saved["id"])
        self.assertEqual(updated["account_number"], saved["account_number"])
        self.assertEqual(updated["created_at"].split("+")[0], saved["created_at"].split("+")[0])
        self.assertGreater(updated["updated_at"].split("+")[0], saved["updated_at"].split("+")[0])
        self.assertEqual(updated["logo_url"], "/assets/image/banks/saman.svg")
        self.assertFalse(updated["active"])

    def test_required_names_card_sheba_and_invalid_bank(self):
        payload = finance_tests.bank_payload()
        for field in ["first_name", "last_name", "bank", "card_number"]:
            for value in [None, "", "  "]:
                status, error = self.request("POST", "/banks", {**payload, field: value})
                self.assertEqual(status, 422, (field, value, error))
            omitted = {key: value for key, value in payload.items() if key != field}
            self.assertEqual(self.request("POST", "/banks", omitted)[0], 422, field)
        for changes in [
            {"first_name": "علی۲"}, {"last_name": "Smith1"}, {"first_name": "علی١"}, {"first_name": "۱۲۳"}, {"last_name": "<script>"},
            {"card_number": "0000000000000000"}, {"card_number": "6037991234567890"}, {"card_number": 6037991234567890}, {"card_number": "6" * 15},
            {"card_number": payload["card_number"][:-1] + "A"}, {"sheba_number": "IR" + "0" * 24},
            {"sheba_number": "IR123456789012345678901234"}, {"sheba_number": "GB820540102680020817909002"},
            {"sheba_number": payload["sheba_number"] + "1"}, {"opening_balance": "1000"}, {"name": "fake"},
        ]:
            self.assertEqual(self.request("POST", "/banks", {**payload, **changes})[0], 422, changes)
        self.assertEqual(self.request("POST", "/banks", {**payload, "bank": "missing"})[0], 404)
        self.assertEqual(self.request("GET", "/banks")[1], [])

    def test_optional_sheba_persistence_edit_and_finance(self):
        saved = []
        for index, value in enumerate([None, "", "  ", "omitted"], start=1):
            payload = finance_tests.bank_payload(index, sheba_number=value, account_number=None)
            if value == "omitted":
                del payload["sheba_number"]
            status, bank = self.request("POST", "/banks", payload)
            self.assertEqual(status, 201, bank)
            self.assertIsNone(bank["sheba_number"])
            self.assertTrue(bank["profile_complete"])
            self.assertEqual(bank["account_number"], bank["card_number"])
            saved.append(bank)
        items = self.request("GET", "/banks")[1]
        self.assertEqual(len(items), 4)
        self.assertTrue(all(item["sheba_number"] is None for item in items))
        payload = finance_tests.bank_payload(1, account_number=None)
        status, bank = self.request("PUT", f'/banks/{saved[0]["id"]}', payload)
        self.assertEqual(status, 200, bank)
        self.assertEqual(bank["sheba_number"], payload["sheba_number"])
        payload["sheba_number"] = ""
        status, bank = self.request("PUT", f'/banks/{bank["id"]}', payload)
        self.assertEqual(status, 200, bank)
        self.assertIsNone(bank["sheba_number"])
        self.assertEqual(bank["account_number"], saved[0]["account_number"])
        status, category = self.request("POST", "/settings/expense-categories", {"title": "هزینه حساب بدون شبا"})
        self.assertEqual(status, 201, category)
        status, transaction = self.request("POST", "/finance/transactions", {
            "request_id": str(uuid.uuid4()), "kind": "expense", "bank_id": bank["id"],
            "expense_category_id": category["id"], "amount": 1000,
            "transaction_date": "1405/07/14", "time_mode": "manual", "hour": 12, "minute": 0,
        })
        self.assertEqual(status, 201, transaction)
        self.assertEqual(next(item for item in self.request("GET", "/banks")[1] if item["id"] == bank["id"])["balance"], -1000)

    def test_duplicate_identifiers_rollback_and_inactive_catalog(self):
        saved = self.create()
        for key in ["card_number", "sheba_number", "account_number"]:
            self.assertEqual(self.request("POST", "/banks", finance_tests.bank_payload(2, **{key: saved[key]}))[0], 409, key)
        self.assertEqual(len(self.request("GET", "/banks")[1]), 1)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE bank_directory SET active=0 WHERE code='saman'")
        try:
            self.assertFalse(next(item for item in self.request("GET", "/banks/catalog")[1] if item["code"] == "saman")["active"])
            self.assertEqual(self.request("POST", "/banks", finance_tests.bank_payload(2, bank="saman"))[0], 409)
        finally:
            with closing(sqlite3.connect(self.database)) as db, db:
                db.execute("UPDATE bank_directory SET active=1 WHERE code='saman'")


class BankMigrationTests(unittest.TestCase):
    def test_existing_account_and_finance_survive_idempotent_upgrade(self):
        with tempfile.TemporaryDirectory(prefix="karbon-bank-migration-") as directory:
            database = str(Path(directory) / "legacy.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.execute("CREATE TABLE bank_accounts (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, account_number VARCHAR(50) NOT NULL UNIQUE, opening_balance BIGINT NOT NULL, active BOOLEAN NOT NULL)")
                db.execute("INSERT INTO bank_accounts VALUES (7, 'بانک ملت', '0012345', 25000, 1)")
            bootstrap = '''
import json
from database import Base, engine, SessionLocal
import models
from models.finance import FinancialTransaction, ExpenseCategory
Base.metadata.create_all(bind=engine)
with SessionLocal() as db:
    category = ExpenseCategory(title="عنوان پیشین")
    db.add(category)
    db.flush()
    from datetime import date
    db.add(FinancialTransaction(request_id="legacy-request", kind="expense", bank_id=7, expense_category_id=category.id, title=category.title, account_code=category.account_code, amount=1000, transaction_date=date(2026,10,6), transaction_time="12:00:00", time_mode="manual"))
    db.commit()
import app
from services.finance_service import initialize_bank_storage, bank_list
initialize_bank_storage(engine)
with SessionLocal() as db:
    print(json.dumps(bank_list(db), default=str))
'''
            result = subprocess.run([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="migration-test-only"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            banks = json.loads(result.stdout)
            self.assertEqual(len(banks), 1)
            self.assertEqual(banks[0]["id"], 7)
            self.assertEqual(banks[0]["account_number"], "0012345")
            self.assertEqual(banks[0]["bank"], "mellat")
            self.assertIsNone(banks[0]["first_name"])
            self.assertIsNone(banks[0]["card_number"])
            self.assertFalse(banks[0]["profile_complete"])
            self.assertEqual(banks[0]["balance"], 24000)
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(db.execute("SELECT bank_id,amount FROM financial_transactions").fetchone(), (7, 1000))


if __name__ == "__main__":
    unittest.main()
