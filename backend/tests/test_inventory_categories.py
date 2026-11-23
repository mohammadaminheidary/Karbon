"""Category hierarchy and dependency behavior through the authenticated API."""
from contextlib import closing
import sqlite3
import unittest
from uuid import uuid4

import test_customers as customer_tests


class InventoryCategoryTests(unittest.TestCase):
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)
    options = "/settings/inventory-options"
    categories = options + "/categories"

    def write(self, method, path, data=None, status=201):
        actual, result = self.request(method, path, data)
        self.assertEqual(actual, status, result)
        return result

    def test_hierarchy_stays_consistent_across_catalog_stock_sales_and_reports(self):
        main = self.write("POST", self.categories, {"name": "UPVC"})
        other = self.write("POST", self.categories, {"name": "Hardware"})
        unused = self.write("POST", self.categories, {"name": "Unused"})
        self.write("DELETE", f'{self.categories}/{unused["id"]}', status=200)
        door = self.write("POST", self.categories, {"name": "Door", "parent_id": main["id"]})
        window = self.write("POST", self.categories, {"name": "Window", "parent_id": main["id"]})
        self.assertEqual(door["path"], "UPVC / Door")
        self.write("POST", self.categories, {"name": "Door", "parent_id": main["id"]}, 409)
        unit = self.request("GET", self.options)[1]["units"][0]
        for parent_id in (door["id"], unit["id"], 99999):
            self.write("POST", self.categories, {"name": "Invalid", "parent_id": parent_id}, 422)
        self.write("PUT", f'{self.categories}/{main["id"]}', {"name": "UPVC", "parent_id": main["id"]}, 422)
        self.write("PUT", f'{self.categories}/{main["id"]}', {"name": "UPVC", "parent_id": other["id"]}, 409)
        self.write("DELETE", f'{self.categories}/{main["id"]}', status=409)
        self.assertEqual(self.request("DELETE", f'{self.categories}/{window["id"]}', authenticated=False)[0], 401)
        self.write("DELETE", f'{self.categories}/{window["id"]}', status=200)
        self.write("DELETE", f'{self.categories}/{window["id"]}', status=404)

        # Omitting parent_id in a legacy update retains the chosen parent.
        door = self.write("PUT", f'{self.categories}/{door["id"]}', {"name": "Door panel"}, 200)
        self.assertEqual(door["parent_id"], main["id"])
        fields = {"name": "Tracked panel", "unit": "عدد", "price": 1000, "stock": 10, "category_id": door["id"]}
        product = self.write("POST", "/products", fields)
        self.assertEqual(product["category_path"], "UPVC / Door panel")
        self.write("DELETE", f'{self.categories}/{door["id"]}', status=409)
        self.write("PUT", f'{self.categories}/{main["id"]}', {"name": "UPVC", "active": False}, 200)
        settings = self.request("GET", self.options)[1]["categories"]
        self.assertFalse(next(item for item in settings if item["id"] == door["id"])["selectable"])
        self.write("POST", "/products", {**fields, "name": "Inactive parent product"}, 422)
        product = self.write("PUT", f'/products/{product["id"]}', {**fields, "revision": product["revision"]}, 200)
        purchase = {"request_id": str(uuid4()), "purchase_date": "1405/08/09", "product_id": product["id"],
                    "category_id": door["id"], "quantity": 3, "purchase_price": 700}
        self.write("POST", "/purchases", purchase, 422)
        self.write("PUT", f'{self.categories}/{main["id"]}', {"name": "UPVC", "active": True}, 200)
        self.write("POST", "/purchases", {**purchase, "category_id": main["id"]}, 422)
        receipt = self.write("POST", "/purchases", purchase)
        self.assertEqual(receipt["rows"][0]["category_path"], "UPVC / Door panel")
        customer = self.write("POST", "/customers", {"first_name": "Test", "last_name": "Buyer", "phone_numbers": []})
        sold = self.write("POST", "/orders", {
            "request_id": str(uuid4()), "customer_id": customer["id"], "invoice_date": "1405/08/09",
            "payment_date": "1405/08/09", "items": [{"product_id": product["id"], "quantity": 2, "unit_price": 1000}],
        })
        self.assertEqual(sold["items"][0]["category_id"], door["id"])
        self.assertEqual(sold["items"][0]["category_path"], "UPVC / Door panel")

        self.write("PUT", f'{self.categories}/{door["id"]}', {"name": "Door", "parent_id": other["id"]}, 200)
        latest = next(item for item in self.request("GET", "/products?for_order=true")[1] if item["id"] == product["id"])
        self.assertEqual((latest["category_path"], latest["stock"]), ("Hardware / Door", 11))
        for dataset in ("products", "order_items"):
            status, result = self.request("POST", f"/reports/{dataset}/preview", {
                "columns": ["category_id", "category_id.main_name", "category_id.name"],
                "filters": [{"field": "category_id.main_id", "value": other["id"]}],
            })
            self.assertEqual(status, 200, result)
            self.assertEqual([item["values"] for item in result["items"]], [{
                "category_id": door["id"], "category_id.main_name": "Hardware", "category_id.name": "Door",
            }])
        self.assertEqual(self.request("GET", "/reports/products/options?field=category_id&search=Hardware")[1]["choices"],
                         [{"value": door["id"], "label": f'{door["id"]} · Hardware · Door'}])
        self.assertEqual(self.request("GET", f'/purchases/{receipt["id"]}')[1], receipt)
        self.assertEqual(self.request("GET", f'/orders/{sold["id"]}/invoice')[1]["items"][0]["category_path"],
                         "UPVC / Door panel")

        # The category remains protected after the live product has moved.
        self.write("PUT", f'/products/{product["id"]}', {
            **fields, "category_id": main["id"], "stock": 11, "revision": latest["revision"],
        }, 200)
        self.assertEqual(self.request("GET", "/reports/products/options?field=category_id")[1]["choices"],
                         [{"value": main["id"], "label": f'{main["id"]} · UPVC'}])
        self.write("DELETE", f'{self.categories}/{door["id"]}', status=409)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE inventory_options SET parent_id=? WHERE id=?", (door["id"], main["id"]))
