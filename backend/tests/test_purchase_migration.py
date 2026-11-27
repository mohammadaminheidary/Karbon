"""Upgrade a real legacy schema and preserve category choices across restarts."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PurchaseMigrationTests(unittest.TestCase):
    def test_flat_catalog_upgrades_in_place_and_retains_hierarchy_on_restart(self):
        with tempfile.TemporaryDirectory(prefix="karbon-category-migration-") as directory:
            database = str(Path(directory) / "old.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript("""
                    CREATE TABLE inventory_options (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, kind VARCHAR(12) NOT NULL,
                        name VARCHAR(80) NOT NULL, active BOOLEAN NOT NULL, UNIQUE (kind, name),
                        CHECK (kind IN ('categories', 'units')));
                    INSERT INTO inventory_options VALUES (7, 'categories', 'UPVC', 1);
                    INSERT INTO inventory_options VALUES (8, 'units', 'عدد', 1);
                    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name VARCHAR(150) NOT NULL UNIQUE, unit VARCHAR(30) NOT NULL,
                        price BIGINT NOT NULL, stock INTEGER, active BOOLEAN NOT NULL,
                        category_id INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT);
                    INSERT INTO products VALUES (1, 'پنجره', 'عدد', 5000, 12, 1, 7);
                """)
            env = dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="category-migration-test-only")

            def restart():
                result = subprocess.run([sys.executable, "-c", "import app"], cwd=ROOT / "backend", env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

            restart()
            with closing(sqlite3.connect(database)) as db, db:
                self.assertEqual(db.execute("SELECT id,name,active,parent_id FROM inventory_options WHERE id IN (7,8)").fetchall(),
                                 [(7, "UPVC", 1, None), (8, "عدد", 1, None)])
                self.assertEqual(db.execute("SELECT category_id,stock FROM products").fetchone(), (7, 12))
                self.assertEqual(db.execute("""SELECT warehouse.kind, warehouse.name FROM products
                    JOIN inventory_options warehouse ON warehouse.id=products.warehouse_category_id""").fetchall(),
                                 [("warehouse-categories", "UPVC")])
                db.execute("INSERT INTO inventory_options (kind,name,active,parent_id) VALUES ('categories','Door',1,7)")
            restart()
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT parent_id FROM inventory_options WHERE name='Door'").fetchall(), [(7,)])
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_single_item_receipts_upgrade_without_stock_replay_and_keep_retry_ids(self):
        with tempfile.TemporaryDirectory(prefix="karbon-purchase-rows-migration-") as directory:
            database = str(Path(directory) / "old.db")
            env = dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="purchase-rows-test-only")
            def run(code):
                result = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "backend", env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            run('''
import app, hashlib, json
from database import SessionLocal
from schemas.order_schema import ProductWrite
from schemas.inventory_schema import PurchaseWrite
from services.order_service import save_product
from services.inventory_service import save_purchase
from models.inventory import Purchase
with SessionLocal() as db:
    product = save_product(db, ProductWrite(name="کالای قدیمی", unit="عدد", price=1000, stock=10))
    body = {"request_id":"00000000-0000-4000-8000-000000000001", "purchase_date":"1405/08/09", "product_id":product["id"], "category_id":product["category_id"], "quantity":3, "purchase_price":700}
    receipt = save_purchase(db, PurchaseWrite(**body))
    old = {key:value for key,value in body.items() if key != "request_id"}
    old["purchase_date"] = "2026-10-31"
    db.get(Purchase, receipt["id"]).request_fingerprint = hashlib.sha256(json.dumps(old, sort_keys=True).encode()).hexdigest()
    db.commit()
''')
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript("""
                    DROP TRIGGER inventory_change_no_update;
                    UPDATE fiscal_inventory_changes SET scope='sales', reference=substr(reference, 11) WHERE scope='warehouse';
                    UPDATE fiscal_inventory_history SET warehouse_available_from=NULL;
                    UPDATE products SET stock=13, revision=2;
                """)
                before = db.execute("SELECT * FROM purchases").fetchall()
                db.execute("DROP TABLE purchase_items")
                db.execute("DROP TABLE purchase_payments")
                db.execute("DELETE FROM inventory_purchase_migrations WHERE version IN (2,4)")
            run("import app")
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT * FROM purchases").fetchall(), before)
                self.assertEqual(db.execute("SELECT stock,revision FROM products WHERE catalog='sales'").fetchone(), (13, 2))
                self.assertEqual(db.execute("SELECT SUM(delta) FROM fiscal_inventory_changes WHERE scope='warehouse'").fetchone(), (13,))
                self.assertEqual(db.execute("""SELECT p.legacy_product_id, m.delta FROM products p
                    JOIN fiscal_inventory_changes m ON m.product_id=p.id
                    WHERE p.catalog='warehouse' AND m.reference='warehouse:purchase:1:1:apply'""").fetchall(), [(1, 3)])
                self.assertEqual(db.execute("SELECT position,quantity,purchase_price FROM purchase_items").fetchall(), [(1, 3, 700)])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM purchase_payments").fetchone(), (0,))
            run('''
import app
from database import SessionLocal
from models.order import Product
from schemas.inventory_schema import PurchaseWrite
from services.inventory_service import get_purchase, save_purchase
from services.inventory_stock import warehouse_balances
from services.order_service import delete_product
from models.user import User
from schemas.finance_schema import FinanceDelete
from security.password import hash_password
with SessionLocal() as db:
    product = db.query(Product).filter_by(catalog="sales").one()
    stored = db.query(Product).filter_by(catalog="warehouse", legacy_product_id=product.id).one()
    result = save_purchase(db, PurchaseWrite(request_id="00000000-0000-4000-8000-000000000001", purchase_date="۱۴۰۵/۰۸/۰۹", product_id=product.id, category_id=product.category_id, quantity=3, purchase_price=700))
    assert result["row_count"] == 1 and result["total"] == 2100
    assert result["paid"] == 0 and result["remaining"] == 2100 and result["payment_status"] == "unpaid"
    assert product.stock == 13
    assert get_purchase(db, result["id"])["rows"][0]["product_id"] == product.id
    assert get_purchase(db, result["id"], for_edit=True)["rows"][0]["product_id"] == stored.id
    assert dict(db.execute(warehouse_balances()).all()) == {stored.id: 13}
    delete_product(db, product.id, FinanceDelete(password="test-password", confirmed=True),
                   User(password_hash=hash_password("test-password")))
    assert get_purchase(db, result["id"]) == result
    assert dict(db.execute(warehouse_balances()).all()) == {stored.id: 13}
''')
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM purchase_items").fetchone()[0], 1)
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_legacy_stock_and_category_migration_is_repeatable(self):
        with tempfile.TemporaryDirectory(prefix="karbon-purchase-migration-") as directory:
            database = str(Path(directory) / "old.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript("""
                    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name VARCHAR(150) NOT NULL UNIQUE, unit VARCHAR(30) NOT NULL,
                        price BIGINT NOT NULL, stock INTEGER, active BOOLEAN NOT NULL);
                    INSERT INTO products VALUES (1, 'کالای قدیمی', 'رول قدیمی', 5000, 12, 1);
                """)
            env = dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="purchase-migration-test-only")
            def restart():
                result = subprocess.run([sys.executable, "-c", "import app"], cwd=ROOT / "backend", env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            restart()
            with closing(sqlite3.connect(database)) as db, db:
                product = db.execute("SELECT name,unit,price,stock,category_id FROM products").fetchone()
                self.assertEqual(product[:4], ("کالای قدیمی", "رول قدیمی", 5000, 12))
                self.assertEqual(db.execute("SELECT requires_brand,brand_id FROM products").fetchone(), (0, None))
                self.assertEqual(db.execute("SELECT kind,name FROM inventory_options WHERE id=?", (product[4],)).fetchone(), ("categories", "عمومی"))
                db.execute("UPDATE inventory_options SET name='دسته‌بندی قدیمی',active=0 WHERE id=?", (product[4],))
                self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 0)
            restart()
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT name,unit,price,stock,category_id FROM products").fetchone(), product)
                self.assertEqual(db.execute("SELECT name,active FROM inventory_options WHERE id=?", (product[4],)).fetchone(), ("دسته‌بندی قدیمی", 0))
                db.execute("PRAGMA foreign_keys=ON")
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("UPDATE products SET requires_brand=1 WHERE id=1")
                brand_id = db.execute("INSERT INTO brands (name) VALUES ('Brand')").lastrowid
                db.execute("UPDATE products SET requires_brand=1, brand_id=? WHERE id=1", (brand_id,))
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM brands WHERE id=?", (brand_id,))
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
