"""Dashboard accuracy checks against the real API and a disposable database."""
from contextlib import closing
import sqlite3
import unittest
from uuid import uuid4

import test_customers as customers
import test_orders as orders


class DashboardIntegrationTests(unittest.TestCase):
    setUpClass = classmethod(customers.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customers.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customers.CustomersIntegrationTests.request.__func__)
    post = orders.OrdersIntegrationTests.post
    payload = orders.OrdersIntegrationTests.payload
    confirmation = {"password": "test-password", "confirmed": True}

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ["order_payments", "order_items", "orders", "financial_transactions", "documents", "document_accounts", "expense_categories", "attendance", "members", "tasks"]:
                db.execute(f"DELETE FROM {table}")
        orders.OrdersIntegrationTests.setUp(self)

    def report(self, start="2026-10-14", end="2026-10-15"):
        status, data = self.request("GET", f"/dashboard?start_date={start}&end_date={end}")
        self.assertEqual(status, 200, data)
        return data

    def transaction(self, amount, day="1405/07/23", kind="income"):
        payload = {"request_id": str(uuid4()), "bank_id": self.bank["id"], "kind": kind, "amount": amount, "transaction_date": day}
        if kind == "income":
            payload["customer_id"] = self.customer["id"]
        else:
            category = self.post("/settings/expense-categories", {"title": "مواد اولیه"})
            payload["expense_category_id"] = category["id"]
        return self.post("/finance/transactions", payload)

    def test_empty_dates_validation_and_auth(self):
        d = self.report()
        self.assertEqual(d["finance"], {"income": "0", "expense": "0", "net": "0", "transactions": 0})
        self.assertEqual(d["inventory"]["value"], "10000")
        self.assertEqual(d["inventory"]["services"], 1)
        self.assertEqual(len(d["daily"]), 2)
        self.assertEqual(d["period"]["previous_start"], "2026-10-12")
        self.assertEqual(d["attendance"]["present"], 0)
        self.assertEqual(self.request("GET", "/dashboard", authenticated=False)[0], 401)
        for query in ["start_date=bad", "start_date=2026-10-15&end_date=2026-10-14", "start_date=2020-01-01&end_date=2026-10-15", "start_date=0001-01-01&end_date=0001-01-02", "end_date=0001-01-01"]:
            self.assertEqual(self.request("GET", "/dashboard?" + query)[0], 422)
        self.assertEqual(len(self.report("2024-01-01", "2024-12-31")["daily"]), 366)
        self.assertEqual(len(self.request("GET", "/dashboard")[1]["daily"]), 30)
        self.assertEqual(len(self.request("GET", "/dashboard?days=7")[1]["daily"]), 7)
        self.assertEqual(self.request("GET", "/dashboard?days=367")[0], 422)

    def test_invoices_receipts_discounts_debt_and_inventory_reconcile(self):
        order = self.post("/orders", self.payload(payments=[{"method": "cash", "amount": 600}]))
        self.transaction(70)
        self.transaction(300, kind="expense")
        self.transaction(100, day="1405/07/20")
        d = self.report()
        self.assertEqual(d["finance"], {"income": "670", "expense": "300", "net": "370", "transactions": 3})
        self.assertEqual(d["previous"]["income"], "100")
        self.assertEqual((d["orders"]["sales"], d["orders"]["discount"], d["orders"]["outstanding"]), ("2000", "500", "1400"))
        self.assertEqual(d["customers"]["debtors"][0]["amount"], "1400")
        self.assertEqual(d["inventory"]["value"], "8000")
        self.assertEqual(sum(int(row["gross"]) for row in d["product_sales"]), 2500)
        self.assertEqual(sum(int(row["income"]) for row in d["daily"]), 670)
        self.assertEqual(sum(int(row["sales"]) for row in d["daily"]), 2000)
        self.assertEqual(sum(int(row["amount"]) for row in d["expenses"]), 300)
        actual = self.request("GET", "/banks")[1]
        self.assertEqual(int(d["banks"]["balance"]), sum(row["balance"] for row in actual))
        summary = self.request("GET", f'/customers/{self.customer["id"]}')[1]["summary"]
        self.assertEqual(int(d["orders"]["outstanding"]), summary["debt"])
        self.request("POST", f'/orders/{order["id"]}/complete')
        d = self.report()
        self.assertEqual((d["orders"]["active_total"], d["orders"]["completed"]), (0, 1))

    def test_document_income_expense_once_and_deletion_propagates(self):
        ia = self.post("/settings/document-accounts", {"title": "درآمد سند", "kind": "income"})
        ea = self.post("/settings/document-accounts", {"title": "هزینه سند", "kind": "expense"})
        doc = self.post("/documents", {"request_id": str(uuid4()), "date": "2026-10-15", "rows": [
            {"kind": "income", "bank_id": self.bank["id"], "document_account_id": ia["id"], "amount": 500},
            {"kind": "expense", "bank_id": self.bank["id"], "document_account_id": ea["id"], "amount": 125},
        ]})
        d = self.report()
        self.assertEqual(d["finance"], {"income": "500", "expense": "125", "net": "375", "transactions": 2})
        self.assertEqual(d["documents"]["total"], 1)
        self.assertEqual(d["expenses"][0]["name"], "هزینه سند")
        self.assertEqual(d["orders"]["sales"], "0")
        self.assertEqual(self.request("DELETE", f'/documents/{doc["id"]}', self.confirmation)[0], 200)
        d = self.report()
        self.assertEqual((d["finance"]["income"], d["finance"]["expense"], d["documents"]["total"]), ("0", "0", 0))

    def test_deleted_invoice_and_ledger_rows_do_not_contribute(self):
        order = self.post("/orders", self.payload())
        ordinary = self.transaction(33)
        self.assertEqual(self.request("DELETE", f'/orders/{order["id"]}/invoice', self.confirmation)[0], 200)
        d = self.report()
        self.assertEqual((d["orders"]["total"], d["orders"]["sales"], d["orders"]["outstanding"]), (0, "0", "0"))
        self.assertEqual(d["finance"]["income"], "33")
        self.assertEqual(d["inventory"]["value"], "10000")
        self.assertEqual(d["product_sales"], [])
        self.request("DELETE", f'/finance/transactions/{ordinary["id"]}', self.confirmation)
        self.assertEqual(self.report()["finance"]["income"], "0")

    def test_operational_dates_and_timezone_not_unrecorded_absences(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE customers SET created_at='2026-10-13 21:00:00'")  # 14th in Tehran
            db.execute("INSERT INTO members(first_name,last_name,created_at,updated_at) VALUES('عضو','اول',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            mid = db.execute("SELECT id FROM members").fetchone()[0]
            for day, status in [("2026-10-14", "present"), ("2026-10-13", "absent")]:
                db.execute("INSERT INTO attendance(member_id,date,status,recorded_time,created_at,updated_at) VALUES(?,?,?,'09:00:00',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", (mid, day, status))
            for day, status in [("2026-10-14", "todo"), ("2026-10-15", "completed"), ("2026-10-12", "completed")]:
                db.execute("INSERT INTO tasks(date,title,description,status,created_at) VALUES(?,'کار','',?,CURRENT_TIMESTAMP)", (day, status))
        d = self.report()
        self.assertEqual((d["customers"]["new"], d["previous"]["customers"]), (1, 0))
        self.assertEqual((d["tasks"]["total"], d["tasks"]["completed"], d["previous"]["tasks_completed"]), (2, 1, 1))
        self.assertEqual((d["attendance"]["present"], d["attendance"]["absent"], d["previous"]["absent"]), (1, 0, 1))
        self.assertEqual((d["daily"][0]["present"], d["daily"][1]["present"]), (1, 0))

    def test_inventory_values_stay_exact_and_no_history_is_invented(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET stock=1000001,price=999999999999,active=0 WHERE id=?", (self.product["id"],))
        d = self.report()
        expected = str(1000001 * 999999999999)
        self.assertEqual(d["inventory"]["value"], expected)
        self.assertEqual(d["inventory"]["products"][0]["value"], expected)
        self.assertEqual(d["inventory"], self.report("2025-01-01", "2025-01-02")["inventory"])
        self.assertNotIn("history", d["inventory"])
        self.assertTrue(all("inventory" not in point for point in d["daily"]))

    def test_totals_not_limited_by_existing_page_size(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for i in range(125):
                db.execute("INSERT INTO financial_transactions(request_id,kind,customer_id,bank_id,title,account_code,amount,transaction_date,transaction_time,time_mode,created_at) VALUES(?,'income',?,?,'مبلغ','1001',7,'2026-10-14','09:00:00','manual',CURRENT_TIMESTAMP)", (str(uuid4()), self.customer["id"], self.bank["id"]))
        d = self.report()
        self.assertEqual((d["finance"]["income"], d["finance"]["transactions"]), ("875", 125))


if __name__ == "__main__":
    unittest.main()
