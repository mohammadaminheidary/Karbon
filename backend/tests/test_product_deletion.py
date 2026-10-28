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
