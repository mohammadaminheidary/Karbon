"""Reconcile customer receipts through the authenticated Finance API."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
import unittest
from uuid import uuid4

import test_orders as order_tests
from test_finance import bank_payload


class CustomerReceiptTests(unittest.TestCase):
    setUpClass = classmethod(order_tests.OrdersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(order_tests.OrdersIntegrationTests.tearDownClass.__func__)
    setUp = order_tests.OrdersIntegrationTests.setUp
    request = classmethod(order_tests.OrdersIntegrationTests.request.__func__)
    post = order_tests.OrdersIntegrationTests.post
    payload = order_tests.OrdersIntegrationTests.payload

    def get(self, path):
        status, response = self.request("GET", path)
        self.assertEqual(status, 200, response)
        return response

    def invoice(self, total=1000, paid=0, **fields):
        payments = [{"method": "cash", "amount": paid}] if paid else []
        return self.post("/orders", self.payload(
            items=[{"product_id": self.service["id"], "quantity": 1, "unit_price": total}],
            discount=0, payments=payments, **fields,
        ))

    def receipt(self, amount, **fields):
        return {"request_id": str(uuid4()), "kind": "income", "bank_id": self.bank["id"],
                "customer_id": self.customer["id"], "amount": amount,
                "transaction_date": "1405/07/24", "time_mode": "auto", **fields}

    def outstanding(self, invoice):
        return self.get(f'/orders/{invoice["id"]}')["remaining"]

    def test_income_payment_methods_persist_and_use_the_correct_accounts(self):
        order = self.invoice()
        customer_path = f'/customers/{self.customer["id"]}'
        path = "/finance/transactions"
        cash_body = self.receipt(100, payment_method="cash", bank_id=None)
        cash = self.post(path, cash_body)
        self.assertTrue(cash["bank"]["is_cash"])
        self.assertEqual(self.post(path, cash_body)["id"], cash["id"])

        pos_body = self.receipt(100, payment_method="pos")
        pos = self.post(path, pos_body)
        transfer = self.post(path, self.receipt(100, payment_method="transfer"))
        self.assertEqual(self.request("POST", path, {**pos_body, "payment_method": "transfer"})[0], 409)
        for bad in [self.receipt(100, payment_method="cash"),
                    self.receipt(100, payment_method="pos", bank_id=cash["bank_id"]),
                    self.receipt(100, payment_method="cheque")]:
            self.assertEqual(self.request("POST", path, bad)[0], 422)

        edit = {key: value for key, value in pos_body.items() if key not in {"request_id", "payment_method"}}
        status, edited = self.request("PUT", f'{path}/{pos["id"]}', {**edit, "description": "رسید مشتری"})
        self.assertEqual(status, 200, edited)
        self.assertEqual(edited["payment_method"], "pos")

        expected = {cash["id"]: "cash", pos["id"]: "pos", transfer["id"]: "transfer"}
        day = self.get("/finance/day?date=2026-10-16")
        self.assertEqual({row["id"]: row["payment_method"] for row in day["transactions"]}, expected)
        history = self.get(customer_path + "/payments")
        self.assertEqual({row["id"]: row["method"] for row in history["items"]}, expected)
        self.assertEqual(history["summary"], {"invoiced": 1000, "paid": 300, "outstanding": 700, "credit": 0})
        self.assertEqual(self.outstanding(order), 700)

    def test_partial_invoice_then_finance_receipt_settles_every_live_view(self):
        order = self.invoice(paid=500)
        path = f'/orders/{order["id"]}'
        issued = self.get(path + "/invoice")
        self.assertEqual((order["total"], order["paid"], order["remaining"]), (1000, 500, 500))
        customer_path = f'/customers/{self.customer["id"]}'
        self.assertEqual(self.get(customer_path)["summary"]["debt"], 500)

        receipt = self.post("/finance/transactions", self.receipt(500))
        category = self.post("/settings/expense-categories", {"title": "هزینه آزمایشی"})
        expense = {k: v for k, v in self.receipt(125).items() if k != "customer_id"}
        self.post("/finance/transactions", {**expense, "kind": "expense", "expense_category_id": category["id"]})
        details = self.get(path)
        self.assertEqual((details["paid"], details["remaining"], details["payment_status"]), (1000, 0, "settled"))
        self.assertEqual({p["transaction_id"]: p["amount"] for p in details["payments"]},
                         {order["payments"][0]["transaction_id"]: 500, receipt["id"]: 500})
        self.assertEqual(self.get(path + "/invoice"), issued)
        preview = self.get(path + "/invoice?include_balance=true")
        self.assertEqual(preview.pop("current_balance"), {"paid": 1000, "remaining": 0})
        self.assertEqual(preview, issued)
        summary = self.get(customer_path)["summary"]
        self.assertEqual((summary["paid"], summary["debt"], summary["status"]), (1000, 0, "settled"))
        self.assertEqual(self.get("/customers")["items"][0]["summary"], summary)
        history = self.get(customer_path + "/payments")
        self.assertEqual(history["summary"], {"invoiced": 1000, "paid": 1000, "outstanding": 0, "credit": 0})
        self.assertEqual([(row["id"], row["amount"], row["method"]) for row in history["items"]],
                         [(receipt["id"], 500, "bank"), (order["payments"][0]["transaction_id"], 500, "cash")])
        for payment in history["items"]:
            self.assertEqual([(a["invoice_code"], a["remaining"]) for a in payment["invoices"]],
                             [(order["invoice_code"], 0)])
        invoices = self.get(customer_path + "/invoices")
        self.assertEqual(invoices, {"items": [{"id": order["id"], "invoice_code": order["invoice_code"],
                                              "invoice_date": order["invoice_date"], "total": 1000,
                                              "paid": 1000, "remaining": 0}], "next_skip": None})
        for listing in ("/orders", "/settings/invoices"):
            self.assertEqual(self.get(listing)["items"][0]["remaining"], 0)

        day = self.get("/finance/day?date=2026-10-16")
        bank = self.get(f'/banks/{self.bank["id"]}/transactions')
        for rows in (day["transactions"], bank["items"]):
            posted = next(item for item in rows if item["id"] == receipt["id"])
            self.assertEqual(posted["customer_id"], self.customer["id"])
            self.assertEqual([(a["order_id"], a["amount"], a["remaining"]) for a in posted["invoice_allocations"]],
                             [(order["id"], 500, 0)])
        self.assertEqual(day["summary"], {"income": 500, "expense": 125, "balance": 375})
        self.assertEqual(sum(account["balance"] for account in self.get("/banks")), 875)
        dashboard = self.get("/dashboard?start_date=2026-10-14&end_date=2026-10-16")
        self.assertEqual((dashboard["orders"]["outstanding"], dashboard["customers"]["debtor_count"]), ("0", 0))
        self.assertEqual((dashboard["finance"]["income"], dashboard["finance"]["expense"], dashboard["banks"]["balance"]),
                         ("1000", "125", "875"))

        status, report = self.request("POST", "/reports/orders/preview", {
            "columns": ["balance.total", "balance.paid", "balance.remaining"],
            "filters": [{"field": "balance.remaining", "op": "eq", "value": 0}],
        })
        self.assertEqual(status, 200, report)
        self.assertEqual(report["items"], [{"id": order["id"], "values": {
            "balance.total": 1000, "balance.paid": 1000, "balance.remaining": 0,
        }}])

    def test_partial_receipts_split_by_invoice_and_edits_and_deletion_reassign_balances(self):
        first = self.invoice(paid=500)
        second = self.invoice(500, invoice_date="1405/07/23")
        other = self.post("/customers", {"first_name": "مشتری", "last_name": "دوم"})
        other_order = self.invoice(700, customer_id=other["id"])
        self.post("/finance/transactions", self.receipt(150))
        self.assertEqual(self.outstanding(first), 350)
        self.post("/finance/transactions", self.receipt(100, customer_id=other["id"]))
        body = self.receipt(500)
        receipt = self.post("/finance/transactions", body)
        self.assertEqual([(a["order_id"], a["amount"]) for a in receipt["invoice_allocations"]],
                         [(first["id"], 350), (second["id"], 150)])
        history_path = f'/customers/{self.customer["id"]}/payments'
        history = self.get(history_path)
        entries = [item for item in history["items"] if item["id"] == receipt["id"]]
        self.assertEqual(len(entries), 1)
        invoices_path = f'/customers/{self.customer["id"]}/invoices?limit=1'
        newest = self.get(invoices_path)
        self.assertEqual((newest["items"][0]["id"], newest["next_skip"]), (second["id"], 1))
        oldest = self.get(invoices_path + "&skip=1")
        self.assertEqual((oldest["items"][0]["id"], oldest["next_skip"]), (first["id"], None))
        self.assertEqual([(a["order_id"], a["amount"]) for a in entries[0]["invoices"]],
                         [(first["id"], 350), (second["id"], 150)])
        self.assertEqual([self.outstanding(o) for o in (first, second, other_order)], [0, 350, 600])
        self.assertEqual(sum(tx["amount"] for tx in self.get(f'/banks/{self.bank["id"]}/transactions')["items"]), 750)

        second_bank = self.post("/banks", bank_payload(2))
        body.pop("request_id")
        path = f'/finance/transactions/{receipt["id"]}'
        status, edited = self.request("PUT", path, {**body, "customer_id": other["id"],
                                                  "bank_id": second_bank["id"], "amount": 250})
        self.assertEqual(status, 200, edited)
        self.assertNotIn(receipt["id"], [row["id"] for row in self.get(history_path)["items"]])
        other_history_path = f'/customers/{other["id"]}/payments'
        other_history = self.get(other_history_path)
        self.assertIn((receipt["id"], 250), [(row["id"], row["amount"]) for row in other_history["items"]])
        self.assertEqual(other_history["summary"]["paid"], 350)
        self.assertEqual([self.outstanding(o) for o in (first, second, other_order)], [350, 500, 350])
        balances = {row["id"]: row["balance"] for row in self.get("/banks")}
        self.assertEqual((balances[self.bank["id"]], balances[second_bank["id"]]), (250, 250))

        result = self.request("DELETE", path, {"password": "test-password", "confirmed": True})
        self.assertEqual(result[0], 200, result[1])
        other_history = self.get(other_history_path)
        self.assertNotIn(receipt["id"], [row["id"] for row in other_history["items"]])
        self.assertEqual(other_history["summary"]["paid"], 100)
        self.assertEqual(self.outstanding(other_order), 600)
        self.assertEqual(self.get(f'/banks/{second_bank["id"]}/transactions')["total"], 0)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT customer_id, amount, deleted_at IS NOT NULL FROM financial_transactions WHERE id=?",
                                        (receipt["id"],)).fetchone(), (other["id"], 250, 1))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_concurrent_retries_and_duplicate_bank_reference_count_once(self):
        order = self.invoice(paid=500)
        body = self.receipt(200, tracking_number="۰۰۱۲۳")
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/finance/transactions", body), range(4)))
        self.assertEqual({status for status, _ in results}, {201})
        self.assertEqual(len({row["id"] for _, row in results}), 1)
        status, duplicate = self.request("POST", "/finance/transactions", self.receipt(200, tracking_number="00123"))
        self.assertEqual(status, 409, duplicate)
        self.assertEqual(duplicate["detail"]["code"], "DUPLICATE_RECEIPT_REFERENCE")
        self.assertEqual(self.outstanding(order), 300)
        self.assertEqual(self.get("/finance/day?date=2026-10-16")["summary"]["income"], 200)

    def test_history_pages_keep_totals_and_credit_independent_of_page_size(self):
        invoice = self.invoice(15)
        other = self.post("/customers", {"first_name": "خریدار", "last_name": "دیگر"})
        self.post("/finance/transactions", self.receipt(90, customer_id=other["id"]))
        receipts = [self.post("/finance/transactions", self.receipt(2, time_mode="manual", hour=10, minute=0))
                    for _ in range(16)]
        path = f'/customers/{self.customer["id"]}/payments'
        first = self.get(path)
        self.assertEqual(first["summary"], {"invoiced": 15, "paid": 32, "outstanding": 0, "credit": 17})
        self.assertEqual(first["items"][0]["status"], "unallocated")
        partial = next(row for row in first["items"] if row["id"] == receipts[7]["id"])
        self.assertEqual((partial["status"], partial["unallocated"], partial["invoices"][0]["order_id"],
                          partial["invoices"][0]["amount"]), ("partially_allocated", 1, invoice["id"], 1))
        self.assertEqual(len(first["items"]), 15)
        backdated = self.post("/finance/transactions", self.receipt(2, transaction_date="1405/07/23"))
        second = self.get(path + "?cursor=" + first["next_cursor"])
        self.assertIsNone(second["next_cursor"])
        self.assertNotIn("summary", second)
        self.assertEqual([row["id"] for row in first["items"] + second["items"]],
                         [row["id"] for row in reversed(receipts)])
        refreshed = self.get(path)
        self.assertEqual((refreshed["summary"]["paid"], refreshed["summary"]["credit"]), (34, 19))
        refreshed_second = self.get(path + "?cursor=" + refreshed["next_cursor"])
        self.assertEqual([row["id"] for row in refreshed_second["items"]], [receipts[0]["id"], backdated["id"]])
        self.assertEqual(self.request("GET", path + "?cursor=invalid")[0], 422)
        self.assertEqual(self.request("GET", "/customers/999999/payments")[0], 404)
        self.assertEqual(self.request("GET", path, authenticated=False)[0], 401)
