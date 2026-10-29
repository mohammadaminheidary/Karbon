"""Real authenticated HTTP checks against a disposable SQLite database."""
import concurrent.futures
from contextlib import closing
import sqlite3
import unittest
from urllib.parse import quote
from uuid import uuid4, uuid5
import test_customers as customer_tests
from test_finance import bank_payload


class OrdersIntegrationTests(unittest.TestCase):
    setUpClass = classmethod(customer_tests.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customer_tests.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customer_tests.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ["order_payments", "order_items", "orders", "financial_transactions", "products", "bank_accounts", "customers"]:
                db.execute(f"DELETE FROM {table}")
        self.customer = self.post("/customers", {"first_name": "علی", "last_name": "سفارشی", "phone_numbers": ["09121234567"]})
        self.bank = self.post("/banks", bank_payload())
        self.product = self.post("/products", {"name": "کالای اول", "unit": "عدد", "price": 1000, "stock": 10})
        self.service = self.post("/products", {"name": "خدمت", "unit": "ساعت", "price": 500})

    def post(self, path, body):
        status, data = self.request("POST", path, body)
        self.assertEqual(status, 201, data)
        return data

    def payload(self, **changes):
        value = {"request_id": str(uuid4()), "customer_id": self.customer["id"], "invoice_date": "۱۴۰۵/۰۷/۲۲", "payment_date": "1405/07/23",
                 "items": [{"product_id": self.product["id"], "quantity": 2, "unit_price": 1000}, {"product_id": self.service["id"], "quantity": 1, "unit_price": 500}],
                 "discount": 500, "payments": [{"method": "pos", "bank_id": self.bank["id"], "amount": 2000}]}
        value.update(changes)
        return value

    def test_full_mixed_payment_finance_banks_customer_and_snapshot(self):
        second = self.post("/banks", bank_payload(2))
        order = self.post("/orders", self.payload(order_number="س-۰۰۰۱", description="توضیحات سفارش", payments=[
            {"method": "pos", "bank_id": self.bank["id"], "amount": 1000}, {"method": "cash", "amount": 500}, {"method": "transfer", "bank_id": second["id"], "amount": 500}]))
        self.assertEqual((order["subtotal"], order["discount"], order["total"], order["paid"], order["remaining"]), (2500,500,2000,2000,0))
        self.assertEqual((order["status"], order["payment_status"]), ("active", "settled"))
        self.assertEqual(order["order_number"], "س-0001")
        self.assertEqual(order["invoice_date"], "2026-10-14")
        self.assertEqual(order["payment_date"], "2026-10-15")
        self.assertEqual([item["position"] for item in order["items"]], [1,2])
        daily = self.request("GET", "/finance/day?date=2026-10-15")[1]
        self.assertEqual(daily["summary"]["income"], 2000)
        self.assertEqual(len(daily["transactions"]),3)
        for row in daily["transactions"]:
            self.assertEqual(row["invoice"]["remaining"],0)
            self.assertEqual(row["invoice"]["total"],2000)
        banks = self.request("GET","/banks")[1]
        self.assertEqual(sum(bank["balance"] for bank in banks),2000)
        cash = next(bank for bank in banks if bank["is_cash"])
        self.assertEqual(cash["name"],"صندوق نقدی")
        self.assertEqual(cash["balance"],500)
        self.assertFalse(cash["can_edit"])
        summary = self.request("GET",f'/customers/{self.customer["id"]}')[1]["summary"]
        self.assertEqual(summary, {"order_count":1,"total_orders":2000,"paid":2000,"debt":0,"status":"settled","available":True})
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?",(self.product["id"],)).fetchone()[0],8)
            db.execute("UPDATE products SET name='نام جدید',unit='بسته',price=999 WHERE id=?",(self.product["id"],))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])
        saved = self.request("GET","/orders")[1]
        self.assertEqual(saved["active_orders"],1)
        self.assertEqual(saved["items"][0]["items"][0]["product_name"],"کالای اول")

    def test_partial_unpaid_and_fully_discounted(self):
        partial = self.post("/orders", self.payload(payments=[{"method":"cash","amount":600}]))
        self.assertEqual((partial["paid"],partial["remaining"],partial["payment_status"]),(600,1400,"partial"))
        unpaid = self.post("/orders", self.payload(payments=[]))
        self.assertEqual((unpaid["paid"],unpaid["remaining"],unpaid["payment_status"]),(0,2000,"unpaid"))
        free = self.post("/orders", self.payload(discount=2500,payments=[]))
        self.assertEqual((free["total"],free["remaining"],free["payment_status"]),(0,0,"settled"))
        summary = self.request("GET", f'/customers/{self.customer["id"]}')[1]["summary"]
        self.assertEqual((summary["total_orders"],summary["paid"],summary["debt"]),(4000,600,3400))
        self.assertEqual(self.request("GET","/orders?status=completed")[1]["items"],[])

    def test_customer_summary_counts_ignore_search_and_pagination(self):
        empty = self.request("GET", "/customers")[1]
        self.assertEqual((empty["total_customers"], empty["unsettled_customers"], empty["settled_customers"]), (1, 0, 0))
        settled = self.post("/customers", {"first_name": "تسویه", "last_name": "شده"})
        free = self.post("/customers", {"first_name": "رایگان", "last_name": "شده"})
        for index in range(12):
            self.post("/customers", {"first_name": f"بدون سفارش {index}", "last_name": "آزمایشی"})
        self.post("/orders", self.payload(payments=[{"method": "cash", "amount": 600}]))
        self.post("/orders", self.payload(customer_id=settled["id"], payments=[
            {"method": "cash", "amount": 1000},
            {"method": "pos", "bank_id": self.bank["id"], "amount": 1000},
        ]))
        self.post("/orders", self.payload(customer_id=free["id"], discount=2500, payments=[]))
        counts = self.request("GET", "/customers?limit=1")[1]
        self.assertEqual((counts["total_customers"], counts["unsettled_customers"], counts["settled_customers"]), (15, 1, 2))
        # A later unpaid invoice makes an otherwise settled customer indebted.
        self.post("/orders", self.payload(customer_id=settled["id"], payments=[]))
        for path in ["/customers?limit=12", "/customers?skip=12&limit=12", "/customers?search=رایگان", "/customers?search=missing"]:
            result = self.request("GET", quote(path, safe="/?=&"))[1]
            self.assertEqual((result["total_customers"], result["unsettled_customers"], result["settled_customers"]), (15, 2, 1))
        customers = self.request("GET", "/customers?limit=100")[1]["items"]
        self.assertEqual(sum(row["summary"]["status"] == "debtor" for row in customers), 2)
        self.assertEqual(sum(row["summary"]["status"] == "settled" for row in customers), 1)
        removed = customers[0]
        self.assertEqual(self.request("DELETE", f'/customers/{removed["id"]}')[0], 204)
        self.assertEqual(self.request("GET", "/customers")[1]["total_customers"], 14)

    def test_strict_validation_and_no_partial_writes(self):
        invalid = [
            {"discount":-1}, {"discount":2501}, {"discount":True}, {"discount":"500"}, {"discount":1.5},
            {"invoice_date":"1404/12/30"}, {"payment_date":"2026-10-14"}, {"total":1}, {"invoice_code":"fake"},
            {"customer_id":99999}, {"items":[]}, {"items":[{"product_id":self.product["id"],"quantity":11,"unit_price":1}]},
            {"items":[{"product_id":99999,"quantity":1,"unit_price":1}]},
            {"payments":[{"method":"pos","bank_id":self.bank["id"],"amount":2001}]},
            {"payments":[{"method":"cash","bank_id":self.bank["id"],"amount":1}]},
            {"payments":[{"method":"pos","amount":1}]},
            {"payments":[{"method":"cash","amount":0}]},
            {"payments":[{"method":"cash","amount":1},{"method":"cash","amount":1}]},
            {"payments":[{"method":"transfer","bank_id":99999,"amount":1}]},
            {"items":[{"product_id":self.product["id"],"quantity":True,"unit_price":1}]},
            {"items":[{"product_id":self.product["id"],"quantity":1,"unit_price":"100"}]},
            {"items":[{"product_id":self.product["id"],"quantity":1,"unit_price":1.5}]},
        ]
        for changes in invalid:
            status,data = self.request("POST","/orders",self.payload(**changes))
            self.assertIn(status,[422,404,409],(changes,data))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM orders").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?",(self.product["id"],)).fetchone()[0],10)

    def test_retries_concurrent_uniqueness_and_stock(self):
        body = self.payload()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST","/orders",body),range(8)))
        self.assertTrue(all(status==201 for status,_ in results),results)
        self.assertEqual(len({data["id"] for _,data in results}),1)
        self.assertEqual(self.request("POST","/orders",{**body,"discount":600,"payments":[]})[0],409)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?",(self.product["id"],)).fetchone()[0],8)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions").fetchone()[0],1)
        one = self.payload(items=[{"product_id":self.product["id"],"quantity":5,"unit_price":1000}],discount=0,payments=[])
        two = {**one,"request_id":str(uuid4())}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda payload:self.request("POST","/orders",payload),[one,two]))
        self.assertEqual(sorted(status for status,_ in results),[201,409])

    def test_duplicate_number_product_inactive_bank_and_aggregated_stock(self):
        self.post("/orders",self.payload(order_number="CUSTOM-1"))
        self.assertEqual(self.request("POST","/orders",self.payload(order_number="CUSTOM-1"))[0],409)
        self.assertEqual(self.request("POST","/orders",self.payload(items=[{"product_id":self.product["id"],"quantity":5,"unit_price":1000}]*2))[0],409)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET active=0 WHERE id=?",(self.product["id"],))
        self.assertEqual(self.request("POST","/orders",self.payload())[0],409)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE products SET active=1 WHERE id=?",(self.product["id"],))
            db.execute("UPDATE bank_accounts SET active=0 WHERE id=?",(self.bank["id"],))
        self.assertEqual(self.request("POST","/orders",self.payload())[0],409)

    def test_ledger_mutations_and_customer_deletion_cannot_break_invoice(self):
        order = self.post("/orders",self.payload())
        payment = order["payments"][0]
        deletion = {"password":"test-password","confirmed":True}
        edit = {"kind":"income","customer_id":self.customer["id"],"bank_id":self.bank["id"],"amount":1,"transaction_date":"1405/7/23"}
        self.assertEqual(self.request("PUT",f'/finance/transactions/{payment["transaction_id"]}',edit)[0],409)
        self.assertEqual(self.request("DELETE",f'/finance/transactions/{payment["transaction_id"]}',deletion)[0],409)
        self.assertEqual(self.request("DELETE",f'/customers/{self.customer["id"]}')[0],409)
        self.assertEqual(self.request("GET","/orders")[1]["items"][0]["paid"],2000)
        self.post("/orders",self.payload(payments=[{"method":"cash","amount":1}]))
        cash = next(b for b in self.request("GET","/banks")[1] if b["is_cash"])
        self.assertEqual(self.request("PUT",f'/banks/{cash["id"]}',bank_payload(3))[0],409)
        self.assertEqual(self.request("DELETE",f'/banks/{cash["id"]}',deletion)[0],409)
        self.assertEqual(self.request("POST","/orders",self.payload(payments=[{"method":"pos","bank_id":cash["id"],"amount":1}]))[0],422)

    def test_failure_after_first_receipt_rolls_back_everything(self):
        body = self.payload(payments=[{"method":"cash","amount":500},{"method":"transfer","bank_id":self.bank["id"],"amount":500}])
        conflict_id = str(uuid5(__import__('uuid').UUID(body["request_id"]),"transfer"))
        self.post("/finance/transactions",{"request_id":conflict_id,"kind":"income","customer_id":self.customer["id"],"bank_id":self.bank["id"],"amount":1,"transaction_date":"1405/7/22"})
        self.assertEqual(self.request("POST","/orders",body)[0],409)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM orders").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM order_items").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM order_payments").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM bank_accounts").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT stock FROM products WHERE id=?",(self.product["id"],)).fetchone()[0],10)

    def test_auth_catalog_numbering_pagination_and_product_validation(self):
        for method,path,body in [("GET","/orders",None),("POST","/orders",self.payload()),("GET","/orders/next-number",None),("GET","/products",None),("POST","/products",{"name":"x","unit":"y","price":1})]:
            self.assertEqual(self.request(method,path,body,False)[0],401)
        self.assertEqual(len(self.request("GET","/products")[1]),2)
        self.assertEqual(self.request("POST","/products",{"name":"کالای اول","unit":"عدد","price":1})[0],409)
        self.assertEqual(self.request("POST","/products",{"name":"x","unit":"y","price":-1})[0],422)
        self.post("/orders",self.payload(payments=[]))
        self.post("/orders",self.payload(payments=[]))
        page = self.request("GET","/orders?limit=1&skip=1")[1]
        self.assertEqual((page["total"],len(page["items"])),(2,1))
        self.assertEqual(self.request("GET","/orders?status=invalid")[0],422)

    def test_product_codes_editing_and_stale_inventory_conflict(self):
        self.assertRegex(self.product["product_code"], r"^P-[0-9]{6,}$")
        body = {"name":"نام جدید", "unit":"بسته", "price":2500, "stock":20, "active":True, "revision":self.product["revision"]}
        status, updated = self.request("PUT", f'/products/{self.product["id"]}', body)
        self.assertEqual(status,200,updated)
        self.assertEqual(updated["product_code"],self.product["product_code"])
        self.assertEqual(updated["revision"],self.product["revision"]+1)
        self.post("/orders",self.payload())
        self.assertEqual(self.request("PUT",f'/products/{self.product["id"]}',{**body,"revision":updated["revision"]})[0],409)
        product = next(item for item in self.request("GET","/products")[1] if item["id"]==self.product["id"])
        self.assertEqual(product["stock"],18)
        self.assertEqual(self.request("PUT",f'/products/{self.product["id"]}',{**body,"revision":product["revision"],"active":False})[0],200)
        self.assertNotIn(self.product["id"],[item["id"] for item in self.request("GET","/products")[1]])
        self.assertIn(self.product["id"],[item["id"] for item in self.request("GET","/products?include_inactive=true")[1]])
        self.assertEqual(self.request("POST","/products",{"name":"x","unit":"y","price":1,"product_code":"fake"})[0],422)
        self.assertEqual(self.request("PUT",f'/products/{self.product["id"]}',body,False)[0],401)

    def test_short_invoice_codes_concurrency_and_immutable_final_snapshot(self):
        payloads = [self.payload(items=[{"product_id":self.service["id"],"quantity":1,"unit_price":500}],discount=0,payments=[{"method":"cash","amount":500}]) for _ in range(8)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda payload:self.request("POST","/orders",payload),payloads))
        self.assertTrue(all(status==201 for status,_ in results),results)
        codes = {row["invoice_code"] for _,row in results}
        self.assertEqual(len(codes),8)
        for code in codes:
            self.assertRegex(code,r"^[0-9]{8}-[0-9]{6}-[0-9A-Z]+$")
            self.assertLessEqual(len(code),29)
        order = results[0][1]
        path = f'/orders/{order["id"]}/invoice'
        status, invoice = self.request("GET",path)
        self.assertEqual(status,200,invoice)
        self.assertEqual(invoice["customer"]["name"],"علی سفارشی")
        self.assertEqual((invoice["total"],invoice["paid"],invoice["remaining"]),(500,500,0))
        self.assertEqual(invoice["items"][0]["product_code"],self.service["product_code"])
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE customers SET first_name='نام عوض‌شده' WHERE id=?",(self.customer["id"],))
            db.execute("UPDATE products SET name='تغییر کالا',price=999,unit='متر' WHERE id=?",(self.service["id"],))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE orders SET invoice_code='changed' WHERE id=?",(order["id"],))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE orders SET invoice_snapshot='{}' WHERE id=?",(order["id"],))
        self.assertEqual(self.request("GET",path)[1],invoice)
        self.assertEqual(self.request("POST","/orders",payloads[0])[1]["invoice_code"],order["invoice_code"])
        self.assertEqual(self.request("GET",path,authenticated=False)[0],401)
        self.assertEqual(self.request("GET","/orders/999999/invoice")[0],404)

    def test_card_details_current_status_and_completion_keep_financial_history(self):
        order = self.post("/orders",self.payload(payments=[{"method":"cash","amount":600}],description="شرح سفارش"))
        path = f'/orders/{order["id"]}'
        details = self.request("GET",path)[1]
        self.assertEqual(details["customer"]["phone_numbers"],["09121234567"])
        self.assertEqual(details["items"][0]["unit_price"],1000)
        self.assertEqual(details["payments"][0]["account_name"],"صندوق نقدی")
        self.assertEqual((details["status"],details["discount"],details["remaining"]),("active",500,1400))
        original_invoice = self.request("GET",path+"/invoice")[1]
        before_banks = self.request("GET","/banks")[1]
        before_summary = self.request("GET",f'/customers/{self.customer["id"]}')[1]["summary"]
        before_products = self.request("GET","/products")[1]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _:self.request("POST",path+"/complete"),range(8)))
        self.assertTrue(all(status==200 and row["status"]=="completed" for status,row in results),results)
        self.assertEqual(self.request("GET",path)[1]["status"],"completed")
        self.assertEqual(self.request("GET",path+"/invoice")[1],original_invoice)
        active = self.request("GET","/orders?status=active")[1]
        completed = self.request("GET","/orders?status=completed")[1]
        self.assertEqual((active["total_orders"],active["active_orders"],active["items"]),(1,0,[]))
        self.assertEqual([row["id"] for row in completed["items"]],[order["id"]])
        self.assertEqual(self.request("GET","/banks")[1],before_banks)
        self.assertEqual(self.request("GET","/products")[1],before_products)
        self.assertEqual(self.request("GET",f'/customers/{self.customer["id"]}')[1]["summary"],before_summary)
        self.assertEqual(self.request("POST",path+"/complete")[1]["remaining"],1400)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM financial_transactions").fetchone()[0],1)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_reactivation_is_concurrent_idempotent_and_preserves_all_data(self):
        order = self.post("/orders", self.payload(payments=[{"method": "cash", "amount": 600}], description="شرح بازگشت"))
        path = f'/orders/{order["id"]}'
        self.assertEqual(self.request("POST", path + "/complete")[0], 200)
        completed = self.request("GET", path)[1]
        tables = ["orders", "order_items", "order_payments", "financial_transactions", "products", "bank_accounts", "customers"]

        def snapshot():
            with closing(sqlite3.connect(self.database)) as db:
                db.row_factory = sqlite3.Row
                return {table: [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY id")] for table in tables}

        before = snapshot()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", path + "/reactivate"), range(8)))
        self.assertTrue(all(status == 200 and row["status"] == "active" for status, row in results), results)
        self.assertEqual(self.request("GET", path)[1], {**completed, "status": "active"})
        before["orders"][0]["status"] = "active"
        self.assertEqual(snapshot(), before)
        active = self.request("GET", "/orders?status=active")[1]
        self.assertEqual((active["total_orders"], active["active_orders"]), (1, 1))
        self.assertEqual([row["id"] for row in active["items"]], [order["id"]])
        self.assertEqual(self.request("GET", "/orders?status=completed")[1]["items"], [])
        self.assertEqual(self.request("POST", path + "/reactivate")[1]["status"], "active")
        self.assertEqual(self.request("POST", path + "/complete")[1]["status"], "completed")
        self.assertEqual(self.request("POST", path + "/reactivate")[1]["status"], "active")

    def test_reactivation_auth_missing_draft_deleted_and_unpaid(self):
        order = self.post("/orders", self.payload(payments=[]))
        path = f'/orders/{order["id"]}'
        self.assertEqual(self.request("POST", path + "/reactivate", authenticated=False)[0], 401)
        self.assertEqual(self.request("POST", "/orders/999999/reactivate")[0], 404)
        self.assertEqual(self.request("POST", path + "/complete")[0], 200)
        status, active = self.request("POST", path + "/reactivate")
        self.assertEqual(status, 200, active)
        self.assertEqual((active["status"], active["paid"], active["remaining"]), ("active", 0, 2000))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE orders SET deleted_at='2026-10-30' WHERE id=?", (order["id"],))
        self.assertEqual(self.request("POST", path + "/reactivate")[0], 404)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO orders(request_id,request_fingerprint,invoice_code,order_number,customer_id,invoice_date,payment_date,subtotal,discount,status,created_at) VALUES('return-draft','draft','RETURN-DRAFT','RETURN-DRAFT',?,'2026-10-14','2026-10-14',100,0,'completed','2026-10-14')", (self.customer["id"],))
            draft_id = db.execute("SELECT id FROM orders WHERE request_id='return-draft'").fetchone()[0]
        self.assertEqual(self.request("POST", f'/orders/{draft_id}/reactivate')[0], 409)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT status FROM orders WHERE id=?", (draft_id,)).fetchone()[0], "completed")

    def test_completion_auth_missing_draft_and_unpaid_order(self):
        order = self.post("/orders",self.payload(payments=[]))
        path=f'/orders/{order["id"]}'
        self.assertEqual(self.request("GET",path,authenticated=False)[0],401)
        self.assertEqual(self.request("POST",path+"/complete",authenticated=False)[0],401)
        self.assertEqual(self.request("GET","/orders/999999")[0],404)
        self.assertEqual(self.request("POST","/orders/999999/complete")[0],404)
        status, completed = self.request("POST",path+"/complete")
        self.assertEqual(status,200,completed)
        self.assertEqual((completed["status"],completed["paid"],completed["remaining"]),("completed",0,2000))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO orders(request_id,request_fingerprint,invoice_code,order_number,customer_id,invoice_date,payment_date,subtotal,discount,status,created_at) VALUES('test-draft','draft','DRAFT','DRAFT',?,'2026-10-14','2026-10-14',100,0,'active','2026-10-14')",(self.customer["id"],))
            draft_id=db.execute("SELECT id FROM orders WHERE request_id='test-draft'").fetchone()[0]
        self.assertEqual(self.request("POST",f'/orders/{draft_id}/complete')[0],409)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT status FROM orders WHERE id=?",(draft_id,)).fetchone()[0],"active")


if __name__ == "__main__":
    unittest.main()
