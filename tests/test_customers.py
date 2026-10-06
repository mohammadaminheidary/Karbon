"""Real HTTP/SQLite integration checks. Never uses the application's live database.
Run: python3 -m unittest discover -s tests -v
"""
import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class CustomersIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="karbon-customers-")
        cls.database = str(Path(cls.temp.name) / "test.db")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}/api"
        cls.log = open(Path(cls.temp.name) / "server.log", "w+")
        env = dict(os.environ, KARBON_DATABASE_PATH=cls.database, KARBON_JWT_SECRET="isolated-test-secret-only")
        bootstrap = f'''
import app
from database import SessionLocal
from models.user import User
from security.password import hash_password
import uvicorn
with SessionLocal() as db:
    db.add(User(username="customers-test", password_hash=hash_password("test-password")))
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port={cls.port}, log_level="warning")
'''
        cls.server = subprocess.Popen([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            try:
                status, data = cls.request("POST", "/login", {"username": "customers-test", "password": "test-password"}, authenticated=False)
                if status == 200:
                    cls.token = data["token"]
                    break
            except OSError:
                pass
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            time.sleep(0.05)
        else:
            raise RuntimeError("Test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, body=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {cls.token}"
        request = urllib.request.Request(cls.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM customers")

    def create(self, **changes):
        payload = {"first_name": "علی", "last_name": "رضایی", "gender": "male", "phone_numbers": []}
        payload.update(changes)
        status, data = self.request("POST", "/customers", payload)
        self.assertEqual(status, 201, data)
        return data

    def test_authentication_and_existing_routes(self):
        for method, path, body in [("GET", "/customers", None), ("GET", "/customers/next-code", None), ("GET", "/customers/1", None), ("POST", "/customers", {"first_name": "x", "last_name": "y"}), ("PUT", "/customers/1", {"first_name": "x", "last_name": "y"}), ("DELETE", "/customers/1", None)]:
            self.assertEqual(self.request(method, path, body, False)[0], 401)
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)
        self.assertEqual(self.request("GET", "/members")[0], 200)
        self.assertEqual(self.request("POST", "/login", {"username": "customers-test", "password": "wrong"}, False)[0], 401)

    def test_empty_create_and_persistence(self):
        self.assertEqual(self.request("GET", "/customers")[1]["total"], 0)
        preview = self.request("GET", "/customers/next-code")[1]["customer_code"]
        customer = self.create(first_name="  علي  ", last_name="  رضايي ", address="  تهران  ", notes="توضیحات", last_contact_date="2026-10-06")
        self.assertEqual(customer["customer_code"], preview)
        self.assertEqual(customer["first_name"], "علی")
        self.assertEqual(customer["last_name"], "رضایی")
        self.assertEqual(customer["phone_numbers"], [])
        self.assertEqual(customer["summary"]["status"], "no_payment")
        self.assertFalse(customer["summary"]["available"])
        with closing(sqlite3.connect(self.database)) as db, db:
            row = db.execute("SELECT phone_numbers, notes FROM customers WHERE id=?", (customer["id"],)).fetchone()
            self.assertEqual(json.loads(row[0]), [])
            self.assertEqual(row[1], "توضیحات")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
        self.assertEqual(self.request("GET", f'/customers/{customer["id"]}')[1]["address"], "تهران")

    def test_phone_normalization_edit_primary_and_delete_all(self):
        one = self.create(phone_numbers=["۰۹۱۲ ۱۲۳-۴۵۶۷"])
        self.assertEqual(one["phone_numbers"], ["09121234567"])
        customer = self.create(first_name="سارا", gender="female", phone_numbers=["+98 (935) 123-4567", "۰۲۱۱۲۳۴۵۶۷۸", "00989351234567"])
        self.assertEqual(customer["phone_numbers"], ["09351234567", "02112345678"])
        payload = {"first_name": "سارا", "last_name": "احمدی", "phone_numbers": customer["phone_numbers"][1:]}
        status, updated = self.request("PUT", f'/customers/{customer["id"]}', payload)
        self.assertEqual(status, 200)
        self.assertEqual(updated["phone_numbers"][0], "02112345678")
        self.assertEqual(updated["customer_code"], customer["customer_code"])
        payload["phone_numbers"] = []
        self.assertEqual(self.request("PUT", f'/customers/{customer["id"]}', payload)[1]["phone_numbers"], [])

    def test_duplicate_warning_name_phone_both_and_override(self):
        customer = self.create(phone_numbers=["09121234567"])
        for payload, name_match, phones in [
            ({"first_name": "علی", "last_name": "رضایی"}, True, []),
            ({"first_name": "سارا", "last_name": "احمدی", "phone_numbers": ["+989121234567"]}, False, ["09121234567"]),
            ({"first_name": "علی", "last_name": "رضایی", "phone_numbers": ["09121234567"]}, True, ["09121234567"]),
        ]:
            status, warning = self.request("POST", "/customers", payload)
            self.assertEqual(status, 409)
            self.assertEqual(warning["detail"]["code"], "DUPLICATE_CUSTOMER")
            match = warning["detail"]["matches"][0]
            self.assertEqual(match["name_match"], name_match)
            self.assertEqual(match["matching_phones"], phones)
        self.assertEqual(self.request("GET", "/customers")[1]["total"], 1)
        self.assertEqual(self.request("PUT", f'/customers/{customer["id"]}', {"first_name": "علی", "last_name": "رضایی", "phone_numbers": ["09121234567"]})[0], 200)
        other = self.create(first_name="سارا", last_name="احمدی")
        payload = {"first_name": "علی", "last_name": "رضایی"}
        self.assertEqual(self.request("PUT", f'/customers/{other["id"]}', payload)[0], 409)
        payload["confirm_duplicate"] = True
        self.assertEqual(self.request("PUT", f'/customers/{other["id"]}', payload)[0], 200)
        self.assertEqual(self.request("POST", "/customers", payload)[0], 201)

    def test_search_pagination_and_literal_sql_input(self):
        customer = self.create(phone_numbers=["09121234567", "02112345678"])
        self.create(first_name="سارا", last_name="احمدی")
        for query in [str(customer["customer_code"]), "علي", "رضایی", "علی رضایی", "۰۹۱۲", "02112345678", "+989121234567", "00989121234567"]:
            status, result = self.request("GET", "/customers?" + urllib.parse.urlencode({"search": query}))
            self.assertEqual(status, 200)
            self.assertEqual(result["total"], 1, query)
        for query in ["ناشناخته", "%' OR 1=1 --", "%", "_"]:
            self.assertEqual(self.request("GET", "/customers?" + urllib.parse.urlencode({"search": query}))[1]["total"], 0)
        status, page = self.request("GET", "/customers?skip=1&limit=1")
        self.assertEqual(page["total"], 2)
        self.assertEqual(len(page["items"]), 1)

    def test_validation_and_code_protection(self):
        for payload in [{"first_name": " ", "last_name": "x"}, {"first_name": "x"}, {"first_name": "x", "last_name": "y", "phone_numbers": ["invalid"]}, {"first_name": "x", "last_name": "y", "customer_code": 9999}, {"first_name": "x", "last_name": "y", "gender": "invalid"}, {"first_name": "x", "last_name": "y", "last_contact_date": "2026-02-31"}, {"first_name": "x", "last_name": "y", "phone_numbers": ["1234567"] * 21}, {"first_name": "x", "last_name": "y", "notes": "x" * 5001}]:
            self.assertEqual(self.request("POST", "/customers", payload)[0], 422, payload)
        self.assertEqual(self.request("GET", "/customers?limit=101")[0], 422)
        self.assertEqual(self.request("GET", "/customers/999999")[0], 404)

    def test_jalali_contact_date_conversion_validation_edit_and_clear(self):
        for index, (jalali, gregorian) in enumerate([
            ("۱۴۰۵/۰۷/۱۴", "2026-10-06"),
            ("١٤٠٥/٠٧/١٤", "2026-10-06"),
            ("1405/7/14", "2026-10-06"),
            ("1403/12/30", "2025-03-20"),
            ("1405/1/1", "2026-03-21"),
        ]):
            customer = self.create(first_name=f"تست شمسی {index}", last_contact_date=jalali)
            self.assertEqual(customer["last_contact_date"], gregorian)
            with closing(sqlite3.connect(self.database)) as db:
                self.assertEqual(db.execute("SELECT last_contact_date FROM customers WHERE id=?", (customer["id"],)).fetchone()[0], gregorian)
        for invalid in ["1404/12/30", "1405/7/31", "1405/13/1", "1405/2/32", "1405/7/no", "0000/1/1", "9999/1/1"]:
            status, error = self.request("POST", "/customers", {"first_name": "تست", "last_name": "تاریخ نامعتبر", "last_contact_date": invalid})
            self.assertEqual(status, 422, invalid)
            self.assertEqual(error["detail"][0]["loc"], ["body", "last_contact_date"])
        payload = {"first_name": customer["first_name"], "last_name": customer["last_name"], "last_contact_date": "۱۴۰۵/۰۷/۱۴"}
        status, edited = self.request("PUT", f'/customers/{customer["id"]}', payload)
        self.assertEqual(status, 200)
        self.assertEqual(edited["last_contact_date"], "2026-10-06")
        payload["last_contact_date"] = None
        self.assertIsNone(self.request("PUT", f'/customers/{customer["id"]}', payload)[1]["last_contact_date"])

    def test_hard_delete_reuses_display_code_and_preserves_internal_sequence(self):
        customer = self.create()
        self.assertEqual(self.request("DELETE", f'/customers/{customer["id"]}')[0], 204)
        self.assertEqual(self.request("GET", f'/customers/{customer["id"]}')[0], 404)
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM customers").fetchone()[0], 0)
        next_customer = self.create()
        self.assertEqual(next_customer["customer_code"], customer["customer_code"])
        self.assertGreater(next_customer["id"], customer["id"])

    def test_concurrent_creates_unique_codes_and_duplicate_lock(self):
        def create_unique(index):
            return self.request("POST", "/customers", {"first_name": f"customer {index}", "last_name": "concurrent"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(create_unique, range(12)))
        self.assertTrue(all(status == 201 for status, _ in results), results)
        self.assertEqual(len({data["customer_code"] for _, data in results}), 12)
        def create_same(_):
            return self.request("POST", "/customers", {"first_name": "same", "last_name": "concurrent"})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(create_same, range(4)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(409), 3)


if __name__ == "__main__":
    unittest.main()
