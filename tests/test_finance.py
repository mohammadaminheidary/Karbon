"""Finance integration checks against real HTTP and an isolated SQLite database."""
import concurrent.futures
from contextlib import closing
from datetime import datetime
import json
import sqlite3
import unittest
import uuid
from zoneinfo import ZoneInfo

import test_customers as customer_tests


def bank_payload(index=1, **changes):
    """Generate checksum-valid identifiers solely for the disposable test DB."""
    base = f"603799{index:09d}"
    checksum = sum((int(char) * 2 - 9 if int(char) * 2 > 9 else int(char) * 2) if position % 2 == 0 else int(char)
                   for position, char in enumerate(base))
    bban = f"017{index:019d}"
    payload = {"first_name": "علی", "last_name": "بانکی", "bank": "melli", "card_number": base + str(-checksum % 10),
               "sheba_number": f"IR{98 - int(bban + '182700') % 97:02d}{bban}", "account_number": str(index), "opening_balance": 0, "active": True}
    payload.update(changes)
    return payload


class FinanceIntegrationTests(unittest.TestCase):
    # Reuse the existing disposable server lifecycle without inheriting its tests.
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM financial_transactions")
            db.execute("DELETE FROM bank_accounts")
            db.execute("DELETE FROM expense_categories")
            db.execute("DELETE FROM customers")
        self.customer = self.post("/customers", {"first_name": "علی", "last_name": "مالی"})
        self.bank = self.post("/banks", bank_payload(account_number="۰۰۱۲۳", opening_balance=1000))
        self.category = self.post("/settings/expense-categories", {"title": "خرید مواد"})

    def post(self, path, body):
        status, data = self.request("POST", path, body)
        self.assertEqual(status, 201, data)
        return data

    def payload(self, kind="income", **changes):
        payload = {"request_id": str(uuid.uuid4()), "kind": kind, "bank_id": self.bank["id"], "amount": 25000000,
                   "transaction_date": "۱۴۰۵/۰۷/۱۴", "time_mode": "manual", "hour": 14, "minute": 32,
                   "customer_id" if kind == "income" else "expense_category_id": self.customer["id"] if kind == "income" else self.category["id"]}
        payload.update(changes)
        return payload

    def test_authentication_all_finance_endpoints_and_old_routes(self):
        for method, path, body in [
            ("GET", "/banks", None), ("GET", "/banks/catalog", None), ("POST", "/banks", bank_payload(2)),
            ("PUT", f'/banks/{self.bank["id"]}', bank_payload()),
            ("GET", "/settings/expense-categories", None), ("POST", "/settings/expense-categories", {"title": "x"}),
            ("PUT", f'/settings/expense-categories/{self.category["id"]}', {"title": "x"}),
            ("GET", "/finance/day?date=2026-10-06", None),
            ("GET", "/finance/calendar?start_date=2026-10-01&end_date=2026-10-08", None),
            ("POST", "/finance/transactions", self.payload()),
        ]:
            self.assertEqual(self.request(method, path, body, False)[0], 401, path)
        for path in ["/auth/me", "/customers", "/members", "/attendance/today"]:
            self.assertEqual(self.request("GET", path)[0], 200, path)

    def test_income_expense_real_totals_chart_calendar_and_banks(self):
        income = self.post("/finance/transactions", self.payload(tracking_number="۰۰۱۲۳", description="فروش محصول"))
        expense = self.post("/finance/transactions", self.payload("expense", amount=8500000, hour=16, minute=10))
        self.post("/finance/transactions", self.payload(amount=500, transaction_date="1405/7/15"))
        other_bank = self.post("/banks", bank_payload(2, bank="mellat", account_number="456", opening_balance=-300))
        self.post("/finance/transactions", self.payload("expense", amount=200, bank_id=other_bank["id"]))
        self.assertEqual(income["account_code"], str(self.customer["customer_code"]))
        self.assertEqual(expense["account_code"], self.category["account_code"])
        self.assertEqual(income["tracking_number"], "00123")
        self.assertIsNone(expense["description"])
        self.assertIsNone(expense["tracking_number"])
        self.assertEqual(income["transaction_date"], "2026-10-06")
        self.assertEqual(income["jalali_date"], "1405/07/14")
        self.assertEqual(income["transaction_time"], "14:32:00")
        day = self.request("GET", "/finance/day?date=2026-10-06")[1]
        self.assertEqual(day["summary"], {"income": 25000000, "expense": 8500200, "balance": 16499800})
        self.assertEqual(len(day["transactions"]), 3)
        self.assertEqual(day["chart"][-1]["balance"], day["summary"]["balance"])
        self.assertEqual([row["transaction_time"] for row in day["transactions"]], ["16:10:00", "14:32:00", "14:32:00"])
        self.assertEqual(day["chart"][0]["balance"], 0)
        calendar = self.request("GET", "/finance/calendar?start_date=2026-10-05&end_date=2026-10-08")[1]
        self.assertEqual(len(calendar), 4)
        self.assertEqual(calendar[0]["balance"], 0)
        self.assertEqual(calendar[1]["balance"], 16499800)
        self.assertEqual(calendar[2]["income"], 500)
        banks = {item["id"]: item for item in self.request("GET", "/banks")[1]}
        self.assertEqual(banks[self.bank["id"]]["balance"], 16501500)
        self.assertEqual(banks[other_bank["id"]]["balance"], -500)
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("SELECT amount, typeof(amount), bank_id, transaction_date, transaction_time FROM financial_transactions WHERE id=?", (income["id"],)).fetchone()
            self.assertEqual(row, (25000000, "integer", self.bank["id"], "2026-10-06", "14:32:00"))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_validation_source_codes_amount_and_optional_fields(self):
        for changes in [
            {"amount": "25,000"}, {"amount": "25000"}, {"amount": True}, {"amount": 1.5}, {"amount": 0}, {"amount": -1}, {"amount": 1000000000000},
            {"hour": 24}, {"minute": 60}, {"hour": None}, {"minute": None},
            {"time_mode": "auto"}, {"time_mode": "invalid"}, {"tracking_number": "abc"},
            {"transaction_date": "1404/12/30"}, {"transaction_date": "1405/7/31"}, {"transaction_date": "2026-10-06"},
            {"customer_id": None}, {"expense_category_id": self.category["id"]}, {"account_code": "999"}, {"title": "fake"},
            {"description": "x" * 5001}, {"request_id": "invalid"},
        ]:
            self.assertEqual(self.request("POST", "/finance/transactions", self.payload(**changes))[0], 422, changes)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload("expense", tracking_number="123"))[0], 422)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload(bank_id=999999))[0], 404)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload(customer_id=999999))[0], 404)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload("expense", expense_category_id=999999))[0], 404)
        self.assertEqual(self.request("GET", "/finance/day?date=bad")[0], 422)
        self.assertEqual(self.request("GET", "/finance/day?date=0001-01-01")[0], 422)
        for query in ["start_date=2026-10-08&end_date=2026-10-05", "start_date=2026-01-01&end_date=2026-10-08"]:
            self.assertEqual(self.request("GET", "/finance/calendar?" + query)[0], 422)
        self.assertEqual(self.request("GET", "/finance/day?date=2026-10-06")[1]["summary"]["income"], 0)
        saved = self.post("/finance/transactions", self.payload(tracking_number="", description="  "))
        self.assertIsNone(saved["tracking_number"])
        self.assertIsNone(saved["description"])

    def test_auto_clock_jalali_leap_day_and_midnight_manual(self):
        before = datetime.now(ZoneInfo("Asia/Tehran")).strftime("%H:%M:%S")
        saved = self.post("/finance/transactions", self.payload(time_mode="auto", hour=None, minute=None))
        after = datetime.now(ZoneInfo("Asia/Tehran")).strftime("%H:%M:%S")
        self.assertGreaterEqual(saved["transaction_time"], before)
        self.assertLessEqual(saved["transaction_time"], after)
        leap = self.post("/finance/transactions", self.payload(transaction_date="١٤٠٣/١٢/٣٠", hour=0, minute=0))
        self.assertEqual(leap["transaction_date"], "2025-03-20")
        self.assertEqual(leap["transaction_time"], "00:00:00")
        last = self.post("/finance/transactions", self.payload(hour=23, minute=59))
        self.assertEqual(last["transaction_time"], "23:59:00")

    def test_retry_and_concurrent_post_do_not_duplicate_money(self):
        payload = self.payload()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/finance/transactions", payload), range(8)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual(len({row["id"] for _, row in results}), 1)
        self.assertEqual(self.request("GET", "/finance/day?date=2026-10-06")[1]["summary"]["income"], 25000000)
        changed = {**payload, "amount": 123}
        self.assertEqual(self.request("POST", "/finance/transactions", changed)[0], 409)

    def test_references_unique_codes_inactive_and_ledger_history(self):
        self.assertEqual(self.request("POST", "/banks", bank_payload(3, account_number="00123"))[0], 409)
        self.assertEqual(self.request("POST", "/settings/expense-categories", {"title": "خرید مواد"})[0], 409)
        self.assertEqual(self.request("POST", "/settings/expense-categories", {"title": "x", "account_code": "1"})[0], 422)
        income = self.post("/finance/transactions", self.payload())
        expense = self.post("/finance/transactions", self.payload("expense"))
        code = self.category["account_code"]
        self.assertEqual(self.request("PUT", f'/settings/expense-categories/{self.category["id"]}', {"title": "عنوان جدید", "active": False})[1]["account_code"], code)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload("expense"))[0], 409)
        self.assertEqual(self.request("PUT", f'/banks/{self.bank["id"]}', bank_payload(bank="saman", account_number="00123", opening_balance=1000, active=False))[0], 200)
        self.assertEqual(self.request("POST", "/finance/transactions", self.payload())[0], 409)
        self.assertEqual(self.request("DELETE", f'/customers/{self.customer["id"]}')[0], 409)
        self.assertEqual(self.request("GET", f'/customers/{self.customer["id"]}')[0], 200)
        ledger = self.request("GET", "/finance/day?date=2026-10-06")[1]["transactions"]
        self.assertEqual({item["title"] for item in ledger}, {income["title"], expense["title"]})
        self.assertEqual({item["bank"]["name"] for item in ledger}, {"بانک سامان"})
        second = self.post("/settings/expense-categories", {"title": "حمل و نقل"})
        self.assertNotEqual(second["account_code"], code)
        self.assertEqual(self.request("GET", "/banks")[1][0]["balance"], 1000)


if __name__ == "__main__":
    unittest.main()
