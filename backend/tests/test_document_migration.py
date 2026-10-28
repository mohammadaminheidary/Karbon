"""Preserve legacy documents and ledger money while adding document links."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DocumentMigrationTests(unittest.TestCase):
    def test_document_only_schema_upgrades_without_posting_money(self):
        with tempfile.TemporaryDirectory(prefix="karbon-document-migration-") as directory:
            path = str(Path(directory) / "legacy.db")
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript('''CREATE TABLE documents (
                    id INTEGER PRIMARY KEY, number VARCHAR(100) NOT NULL UNIQUE,
                    description TEXT NOT NULL, date DATE NOT NULL,
                    document_type VARCHAR(100) NOT NULL, created_at DATETIME NOT NULL);
                    INSERT INTO documents VALUES (7,'LEGACY-007','یادداشت قدیمی','2026-10-06','قرارداد','2026-10-06 10:00:00');''')
            script = '''
import app
from database import engine, SessionLocal
from services.document_service import initialize_document_storage, get_document
initialize_document_storage(engine)
initialize_document_storage(engine)
with SessionLocal() as db:
    document = get_document(db,7)
    assert document["number"] == "LEGACY-007"
    assert document["rows"] == []
    assert document["total_income"] == document["total_expense"] == 0
    assert document["revision"] == 1
'''
            result = subprocess.run([sys.executable,"-c",script],cwd=ROOT/"backend",env=dict(os.environ,KARBON_DATABASE_PATH=path,KARBON_JWT_SECRET="document-migration-test"),capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM financial_transactions").fetchone()[0],0)
                self.assertEqual(db.execute("SELECT number,description FROM documents").fetchone(),("LEGACY-007","یادداشت قدیمی"))
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_linked_ledger_upgrade_keeps_money_ids_and_invoice_references(self):
        with tempfile.TemporaryDirectory(prefix="karbon-linked-document-migration-") as directory:
            path = str(Path(directory) / "ledger.db")
            env = dict(os.environ,KARBON_DATABASE_PATH=path,KARBON_JWT_SECRET="document-migration-test")
            prepare = """
import app
from database import SessionLocal
from models.customer import Customer
from models.finance import BankAccount, FinancialTransaction
from models.document import Document
from models.order import Order, OrderPayment
from datetime import date
with SessionLocal() as db:
    db.add(Customer(id=1,customer_code=1001,first_name="مشتری",last_name="قدیمی"))
    db.add(BankAccount(id=1,name="بانک",account_number="legacy",opening_balance=1000))
    db.add(Document(id=1,number="legacy-doc",description="یادداشت",date=date(2026,10,6),document_type="درآمد"))
    db.flush()
    for record_id, doc_id, amount in [(10,1,100),(11,None,50)]:
        db.add(FinancialTransaction(id=record_id,document_id=doc_id,request_id=f"legacy-{record_id}",kind="income",bank_id=1,customer_id=1,title="مشتری قدیمی",account_code="1001",amount=amount,transaction_date=date(2026,10,6),transaction_time="12:00:00",time_mode="auto"))
    db.add(Order(id=1,request_id="legacy-order",request_fingerprint="legacy",invoice_code="INV-OLD",order_number="O-OLD",customer_id=1,invoice_date=date(2026,10,6),payment_date=date(2026,10,6),subtotal=50,discount=0))
    db.flush()
    db.add(OrderPayment(id=1,order_id=1,transaction_id=11,method="transfer"))
    db.commit()
"""
            result = subprocess.run([sys.executable,"-c",prepare],cwd=ROOT/"backend",env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            # Recreate the exact prior source constraint and remove the new FK.
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript('''CREATE TABLE financial_transactions_old (
                    id INTEGER PRIMARY KEY, transaction_number INTEGER, request_id VARCHAR(36) NOT NULL UNIQUE,
                    kind VARCHAR(10) NOT NULL, customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
                    expense_category_id INTEGER REFERENCES expense_categories(id) ON DELETE RESTRICT,
                    bank_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
                    document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
                    title VARCHAR(201) NOT NULL, account_code VARCHAR(50) NOT NULL, amount BIGINT NOT NULL,
                    tracking_number VARCHAR(100), description TEXT, transaction_date DATE NOT NULL,
                    transaction_time VARCHAR(8) NOT NULL, time_mode VARCHAR(10) NOT NULL,
                    created_at DATETIME NOT NULL, updated_at DATETIME, deleted_at DATETIME,
                    CONSTRAINT financial_source CHECK ((kind='income' AND customer_id IS NOT NULL AND expense_category_id IS NULL) OR (kind='expense' AND customer_id IS NULL AND expense_category_id IS NOT NULL)),
                    CHECK (amount>0 AND amount<=999999999999), CHECK (time_mode IN ('auto','manual')));
                    INSERT INTO financial_transactions_old SELECT id,transaction_number,request_id,kind,customer_id,expense_category_id,bank_id,document_id,title,account_code,amount,tracking_number,description,transaction_date,transaction_time,time_mode,created_at,updated_at,deleted_at FROM financial_transactions;
                    DROP TABLE financial_transactions;
                    ALTER TABLE financial_transactions_old RENAME TO financial_transactions;''')
            upgrade = """
import app
from database import engine, SessionLocal
from services.document_service import initialize_document_storage, get_document
from services.finance_service import bank_list
initialize_document_storage(engine)
initialize_document_storage(engine)
with engine.connect() as connection:
    assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
with SessionLocal() as db:
    document=get_document(db,1)
    assert document["rows"][0]["id"] == 10
    assert document["rows"][0]["customer_id"] is None
    assert document["rows"][0]["document_account_id"] is not None
    assert document["total_income"] == 100
    assert bank_list(db)[0]["balance"] == 1150
"""
            result = subprocess.run([sys.executable,"-c",upgrade],cwd=ROOT/"backend",env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT id,amount,request_id FROM financial_transactions ORDER BY id").fetchall(),[(10,100,"legacy-10"),(11,50,"legacy-11")])
                self.assertEqual(db.execute("SELECT transaction_id FROM order_payments").fetchone()[0],11)
                self.assertEqual(db.execute("SELECT customer_id FROM financial_transactions WHERE id=11").fetchone()[0],1)
                self.assertEqual(db.execute("SELECT count(*) FROM document_accounts").fetchone()[0],1)
                self.assertEqual(db.execute("SELECT revision FROM documents").fetchone()[0],2)
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])


if __name__ == "__main__":
    unittest.main()
