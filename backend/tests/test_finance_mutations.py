"""Money mutations, password protection and contiguous codes using disposable HTTP/SQLite."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
from urllib.parse import quote

import test_finance as finance_tests


class FinanceMutationTests(unittest.TestCase):
    setUpClass = classmethod(finance_tests.FinanceIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(finance_tests.FinanceIntegrationTests.tearDownClass.__func__)
    request = classmethod(finance_tests.FinanceIntegrationTests.request.__func__)
    setUp = finance_tests.FinanceIntegrationTests.setUp
    post = finance_tests.FinanceIntegrationTests.post
    payload = finance_tests.FinanceIntegrationTests.payload
    confirmation = {"password": "test-password", "confirmed": True}

    def day(self):
        return self.request("GET", "/finance/day?date=2026-10-06")[1]

    def edit_body(self, **changes):
        body = self.payload(**changes)
        del body["request_id"]
        return body

    def test_delete_needs_auth_password_and_explicit_confirmation(self):
        row = self.post("/finance/transactions", self.payload())
        paths = [f'/finance/transactions/{row["id"]}', f'/banks/{self.bank["id"]}', f'/settings/expense-categories/{self.category["id"]}']
        for path in paths:
            self.assertEqual(self.request("DELETE", path, self.confirmation, False)[0], 401)
            for body in [None, {"password": "test-password"}, {**self.confirmation, "confirmed": False}, {**self.confirmation, "confirmed": 1}]:
                self.assertEqual(self.request("DELETE", path, body)[0], 422, body)
            self.assertEqual(self.request("DELETE", path, {**self.confirmation, "password": "wrong"})[0], 403)
        self.assertEqual(self.day()["summary"]["income"], row["amount"])
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)

    def test_edit_updates_amount_source_bank_date_and_all_totals(self):
        row = self.post("/finance/transactions", self.payload(amount=1000))
        other = self.post("/banks", finance_tests.bank_payload(2))
        body = self.edit_body(kind="expense", customer_id=None, expense_category_id=self.category["id"], bank_id=other["id"], amount=300, hour=23, minute=59, description="اصلاح هزینه")
        status, edited = self.request("PUT", f'/finance/transactions/{row["id"]}', body)
        self.assertEqual(status, 200, edited)
        self.assertEqual((edited["id"], edited["request_id"], edited["transaction_number"]), (row["id"], row["request_id"], 1))
        self.assertEqual(edited["account_code"], self.category["account_code"])
        self.assertEqual(edited["transaction_time"], "23:59:00")
        self.assertEqual(self.day()["summary"], {"income": 0, "expense": 300, "balance": -300})
        banks = {item["id"]: item for item in self.request("GET", "/banks")[1]}
        self.assertEqual(banks[self.bank["id"]]["balance"], 1000)
        self.assertEqual(banks[other["id"]]["balance"], -300)
        self.assertEqual(self.request("GET", f'/banks/{self.bank["id"]}/transactions')[1]["total"], 0)
        body.update(transaction_date="1405/07/15", time_mode="auto", hour=None, minute=None)
        self.assertEqual(self.request("PUT", f'/finance/transactions/{row["id"]}', body)[1]["transaction_time"], "23:59:00")
        self.assertEqual(self.day()["summary"]["expense"], 0)
        self.assertEqual(self.request("GET", "/finance/calendar?start_date=2026-10-06&end_date=2026-10-07")[1][1]["expense"], 300)

    def test_edit_invalid_fields_and_deleted_record_do_not_change_money(self):
        row = self.post("/finance/transactions", self.payload(amount=1000))
        path = f'/finance/transactions/{row["id"]}'
        self.assertEqual(self.request("PUT", path, self.edit_body(), False)[0], 401)
        for change in [{"amount":0}, {"transaction_date":"1404/12/30"}, {"account_code":"fake"}]:
            self.assertEqual(self.request("PUT", path, self.edit_body(**change))[0], 422)
        self.assertEqual(self.request("PUT", path, self.edit_body(bank_id=999999))[0], 404)
        self.assertEqual(self.day()["summary"]["income"], 1000)
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0], 200)
        self.assertEqual(self.request("PUT", path, self.edit_body())[0], 404)

    def test_delete_removes_money_everywhere_and_renumbers_without_reusing_ids(self):
        rows = [self.post("/finance/transactions", self.payload(amount=value)) for value in (100,200,300)]
        path = f'/finance/transactions/{rows[1]["id"]}'
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0], 200)
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0], 200)
        day = self.day()
        self.assertEqual(day["summary"]["income"], 400)
        self.assertEqual({row["id"]:row["transaction_number"] for row in day["transactions"]}, {rows[0]["id"]:1,rows[2]["id"]:2})
        self.assertEqual(self.request("GET", f'/banks/{self.bank["id"]}/activity?period=day&anchor=1405/07/14')[1]["summary"]["income"],400)
        self.assertEqual(self.request("GET", "/banks")[1][0]["balance"], 1400)
        self.assertEqual(self.request("GET", f'/banks/{self.bank["id"]}/transactions?search=2')[1]["items"][0]["id"],rows[2]["id"])
        new = self.post("/finance/transactions", self.payload(amount=1))
        self.assertEqual(new["transaction_number"], 3)
        self.assertGreater(new["id"], rows[-1]["id"])
        self.assertEqual(self.request("POST", "/finance/transactions", {**self.payload(), "request_id":rows[1]["request_id"], "amount":200})[0],410)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_bank_delete_blocks_linked_transactions_and_disappears_from_every_endpoint(self):
        row = self.post("/finance/transactions", self.payload())
        path = f'/banks/{self.bank["id"]}'
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0],409)
        self.assertFalse(self.request("GET", "/banks")[1][0]["can_delete"])
        self.assertEqual(self.request("DELETE", f'/finance/transactions/{row["id"]}', self.confirmation)[0],200)
        self.assertTrue(self.request("GET", "/banks")[1][0]["can_delete"])
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0],200)
        self.assertEqual(self.request("GET", "/banks")[1],[])
        for suffix in ["/transactions", "/activity"]:
            self.assertEqual(self.request("GET", path+suffix)[0],404)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload())[0],404)

    def test_category_delete_closes_gap_updates_ledger_and_preserves_history(self):
        second = self.post("/settings/expense-categories", {"title":"حمل"})
        third = self.post("/settings/expense-categories", {"title":"اجاره"})
        old = self.post("/finance/transactions", self.payload("expense", expense_category_id=second["id"], amount=10))
        retained = self.post("/finance/transactions", self.payload("expense", expense_category_id=third["id"], amount=20))
        self.assertEqual(self.request("DELETE", f'/settings/expense-categories/{second["id"]}', self.confirmation)[0],200)
        categories = self.request("GET", "/settings/expense-categories")[1]
        self.assertEqual([item["account_code"] for item in categories], ["E-000001","E-000002"])
        self.assertEqual(categories[1]["id"],third["id"])
        ledger = {row["id"]:row for row in self.day()["transactions"]}
        self.assertEqual(ledger[retained["id"]]["account_code"],"E-000002")
        self.assertEqual(ledger[old["id"]]["title"],second["title"])
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload("expense", expense_category_id=second["id"]))[0],404)
        self.assertEqual(self.request("PUT", f'/finance/transactions/{old["id"]}', self.edit_body(kind="expense", expense_category_id=second["id"], amount=11))[0],200)
        self.assertEqual(self.post("/settings/expense-categories", {"title":"جدید"})["account_code"],"E-000003")
        restored = self.post("/settings/expense-categories", {"title":second["title"]})
        self.assertEqual(restored["account_code"],"E-000004")
        self.assertEqual(self.request("GET", "/settings/expense-categories")[1][-1]["id"],restored["id"])

    def test_customer_delete_closes_gap_in_customer_and_finance_views(self):
        second = self.post("/customers", {"first_name":"دو", "last_name":"آزمایش"})
        third = self.post("/customers", {"first_name":"سه", "last_name":"آزمایش"})
        row = self.post("/finance/transactions", self.payload(customer_id=third["id"]))
        self.assertEqual(self.request("DELETE", f'/customers/{second["id"]}')[0],204)
        self.assertEqual(self.request("GET", f'/customers/{third["id"]}')[1]["customer_code"],1002)
        self.assertEqual(self.day()["transactions"][0]["account_code"],"1002")
        self.assertEqual(self.day()["transactions"][0]["customer_id"],third["id"])
        self.assertEqual(self.request("GET", "/customers/next-code")[1]["customer_code"],1003)
        self.assertEqual(self.post("/customers", {"first_name":"چهار", "last_name":"آزمایش"})["customer_code"],1003)

    def test_customer_delete_explains_live_transactions_and_retains_deleted_history(self):
        middle = self.post("/customers", {"first_name":"میانه", "last_name":"آزمایش"})
        later = self.post("/customers", {"first_name":"آخر", "last_name":"آزمایش"})
        old = self.post("/finance/transactions", self.payload(customer_id=middle["id"], amount=10))
        live = self.post("/finance/transactions", self.payload(customer_id=middle["id"], amount=20))
        self.request("DELETE", f'/finance/transactions/{old["id"]}', self.confirmation)
        path = f'/customers/{middle["id"]}'
        status, data = self.request("DELETE", path)
        self.assertEqual(status,409)
        self.assertIn("1 تراکنش حذف‌نشده",data["detail"])
        self.assertIn("بخش مالی",data["detail"])
        self.assertEqual(self.request("GET",path)[0],200)
        self.request("DELETE", f'/finance/transactions/{live["id"]}', self.confirmation)
        self.assertEqual(self.request("DELETE",path)[0],204)
        self.assertEqual(self.request("GET",path)[0],404)
        self.assertEqual(self.request("PUT",path,{"first_name":"میانه","last_name":"آزمایش"})[0],404)
        self.assertEqual(self.request("GET","/customers?search=" + quote("میانه"))[1]["total"],0)
        self.assertEqual(self.request("GET",f'/customers/{later["id"]}')[1]["customer_code"],1002)
        self.assertEqual(self.request("GET","/customers/next-code")[1]["customer_code"],1003)
        new = self.post("/customers", {"first_name":"میانه", "last_name":"آزمایش"})
        self.assertEqual(new["customer_code"],1003)
        self.assertGreater(new["id"],later["id"])
        self.assertEqual(self.request("POST","/finance/transactions",self.payload(customer_id=middle["id"]))[0],404)
        self.assertEqual(self.request("POST","/finance/transactions",self.payload(request_id=old["request_id"],customer_id=new["id"]))[0],410)
        self.assertEqual(self.day()["transactions"],[])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions WHERE customer_id=?",(middle["id"],)).fetchone()[0],2)
            self.assertIsNotNone(db.execute("SELECT deleted_at FROM customers WHERE id=?",(middle["id"],)).fetchone()[0])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_concurrent_delete_and_create_keeps_contiguous_codes(self):
        second = self.post("/settings/expense-categories", {"title":"دو"})
        third = self.post("/settings/expense-categories", {"title":"سه"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.request,"DELETE", f'/settings/expense-categories/{second["id"]}',self.confirmation)]
            futures += [pool.submit(self.request,"POST","/settings/expense-categories",{"title":f"جدید {index}"}) for index in range(3)]
            results = [future.result() for future in futures]
        self.assertTrue(all(status in (200,201) for status,_ in results),results)
        codes = [item["account_code"] for item in self.request("GET","/settings/expense-categories")[1]]
        self.assertEqual(codes,[f"E-{number:06d}" for number in range(1,6)])


if __name__ == "__main__":
    unittest.main()
