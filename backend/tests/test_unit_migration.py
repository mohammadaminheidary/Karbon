"""A real process restart adopts legacy units once and preserves deselections."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UnitMigrationTests(unittest.TestCase):
    def test_upgrade_and_restarts_preserve_units_selections_and_invoice_history(self):
        with tempfile.TemporaryDirectory(prefix="karbon-unit-migration-") as directory:
            database = str(Path(directory) / "old.db")
            env = dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="unit-migration-test")

            def run(code):
                result = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "backend", env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

            run('''
import app
from database import SessionLocal
from models.customer import Customer
from models.order import Product
from models.inventory import InventoryOption
from services.order_service import save_order
from schemas.order_schema import OrderWrite
from uuid import uuid4
with SessionLocal() as db:
    db.add(Customer(id=1, customer_code=1001, first_name="مشتری", last_name="قدیمی", phone_numbers=[]))
    db.add(InventoryOption(kind="units", name="رول قدیمی", active=True))
    db.add(Product(id=1, product_code="P-000001", name="کالا", unit="رول قدیمی", price=1000, stock=10))
    db.commit()
    save_order(db, OrderWrite(request_id=uuid4(), customer_id=1, invoice_date="1405/7/22", payment_date="1405/7/22", items=[{"product_id":1,"quantity":2,"unit_price":1000}]))
''')
            with closing(sqlite3.connect(database)) as db, db:
                # Simulate the earlier app's saved catalog and legacy free-text units.
                db.execute("DROP TABLE inventory_unit_migrations")
                db.execute("DELETE FROM inventory_options")
                db.execute("INSERT INTO inventory_options (kind,name,active) VALUES ('units','عدد',0)")
                db.execute("UPDATE products SET unit='واحد محصول قدیمی'")
                product_before = db.execute("SELECT * FROM products").fetchall()
                invoice_before = db.execute("SELECT invoice_snapshot FROM orders").fetchone()[0]
                self.assertEqual(json.loads(invoice_before)["items"][0]["unit"], "رول قدیمی")
            run("import app")
            with closing(sqlite3.connect(database)) as db, db:
                catalog = dict(db.execute("SELECT name,active FROM inventory_options WHERE kind='units'"))
                self.assertFalse(catalog["عدد"])
                self.assertTrue(catalog["واحد محصول قدیمی"])
                self.assertTrue(catalog["رول قدیمی"])
                self.assertEqual(db.execute("SELECT * FROM products").fetchall(), product_before)
                self.assertEqual(db.execute("SELECT invoice_snapshot FROM orders").fetchone()[0], invoice_before)
                db.execute("UPDATE inventory_options SET active=0")
                expected = db.execute("SELECT id,kind,name,active FROM inventory_options ORDER BY id").fetchall()
            run("import app\nfrom services.inventory_service import initialize_unit_storage\nfrom database import engine\ninitialize_unit_storage(engine)")
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT id,kind,name,active FROM inventory_options ORDER BY id").fetchall(), expected)
                self.assertEqual(db.execute("SELECT invoice_snapshot FROM orders").fetchone()[0], invoice_before)
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
