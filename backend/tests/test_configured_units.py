"""Central unit validation across authenticated product and order APIs."""
from contextlib import closing
import sqlite3
import unittest
import test_orders as orders


class ConfiguredUnitTests(unittest.TestCase):
    setUpClass = classmethod(orders.OrdersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(orders.OrdersIntegrationTests.tearDownClass.__func__)
    request = classmethod(orders.OrdersIntegrationTests.request.__func__)
    post = orders.OrdersIntegrationTests.post
    payload = orders.OrdersIntegrationTests.payload

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM inventory_options")
            db.executemany("INSERT INTO inventory_options (kind,name,active) VALUES ('units',?,1)", [("عدد",), ("ساعت",), ("بسته",)])
        orders.OrdersIntegrationTests.setUp(self)

    def unit(self, name="عدد"):
        return next(u for u in self.request("GET", "/settings/inventory-options")[1]["units"] if u["name"] == name)

    def toggle(self, name="عدد", active=False):
        u = self.unit(name)
        status, data = self.request("PUT", f'/settings/inventory-options/units/{u["id"]}', {"name": name, "active": active})
        self.assertEqual(status, 200, data)
        return data

    def edit(self, product=None, **changes):
        p = product or self.product
        body = {key: p[key] for key in ("name", "unit", "price", "stock", "active", "revision")}
        return self.request("PUT", f'/products/{p["id"]}', {**body, **changes})

    def test_new_assignments_require_enabled_units_and_category_is_not_a_unit(self):
        self.post("/settings/inventory-options/categories", {"name": "دسته"})
        self.toggle()
        for unit in ("واحد ناشناخته", "عدد", "دسته"):
            self.assertEqual(self.request("POST", "/products", {"name": "جدید", "unit": unit, "price": 10})[0], 422)
            status, result = self.edit(unit=unit)
            self.assertEqual(status, 200 if unit == "عدد" else 422)
            if status == 200:
                self.product = result
        # Arabic letters and spaces follow the same normalization in both APIs.
        self.post("/settings/inventory-options/units", {"name": "  كيلو  "})
        created = self.post("/products", {"name": "جدید", "unit": "  كيلو  ", "price": 10})
        self.assertEqual(created["unit"], "کیلو")
        long_name = "و" * 80
        self.post("/settings/inventory-options/units", {"name": long_name})
        self.post("/products", {"name": "واحد بلند", "unit": long_name, "price": 10})
        self.assertEqual(self.request("POST", "/products", {"name": "بلند", "unit": "و" * 81, "price": 10})[0], 422)

    def test_disabled_unit_keeps_existing_product_and_invoice_workflows(self):
        body = self.payload(payments=[])
        order = self.post("/orders", body)
        invoice = self.request("GET", f'/orders/{order["id"]}/invoice')[1]
        self.toggle()
        # Existing history and idempotent retries work even after deselection.
        self.assertEqual(self.request("POST", "/orders", body)[0], 201)
        self.assertEqual(self.request("GET", f'/orders/{order["id"]}/invoice')[1], invoice)
        self.assertEqual(len(self.request("GET", "/products?include_inactive=true")[1]), 2)
        self.assertEqual([p["id"] for p in self.request("GET", "/products?for_order=true")[1]], [self.service["id"]])
        self.assertEqual(self.request("POST", "/orders", self.payload(payments=[]))[0], 422)
        product = next(p for p in self.request("GET", "/products")[1] if p["id"] == self.product["id"])
        status, updated = self.edit(product, price=2000)
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["unit"], "عدد")
        self.assertEqual(updated["stock"], 8)
        self.assertEqual(self.request("POST", f'/orders/{order["id"]}/complete')[0], 200)
        self.toggle(active=True)
        self.post("/orders", self.payload(payments=[]))
        self.assertEqual(self.request("GET", f'/orders/{order["id"]}/invoice')[1], invoice)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_disabled_or_missing_legacy_unit_can_only_be_retained_by_its_owner(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET unit='  قديمي  ' WHERE id=?", (self.product["id"],))
        legacy = {**self.product, "unit": "  قديمي  "}
        status, updated = self.edit(legacy, price=20)
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["unit"], "  قديمي  ")
        self.assertEqual(self.edit(self.service, unit="قدیمی")[0], 422)
        self.assertEqual(self.request("POST", "/orders", self.payload(payments=[]))[0], 422)
        self.assertEqual(self.edit(updated, unit="بسته")[0], 200)
        self.toggle("ساعت")
        self.toggle("بسته")
        self.toggle("عدد")
        self.assertEqual(self.request("GET", "/products?for_order=true")[1], [])
        self.assertEqual(self.request("POST", "/products", {"name": "جدید", "unit": "بسته", "price": 0})[0], 422)

    def test_used_unit_cannot_be_renamed_but_can_be_disabled(self):
        u = self.unit()
        self.assertEqual(self.request("PUT", f'/settings/inventory-options/units/{u["id"]}', {"name": "نام جدید"})[0], 409)
        self.toggle()
        # Even when only invoice history references a unit, its name is stable.
        self.toggle(active=True)
        self.post("/orders", self.payload(payments=[]))
        p = next(p for p in self.request("GET", "/products")[1] if p["id"] == self.product["id"])
        self.assertEqual(self.edit(p, unit="بسته")[0], 200)
        self.assertEqual(self.request("PUT", f'/settings/inventory-options/units/{u["id"]}', {"name": "نام جدید"})[0], 409)
        unused = self.post("/settings/inventory-options/units", {"name": "بدون سابقه"})
        self.assertEqual(self.request("PUT", f'/settings/inventory-options/units/{unused["id"]}', {"name": "نام جدید"})[0], 200)

    def test_adopted_legacy_catalog_spelling_can_be_toggled_and_selected(self):
        name = "  رول قديمي  "
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO inventory_options (kind,name,active) VALUES ('units',?,1)", (name,))
        product = self.post("/products", {"name": "واحد قدیمی", "unit": name, "price": 1})
        self.assertEqual(product["unit"], name)
        disabled = self.toggle(name)
        self.assertEqual(disabled["name"], name)
        self.assertEqual(self.request("POST", "/products", {"name": "غیرفعال", "unit": name, "price": 1})[0], 422)
        self.assertEqual(self.edit(product, price=2)[0], 200)
        self.toggle(name, active=True)
        self.assertIn(product["id"], [p["id"] for p in self.request("GET", "/products?for_order=true")[1]])


if __name__ == "__main__":
    unittest.main()
