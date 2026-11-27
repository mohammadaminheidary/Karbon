"""Brand catalog, product validation, and historical transaction integration."""
from contextlib import closing
import sqlite3
import unittest
from uuid import uuid4

import test_customers as customers


class BrandTests(unittest.TestCase):
    setUpClass = classmethod(customers.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customers.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customers.CustomersIntegrationTests.request.__func__)

    def send(self, method, path, body=None, status=200):
        actual, result = self.request(method, path, body)
        self.assertEqual(actual, status, result)
        return result

    def test_brand_lifecycle_across_inventory_sales_and_reports(self):
        brands = "/settings/brands"
        self.assertEqual(self.request("GET", brands, authenticated=False)[0], 401)
        brand = self.send("POST", brands, {"name": "  Acme  "}, 201)
        brand_id = brand["id"]
        brand_path = f"{brands}/{brand_id}"
        self.assertEqual(brand["name"], "Acme")
        self.send("POST", brands, {"name": "Acme"}, 409)
        self.send("POST", brands, {"name": "   "}, 422)
        self.assertEqual(self.send("GET", brands), [brand])

        fields = {"name": "Tracked product", "unit": "عدد", "price": 100, "stock": 5}
        self.send("POST", "/products", {**fields, "requires_brand": True}, 422)
        self.send("POST", "/products", {**fields, "requires_brand": True, "brand_id": 9999}, 422)
        product = self.send("POST", "/products", {**fields, "requires_brand": True, "brand_id": brand_id}, 201)
        self.assertEqual((product["requires_brand"], product["brand_id"], product["brand_name"]), (True, brand_id, "Acme"))
        path = f'/products/{product["id"]}'
        product = self.send("PUT", path, {**fields, "price": 120, "revision": product["revision"]})
        self.assertEqual((product["brand_id"], product["price"]), (brand_id, 120))
        self.send("DELETE", brand_path, status=409)

        with closing(sqlite3.connect(self.database)) as db:
            db.execute("PRAGMA foreign_keys=ON")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM brands WHERE id=?", (brand_id,))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE products SET brand_id=NULL WHERE id=?", (product["id"],))

        receipt = self.send("POST", "/purchases", {
            "request_id": str(uuid4()), "purchase_date": "1405/08/09", "product_id": product["id"],
            "category_id": product["category_id"], "quantity": 3, "purchase_price": 70,
        }, 201)
        customer = self.send("POST", "/customers", {"first_name": "Test", "last_name": "Buyer", "phone_numbers": []}, 201)
        order = self.send("POST", "/orders", {
            "request_id": str(uuid4()), "customer_id": customer["id"], "invoice_date": "1405/08/09",
            "payment_date": "1405/08/09", "items": [{"product_id": product["id"], "quantity": 2, "unit_price": 120}],
        }, 201)
        self.assertEqual(receipt["rows"][0]["brand_name"], "Acme")
        self.assertEqual(order["items"][0]["brand_name"], "Acme")

        self.send("PUT", brand_path, {"name": "Acme Tools"})
        current = self.send("GET", "/products?for_order=true")[0]
        self.assertEqual((current["brand_name"], current["stock"], current["price"]), ("Acme Tools", 3, 120))
        dashboard = self.send("GET", "/dashboard?start_date=2026-10-31&end_date=2026-10-31")
        self.assertEqual(dashboard["inventory"]["products"][0]["brand_name"], "Acme Tools")
        self.assertEqual((dashboard["product_sales"][0]["brand_name"], dashboard["product_sales"][0]["gross"]), ("Acme Tools", "240"))
        report = self.send("POST", "/reports/products/preview", {"search": "Acme Tools"})
        self.assertEqual(report["items"][0]["values"]["brand_id.name"], "Acme Tools")
        for dataset in ("purchases", "purchase_items", "order_items"):
            report = self.send("POST", f"/reports/{dataset}/preview", {"columns": ["brand_name"]})
            self.assertEqual(report["items"][0]["values"], {"brand_name": "Acme"})

        edited = self.send("PUT", path, {**fields, "price": 120, "stock": current["stock"],
                                       "revision": current["revision"], "requires_brand": False, "brand_id": brand_id})
        self.assertEqual((edited["requires_brand"], edited["brand_id"], edited["brand_name"]), (False, None, None))
        self.send("DELETE", brand_path)
        self.send("DELETE", brand_path, status=404)
        self.assertEqual(self.send("GET", brands), [])
        self.assertEqual(self.send("GET", f'/purchases/{receipt["id"]}'), receipt)
        self.assertEqual(self.send("GET", f'/orders/{order["id"]}/invoice')["items"][0]["brand_name"], "Acme")
