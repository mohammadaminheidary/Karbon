"""Destructive factory reset tests on seeded, disposable SQLite databases."""
from base64 import b64decode
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from cryptography.fernet import Fernet

import test_backup as fixtures


RESET = "/api/settings/factory-reset"
CAPTCHA = "AAAAAA"


class FactoryResetTests(TestCase):
    call = staticmethod(fixtures.BackupIntegrationTests.call)
    start = classmethod(fixtures.BackupIntegrationTests.start.__func__)

    @classmethod
    def setUpClass(cls):
        temporary = TemporaryDirectory(prefix="karbon-reset-test-")
        cls.addClassCleanup(temporary.cleanup)
        cls.root = Path(temporary.name)
        cls.database = cls.root / "source.db"
        with closing(sqlite3.connect(cls.database)) as db, db:
            db.execute("""CREATE TABLE factory_reset_challenges (
                user_id INTEGER PRIMARY KEY, challenge_id VARCHAR(32) NOT NULL, owner VARCHAR(64) NOT NULL,
                answer_digest VARCHAR(64) NOT NULL, issued_at INTEGER NOT NULL
            )""")
            db.execute("INSERT INTO factory_reset_challenges VALUES (999, 'legacy', 'owner', 'digest', 0)")
        cls.bootstrap = fixtures.BOOTSTRAP.replace("import app\n", "import app\nfrom routes import factory_reset\nfactory_reset.choice = lambda _: 'A'\n")
        with mock.patch.object(fixtures, "BOOTSTRAP", cls.bootstrap):
            key = Fernet.generate_key()
            cls.host = cls.start("source", "Asia/Tehran", key)
            cls.peer = cls.start("source", "Asia/Tehran", key)

    def login(self, username="admin", password=fixtures.PASSWORD):
        return self.call(self.host, "/api/login", "POST", {"username": username, "password": password})

    def issue(self, token):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE factory_reset_challenges SET issued_at=issued_at-3")
        result = self.call(self.host, RESET + "/challenge", "POST", token=token)
        self.assertEqual(result[0], 200, result[1])
        data = result[1]
        mime, image = data["image"].split(",", 1)
        self.assertEqual(mime, "data:image/png;base64")
        self.assertTrue(b64decode(image).startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(set(data), {"challenge_id", "image", "expires_in"})
        return {"challenge_id": data["challenge_id"], "captcha": CAPTCHA, "confirmation": "ریست داده‌های کاری",
                "acknowledge": True, "current_password": fixtures.PASSWORD}

    def submit(self, token, body, host=None):
        return self.call(host or self.host, RESET, "POST", body, token)

    def test_factory_reset_rejects_invalid_requests_and_rebuilds_every_module(self):
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT consumed, failed_attempts, failure_window FROM factory_reset_challenges "
                                        "WHERE user_id=999").fetchone(), (1, 0, 0))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE bank_accounts SET opening_balance=700")
            db.execute("INSERT INTO inventory_options (id,kind,name,active) VALUES (110,'categories','Master category',1)")
            db.execute("INSERT INTO inventory_options (id,kind,name,active,parent_id) VALUES (109,'categories','Master child',1,110)")
            db.execute("UPDATE products SET category_id=109 WHERE id=1")
            db.execute("UPDATE invoice_settings SET data=json_set(data, '$.scope', 'existing-store')")
            credentials = db.execute("SELECT username, password_hash FROM users ORDER BY id").fetchall()
        admin = self.login()[1]["token"]
        staff = self.login("staff")[1]["token"]
        self.assertEqual(self.call(self.host, RESET + "/challenge", "POST")[0], 401)
        self.assertEqual(self.call(self.host, RESET + "/challenge", "POST", token=staff)[0], 403)
        self.assertEqual(self.submit(staff, {})[0], 403)
        backup = self.call(self.host, fixtures.API, "POST", {"passphrase": fixtures.PASSPHRASE}, admin)
        self.assertEqual(backup[0], 201, backup[1])
        archive = self.root / "backup" / backup[1]["filename"]
        self.assertTrue(archive.is_file())
        body = self.issue(admin)
        self.assertEqual(self.call(self.host, RESET + "/challenge", "POST", token=admin)[0], 429)
        self.assertEqual(self.submit(admin, {**body, "confirmation": "ریست کامل کاربن"})[0], 422)
        bad = self.submit(admin, {**body, "new_password": "legacy-secret"})
        self.assertEqual(bad[0], 422)
        self.assertNotIn("legacy-secret", str(bad[1]))
        self.assertEqual(self.submit(admin, {**body, "captcha": "BBBBBB"}, host=self.peer)[0], 403)
        self.assertEqual(self.submit(admin, body)[0], 403)
        body = self.issue(admin)
        self.assertEqual(self.submit(admin, {**body, "current_password": "incorrect-current"})[0], 403)
        body = self.issue(admin)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE factory_reset_challenges SET issued_at=0")
        self.assertEqual(self.submit(admin, body)[0], 403)
        self.assertEqual(self.call(self.host, "/api/products", token=admin)[1][0]["stock"], 19)

        body = self.issue(admin)
        (self.root / "fail").touch()
        self.assertEqual(self.submit(admin, body)[0], 500)
        (self.root / "fail").unlink()
        self.assertEqual(self.call(self.host, "/api/products", token=admin)[1][0]["stock"], 19)
        self.assertEqual(self.submit(admin, self.issue(admin), host=self.peer)[:2], (200, {"status": "completed"}))
        self.assertTrue(archive.is_file())
        for host in (self.host, self.peer):
            for token in (admin, staff):
                self.assertEqual(self.call(host, "/api/auth/me", token=token)[0], 401)
        self.assertEqual(self.login("staff")[0], 200)
        new_token = self.login()[1]["token"]
        product = self.call(self.peer, "/api/products", token=new_token)[1][0]
        self.assertEqual((product["id"], product["name"], product["category_id"], product["stock"]), (1, "stock item", 109, 0))
        self.assertEqual(self.call(self.host, "/api/settings/inventory-options", token=new_token)[0], 200)
        with closing(sqlite3.connect(self.database)) as db:
            for table in ("customers", "financial_transactions", "orders", "order_items", "purchases",
                          "attendance", "tasks", "fiscal_snapshots", "factory_reset_challenges"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)
            self.assertEqual(db.execute("SELECT username, password_hash FROM users ORDER BY id").fetchall(), credentials)
            self.assertEqual(db.execute("SELECT account_number, opening_balance FROM bank_accounts").fetchall(), [("backup-account", 0)])
            self.assertEqual(db.execute("SELECT member_id FROM member_faces").fetchall(), [(1,)])
            self.assertEqual(db.execute("SELECT member_id FROM member_face_photos").fetchall(), [(1,)])
            self.assertEqual(db.execute("SELECT product_id, delta, tracked FROM fiscal_inventory_changes").fetchall(), [(1, 0, 1)])
            self.assertEqual(db.execute("SELECT json_extract(data, '$.scope') FROM invoice_settings").fetchone(), ("existing-store",))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_failed_attempt_budget_is_shared_across_workers(self):
        with mock.patch.object(fixtures, "BOOTSTRAP", self.bootstrap):
            key = Fernet.generate_key()
            self.database = self.root / "rate.db"
            self.host = self.start("rate", "UTC", key)
            self.peer = self.start("rate", "UTC", key)
        admin = self.login()[1]["token"]
        body = self.issue(admin)
        for index in range(5):
            self.assertEqual(self.submit(admin, {**body, "captcha": "BBBBBB"}, host=(self.host, self.peer)[index % 2])[0], 403)
        self.assertEqual(self.call(self.peer, RESET + "/challenge", "POST", token=admin)[0], 429)
        self.assertEqual(self.submit(admin, body)[0], 429)
