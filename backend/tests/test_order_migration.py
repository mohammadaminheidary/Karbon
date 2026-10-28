"""Verify upgrade from the initial orders schema without rewriting invoice codes."""
from contextlib import closing
from datetime import date
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class OrderMigrationTests(unittest.TestCase):
    def test_upgrade_preserves_links_stock_and_codes_and_freezes_invoice(self):
        with tempfile.TemporaryDirectory(prefix="karbon-order-migration-") as directory:
            database = str(Path(directory)/"old.db")
            env = dict(os.environ,KARBON_DATABASE_PATH=database,KARBON_JWT_SECRET="migration-test-only")
            prepare = '''
import app
from database import SessionLocal
from models.customer import Customer
from models.order import Product
from services.order_service import save_order
from schemas.order_schema import OrderWrite
from uuid import uuid4
with SessionLocal() as db:
    db.add(Customer(id=1,customer_code=1001,first_name="مشتری",last_name="قدیمی",phone_numbers=["09120000001"]))
    db.add(Product(id=3,product_code="P-000003",name="کالا",unit="عدد",price=1000,stock=10))
    db.commit()
    save_order(db,OrderWrite(request_id=uuid4(),customer_id=1,invoice_date="1405/7/22",payment_date="1405/7/22",items=[{"product_id":3,"quantity":2,"unit_price":1000}],payments=[{"method":"cash","amount":500}]))
'''
            result = subprocess.run([sys.executable,"-c",prepare],cwd=ROOT/"backend",env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript('''
DROP TRIGGER permanent_invoice_code;
DROP TRIGGER permanent_invoice_snapshot;
UPDATE orders SET invoice_code='INV-legacy-code';
ALTER TABLE orders DROP COLUMN invoice_snapshot;
ALTER TABLE orders DROP COLUMN deleted_at;
CREATE TABLE products_old (id INTEGER PRIMARY KEY AUTOINCREMENT,name VARCHAR(150) NOT NULL UNIQUE,unit VARCHAR(30) NOT NULL,price BIGINT NOT NULL,stock INTEGER,active BOOLEAN NOT NULL);
INSERT INTO products_old SELECT id,name,unit,price,stock,active FROM products;
DROP TABLE products;
ALTER TABLE products_old RENAME TO products;
''')
            upgrade = '''
import app
from database import engine
from services.order_service import initialize_order_storage
initialize_order_storage(engine)
'''
            result = subprocess.run([sys.executable,"-c",upgrade],cwd=ROOT/"backend",env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with closing(sqlite3.connect(database)) as db:
                code,snapshot = db.execute("SELECT invoice_code,invoice_snapshot FROM orders").fetchone()
                self.assertEqual(code,"INV-legacy-code")
                final = json.loads(snapshot)
                self.assertEqual(final["invoice_code"],code)
                self.assertEqual((final["total"],final["paid"],final["remaining"]),(2000,500,1500))
                self.assertEqual(final["items"][0]["product_code"],"P-000003")
                self.assertEqual(db.execute("SELECT product_code,revision,stock FROM products").fetchone(),("P-000003",1,8))
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])
                self.assertIsNone(db.execute("SELECT deleted_at FROM orders").fetchone()[0])
