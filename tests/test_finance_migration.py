"""Upgrade old financial tables and compact codes without changing relationships."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FinanceMigrationTests(unittest.TestCase):
    def test_old_columns_and_gapped_codes_upgrade_idempotently(self):
        with tempfile.TemporaryDirectory(prefix="karbon-code-migration-") as directory:
            database = str(Path(directory) / "old.db")
            bootstrap = '''
from database import Base, engine, SessionLocal
import models
from models.customer import Customer
from models.finance import BankAccount, ExpenseCategory, FinancialTransaction
from datetime import date
Base.metadata.create_all(bind=engine)
with SessionLocal() as db:
    db.add_all([Customer(id=3, customer_code=1001, first_name="یک", last_name="قدیمی"),
                Customer(id=9, customer_code=1007, first_name="دو", last_name="قدیمی"),
                BankAccount(id=7, name="قدیمی", account_number="old", opening_balance=0),
                ExpenseCategory(id=2, title="یک"), ExpenseCategory(id=8, title="دو")])
    db.flush()
    db.add_all([FinancialTransaction(id=5, request_id="old-income", kind="income", bank_id=7, customer_id=9, title="دو قدیمی", account_code="1007", amount=500, transaction_date=date(2026,10,6), transaction_time="12:00:00", time_mode="manual"),
                FinancialTransaction(id=11, request_id="old-expense", kind="expense", bank_id=7, expense_category_id=8, title="دو", account_code="E-000008", amount=100, transaction_date=date(2026,10,6), transaction_time="13:00:00", time_mode="manual")])
    db.commit()
with engine.begin() as connection:
    for table, fields in {"customers":["deleted_at"], "bank_accounts":["deleted_at"], "expense_categories":["display_code","deleted_at"], "financial_transactions":["transaction_number","updated_at","deleted_at"]}.items():
        for field in fields:
            connection.exec_driver_sql(f"ALTER TABLE {table} DROP COLUMN {field}")
import app
from services.finance_service import initialize_bank_storage
initialize_bank_storage(engine)
'''
            result = subprocess.run([sys.executable, "-c", bootstrap], cwd=ROOT / "backend",
                                    env=dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="migration-test-only"),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT id, customer_code FROM customers ORDER BY id").fetchall(),[(3,1001),(9,1002)])
                self.assertEqual(db.execute("SELECT id, display_code FROM expense_categories ORDER BY id").fetchall(),[(2,1),(8,2)])
                self.assertEqual(db.execute("SELECT id, transaction_number, bank_id, customer_id, expense_category_id, account_code, amount FROM financial_transactions ORDER BY id").fetchall(),[(5,1,7,9,None,"1002",500),(11,2,7,None,8,"E-000002",100)])
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])


if __name__ == "__main__":
    unittest.main()
