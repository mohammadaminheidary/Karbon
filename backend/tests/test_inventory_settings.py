"""Authenticated inventory reference-list checks against a disposable database."""
from contextlib import closing
import sqlite3
import unittest
import test_customers as customer_tests


class InventorySettingsTests(unittest.TestCase):
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM inventory_options")

    def test_settings_round_trip_normalization_and_kind_isolation(self):
        self.assertEqual(self.request("GET", "/settings/inventory-options")[1], {"categories": [], "units": []})
        status, category = self.request("POST", "/settings/inventory-options/categories", {"name": "  مواد  اوليه  "})
        self.assertEqual(status, 201)
        self.assertEqual(category["name"], "مواد اولیه")
        status, unit = self.request("POST", "/settings/inventory-options/units", {"name": "متر"})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("POST", "/settings/inventory-options/units", {"name": "متر"})[0], 409)
        # Identical names in different lists are allowed.
        self.assertEqual(self.request("POST", "/settings/inventory-options/categories", {"name": "متر"})[0], 201)
        self.assertEqual(self.request("PUT", f'/settings/inventory-options/units/{category["id"]}', {"name": "test"})[0], 404)
        status, updated = self.request("PUT", f'/settings/inventory-options/units/{unit["id"]}', {"name": "متر", "active": False})
        self.assertEqual(status, 200)
        self.assertFalse(updated["active"])
        self.assertEqual(self.request("GET", "/settings/inventory-options")[1]["units"], [updated])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT name, active FROM inventory_options WHERE id=?", (unit["id"],)).fetchone(), ("متر", 0))

    def test_authentication_validation_and_no_purchase_processing(self):
        for method, path, body in [
            ("GET", "/settings/inventory-options", None),
            ("POST", "/settings/inventory-options/units", {"name": "عدد"}),
            ("PUT", "/settings/inventory-options/units/1", {"name": "عدد"}),
        ]:
            self.assertEqual(self.request(method, path, body, authenticated=False)[0], 401)
        for name in ["", "   ", "x" * 81]:
            self.assertEqual(self.request("POST", "/settings/inventory-options/units", {"name": name})[0], 422)
        self.assertEqual(self.request("POST", "/settings/inventory-options/wrong", {"name": "x"})[0], 422)
        self.assertEqual(self.request("POST", "/settings/inventory-options/units", {"name": "x", "active": "false"})[0], 422)
        self.assertEqual(self.request("POST", "/settings/inventory-options/units", {"name": "x", "stock": 4})[0], 422)


if __name__ == "__main__":
    unittest.main()
