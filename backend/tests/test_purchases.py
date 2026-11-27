"""Authenticated purchase persistence, atomic inventory changes and retry safety."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
from uuid import uuid4
import test_customers as customer_tests


class PurchaseTests(unittest.TestCase):
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ["order_payments", "order_items", "orders", "purchase_items", "purchases", "products"]:
                db.execute(f"DELETE FROM {table}")
        categories = self.request("GET", "/settings/inventory-options")[1]["categories"]
        self.category = next(item for item in categories if item["name"] == "عمومی")
        self.other = next((item for item in categories if item["name"] == "مواد اولیه"), None)
        if not self.other:
            self.other = self.post("/settings/inventory-options/categories", {"name": "مواد اولیه"})
        for category in [self.category, self.other]:
            self.request("PUT", f'/settings/inventory-options/categories/{category["id"]}', {"name": category["name"], "active": True})
        units = self.request("GET", "/settings/inventory-options")[1]["units"]
        self.unit = next(item for item in units if item["name"] == "عدد")
        self.request("PUT", f'/settings/inventory-options/units/{self.unit["id"]}', {"name": "عدد", "active": True})
        self.product = self.post("/products", {"name": "کالای خرید", "category_id": self.category["id"], "unit": "عدد", "price": 1000, "stock": 10})

    def post(self, path, body):
        status, data = self.request("POST", path, body)
        self.assertEqual(status, 201, data)
        return data

    def payload(self, **changes):
        return {"request_id": str(uuid4()), "purchase_date": "۱۴۰۵/۰۸/۰۹", "category_id": self.category["id"],
                "product_id": self.product["id"], "quantity": 3, "purchase_price": 700, **changes}

    def stock(self):
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute("SELECT stock, revision FROM products WHERE id=?", (self.product["id"],)).fetchone()

    def warehouse_stock(self, product=None):
        product = product or self.product
        status, rows = self.request("GET", "/inventory/products")
        self.assertEqual(status, 200, rows)
        return next((row["stock"] for row in rows if row["id"] == product["id"]), 0)

    def test_purchase_persistence_date_stock_snapshot_and_sale(self):
        body = self.payload(discount=100, description="خرید آزمایشی\nتحویل انبار")
        purchase = self.post("/purchases", body)
        self.assertRegex(purchase["invoice_number"], r"^PUR-\d{6,}$")
        self.assertEqual(purchase["purchase_date"], "2026-10-31")
        self.assertEqual(purchase["jalali_date"], "1405/08/09")
        self.assertEqual((purchase["product_name"], purchase["unit"], purchase["total"]), ("کالای خرید", "عدد", 2000))
        self.assertEqual((purchase["description"], purchase["discount"]), (body["description"], 100))
        self.assertEqual(self.request("GET", f'/purchases/{purchase["id"]}/invoice')[1]["description"], body["description"])
        self.assertEqual(self.stock(), (10, 1))
        self.assertEqual(self.warehouse_stock(), 3)
        self.assertEqual(self.request("GET", f'/purchases/{purchase["id"]}')[1], purchase)
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT quantity,purchase_price FROM purchases").fetchone(), (3, 700))
            self.assertEqual(db.execute("SELECT price FROM products").fetchone()[0], 1000)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM orders").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions").fetchone()[0], 0)
            db.execute("UPDATE products SET name='نام جدید' WHERE id=?", (self.product["id"],))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.request("GET", f'/purchases/{purchase["id"]}')[1]["product_name"], "کالای خرید")
        customer = self.post("/customers", {"first_name": "خریدار", "last_name": str(uuid4()), "phone_numbers": []})
        self.post("/orders", {"request_id": str(uuid4()), "customer_id": customer["id"], "invoice_date": "1405/08/10", "payment_date": "1405/08/10", "items": [{"product_id": self.product["id"], "quantity": 12, "unit_price": 1000}]})
        self.assertEqual(self.stock()[0], -2)
        self.assertEqual(self.warehouse_stock(), 3)
        movements = self.request("GET", f'/inventory/movements?product_id={self.product["id"]}')[1]["items"]
        self.assertEqual([(row["reference"], row["delta"]) for row in movements], [(f'purchase:{purchase["id"]}:1:apply', 3)])

    def test_concurrent_retries_and_separate_purchases(self):
        body = self.payload()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/purchases", body), range(6)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual(len({data["id"] for _, data in results}), 1)
        self.assertEqual(self.warehouse_stock(), 3)
        self.assertEqual(self.request("POST", "/purchases", {**body, "quantity": 4})[0], 409)
        self.assertEqual(self.warehouse_stock(), 3)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/purchases", self.payload(quantity=1)), range(6)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual(len({data["invoice_number"] for _, data in results}), 6)
        self.assertEqual(self.warehouse_stock(), 9)
        self.assertEqual(self.stock(), (10, 1))

    def test_validation_and_rollback(self):
        for changes in [{"quantity": 0}, {"quantity": -1}, {"quantity": 1.5}, {"quantity": "2"}, {"quantity": True}, {"quantity": 1000001},
                        {"purchase_price": -1}, {"purchase_price": 1.5}, {"quantity": 1000000, "purchase_price": 999999999999},
                        {"purchase_date": "1405/12/30"}, {"purchase_date": "2026-10-31"}, {"purchase_date": ""},
                        {"product_id": 999999}, {"category_id": self.other["id"]}, {"unit": "متر"}, {"invoice_number": "fake"},
                        {"request_id": "bad"}, {"discount": -1}, {"discount": 2101}, {"description": "a" * 1001}]:
            self.assertEqual(self.request("POST", "/purchases", self.payload(**changes))[0], 422, changes)
            self.assertEqual(self.stock(), (10, 1))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 0)
        self.post("/purchases", self.payload(purchase_price=0))

    def test_reference_validation_and_history_protection(self):
        body = self.payload()
        self.request("PUT", f'/settings/inventory-options/categories/{self.category["id"]}', {"name": self.category["name"], "active": False})
        self.assertEqual(self.request("POST", "/purchases", body)[0], 422)
        self.request("PUT", f'/settings/inventory-options/categories/{self.category["id"]}', {"name": self.category["name"], "active": True})
        self.request("PUT", f'/settings/inventory-options/units/{self.unit["id"]}', {"name": "عدد", "active": False})
        self.assertEqual(self.request("POST", "/purchases", body)[0], 422)
        self.request("PUT", f'/settings/inventory-options/units/{self.unit["id"]}', {"name": "عدد", "active": True})
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET active=0 WHERE id=?", (self.product["id"],))
        self.assertEqual(self.request("POST", "/purchases", body)[0], 422)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET stock=NULL,active=1 WHERE id=?", (self.product["id"],))
        purchase = self.post("/purchases", body)
        product = next(item for item in self.request("GET", "/products")[1] if item["id"] == self.product["id"])
        self.assertFalse(product["can_delete"])
        self.assertEqual(self.request("DELETE", f'/products/{self.product["id"]}', {"password": "test-password", "confirmed": True})[0], 409)
        self.request("PUT", f'/settings/inventory-options/units/{self.unit["id"]}', {"name": "عدد", "active": False})
        self.assertEqual(self.post("/purchases", body), purchase)  # Retry checks precede catalog changes.
        self.assertEqual(self.stock(), (None, 1))
        self.assertEqual(self.warehouse_stock(), 3)

    def test_authentication_and_settings_category_validation(self):
        for method, path, body in [("GET", "/purchases/next-number", None), ("GET", "/purchases/1", None), ("POST", "/purchases", self.payload())]:
            self.assertEqual(self.request(method, path, body, authenticated=False)[0], 401)
        for category_id in [self.unit["id"], 999999]:
            self.assertEqual(self.request("POST", "/products", {"name": "نامعتبر", "unit": "عدد", "price": 1, "category_id": category_id})[0], 422)
        self.assertEqual(self.request("GET", "/purchases/999999")[0], 404)
        # Old clients still assign an existing Settings category, never a free-text category.
        product = self.post("/products", {"name": "سازگار", "unit": "عدد", "price": 1})
        self.assertEqual(product["category_id"], self.category["id"])

    def test_database_failure_rolls_back_inventory_and_retry_can_complete(self):
        body = self.payload()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("CREATE TRIGGER reject_purchase BEFORE INSERT ON purchases BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        self.assertEqual(self.request("POST", "/purchases", body)[0], 409)
        self.assertEqual(self.stock(), (10, 1))
        self.assertEqual(self.warehouse_stock(), 0)
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 0)
            db.execute("DROP TRIGGER reject_purchase")
        self.post("/purchases", body)
        self.assertEqual(self.warehouse_stock(), 3)

    def multi_payload(self):
        second = self.post("/products", {"name": "کالای دوم", "category_id": self.other["id"], "unit": "عدد", "price": 2000, "stock": 5})
        row = {key: self.payload()[key] for key in ("category_id", "product_id", "quantity", "purchase_price")}
        return second, {"request_id": str(uuid4()), "purchase_date": "1405/08/09", "rows": [row,
            {"category_id": self.other["id"], "product_id": second["id"], "quantity": 2, "purchase_price": 900},
            {**row, "quantity": 4, "purchase_price": 500}]}

    def test_multiple_rows_one_invoice_snapshots_and_stock_aggregation(self):
        second, body = self.multi_payload()
        result = self.post("/purchases", body)
        self.assertEqual((result["total_quantity"], result["row_count"], result["total"]), (9, 3, 5900))
        self.assertEqual([row["position"] for row in result["rows"]], [1, 2, 3])
        self.assertEqual([row["total"] for row in result["rows"]], [2100, 1800, 2000])
        self.assertEqual(self.warehouse_stock(), 7)
        self.assertEqual(self.post("/purchases", body), result)
        self.assertEqual(self.request("POST", "/purchases", {**body, "rows": list(reversed(body["rows"]))})[0], 409)
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT stock,revision FROM products WHERE id=?", (second["id"],)).fetchone(), (5, 1))
            self.assertEqual(self.warehouse_stock(second), 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 1)
            db.execute("UPDATE products SET name='تغییر نام' WHERE id=?", (second["id"],))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        saved = self.request("GET", f'/purchases/{result["id"]}')[1]
        self.assertEqual(saved, result)
        product = next(item for item in self.request("GET", "/products")[1] if item["id"] == second["id"])
        self.assertFalse(product["can_delete"])
        self.assertEqual(self.request("DELETE", f'/products/{second["id"]}', {"password": "test-password", "confirmed": True})[0], 409)

    def test_invalid_rows_invoice_limit_and_aggregated_stock_roll_back(self):
        second, body = self.multi_payload()
        row = body["rows"][0]
        for rows in [[], [{}], [row, {}], [row, {**row, "quantity": 0}], [row, {**row, "product_id": second["id"]}],
                     [row] * 101, [{**row, "purchase_price": 600000000000, "quantity": 1}] * 2,
                     [row, {**row, "unit": "متر"}], [row, {**row, "quantity": "2"}]]:
            self.assertEqual(self.request("POST", "/purchases", {**body, "rows": rows})[0], 422, rows)
            self.assertEqual(self.stock(), (10, 1))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("""INSERT INTO fiscal_inventory_changes (reference, scope, product_id, business_date, delta, name, unit)
                VALUES ('warehouse:test-opening', 'warehouse', ?, '2026-10-31', 999999995, 'Test', 'عدد')""", (self.product["id"],))
        self.assertEqual(self.request("POST", "/purchases", {**body, "rows": [row, row]})[0], 422)
        self.assertEqual(self.warehouse_stock(), 999999995)
        self.assertEqual(self.stock(), (10, 1))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchase_items").fetchone()[0], 0)

    def test_later_row_failure_is_atomic_and_concurrent_retries_are_safe(self):
        second, body = self.multi_payload()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("CREATE TRIGGER reject_second_purchase_row BEFORE INSERT ON purchase_items WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT, 'row failure'); END")
        self.assertEqual(self.request("POST", "/purchases", body)[0], 409)
        self.assertEqual(self.stock(), (10, 1))
        self.assertEqual((self.warehouse_stock(), self.warehouse_stock(second)), (0, 0))
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?", (second["id"],)).fetchone()[0], 5)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchases").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM purchase_items").fetchone()[0], 0)
            db.execute("DROP TRIGGER reject_second_purchase_row")
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/purchases", body), range(6)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual(len({data["id"] for _, data in results}), 1)
        self.assertEqual(self.warehouse_stock(), 7)


if __name__ == "__main__":
    unittest.main()
