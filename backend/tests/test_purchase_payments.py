"""Exercise warehouse payments through the authenticated API and shared ledger."""
import concurrent.futures
import sqlite3
import unittest
from contextlib import closing
from uuid import uuid4

import test_customers
from test_finance import bank_payload

DAY = "1405/08/09"
ISO_DAY = "2026-10-31"
DELETE = {"password": "test-password", "confirmed": True}


class PurchasePaymentTests(unittest.TestCase):
    start_server = classmethod(test_customers.CustomersIntegrationTests.setUpClass.__func__)
    stop_server = classmethod(test_customers.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(test_customers.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        self.start_server()
        self.addCleanup(self.stop_server)
        banks = [self.post("/banks", bank_payload(i, opening_balance=10000)) for i in (1, 2)]
        self.bank, self.second_bank = [bank["id"] for bank in banks]
        options = self.get("/settings/inventory-options")
        self.category = options["warehouse-categories"][0]["id"]
        self.product = self.post("/inventory/products", {"name": "قطعه انبار", "unit": "عدد", "price": 100,
                                                           "warehouse_category_id": self.category})["id"]

    def call(self, method, path, body=None, expected=200):
        status, data = self.request(method, path, body)
        if status >= 500:
            self.log.seek(0)
            self.fail(self.log.read())
        self.assertEqual(status, expected, data)
        return data

    def post(self, path, body):
        return self.call("POST", path, body, 201)

    def get(self, path):
        return self.call("GET", path)

    def purchase(self, **changes):
        return {"request_id": str(uuid4()), "purchase_date": DAY, "product_id": self.product,
                "category_id": self.category, "quantity": 3, "purchase_price": 700, "discount": 100, **changes}

    def payment(self, amount, **changes):
        return {"request_id": str(uuid4()), "method": "transfer", "bank_id": self.bank, "amount": amount,
                "transaction_date": DAY, **changes}

    def balances(self):
        return [bank["balance"] for bank in self.get("/banks") if bank["id"] in (self.bank, self.second_bank)]

    def stock(self):
        return next(item["stock"] for item in self.get("/inventory/products") if item["id"] == self.product)

    def test_payment_lifecycle_in_warehouse_dashboard_banks_and_reports(self):
        unpaid = self.post("/purchases", self.purchase())
        self.assertEqual((unpaid["subtotal"], unpaid["paid"], unpaid["remaining"], unpaid["payment_status"]),
                         (2100, 0, 2000, "unpaid"))
        self.assertEqual(self.balances(), [10000, 10000])
        self.assertEqual(self.stock(), 3)
        self.assertEqual(self.get("/purchases/obligations")["items"][0]["id"], unpaid["id"])
        supplier = self.post("/customers", {"first_name": "تأمین‌کننده", "last_name": "قطعات"})
        body = self.purchase(supplier_id=supplier["id"], payments=[
            self.payment(400, tracking_number="014"), self.payment(500, bank_id=self.second_bank),
        ])
        receipt = self.post("/purchases", body)
        self.assertEqual((receipt["paid"], receipt["remaining"], receipt["payment_status"]), (900, 1100, "partial"))
        self.assertEqual(self.post("/purchases", body), receipt)
        self.assertEqual(self.stock(), 6)
        self.assertEqual(self.balances(), [9600, 9500])
        path = f'/purchases/{receipt["id"]}'
        summary = self.get(f"/dashboard?start_date={ISO_DAY}&end_date={ISO_DAY}")
        self.assertEqual(summary["finance"], {"income": "0", "expense": "900", "net": "-900", "transactions": 2})
        self.assertEqual(summary["daily"][0]["expense"], "900")
        self.assertEqual((summary["orders"]["count"], summary["purchase_obligations"]["amount"]), (0, 3100))
        expenses = self.get(f"/purchases/expenses?start_date={ISO_DAY}&end_date={ISO_DAY}")
        self.assertEqual((expenses["count"], expenses["next_cursor"]), (2, None))
        self.assertEqual(sorted((row["id"], row["amount"]) for row in expenses["items"]),
                         [(receipt["id"], 400), (receipt["id"], 500)])
        obligations = self.get("/purchases/obligations")
        self.assertEqual(obligations["items"][1]["supplier_name"], "تأمین‌کننده قطعات")
        expense = self.get(f"/banks/{self.bank}/transactions")["items"][0]
        self.assertEqual((expense["kind"], expense["amount"], expense["transaction_date"]), ("expense", 400, ISO_DAY))
        self.assertEqual(expense["purchase_invoice"], {"id": receipt["id"], "invoice_number": receipt["invoice_number"]})
        ledger = self.get(f"/finance/day?date={ISO_DAY}")["transactions"]
        self.assertEqual({row["purchase_invoice"]["id"] for row in ledger}, {receipt["id"]})
        preview = self.call("POST", "/reports/financial_transactions/preview",
                            {"ids": [expense["id"]], "columns": ["kind", "purchase.id", "purchase.invoice_number"]})
        self.assertEqual(preview["items"][0]["values"]["purchase.invoice_number"], receipt["invoice_number"])
        self.call("DELETE", f'/finance/transactions/{expense["id"]}', DELETE, 409)
        rows = [{key: body[key] for key in ("category_id", "product_id", "quantity", "purchase_price")}]
        update = {"request_id": str(uuid4()), "purchase_date": DAY, "rows": rows, "discount": 200,
                  "supplier_id": supplier["id"], "revision": receipt["revision"]}
        self.call("PUT", path, {**update, "discount": 1300}, 422)
        amended = self.call("PUT", path, update)
        self.assertEqual((amended["paid"], amended["remaining"], self.balances()), (900, 1000, [9600, 9500]))
        self.call("POST", f"{path}/payments", self.payment(1001), 422)
        settlement = self.payment(1000, transaction_date="1405/08/10")
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            retries = list(pool.map(lambda _: self.request("POST", f"{path}/payments", settlement), range(4)))
        self.assertTrue(all(code == 201 for code, _ in retries), retries)
        self.assertEqual(len({data["id"] for _, data in retries}), 1)
        invoice = self.get(f"{path}/invoice")
        self.assertEqual((invoice["paid"], invoice["remaining"], invoice["payment_status"]), (1900, 0, "settled"))
        self.assertEqual(self.balances(), [8600, 9500])
        payment_path = f'{path}/payments/{retries[0][1]["id"]}'
        edit = self.payment(750, bank_id=self.second_bank, transaction_date="1405/08/10", revision=1)
        updated = self.call("PUT", payment_path, edit)
        self.assertEqual(self.call("PUT", payment_path, edit), updated)
        self.assertEqual((updated["remaining"], self.balances()), (250, [9600, 8750]))
        self.call("PUT", payment_path, {**edit, "request_id": str(uuid4())}, 409)
        self.assertEqual(self.call("DELETE", payment_path, DELETE)["remaining"], 1000)
        self.assertEqual(self.call("DELETE", payment_path, DELETE)["remaining"], 1000)
        self.assertEqual(self.balances(), [9600, 9500])
        cash = self.post(f"{path}/payments", self.payment(1000, method="cash", bank_id=None))
        self.assertEqual(cash["payment_status"], "settled")
        cash_before_cancel = next(bank for bank in self.get("/banks") if bank["is_cash"])
        self.assertEqual(cash_before_cancel["balance"], -1000)
        self.call("DELETE", path, DELETE)
        self.assertEqual(next(bank["balance"] for bank in self.get("/banks") if bank["is_cash"]), 0)
        self.assertEqual(self.balances(), [10000, 10000])
        self.assertEqual(self.stock(), 3)

    def test_second_payment_failure_rolls_back_invoice_stock_and_first_payment(self):
        first = self.payment(400, tracking_number="042")
        duplicate = self.payment(500, tracking_number="042")
        self.call("POST", "/purchases", self.purchase(payments=[first, duplicate]), 409)
        self.assertEqual(self.get("/purchases")["total"], 0)
        self.assertEqual(self.get(f"/finance/day?date={ISO_DAY}")["transactions"], [])
        self.assertEqual(self.get("/purchases/obligations")["count"], 0)
        self.assertEqual(self.stock(), 0)
        self.assertEqual(self.balances(), [10000, 10000])
        saved = self.post("/purchases", self.purchase(payments=[first]))
        self.assertEqual(saved["paid"], 400)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
