"""Authenticated product deletion checks against an isolated SQLite database."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
import test_orders as order_tests


class ProductDeletionTests(unittest.TestCase):
    setUpClass = classmethod(order_tests.OrdersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(order_tests.OrdersIntegrationTests.tearDownClass.__func__)
    request = classmethod(order_tests.OrdersIntegrationTests.request.__func__)
    setUp = order_tests.OrdersIntegrationTests.setUp
    post = order_tests.OrdersIntegrationTests.post
    payload = order_tests.OrdersIntegrationTests.payload

    def remove(self, product_id, **changes):
        body = {"password": "test-password", "confirmed": True}
        body.update(changes)
        return self.request("DELETE", f"/products/{product_id}", body)

    def test_unused_product_deletion_preserves_other_products_and_codes(self):
        self.assertTrue(all(product["can_delete"] for product in self.request("GET", "/products?include_inactive=true")[1]))
        self.assertEqual(self.remove(self.product["id"]), (200, {"id": self.product["id"], "deleted": True}))
        products = self.request("GET", "/products?include_inactive=true")[1]
        self.assertEqual([product["id"] for product in products], [self.service["id"]])
        self.assertEqual(products[0]["product_code"], self.service["product_code"])
        self.assertEqual(self.remove(self.product["id"])[0], 404)
        replacement = self.post("/products", {"name": self.product["name"], "unit": "عدد", "price": 1000})
        self.assertGreater(replacement["id"], self.service["id"])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_auth_password_and_explicit_confirmation_are_required(self):
        path = f'/products/{self.product["id"]}'
        self.assertEqual(self.request("DELETE", path, {"password": "test-password", "confirmed": True}, authenticated=False)[0], 401)
        self.assertEqual(self.remove(self.product["id"], password="wrong")[0], 403)
        for body in [{"password": "test-password"}, {"password": "", "confirmed": True},
                     {"password": "test-password", "confirmed": False}, {"password": "test-password", "confirmed": "true"}]:
            self.assertEqual(self.request("DELETE", path, body)[0], 422)
        self.assertEqual(self.remove(999999)[0], 404)
        self.assertEqual(self.remove(0)[0], 422)
        self.assertEqual(len(self.request("GET", "/products")[1]), 2)

    def test_referenced_product_cannot_be_deleted_or_change_related_data(self):
        order = self.post("/orders", self.payload())
        invoice = self.request("GET", f'/orders/{order["id"]}/invoice')[1]
        banks = self.request("GET", "/banks")[1]
        products = self.request("GET", "/products?include_inactive=true")[1]
        self.assertTrue(all(not product["can_delete"] for product in products))
        self.assertEqual(self.remove(self.product["id"])[0], 409)
        self.assertEqual(self.request("GET", f'/orders/{order["id"]}/invoice')[1], invoice)
        self.assertEqual(self.request("GET", "/banks")[1], banks)
        self.assertEqual(self.request("GET", "/products?include_inactive=true")[1], products)
        # Deactivation remains available for products retained in order history.
        self.assertEqual(self.request("PUT", f'/products/{self.product["id"]}', {
            "name": self.product["name"], "unit": "عدد", "price": 1000, "stock": 8,
            "active": False, "revision": products[0]["revision"],
        })[0], 200)
        self.assertEqual(self.remove(self.product["id"])[0], 409)

    def test_sales_only_product_can_be_removed_from_warehouse(self):
        product = self.product
        warehouse = self.request("GET", "/settings/inventory-options")[1]["warehouse-categories"][0]
        fields = {key: product[key] for key in ("name", "unit", "price", "category_id", "revision")}
        self.assertEqual(self.request("PUT", f'/products/{product["id"]}', {
            **fields, "warehouse_category_id": warehouse["id"],
        })[0], 200)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("""INSERT INTO fiscal_inventory_changes
                (scope, reference, product_id, business_date, delta, tracked, name, unit)
                VALUES ('warehouse', 'warehouse:opening', ?, '2026-10-14', 0, 1, ?, ?)""",
                       (product["id"], product["name"], product["unit"]))
        order = self.post("/orders", self.payload())
        invoice_url = f'/orders/{order["id"]}/invoice'
        invoice = self.request("GET", invoice_url)[1]
        before = next(row for row in self.request("GET", "/products")[1] if row["id"] == product["id"])
        self.assertFalse(before["can_delete"])
        entry = next(row for row in self.request("GET", "/inventory/products")[1] if row["id"] == product["id"])
        self.assertEqual((entry["stock"], entry["removal_blocked_reason"]), (0, None))

        remove_url = f'/inventory/products/{product["id"]}'
        body = {"password": "test-password", "confirmed": True}
        self.assertEqual(self.request("DELETE", remove_url, body, authenticated=False)[0], 401)
        self.assertEqual(self.request("DELETE", remove_url, {**body, "password": "wrong"})[0], 403)
        self.assertEqual(self.request("DELETE", remove_url, body), (200, {"id": product["id"], "removed": True}))
        after = next(row for row in self.request("GET", "/products")[1] if row["id"] == product["id"])
        self.assertEqual((after["stock"], after["category_id"], after["warehouse_category_id"]),
                         (before["stock"], before["category_id"], None))
        self.assertEqual(self.request("GET", invoice_url)[1], invoice)
        self.assertEqual(self.request("GET", "/purchases")[1]["total"], 0)
        self.assertNotIn(product["id"], [row["id"] for row in self.request("GET", "/inventory/products")[1]])
        self.assertEqual(self.remove(product["id"])[0], 409)

    def test_deleted_invoice_allows_product_deletion_and_preserves_history(self):
        order = self.post("/orders", self.payload())
        self.assertEqual(self.request("DELETE", f'/orders/{order["id"]}/invoice', {"password": "test-password", "confirmed": True})[0], 200)
        products = self.request("GET", "/products?include_inactive=true")[1]
        self.assertTrue(all(product["can_delete"] for product in products))
        self.assertEqual(products[0]["stock"], 10)
        self.assertEqual(self.remove(self.product["id"])[0], 200)
        self.assertEqual(self.remove(self.product["id"])[0], 200)
        self.assertNotIn(self.product["id"], [product["id"] for product in self.request("GET", "/products?include_inactive=true")[1]])
        self.assertEqual(self.request("PUT", f'/products/{self.product["id"]}', {"name": "ویرایش", "unit": "عدد", "price": 1000, "stock": 10, "revision": 3})[0], 404)
        # Repeated invoice deletion cannot restore inventory a second time.
        self.assertEqual(self.request("DELETE", f'/orders/{order["id"]}/invoice', {"password": "test-password", "confirmed": True})[0], 200)
        with closing(sqlite3.connect(self.database)) as db:
            stock, deleted_at = db.execute("SELECT stock,deleted_at FROM products WHERE id=?", (self.product["id"],)).fetchone()
            self.assertEqual(stock, 10)
            self.assertIsNotNone(deleted_at)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM order_items").fetchone()[0], 2)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_order_creation_and_deletion_race_cannot_leave_broken_references(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            deletion = pool.submit(self.remove, self.product["id"])
            creation = pool.submit(self.request, "POST", "/orders", self.payload())
            deleted_status = deletion.result()[0]
            created_status = creation.result()[0]
        self.assertIn((deleted_status, created_status), [(200, 404), (409, 201)])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
