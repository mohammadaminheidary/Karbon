"""Document posting and ledger consistency against isolated authenticated HTTP/SQLite."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
from urllib.parse import urlencode
from uuid import uuid4

import test_finance as finance_tests


class DocumentsIntegrationTests(unittest.TestCase):
    setUpClass = classmethod(finance_tests.FinanceIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(finance_tests.FinanceIntegrationTests.tearDownClass.__func__)
    request = classmethod(finance_tests.FinanceIntegrationTests.request.__func__)
    post = finance_tests.FinanceIntegrationTests.post
    payload = finance_tests.FinanceIntegrationTests.payload
    confirmation = {"password": "test-password", "confirmed": True}

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM financial_transactions")
            db.execute("DELETE FROM documents")
            db.execute("DELETE FROM document_accounts")
        finance_tests.FinanceIntegrationTests.setUp(self)
        self.income_account = self.post("/settings/document-accounts", {"title":"درآمد سند", "kind":"income"})
        self.expense_account = self.post("/settings/document-accounts", {"title":"هزینه سند", "kind":"expense"})

    def line(self, kind="income", **changes):
        return {"kind": kind, "bank_id": self.bank["id"], "amount": 1000,
                "document_account_id": self.income_account["id"] if kind == "income" else self.expense_account["id"], **changes}

    def document(self, **changes):
        return {"request_id": str(uuid4()), "date": "1405/07/14", "description": "یادداشت کلی\nخط دوم", "rows": [self.line(), self.line("expense", amount=300)], **changes}

    def edit(self, document, **changes):
        rows = [{key: row[key] for key in ("id", "kind", "bank_id", "document_account_id", "amount", "description", "tracking_number")} for row in document["rows"]]
        return self.document(revision=document["revision"], rows=rows, **changes)

    def day(self, date="2026-10-06"):
        return self.request("GET", "/finance/day?date=" + date)[1]

    def banks(self):
        return {bank["id"]: bank for bank in self.request("GET", "/banks")[1]}

    def test_create_edit_delete_update_every_financial_projection_once(self):
        other = self.post("/banks", finance_tests.bank_payload(2, opening_balance=500))
        ordinary = self.post("/finance/transactions", self.payload(amount=50))
        payload = self.document(rows=[self.line(description="دریافت"), self.line("expense", amount=300), self.line(amount=700, bank_id=other["id"]), self.line("expense", amount=100, bank_id=other["id"])])
        document = self.post("/documents", payload)
        self.assertRegex(document["number"], r"^\d{8}-\d{6}-\d{6,}$")
        self.assertEqual(document["description"], payload["description"])
        self.assertEqual((document["total_income"], document["total_expense"]), (1700, 400))
        self.assertEqual(len(document["rows"]), 4)
        self.assertEqual(document["rows"][0]["account_code"], self.income_account["code"])
        self.assertEqual(document["rows"][1]["account_code"], self.expense_account["code"])
        self.assertTrue(all(row["document_id"] == document["id"] for row in document["rows"]))
        self.assertEqual(self.post("/documents", payload), document)
        self.assertEqual(self.banks()[self.bank["id"]]["balance"], 1750)
        self.assertEqual(self.banks()[other["id"]]["balance"], 1100)
        self.assertEqual(self.day()["summary"], {"income":1750,"expense":400,"balance":1350})
        self.assertEqual(self.day()["chart"][-1]["balance"], 1350)
        self.assertEqual(self.request("GET", "/finance/calendar?start_date=2026-10-06&end_date=2026-10-07")[1][0]["income"], 1750)
        ledger = self.request("GET", f'/banks/{self.bank["id"]}/transactions')[1]
        self.assertEqual(ledger["total"], 3)
        activity = self.request("GET", f'/banks/{other["id"]}/activity?period=day&anchor=1405/07/14')[1]
        self.assertEqual(activity["summary"], {"income":700,"expense":100,"balance":600})
        self.assertFalse(self.banks()[other["id"]]["can_delete"])
        # Document income is not an invoice payment; order/customer debt must stay unchanged.
        self.assertEqual(self.request("GET", f'/customers/{self.customer["id"]}')[1]["summary"]["paid"], 0)
        first_id = document["rows"][0]["id"]
        changes = self.document(revision=document["revision"], date="1405/07/15", rows=[self.line("expense", id=first_id, amount=200, bank_id=other["id"]), self.line(amount=600)])
        code, edited = self.request("PUT", f'/documents/{document["id"]}', changes)
        self.assertEqual(code, 200, edited)
        self.assertEqual(edited["number"], document["number"])
        self.assertEqual(edited["revision"], 2)
        self.assertEqual(edited["rows"][0]["id"], first_id)
        self.assertEqual(self.request("PUT", f'/documents/{document["id"]}', changes), (200, edited))
        self.assertEqual(self.day()["summary"], {"income":50,"expense":0,"balance":50})
        self.assertEqual(self.day("2026-10-07")["summary"], {"income":600,"expense":200,"balance":400})
        self.assertEqual(self.banks()[self.bank["id"]]["balance"], 1650)
        self.assertEqual(self.banks()[other["id"]]["balance"], 300)
        path = f'/documents/{document["id"]}'
        self.assertEqual(self.request("DELETE", path, {**self.confirmation, "password":"wrong"})[0],403)
        self.assertEqual(self.day("2026-10-07")["summary"]["income"],600)
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0],200)
        self.assertEqual(self.request("DELETE", path, self.confirmation)[0],200)
        self.assertEqual(self.request("GET", path)[0],404)
        self.assertEqual(self.post("/documents", self.document())["row_count"],2)
        # Remove that separate document before checking the original baseline.
        second = self.request("GET", "/documents")[1]["items"][0]
        self.assertEqual(self.request("DELETE", f'/documents/{second["id"]}', self.confirmation)[0],200)
        self.assertEqual(self.banks()[self.bank["id"]]["balance"],1050)
        self.assertEqual(self.banks()[other["id"]]["balance"],500)
        self.assertEqual(self.day("2026-10-07")["summary"],{"income":0,"expense":0,"balance":0})
        self.assertEqual([row["id"] for row in self.day()["transactions"]],[ordinary["id"]])
        self.assertEqual(self.request("GET", f'/banks/{other["id"]}/transactions')[1]["total"],0)
        self.assertEqual(self.request("GET", "/finance/calendar?start_date=2026-10-06&end_date=2026-10-07")[1][1]["income"],0)
        self.assertEqual(self.request("POST", "/documents", payload)[0],410)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_concurrent_retries_unique_numbers_and_stale_edits(self):
        payload = self.document()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/documents", payload), range(8)))
        self.assertTrue(all(code == 201 for code, _ in results),results)
        self.assertEqual(len({item["id"] for _, item in results}),1)
        self.assertEqual(self.day()["summary"]["income"],1000)
        document = results[0][1]
        self.assertEqual(self.request("POST", "/documents", {**payload,"description":"different"})[0],409)
        changes = self.edit(document, description="ویرایش")
        code, edited = self.request("PUT", f'/documents/{document["id"]}', changes)
        self.assertEqual(code,200,edited)
        stale = {**changes,"request_id":str(uuid4()),"description":"stale"}
        self.assertEqual(self.request("PUT", f'/documents/{document["id"]}',stale)[0],409)
        self.assertEqual(self.request("GET", f'/documents/{document["id"]}')[1],edited)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            others=list(pool.map(lambda _: self.request("POST","/documents",self.document()),range(4)))
        self.assertTrue(all(code==201 for code,_ in others),others)
        self.assertEqual(len({item["number"] for _,item in others}),4)
        self.assertEqual(self.day()["summary"]["income"],5000)

    def test_atomic_validation_row_ownership_and_ledger_guards(self):
        invalids = [self.document(rows=[]), self.document(rows=[self.line(amount=0)]), self.document(rows=[self.line(amount=True)]), self.document(rows=[self.line(amount="1,000")]), self.document(date="1405/12/30"), self.document(date="0001-01-01"), self.document(number="manual"), self.document(rows=[self.line(customer_id=self.customer["id"])]) ]
        for body in invalids:
            self.assertEqual(self.request("POST","/documents",body)[0],422,body)
        for bad in [self.line(bank_id=999999), self.line(document_account_id=999999)]:
            self.assertEqual(self.request("POST","/documents",self.document(rows=[self.line(),bad]))[0],404)
        self.assertEqual(self.request("GET","/documents")[1]["total"],0)
        self.assertEqual(self.day()["summary"]["income"],0)
        one=self.post("/documents",self.document())
        two=self.post("/documents",self.document())
        row=one["rows"][0]
        changes=self.edit(one)
        changes["rows"][0]["id"]=two["rows"][0]["id"]
        self.assertEqual(self.request("PUT",f'/documents/{one["id"]}',changes)[0],409)
        self.assertEqual(self.request("GET",f'/documents/{one["id"]}')[1],one)
        self.assertEqual(self.request("PUT",f'/finance/transactions/{row["id"]}',{key:value for key,value in self.payload().items() if key!="request_id"})[0],409)
        self.assertEqual(self.request("DELETE",f'/finance/transactions/{row["id"]}',self.confirmation)[0],409)
        self.assertEqual(self.request("DELETE",f'/banks/{self.bank["id"]}',self.confirmation)[0],409)
        self.assertEqual(self.request("DELETE",f'/customers/{self.customer["id"]}')[0],204)
        self.assertEqual(self.day()["summary"]["income"],2000)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE bank_accounts SET active=0 WHERE id=?",(self.bank["id"],))
        # Unchanged archived references remain editable, new postings cannot use them.
        self.assertEqual(self.request("PUT",f'/documents/{one["id"]}',self.edit(one))[0],200)
        self.assertEqual(self.request("POST","/documents",self.document())[0],409)

    def test_independent_account_management_validation_and_history(self):
        path = "/settings/document-accounts"
        self.assertEqual(self.request("GET", path, authenticated=False)[0],401)
        self.assertEqual(self.request("POST",path,{"code":"D-000001","title":"تکراری","kind":"income"})[0],422)
        for body in ({"title":" ","kind":"income"},{"title":"حساب","kind":"other"}):
            self.assertEqual(self.request("POST",path,body)[0],422)
        # The document API no longer accepts customer/category account sources.
        legacy = self.document(rows=[{"kind":"income","customer_id":self.customer["id"],"bank_id":self.bank["id"],"amount":100}])
        self.assertEqual(self.request("POST","/documents",legacy)[0],422)
        self.assertEqual(self.request("POST","/documents",self.document(rows=[self.line(document_account_id=self.expense_account["id"])]))[0],422)
        document = self.post("/documents",self.document())
        account_path = f'{path}/{self.income_account["id"]}'
        self.assertEqual(self.request("DELETE",account_path,self.confirmation)[0],409)
        self.assertFalse(next(item for item in self.request("GET",path)[1] if item["id"]==self.income_account["id"])["can_delete"])
        edit = {"title":"حساب مستقل جدید","kind":"income","active":True}
        self.assertEqual(self.request("PUT",account_path,edit)[0],200)
        self.assertEqual(self.request("PUT",account_path,{**edit,"kind":"expense"})[0],409)
        # Other modules may renumber their own accounts without touching these.
        self.assertEqual(self.request("DELETE",f'/customers/{self.customer["id"]}')[0],204)
        self.assertEqual(self.request("DELETE",f'/settings/expense-categories/{self.category["id"]}',self.confirmation)[0],200)
        stored = self.request("GET",f'/documents/{document["id"]}')[1]
        income = next(row for row in stored["rows"] if row["kind"]=="income")
        self.assertEqual(income["account_code"],self.income_account["code"])
        self.assertIsNone(income["customer_id"])
        self.assertTrue(all(row["expense_category_id"] is None for row in stored["rows"]))
        self.assertEqual(stored["total_income"],1000)
        self.assertEqual(self.banks()[self.bank["id"]]["balance"],1700)
        self.assertEqual(self.request("PUT",account_path,{**edit,"active":False})[0],200)
        current = self.request("GET",f'/documents/{document["id"]}')[1]
        self.assertEqual(self.request("PUT",f'/documents/{document["id"]}',self.edit(current))[0],200)
        self.assertEqual(self.request("POST","/documents",self.document())[0],409)
        unused = self.post(path,{"title":"بدون استفاده","kind":"expense"})
        self.assertEqual(self.request("DELETE",f'{path}/{unused["id"]}',{**self.confirmation,"password":"wrong"})[0],403)
        self.assertEqual(self.request("DELETE",f'{path}/{unused["id"]}',self.confirmation)[0],200)
        self.assertNotIn(unused["id"],[row["id"] for row in self.request("GET",path)[1]])

    def test_account_codes_are_generated_sequentially_and_unique_under_concurrency(self):
        path = "/settings/document-accounts"
        self.assertEqual(self.income_account["code"], "D-000001")
        self.assertEqual(self.expense_account["code"], "D-000002")
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda index: self.request("POST",path,{"title":f"حساب {index}","kind":"income"}),range(8)))
        self.assertTrue(all(status == 201 for status,_ in results),results)
        self.assertEqual(sorted(item["code"] for _,item in results),[f"D-{index:06d}" for index in range(3,11)])
        account = results[0][1]
        self.assertEqual(self.request("PUT",f'{path}/{account["id"]}',{"title":"عنوان جدید","kind":"income","active":False})[1]["code"],account["code"])
        self.assertEqual(self.request("DELETE",f'{path}/{account["id"]}',self.confirmation)[0],200)
        self.assertEqual(self.post(path,{"title":"حساب بعدی","kind":"expense"})["code"],"D-000011")
        # Legacy/manual codes remain intact and cannot be changed by a client.
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO document_accounts (code,title,kind,active) VALUES ('D-000099','قدیمی','income',1)")
        self.assertEqual(self.post(path,{"title":"پس از کد قدیمی","kind":"income"})["code"],"D-000100")
        self.assertEqual(self.request("PUT",f'{path}/{self.income_account["id"]}',{"code":"fake","title":"عنوان","kind":"income"})[0],422)

    def test_search_dates_fifteen_batches_and_authentication(self):
        for index in range(31):
            self.post("/documents",self.document(description=f"گروه {index}"))
        pages=[self.request("GET",f'/documents?skip={skip}')[1] for skip in (0,15,30,45)]
        self.assertEqual([len(page["items"]) for page in pages],[15,15,1,0])
        self.assertEqual(len({item["id"] for page in pages for item in page["items"]}),31)
        self.assertEqual(pages[0]["available_dates"],["2026-10-06"])
        for filters in ({"search":"گروه ۳۰"},{"start_date":"1405/07/15"},{"document_type":"هزینه"}):
            result=self.request("GET","/documents?"+urlencode(filters))[1]
            self.assertEqual(result["filtered_total"],1 if "search" in filters else 0)
            self.assertEqual(result["total"],31)
        path=f'/documents/{pages[0]["items"][0]["id"]}'
        for body in (None,{"password":"test-password"},{**self.confirmation,"confirmed":False}):
            self.assertEqual(self.request("DELETE",path,body)[0],422)
        for method,url,body in [("GET","/documents",None),("GET","/documents/next-number",None),("POST","/documents",self.document()),("GET",path,None),("PUT",path,self.document()),("DELETE",path,self.confirmation)]:
            self.assertEqual(self.request(method,url,body,False)[0],401)
        for query in ("limit=16","skip=-1","start_date=bad","start_date=2026-10-07&end_date=2026-10-06"):
            self.assertEqual(self.request("GET","/documents?"+query)[0],422)


if __name__ == "__main__":
    unittest.main()
