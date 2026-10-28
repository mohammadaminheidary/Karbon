"""Account-specific charts and filtered keyset pagination against real HTTP/SQLite."""
from urllib.parse import urlencode
import unittest

import test_finance as finance_tests


class BankLedgerIntegrationTests(unittest.TestCase):
    setUpClass = classmethod(finance_tests.FinanceIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(finance_tests.FinanceIntegrationTests.tearDownClass.__func__)
    request = classmethod(finance_tests.FinanceIntegrationTests.request.__func__)
    setUp = finance_tests.FinanceIntegrationTests.setUp
    post = finance_tests.FinanceIntegrationTests.post
    payload = finance_tests.FinanceIntegrationTests.payload

    def get(self, resource="transactions", **query):
        return self.request("GET", f'/banks/{self.bank["id"]}/{resource}?' + urlencode(query))

    def test_newest_first_fifteen_pages_snapshot_and_account_isolation(self):
        rows = [self.post("/finance/transactions", self.payload(amount=index + 100)) for index in range(31)]
        other = self.post("/banks", finance_tests.bank_payload(2))
        self.post("/finance/transactions", self.payload(bank_id=other["id"], amount=999))
        status, page = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(page["total"], 31)
        self.assertEqual([item["id"] for item in page["items"]], [item["id"] for item in reversed(rows[-15:])])
        self.assertTrue(page["next_cursor"])
        # Inserting between pages does not duplicate/skip the original snapshot.
        self.post("/finance/transactions", self.payload(amount=2000))
        collected = page["items"][:]
        while page["next_cursor"]:
            status, page = self.get(cursor=page["next_cursor"])
            self.assertEqual(status, 200)
            self.assertEqual(page["total"], 31)
            self.assertLessEqual(len(page["items"]), 15)
            collected.extend(page["items"])
        self.assertEqual([item["id"] for item in collected], [item["id"] for item in reversed(rows)])
        self.assertEqual(len({item["id"] for item in collected}), 31)
        self.assertTrue(all(item["bank_id"] == self.bank["id"] for item in collected))

    def test_jalali_date_amount_description_tracking_and_literal_search(self):
        one = self.post("/finance/transactions", self.payload(amount=1000, transaction_date="1403/12/30", tracking_number="00123", description="فاکتور 100%_"))
        two = self.post("/finance/transactions", self.payload("expense", amount=2000, transaction_date="1404/01/01", description="خرید مواد"))
        three = self.post("/finance/transactions", self.payload(amount=3000, transaction_date="1404/02/01", tracking_number="900"))
        for query, expected in [
            ({"day":"۱۴۰۳/۱۲/۳۰"}, [one]), ({"month":"۱۴۰۴/۰۱"}, [two]), ({"year":"۱۴۰۳"}, [one]),
            ({"start_date":"1404/01/01","end_date":"1404/01/31"}, [two]),
            ({"min_amount":1500,"max_amount":2500}, [two]), ({"search":"خرید"}, [two]),
            ({"search":"۰۰۱۲۳"}, [one]), ({"search":"%_"}, [one]), ({"search":"missing"}, []),
            ({"year":"1404","min_amount":2500}, [three]),
        ]:
            status, result = self.get(**query)
            self.assertEqual(status, 200, (query,result))
            self.assertEqual([item["id"] for item in result["items"]], [item["id"] for item in expected], query)
            self.assertEqual(result["total"], len(expected))
        self.assertEqual(self.get(search=str(three["id"]))[1]["items"][0]["id"], three["id"])

    def test_chart_jalali_period_boundaries_zero_days_and_real_sums(self):
        self.post("/finance/transactions", self.payload(amount=1000))
        self.post("/finance/transactions", self.payload("expense", amount=200, transaction_date="1405/07/15"))
        other = self.post("/banks", finance_tests.bank_payload(2))
        self.post("/finance/transactions", self.payload(bank_id=other["id"], amount=999))
        expected = {"yesterday":("2026-10-05","2026-10-05",0,0), "day":("2026-10-06","2026-10-06",1000,0), "week":("2026-10-03","2026-10-09",1000,200),
                    "month":("2026-09-23","2026-10-22",1000,200), "quarter":("2026-09-23","2026-12-21",1000,200),
                    "year":("2026-03-21","2027-03-20",1000,200)}
        for period, (start,end,income,expense) in expected.items():
            status, result = self.get("activity", period=period, anchor="۱۴۰۵/۰۷/۱۴")
            self.assertEqual(status, 200, result)
            self.assertEqual((result["start_date"],result["end_date"]),(start,end),period)
            self.assertEqual(result["summary"], {"income":income,"expense":expense,"balance":income-expense})
            self.assertEqual(sum(point["income"] for point in result["chart"]), income)
            self.assertEqual(sum(point["expense"] for point in result["chart"]), expense)
            self.assertEqual(result["bank"]["balance"], 1800)
        year = self.get("activity", period="year", anchor="1403/12/30")[1]
        self.assertEqual(len(year["chart"]), 366)
        self.assertEqual(year["end_date"], "2025-03-20")
        self.assertTrue(all(point["income"] == point["expense"] == 0 for point in year["chart"]))

    def test_authentication_missing_account_invalid_filters_and_cursor(self):
        for resource in ["activity","transactions"]:
            self.assertEqual(self.request("GET", f'/banks/{self.bank["id"]}/{resource}', authenticated=False)[0],401)
            self.assertEqual(self.request("GET", f'/banks/999999/{resource}')[0],404)
        for query in [{"day":"1404/12/30"},{"month":"1405/13"},{"year":"x"},{"year":"9999"},
                      {"start_date":"1405/07/15","end_date":"1405/07/14"},{"min_amount":3000,"max_amount":1000},
                      {"min_amount":-1},{"cursor":"bad"},{"cursor":"e30="},{"search":"x"*201}]:
            self.assertEqual(self.get(**query)[0],422,query)
        self.assertEqual(self.get("activity", period="bad")[0],422)
        self.assertEqual(self.get("activity", anchor="bad")[0],422)
        self.assertEqual(self.get("activity", period="year", anchor="9377/01/01")[0],422)
        self.assertEqual(self.request("GET", "/banks/99999999999999999999999/transactions")[0],422)

    def test_finance_transactions_include_database_logo_and_bank_name(self):
        saved = self.post("/finance/transactions", self.payload())
        self.assertEqual(saved["bank"]["logo_url"], "/assets/image/banks/melli.svg")
        day = self.request("GET", "/finance/day?date=2026-10-06")[1]
        self.assertEqual(day["transactions"][0]["bank"]["name"], "بانک ملی ایران")
        self.assertEqual(day["transactions"][0]["bank"]["logo_url"], saved["bank"]["logo_url"])


if __name__ == "__main__":
    unittest.main()
