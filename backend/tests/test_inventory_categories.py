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
        self.assertEqual((latest["category_path"], latest["stock"]), ("Hardware / Door", 8))
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
            **fields, "category_id": main["id"], "stock": 8, "revision": latest["revision"],
        }, 200)
        self.assertEqual(self.request("GET", "/reports/products/options?field=category_id")[1]["choices"],
                         [{"value": main["id"], "label": f'{main["id"]} · UPVC'}])
        self.write("DELETE", f'{self.categories}/{door["id"]}', status=409)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE inventory_options SET parent_id=? WHERE id=?", (door["id"], main["id"]))

    def test_same_product_properties_are_independent_in_two_catalogs(self):
        brand = self.write("POST", "/settings/brands", {"name": "هافمن"})
        categories = self.write("GET", self.options, status=200)
        warehouse = categories["warehouse-categories"][0]
        fields = {"name": "فریم", "unit": "عدد", "price": 1200, "requires_brand": True, "brand_id": brand["id"]}
        sale = self.write("POST", "/products", {**fields, "stock": 10})
        warehouse_fields = {**fields, "warehouse_category_id": warehouse["id"]}
        stored = self.write("POST", "/inventory/products", warehouse_fields)
        self.assertNotEqual(sale["id"], stored["id"])
        self.assertEqual({key: stored[key] for key in fields}, fields)
        self.write("POST", "/products", fields, 409)
        self.write("POST", "/inventory/products", warehouse_fields, 409)
        self.write("PUT", f'/products/{stored["id"]}', {**fields, "revision": stored["revision"]}, 404)
        self.write("PUT", f'/inventory/products/{sale["id"]}', {**warehouse_fields, "revision": sale["revision"]}, 404)
        body = {"request_id": str(uuid4()), "purchase_date": "1405/08/09", "product_id": stored["id"],
                "category_id": warehouse["id"], "quantity": 3, "purchase_price": 800, "catalog_only": True}
        self.write("POST", "/purchases", {**body, "product_id": sale["id"], "category_id": sale["category_id"]}, 422)
        self.write("POST", "/purchases", body)
        customer = self.write("POST", "/customers", {"first_name": "خریدار", "last_name": str(uuid4())})
        order = {"request_id": str(uuid4()), "customer_id": customer["id"], "invoice_date": "1405/08/09",
                 "payment_date": "1405/08/09", "items": [{"product_id": stored["id"], "quantity": 2, "unit_price": 1200}]}
        self.write("POST", "/orders", order, 404)
        self.write("POST", "/orders", {**order, "items": [{**order["items"][0], "product_id": sale["id"]}]})
        sales = {item["id"]: item["stock"] for item in self.write("GET", "/products?for_order=true", status=200)}
        stock = {item["id"]: item["stock"] for item in self.write("GET", "/inventory/products?catalog_only=true", status=200)}
        self.assertEqual((sales[sale["id"]], stock[stored["id"]]), (8, 3))
        self.assertNotIn(stored["id"], sales)
        self.assertNotIn(sale["id"], stock)

    def test_warehouse_assignment_purchase_and_safe_deletion(self):
        warehouse_path = self.options + "/warehouse-categories"
        sales = self.write("POST", self.categories, {"name": "Warehouse test"})
        first = self.write("POST", warehouse_path, {"name": sales["name"]})
        second = self.write("POST", warehouse_path, {"name": "Other warehouse"})
        self.assertEqual(first["product_count"], 0)
        self.write("POST", warehouse_path, {"name": " warehouse   test "}, 409)
        self.write("POST", warehouse_path, {"name": " "}, 422)
        self.write("POST", warehouse_path, {"name": "Cross-catalog", "parent_id": sales["id"]}, 422)
        fields = {"name": "Warehouse test product", "unit": "عدد", "stock": 7, "price": 900,
                  "category_id": sales["id"]}
        self.write("POST", "/products", {**fields, "warehouse_category_id": sales["id"]}, 422)
        product = self.write("POST", "/products", {**fields, "warehouse_category_id": first["id"]})
        product_path = f'/products/{product["id"]}'
        category_path = f'{warehouse_path}/{first["id"]}'
        self.assertEqual((product["category_id"], product["warehouse_category_id"]), (sales["id"], first["id"]))
        self.write("DELETE", category_path, status=409)
        renamed = self.write("PUT", category_path, {"name": "Renamed warehouse"}, 200)
        self.assertEqual(renamed["product_count"], 1)
        self.assertEqual(self.write("GET", self.options, status=200)["categories"][-1]["name"], sales["name"])
        body = {"request_id": str(uuid4()), "purchase_date": "1405/08/09", "product_id": product["id"],
                "category_id": first["id"], "quantity": 3, "purchase_price": 700}
        self.write("POST", "/purchases", {**body, "category_id": second["id"]}, 422)
        receipt = self.write("POST", "/purchases", body)
        self.assertEqual(receipt["rows"][0]["category_path"], renamed["name"])
        self.write("DELETE", f'/inventory/products/{product["id"]}',
                   {"password": "test-password", "confirmed": True}, 409)
        removable = [
            self.write("POST", "/products", {**fields, "name": f"Bulk removal {index}", "warehouse_category_id": second["id"]})
            for index in range(2)
        ]
        ids = [item["id"] for item in removable]
        delete_body = {"password": "test-password", "confirmed": True}
        self.write("DELETE", "/inventory/products", {**delete_body, "product_ids": []}, 422)
        self.write("DELETE", "/inventory/products", {**delete_body, "product_ids": [*ids, product["id"]]}, 409)
        self.write("DELETE", "/inventory/products", {**delete_body, "product_ids": [*ids, 999999]}, 404)
        warehouse_ids = {item["id"] for item in self.write("GET", "/inventory/products", status=200)}
        self.assertTrue(set(ids) <= warehouse_ids)
        self.assertEqual(self.write("DELETE", "/inventory/products", {**delete_body, "product_ids": ids}, 200),
                         {"product_ids": ids, "removed": True})
        warehouse_ids = {item["id"] for item in self.write("GET", "/inventory/products", status=200)}
        self.assertTrue(set(ids).isdisjoint(warehouse_ids))
        remaining = {item["id"]: item for item in self.write("GET", "/products", status=200)}
        self.assertEqual([remaining[id]["stock"] for id in ids], [7, 7])

        def product_state():
            return next(item for item in self.write("GET", "/products", status=200) if item["id"] == product["id"])

        def warehouse_stock():
            return next(item["stock"] for item in self.write("GET", "/inventory/products", status=200) if item["id"] == product["id"])

        self.assertEqual((product_state()["stock"], warehouse_stock()), (7, 3))
        moved = self.write("PUT", product_path, {**fields, "warehouse_category_id": second["id"],
                                                "revision": product_state()["revision"]}, 200)
        categories = self.write("GET", self.options, status=200)["warehouse-categories"]
        counts = {item["id"]: item["product_count"] for item in categories}
        self.assertEqual((counts[first["id"]], counts[second["id"]]), (0, 1))
        self.write("DELETE", category_path, status=200)
        self.write("DELETE", f'{warehouse_path}/{second["id"]}?confirm_unassignment=true', status=200)
        self.assertEqual((product_state()["warehouse_category_id"], product_state()["category_id"], product_state()["stock"]),
                         (None, sales["id"], 7))
        self.write("PUT", product_path, {**fields, "revision": moved["revision"]}, 409)
        self.write("POST", "/purchases", {**body, "request_id": str(uuid4())}, 422)
        self.write("POST", warehouse_path, {"name": renamed["name"]})
        receipt_path = f'/purchases/{receipt["id"]}'
        self.assertEqual(self.write("GET", receipt_path, status=200), receipt)
        edited = self.write("PUT", receipt_path, {**body, "request_id": str(uuid4()), "revision": receipt["revision"],
                                                 "quantity": 4}, 200)
        self.assertEqual((edited["rows"][0]["category_name"], warehouse_stock(), product_state()["stock"]), (renamed["name"], 4, 7))
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE products SET warehouse_category_id=? WHERE id=?", (sales["id"], product["id"]))
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO inventory_options (kind,name,active) VALUES ('warehouse-categories', ' ', 1)")
