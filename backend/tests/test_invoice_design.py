"""Verify invoice settings and issuance against the authenticated HTTP API and SQLite."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
import sqlite3
import unittest
from uuid import uuid4

from PIL import Image

import test_customers


PATH = "/settings/invoice-design"
SETTINGS = ("store", "signatures", "sale_finance", "purchase_finance", "sale_numbering", "purchase_numbering")


class InvoiceDesignTests(unittest.TestCase):
    setUpClass = classmethod(test_customers.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(test_customers.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(test_customers.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("""INSERT OR IGNORE INTO users (username, password_hash)
                          SELECT 'admin', password_hash FROM users WHERE username='customers-test'""")
        self.member = self.token
        self.admin = self.request("POST", "/login", {"username": "admin", "password": "test-password"}, False)[1]["token"]

    def admin_request(self, method, path, body=None):
        token = type(self).token
        try:
            type(self).token = self.admin
            return self.request(method, path, body)
        finally:
            type(self).token = token

    def ok(self, method, path, body=None, status=200, admin=True):
        result, response = (self.admin_request if admin else self.request)(method, path, body)
        self.assertEqual(result, status, response)
        return response

    def save(self, config):
        body = {key: config[key] for key in (*SETTINGS, "revision")}
        return self.ok("PUT", PATH, body)

    def template(self, kind, config):
        return next(row for row in config["templates"] if row["kind"] == kind and row["default"])

    def test_validation_permissions_and_immutable_real_invoices(self):
        config = self.ok("GET", PATH)
        self.assertTrue(config["editable"])
        self.assertFalse(self.ok("GET", PATH, admin=False)["editable"])
        self.assertEqual(self.request("GET", PATH, authenticated=False)[0], 401)
        self.assertEqual(self.request("POST", PATH + "/templates", {"name": "denied", "kind": "sale"})[0], 403)
        self.assertEqual(self.request("PUT", PATH, {key: config[key] for key in (*SETTINGS, "revision")})[0], 403)
        self.ok("POST", PATH + "/assets", {"data": base64.b64encode(b"<svg/>").decode()}, 422)
        image = BytesIO()
        Image.new("RGB", (200, 70), "blue").save(image, format="PNG")
        original = base64.b64encode(image.getvalue()).decode()
        asset = self.ok("POST", PATH + "/assets", {"data": original}, 201)
        self.assertEqual(self.ok("POST", PATH + "/assets", {"data": original}, 201), asset)

        config["store"].update(name="فروشگاه ثابت 123", logo=asset["id"])
        config["sale_finance"].update(discount_kind="percent", discount_value=1000, tax_enabled=True, tax_rate=1000, shipping=70)
        config["purchase_finance"].update(discount_kind="fixed", discount_value=30, shipping=20)
        config["sale_numbering"].update(mode="automatic", start=20, prefix="S-", suffix="-A", digits=5, yearly=True)
        config["purchase_numbering"].update(mode="manual")
        saved = self.save(config)
        self.ok("PUT", PATH, {key: config[key] for key in (*SETTINGS, "revision")}, 409)

        default = self.template("sale", config)
        purchase_default = self.template("purchase", config)
        self.ok("DELETE", f"{PATH}/templates/{default['id']}?revision={default['revision']}", status=409)
        standard = self.ok("GET", f"{PATH}/templates/{default['id']}")
        template = self.ok("POST", PATH + "/templates", {"name": "چیدمان ویژه", "kind": "sale", "copy_from": default["id"]}, 201)
        self.assertEqual(template["layout"], standard["layout"])
        template_path = f"{PATH}/templates/{template['id']}"
        layout = template["layout"]
        layout["elements"][0]["text"] = "نسخه اولیه"
        template = self.ok("PUT", template_path, {key: template[key] for key in ("revision", "name", "layout")})
        self.ok("PUT", template_path + "/default", status=204)

        buyer = self.ok("POST", "/customers", {"first_name": "مشتری", "last_name": str(uuid4())}, 201, admin=False)
        supplier = self.ok("POST", "/customers", {"first_name": "تأمین", "last_name": str(uuid4())}, 201, admin=False)
        product = self.ok("POST", "/products", {"name": "فروش آزمایشی", "unit": "عدد", "price": 1000, "stock": 100}, 201, admin=False)
        day = "1405/08/10"
        sale = {"request_id": str(uuid4()), "customer_id": buyer["id"], "invoice_date": day, "payment_date": day,
                "items": [{"product_id": product["id"], "quantity": 2, "unit_price": 1000}],
                "payments": [{"method": "cash", "amount": 1400}], "invoice_settings_revision": saved["revision"]}
        order = self.ok("POST", "/orders", sale, 201, admin=False)
        self.assertEqual((order["discount"], order["tax"], order["shipping"], order["total"], order["remaining"]),
                         (200, 180, 70, 2050, 650))
        self.assertEqual(order["invoice_code"], "S-1405-00020-A")
        totals = self.ok("GET", f"/customers/{buyer['id']}", admin=False)["summary"]
        self.assertEqual((totals["total_orders"], totals["debt"]), (2050, 650))

        receipt = {"request_id": str(uuid4()), "purchase_date": day, "supplier_id": supplier["id"],
                   "invoice_number": "SUP-۰۰۱", "rows": [{"category_id": product["category_id"],
                   "product_id": product["id"], "quantity": 3, "purchase_price": 600}]}
        purchase = self.ok("POST", "/purchases", receipt, 201, admin=False)
        self.assertEqual((purchase["invoice_number"], purchase["total"]), ("SUP-001", 1790))
        self.assertEqual(self.ok("POST", "/purchases", receipt, 201, admin=False), purchase)
        duplicate = self.ok("POST", "/purchases", {**receipt, "request_id": str(uuid4())}, 409, admin=False)
        self.assertEqual(duplicate["detail"]["code"], "INVOICE_NUMBER_TAKEN")

        sale_path = f"/orders/{order['id']}/invoice"
        purchase_path = f"/purchases/{purchase['id']}/invoice"
        issued = self.ok("GET", sale_path, admin=False)
        received = self.ok("GET", purchase_path, admin=False)
        self.assertEqual(issued["presentation"]["images"]["logo"], "data:image/png;base64," + original)
        self.assertEqual(issued["presentation"]["layout"]["elements"][0]["text"], "نسخه اولیه")
        self.assertEqual(received["presentation"]["kind"], "purchase")
        self.assertEqual(received["supplier"]["code"], supplier["customer_code"])
        self.assertNotEqual(received["presentation"]["layout_version"], issued["presentation"]["layout_version"])

        alter = template["layout"]
        alter["elements"][0]["text"] = "نسخه دوم"
        body = {**{key: template[key] for key in ("revision", "name")}, "layout": alter}
        updated = self.ok("PUT", template_path, body)
        self.ok("PUT", template_path, body, 409)
        invalid = {**body, "revision": updated["revision"]}
        invalid["layout"]["elements"][0]["x"] = 400
        self.ok("PUT", template_path, invalid, 422)
        self.ok("PUT", f"{PATH}/templates/{default['id']}/default", status=204)
        self.ok("DELETE", f"{template_path}?revision={updated['revision']}", status=204)
        self.assertFalse(self.ok("GET", f"{PATH}/templates/{purchase_default['id']}")["layout"]["elements"][0]["text"])
        saved["store"].update(name="فروشگاه جدید", logo=None)
        self.save(saved)
        self.assertEqual(issued, self.ok("GET", sale_path))
        self.assertEqual(received, self.ok("GET", purchase_path))
        self.assertEqual(self.ok("POST", "/orders", sale, 201, admin=False)["id"], order["id"])
        stale = {**sale, "request_id": str(uuid4())}
        self.assertEqual(self.ok("POST", "/orders", stale, 409, admin=False)["detail"]["code"], "INVOICE_SETTINGS_CHANGED")

    def test_yearly_sequences_are_allocated_under_concurrency(self):
        config = self.ok("GET", PATH)
        config["sale_numbering"].update(mode="automatic", start=30, prefix="Q-", suffix="", digits=3, yearly=True)
        config["sale_finance"].update(tax_enabled=False, discount_value=0, shipping=0)
        self.save(config)
        customer = self.ok("POST", "/customers", {"first_name": "شماره‌گذاری", "last_name": str(uuid4())}, 201)
        service = self.ok("POST", "/products", {"name": "خدمت شماره‌گذاری", "unit": "عدد", "price": 125}, 201)

        def payload(day):
            return {"request_id": str(uuid4()), "customer_id": customer["id"], "invoice_date": day, "payment_date": day,
                    "items": [{"product_id": service["id"], "quantity": 1, "unit_price": 125}]}

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda index: self.request("POST", "/orders", payload("1405/08/10")), range(6)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual({value["invoice_code"] for _, value in results}, {f"Q-1405-{index:03}" for index in range(30, 36)})
        next_year = self.ok("POST", "/orders", payload("1406/01/02"), 201)
        self.assertEqual(next_year["invoice_code"], "Q-1406-030")
