"""Cross-module stock behavior through authenticated HTTP and disposable SQLite."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

import test_orders as order_tests


class StockWorkflowTests(unittest.TestCase):
    setUpClass = classmethod(order_tests.OrdersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(order_tests.OrdersIntegrationTests.tearDownClass.__func__)
    request = classmethod(order_tests.OrdersIntegrationTests.request.__func__)
    post = order_tests.OrdersIntegrationTests.post
    order_body = order_tests.OrdersIntegrationTests.payload
    confirmation = {"password": "test-password", "confirmed": True}
    date = "1405/08/09"

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ("production_runs", "purchase_items", "purchases", "documents", "document_accounts"):
                db.execute(f"DELETE FROM {table}")
        order_tests.OrdersIntegrationTests.setUp(self)
        self.category = self.post("/settings/inventory-options/categories", {"name": str(uuid4())})
        self.finished = self.post("/products", {"name": "کالای ساخته‌شده", "category_id": self.category["id"],
                                                "unit": "بسته", "price": 700, "stock": 0})

    def receipt(self, *rows, **fields):
        return {"request_id": str(uuid4()), "purchase_date": self.date, "rows": rows, **fields}

    @staticmethod
    def line(product, quantity, **fields):
        return {"product_id": product["id"], "category_id": product["category_id"], "unit": product["unit"],
                "quantity": quantity, "purchase_price": 235, **fields}

    def stock(self, product):
        return next(row["stock"] for row in self.request("GET", "/products?include_inactive=true")[1]
                    if row["id"] == product["id"])

    def postings(self, product):
        path = f'/inventory/movements?product_id={product["id"]}'
        status, result = self.request("GET", path)
        self.assertEqual(status, 200, result)
        return {row["reference"]: row["delta"] for row in result["items"]}

    def warehouse_stock(self, product):
        return next((row["stock"] for row in self.request("GET", "/inventory/products")[1]
                     if row["id"] == product["id"]), 0)

    def test_same_name_is_unique_per_brand_and_stock_is_separate(self):
        first = self.post("/settings/brands", {"name": "First"})
        second = self.post("/settings/brands", {"name": "Second"})
        fields = {"name": self.product["name"], "category_id": self.category["id"], "unit": "عدد",
                  "stock": -2, "requires_brand": True}
        one = self.post("/products", {**fields, "brand_id": first["id"]})
        two = self.post("/products", {**fields, "brand_id": second["id"]})
        self.assertEqual(self.request("POST", "/products", {**fields, "brand_id": first["id"]})[0], 409)
        self.assertEqual(self.request("PUT", f'/products/{two["id"]}', {
            **fields, "brand_id": first["id"], "revision": two["revision"],
        })[0], 409)
        self.post("/purchases", self.receipt(self.line(one, 1)))
        self.assertEqual((self.stock(self.product), self.stock(one), self.stock(two)), (10, -2, -2))
        self.assertEqual((self.warehouse_stock(one), self.warehouse_stock(two)), (1, 0))
        with closing(sqlite3.connect(self.database)) as db, db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE products SET brand_id=? WHERE id=?", (first["id"], two["id"]))

    def test_purchase_edit_order_issue_completion_and_cancellations(self):
        for fields in ({"category_id": self.category["id"]}, {"unit": self.finished["unit"]}):
            invalid = self.line(self.product, 4)
            invalid.update(fields)
            self.assertEqual(self.request("POST", "/purchases", self.receipt(invalid))[0], 422)
        supplier = self.post("/customers", {"first_name": "تأمین‌کننده", "last_name": "خرید"})
        body = self.receipt(self.line(self.product, 5), self.line(self.finished, 3), self.line(self.product, 2),
                            supplier_id=supplier["id"])
        purchase = self.post("/purchases", body)
        self.assertEqual((self.warehouse_stock(self.product), self.warehouse_stock(self.finished)), (7, 3))
        self.assertEqual((self.stock(self.product), self.stock(self.finished)), (10, 0))
        order_body = self.order_body(invoice_date=self.date, payment_date=self.date, discount=0, payments=[], items=[
            {"product_id": self.product["id"], "quantity": 8, "unit_price": 100},
            {"product_id": self.product["id"], "quantity": 5, "unit_price": 100},
            {"product_id": self.finished["id"], "quantity": 1, "unit_price": 700},
        ])
        sale = self.post("/orders", order_body)
        self.assertEqual(self.post("/orders", order_body), sale)
        order_url = f'/orders/{sale["id"]}'
        for method, suffix in (("GET", "invoice"), ("POST", "complete"), ("POST", "reactivate"), ("POST", "complete")):
            self.assertEqual(self.request(method, f"{order_url}/{suffix}")[0], 200)
        self.assertEqual((self.stock(self.product), self.stock(self.finished)), (-3, -1))
        self.assertEqual((self.warehouse_stock(self.product), self.warehouse_stock(self.finished)), (7, 3))
        purchase_url = f'/purchases/{purchase["id"]}'
        replacement = self.receipt(self.line(self.product, 2), self.line(self.finished, 2), revision=1,
                                   supplier_id=supplier["id"])
        status, updated = self.request("PUT", purchase_url, replacement)
        self.assertEqual(status, 200, updated)
        self.assertEqual((updated["invoice_number"], updated["revision"], updated["row_count"]), (purchase["invoice_number"], 2, 2))
        self.assertEqual(self.request("PUT", purchase_url, replacement), (200, updated))
        self.assertEqual(self.request("PUT", purchase_url, {**replacement, "request_id": str(uuid4())})[0], 409)
        self.assertEqual((self.stock(self.product), self.stock(self.finished)), (-3, -1))
        self.assertEqual((self.warehouse_stock(self.product), self.warehouse_stock(self.finished)), (2, 2))
        self.assertEqual(self.request("DELETE", order_url, self.confirmation)[0], 200)
        self.assertEqual(self.request("DELETE", f"{order_url}/invoice", self.confirmation)[0], 200)
        self.assertEqual((self.stock(self.product), self.stock(self.finished)), (10, 0))
        self.assertEqual(self.request("DELETE", f'/customers/{supplier["id"]}')[0], 409)
        self.assertEqual(self.request("DELETE", purchase_url, self.confirmation)[0], 200)
        self.assertEqual(self.request("DELETE", purchase_url, self.confirmation)[0], 200)
        self.assertEqual(self.request("POST", "/purchases", body)[0], 409)
        self.assertEqual(self.request("GET", "/purchases")[1]["total"], 0)
        self.assertEqual(self.request("DELETE", f'/customers/{supplier["id"]}')[0], 204)
        self.assertEqual((self.stock(self.product), self.stock(self.finished)), (10, 0))
        self.assertEqual((self.warehouse_stock(self.product), self.warehouse_stock(self.finished)), (0, 0))
        dashboard = self.request("GET", "/dashboard?start_date=2026-10-31&end_date=2026-10-31")[1]
        self.assertEqual(dashboard["purchases"]["count"], 0)
        self.assertEqual(next(row["stock"] for row in dashboard["inventory"]["products"] if row["id"] == self.product["id"]), 10)
        purchase_ref = f'purchase:{purchase["id"]}'
        self.assertEqual(self.postings(self.product), {
            f"{purchase_ref}:1:apply": 7, f"{purchase_ref}:2:reverse": -7,
            f"{purchase_ref}:2:apply": 2, f"{purchase_ref}:cancel": -2,
        })

    def test_document_is_stock_neutral_and_later_tracking_does_not_inflate_cancellation(self):
        account = self.post("/settings/document-accounts", {"title": "خرید مواد", "kind": "expense"})
        document = self.post("/documents", {"request_id": str(uuid4()), "date": self.date,
            "rows": [{"kind": "expense", "bank_id": self.bank["id"], "document_account_id": account["id"], "amount": 400}]})
        self.assertEqual(self.request("DELETE", f'/documents/{document["id"]}', self.confirmation)[0], 200)
        self.assertEqual(self.stock(self.product), 10)
        self.assertEqual(self.postings(self.product), {})
        order = self.post("/orders", self.order_body(discount=0, payments=[], items=[
            {"product_id": self.service["id"], "quantity": 2, "unit_price": 100},
        ]))
        url = f'/products/{self.service["id"]}'
        product = {key: self.service[key] for key in ("name", "unit", "price", "active", "revision")}
        self.assertEqual(self.request("PUT", url, {**product, "stock": 3})[0], 200)
        self.assertEqual(self.request("DELETE", f'/orders/{order["id"]}', self.confirmation)[0], 200)
        self.assertEqual(self.stock(self.service), 3)
        self.assertEqual(self.postings(self.service), {})
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT delta FROM fiscal_inventory_changes WHERE reference=? AND scope='sales'",
                                        (f'sale:{order["id"]}:issue',)).fetchone(), (0,))


class InventoryReferenceMigrationTests(unittest.TestCase):
    def test_additive_upgrade_preserves_balances_and_links_only_verifiable_sales(self):
        with tempfile.TemporaryDirectory(prefix="karbon-stock-upgrade-") as directory:
            database = Path(directory) / "legacy.db"
            env = dict(os.environ, KARBON_DATABASE_PATH=str(database), KARBON_JWT_SECRET="inventory-migration-test-only")

            def run(source):
                result = subprocess.run([sys.executable, "-B", "-c", source], cwd=Path(__file__).resolve().parents[1],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

            run('''
import app
from database import SessionLocal
from models.customer import Customer
from schemas.order_schema import OrderWrite, ProductWrite
from schemas.inventory_schema import PurchaseWrite
from services.fiscal_period import business_today, jalali
from services.inventory_service import save_purchase
from services.order_service import save_order, save_product
from uuid import uuid4
with SessionLocal() as db:
    day = jalali(business_today())
    customer = Customer(first_name="علی", last_name="مهاجرت", customer_code=1001)
    db.add(customer)
    db.commit()
    customer_id = customer.id
    product = save_product(db, ProductWrite(name="کالا", unit="عدد", price=1000, stock=10))
    unknown = save_product(db, ProductWrite(name="کالای دیگر", unit="عدد", price=1000, stock=4))
    save_purchase(db, PurchaseWrite(request_id=uuid4(), purchase_date=day, product_id=product["id"],
                                    category_id=product["category_id"], quantity=3, purchase_price=300))
    for item in (product, unknown):
        save_order(db, OrderWrite(request_id=uuid4(), customer_id=customer_id, invoice_date=day, payment_date=day,
                                  items=[dict(product_id=item["id"], quantity=2, unit_price=1000)]))
''')
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript("""
                    DROP TRIGGER inventory_change_requires_reference;
                    DROP TRIGGER inventory_change_no_update;
                    DROP TRIGGER inventory_change_no_delete;
                    DROP INDEX ux_inventory_change_reference_product;
                    UPDATE fiscal_inventory_changes SET scope='sales' WHERE scope='warehouse';
                    UPDATE fiscal_inventory_history SET warehouse_available_from=NULL;
                    UPDATE products SET stock=stock+3, revision=revision+1 WHERE id=1;
                    DELETE FROM fiscal_inventory_changes WHERE reference='sale:2:issue';
                    ALTER TABLE fiscal_inventory_changes DROP COLUMN reference;
                    ALTER TABLE fiscal_inventory_changes DROP COLUMN posted_at;
                    DROP TABLE production_runs;
                    DROP TRIGGER purchase_invoice_revision_guard;
                    ALTER TABLE purchases DROP COLUMN revision;
                    ALTER TABLE purchases DROP COLUMN deleted_at;
                    ALTER TABLE purchases DROP COLUMN last_edit_id;
                    ALTER TABLE purchases DROP COLUMN last_edit_fingerprint;
                """)
                before = db.execute("SELECT id, stock, revision FROM products").fetchall()
                changes = db.execute("SELECT id, product_id, delta FROM fiscal_inventory_changes ORDER BY id").fetchall()
            for _ in range(2):
                run("import app")
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT id, stock, revision FROM products").fetchall(), before)
                self.assertEqual(db.execute("SELECT id, product_id, delta FROM fiscal_inventory_changes WHERE scope='sales' ORDER BY id").fetchall(), changes)
                self.assertEqual(db.execute("SELECT reference FROM fiscal_inventory_changes WHERE delta < 0").fetchall(), [("sale:1:issue",)])
                self.assertEqual(db.execute("SELECT product_id, SUM(delta) FROM fiscal_inventory_changes WHERE scope='warehouse' GROUP BY product_id").fetchall(),
                                 [(1, 11), (2, 2)])
                self.assertEqual(db.execute("SELECT revision FROM purchases").fetchone(), (1,))
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            run('''
import app
from database import SessionLocal
from models.order import Product
from models.user import User
from schemas.finance_schema import FinanceDelete
from security.password import hash_password
from services.finance_service import FinanceError
from services.inventory_service import cancel_purchase
from services.inventory_stock import warehouse_balances
from services.order_service import delete_invoice
confirmation = FinanceDelete(password="migration-pass", confirmed=True)
user = User(password_hash=hash_password("migration-pass"))
with SessionLocal() as db:
    delete_invoice(db, 1, confirmation, user)
    cancel_purchase(db, 1, confirmation, user)
    assert db.get(Product, 1).stock == 13
    assert dict(db.execute(warehouse_balances()).all()) == {1: 8, 2: 2}
    try:
        delete_invoice(db, 2, confirmation, user)
    except FinanceError as exc:
        assert exc.code == "UNATTRIBUTED_STOCK"
    else:
        raise AssertionError("Cancellation changed stock without a matching historical posting")
    assert db.get(Product, 2).stock == 2
''')
