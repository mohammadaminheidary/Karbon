"""Invoice deletion reverses its ledger and inventory atomically."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
from urllib.parse import quote
from uuid import uuid4

import test_orders as order_tests
from test_finance import bank_payload


class InvoiceDeletionTests(unittest.TestCase):
    setUpClass = classmethod(order_tests.OrdersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(order_tests.OrdersIntegrationTests.tearDownClass.__func__)
    request = classmethod(order_tests.OrdersIntegrationTests.request.__func__)
    setUp = order_tests.OrdersIntegrationTests.setUp
    post = order_tests.OrdersIntegrationTests.post
    payload = order_tests.OrdersIntegrationTests.payload

    def remove(self, order_id, **changes):
        return self.request("DELETE", f"/orders/{order_id}/invoice", {
            "password": "test-password", "confirmed": True, **changes,
        })

    def test_delete_mixed_receipts_preserves_other_invoices_and_recalculates_every_view(self):
        other_bank = self.post("/banks", bank_payload(2))
        order = self.post("/orders", self.payload(payments=[
            {"method": "cash", "amount": 500},
            {"method": "pos", "bank_id": self.bank["id"], "amount": 900},
            {"method": "transfer", "bank_id": other_bank["id"], "amount": 600},
        ]))
        survivor = self.post("/orders", self.payload(payments=[{"method": "cash", "amount": 600}]))
        snapshot = self.request("GET", f'/orders/{survivor["id"]}/invoice')[1]
        unrelated = self.post("/finance/transactions", {
            "request_id": str(uuid4()), "kind": "income", "bank_id": self.bank["id"],
            "customer_id": self.customer["id"], "amount": 777, "transaction_date": "1405/07/23", "time_mode": "auto",
        })
        self.assertEqual(self.request("POST", f'/orders/{order["id"]}/complete', {})[0], 200)
        self.assertEqual(self.remove(order["id"])[0], 200)
        for suffix in ["", "/invoice"]:
            self.assertEqual(self.request("GET", f'/orders/{order["id"]}{suffix}')[0], 404)
        self.assertEqual(self.request("POST", f'/orders/{order["id"]}/complete', {})[0], 404)
        self.assertEqual(self.request("GET", f'/orders/{survivor["id"]}/invoice')[1], snapshot)
        orders = self.request("GET", "/orders")[1]
        self.assertEqual((orders["total_orders"], orders["active_orders"], orders["total"]), (1, 1, 1))
        self.assertEqual(self.request("GET", "/orders?status=completed")[1]["total"], 0)
        listing = self.request("GET", "/settings/invoices")[1]
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["items"][0]["id"], survivor["id"])
        summary = self.request("GET", f'/customers/{self.customer["id"]}')[1]["summary"]
        self.assertEqual((summary["order_count"], summary["total_orders"], summary["paid"], summary["debt"]), (1, 2000, 600, 1400))
        customers = self.request("GET", "/customers")[1]
        self.assertEqual((customers["unsettled_customers"], customers["settled_customers"]), (1, 0))
        day = self.request("GET", "/finance/day?date=2026-10-15")[1]
        self.assertEqual(day["summary"]["income"], 1377)
        self.assertEqual({row["id"] for row in day["transactions"]}, {unrelated["id"], survivor["payments"][0]["transaction_id"]})
        banks = self.request("GET", "/banks")[1]
        self.assertEqual(sum(bank["balance"] - bank["opening_balance"] for bank in banks), 1377)
        for bank in banks:
            activity = self.request("GET", f'/banks/{bank["id"]}/activity?period=month&anchor=1405/07/23')[1]
            ledger = self.request("GET", f'/banks/{bank["id"]}/transactions')[1]
            self.assertEqual(activity["summary"]["income"], sum(row["amount"] for row in ledger["items"]))
        calendar = self.request("GET", "/finance/calendar?start_date=2026-10-15&end_date=2026-10-15")[1]
        self.assertEqual(calendar, [{"date": "2026-10-15", "income": 1377, "expense": 0, "balance": 1377}])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?", (self.product["id"],)).fetchone()[0], 8)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions WHERE deleted_at IS NOT NULL").fetchone()[0], 3)
            numbers = db.execute("SELECT transaction_number FROM financial_transactions WHERE deleted_at IS NULL ORDER BY id").fetchall()
            self.assertEqual(numbers, [(1,), (2,)])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_auth_confirmation_wrong_password_and_missing_invoice_do_not_change_data(self):
        order = self.post("/orders", self.payload())
        path = f'/orders/{order["id"]}/invoice'
        self.assertEqual(self.request("GET", "/settings/invoices", authenticated=False)[0], 401)
        self.assertEqual(self.request("DELETE", path, {"password": "test-password", "confirmed": True}, authenticated=False)[0], 401)
        self.assertEqual(self.remove(order["id"], confirmed=False)[0], 422)
        self.assertEqual(self.remove(order["id"], password="wrong")[0], 403)
        self.assertEqual(self.remove(999999)[0], 404)
        self.assertEqual(self.request("GET", path)[0], 200)
        self.assertEqual(self.request("GET", "/finance/day?date=2026-10-15")[1]["summary"]["income"], 2000)

    def test_concurrent_delete_is_idempotent_and_stale_create_cannot_resurrect_invoice(self):
        payload = self.payload()
        order = self.post("/orders", payload)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.remove(order["id"]), range(2)))
        self.assertEqual([result[0] for result in results], [200, 200])
        self.assertEqual(self.request("POST", "/orders", payload)[0], 409)
        summary = self.request("GET", f'/customers/{self.customer["id"]}')[1]["summary"]
        self.assertEqual((summary["order_count"], summary["paid"], summary["debt"], summary["status"]), (0, 0, 0, "no_payment"))
        self.assertEqual(self.request("GET", "/settings/invoices")[1]["total"], 0)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?", (self.product["id"],)).fetchone()[0], 10)
        self.assertEqual(self.request("DELETE", f'/customers/{self.customer["id"]}')[0], 204)

    def test_unpaid_invoice_and_service_only_invoice_can_be_removed(self):
        order = self.post("/orders", self.payload(payments=[]))
        self.assertEqual(self.remove(order["id"])[0], 200)
        self.assertEqual(self.request("DELETE", f'/customers/{self.customer["id"]}')[0], 204)
        client = self.post("/customers", {"first_name": "جدید", "last_name": "آزمایشی"})
        free = self.post("/orders", self.payload(customer_id=client["id"], items=[{"product_id": self.service["id"], "quantity": 1, "unit_price": 500}], discount=500, payments=[]))
        self.assertEqual(self.remove(free["id"])[0], 200)
        products = self.request("GET", "/products")[1]
        self.assertIsNone(next(row for row in products if row["id"] == self.service["id"])["stock"])

    def test_failure_rolls_back_receipts_stock_and_invoice_and_listing_search_paginates(self):
        order = self.post("/orders", self.payload())
        for _ in range(3):
            self.post("/orders", self.payload(payments=[]))
        pages = [self.request("GET", f"/settings/invoices?skip={skip}&limit=2")[1] for skip in (0, 2)]
        self.assertTrue(all(page["total"] == 4 for page in pages))
        self.assertEqual(len({row["id"] for page in pages for row in page["items"]}), 4)
        for search, expected in [(order["invoice_code"], 1), ("علی", 4), ("۱۰۰۱", 4), ("%", 0)]:
            self.assertEqual(self.request("GET", "/settings/invoices?search=" + quote(search))[1]["total"], expected)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("CREATE TRIGGER fail_invoice_delete BEFORE UPDATE OF deleted_at ON orders BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
            before_stock = db.execute("SELECT stock FROM products WHERE id=?", (self.product["id"],)).fetchone()[0]
        self.assertEqual(self.remove(order["id"])[0], 409)
        self.assertEqual(self.request("GET", f'/orders/{order["id"]}/invoice')[0], 200)
        self.assertEqual(self.request("GET", "/finance/day?date=2026-10-15")[1]["summary"]["income"], 2000)
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?", (self.product["id"],)).fetchone()[0], before_stock)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions WHERE deleted_at IS NOT NULL").fetchone()[0], 0)
            db.execute("DROP TRIGGER fail_invoice_delete")
