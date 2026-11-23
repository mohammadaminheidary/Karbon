"""Manual backup HTTP integration using disposable SQLite databases and keys."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cryptography.fernet import Fernet
import pyzipper


ROOT = Path(__file__).resolve().parents[2]
API = "/api/settings/backup"
PASSWORD = "disposable-password"
PASSPHRASE = "backup test عبارت عبور"
BOOTSTRAP = r"""
from contextlib import closing
from datetime import date, datetime, time as clock
import os
from pathlib import Path
import sqlite3
import time

import numpy as np
import uvicorn

import app
import config
from database import SessionLocal
from models.attendance import Attendance
from models.customer import Customer
from models.finance import BankAccount, FinancialTransaction
from models.member import Member
from models.member_face import MemberFace, MemberFacePhoto
from models.order import Order, OrderItem, Product
from models.task import Task
from models.user import User
from security.face_templates import encrypt_template
from security.password import hash_password
from services import backup_service as backup, face_service as face

root = Path(os.environ["TEST_ROOT"])
source = os.environ["KARBON_TIMEZONE"] == "Asia/Tehran"
backup.BACKUP_DIRECTORY = root / "backup"
today = date(2026, 11, 22)
features = np.tile(np.eye(1, 128, dtype="<f4"), (3, 1))
with closing(sqlite3.connect(config.DATABASE_PATH)) as db:
    db.execute("PRAGMA journal_mode=WAL")
with SessionLocal() as db:
    if db.query(User).count() == 0:
        password = hash_password("disposable-password")
        db.add_all([User(username="admin", password_hash=password), User(username="staff", password_hash=password)])
        db.add(Task(title="source task" if source else "target task", date=today))
        if source:
            db.add_all([
                Customer(id=1, first_name="backup customer", last_name="test", customer_code=1),
                Product(id=1, name="stock item", unit="عدد", price=123, stock=19),
                Member(id=1, first_name="backup member", last_name="test"),
                BankAccount(id=1, name="test account", account_number="backup-account"),
            ])
            db.flush()
            db.add_all([
                Attendance(id=1, member_id=1, date=today, recorded_time=clock(12), status="present"),
                Order(id=1, request_id="restore-order", request_fingerprint="test", invoice_code="B-1",
                      order_number="1", customer_id=1, invoice_date=today, payment_date=today,
                      subtotal=123, discount=0, status="active"),
                FinancialTransaction(id=1, request_id="test-transaction", kind="income", customer_id=1,
                                     bank_id=1, title="backup finance", account_code="1", amount=123,
                                     transaction_date=today, transaction_time="12:00:00", time_mode="manual"),
                MemberFace(member_id=1, encrypted_template=encrypt_template(1, features.tobytes()),
                           consented_at=datetime.now()),
            ])
            db.flush()
            db.add(OrderItem(id=1, order_id=1, product_id=1, position=0, product_name="stock item",
                             unit="عدد", quantity=1, unit_price=123))
            db.add(MemberFacePhoto(member_id=1, angle="front", encrypted_image=encrypt_template(1, b"photo:front:sample")))
        db.commit()

# Simulate the extraction stage only. The actual encrypted template read and
# matching logic execute unchanged against the restored database.
def synthetic_extract(images):
    return features[:len(images)]
face.engine.extract = synthetic_extract
from contextlib import nullcontext
face.engine.session = nullcontext

original_copy = backup.copy_database
def test_copy(source, destination, *, restore=False):
    if restore and (root / "fail").exists():
        with closing(backup.database_connection(source, read_only=True, immutable=True)) as src,                 closing(backup.database_connection(destination, must_exist=True)) as dest:
            def abort(*args):
                raise OSError("test failure after SQLite backup began")
            src.backup(dest, pages=1, progress=abort)
    if restore and (root / "hold").exists():
        (root / "maintenance-ready").touch()
        deadline = time.monotonic() + 10
        while (root / "hold").exists() and time.monotonic() < deadline:
            time.sleep(.025)
    return original_copy(source, destination, restore=restore)
backup.copy_database = test_copy

from services import backup_folder
def test_desktop():
    if (root / "headless").exists():
        return None
    return lambda path: (root / "opened-folder").write_text(path)
backup_folder.desktop_opener = test_desktop

uvicorn.run(app.app, host="127.0.0.1", port=int(os.environ["TEST_PORT"]), log_level="warning")
"""


class BackupIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="karbon-backup-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.source_key, cls.target_key = Fernet.generate_key(), Fernet.generate_key()
        cls.source = cls.start("source", "Asia/Tehran", cls.source_key)
        with closing(sqlite3.connect(cls.root / "target.db")) as db:
            db.execute("PRAGMA page_size=8192")
            db.execute("VACUUM")
        cls.target = cls.start("target", "UTC", cls.target_key)
        cls.peer = cls.start("target", "UTC", cls.target_key)

    @classmethod
    def start(cls, name, zone, key):
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        log = (cls.root / f"{port}.log").open("w+")
        cls.addClassCleanup(log.close)
        env = dict(os.environ, TEST_ROOT=str(cls.root), TEST_PORT=str(port),
                   KARBON_DATABASE_PATH=str(cls.root / f"{name}.db"), KARBON_TIMEZONE=zone,
                   KARBON_JWT_SECRET="disposable-backup-test-only", KARBON_FACE_KEY=key.decode())
        process = subprocess.Popen([sys.executable, "-c", BOOTSTRAP], cwd=ROOT / "backend", env=env,
                                   stderr=log, stdout=log)

        def stop():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)

        cls.addClassCleanup(stop)
        base = f"http://127.0.0.1:{port}"
        for _ in range(200):
            try:
                if cls.call(base, "/api/health")[0] == 200:
                    return base
            except URLError:
                pass
            if process.poll() is not None:
                break
            time.sleep(.05)
        log.seek(0)
        raise RuntimeError(log.read())

    @staticmethod
    def call(base, path, method="GET", payload=None, token=None, headers=None):
        headers = dict(headers or {})
        if isinstance(payload, dict):
            payload = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        request = Request(base + path, method=method, headers=headers, data=payload)
        try:
            response = urlopen(request, timeout=30)
        except HTTPError as error:
            response = error
        with response:
            data = response.read()
            if data and response.headers.get_content_type() == "application/json":
                data = json.loads(data)
            return response.status, data, response.headers

    def login(self, host, username="admin"):
        status, body, _ = self.call(host, "/api/login", "POST", {"username": username, "password": PASSWORD})
        self.assertEqual(status, 200, body)
        return body["token"]

    def upload(self, archive, token, passphrase=PASSPHRASE, **headers):
        return self.call(self.target, API + "/validate", "POST", archive, token,
                         {"Content-Type": "application/zip",
                          "X-Karbon-Backup-Passphrase": base64.b64encode(passphrase.encode()).decode(), **headers})

    def dump(self):
        with closing(sqlite3.connect(self.root / "target.db")) as db:
            return list(db.iterdump())

    @staticmethod
    def members(archive):
        with pyzipper.AESZipFile(BytesIO(archive)) as files:
            files.setpassword(PASSPHRASE.encode())
            return {name: files.read(name) for name in files.namelist()}

    @staticmethod
    def make_archive(files):
        with BytesIO() as output:
            with pyzipper.AESZipFile(output, "w", compression=pyzipper.ZIP_DEFLATED) as archive:
                archive.setpassword(PASSPHRASE.encode())
                archive.setencryption(pyzipper.WZ_AES, nbits=256, force_wz_aes_version=2)
                for name, data in files.items():
                    archive.writestr(name, data)
            return output.getvalue()

    def test_access_permissions_local_and_remote_folder(self):
        token = self.login(self.source)
        staff = self.login(self.source, "staff")
        origin = {"Origin": "http://localhost:5501"}
        for path, method, body in [
            ("", "GET", None), ("", "POST", {"passphrase": PASSPHRASE}),
            ("/download/karbon-backup-20261122-123456.zip", "GET", None),
            ("/validate", "POST", None), ("/open-folder", "POST", None),
            ("/restore", "POST", {"passphrase": PASSPHRASE, "validation_id": "0" * 32, "confirm": True}),
        ]:
            with self.subTest(path=path, method=method):
                self.assertEqual(self.call(self.source, API + path, method, body, headers=origin)[0], 401)
                self.assertEqual(self.call(self.source, API + path, method, body, staff, origin)[0], 403)

        self.assertTrue(self.call(self.source, API, token=token, headers=origin)[1]["folder"]["available"])
        self.assertEqual(self.call(self.source, API + "/open-folder", "POST", token=token, headers=origin)[0], 204)
        self.assertEqual((self.root / "opened-folder").read_text(), str(self.root / "backup"))
        for remote in ({"Origin": "https://karbon.example.com"}, {**origin, "Forwarded": "for=203.0.113.7"}):
            self.assertFalse(self.call(self.source, API, token=token, headers=remote)[1]["folder"]["available"])
            self.assertEqual(self.call(self.source, API + "/open-folder", "POST", token=token, headers=remote)[0], 403)
        marker = self.root / "headless"
        marker.touch()
        try:
            source = self.call(self.source, API, token=token, headers=origin)[1]
            self.assertFalse(source["folder"]["available"])
            self.assertTrue(source["folder"]["reason"])
            self.assertEqual(self.call(self.source, API + "/open-folder", "POST", token=token, headers=origin)[0], 403)
        finally:
            marker.unlink()

    def test_create_download_validate_rollback_and_restore(self):
        source_token, target_token = self.login(self.source), self.login(self.target)
        reports = {}
        for fmt in ("xlsx", "pdf"):
            status, data, _ = self.call(self.source, f"/api/reports/customers/export/{fmt}", "POST",
                                        {"columns": ["first_name"]}, source_token)
            self.assertEqual(status, 200, data)
            reports[fmt] = data
        status, entries, _ = self.call(self.source, "/api/reports/history", token=source_token)
        self.assertEqual(status, 200)
        report_ids = {item["format"]: item["id"] for item in entries["items"]}

        # A writer holds an uncommitted change in WAL while Karbon snapshots.
        with closing(sqlite3.connect(self.root / "source.db")) as writer, ThreadPoolExecutor() as pool:
            writer.execute("UPDATE tasks SET title='uncommitted'")
            calls = [pool.submit(self.call, self.source, API, "POST", {"passphrase": PASSPHRASE}, source_token)
                     for _ in range(2)]
            results = [job.result() for job in calls]
            writer.rollback()
        for status, body, _ in results:
            self.assertEqual(status, 201, body)
        filenames = {result[1]["filename"] for result in results}
        self.assertEqual(len(filenames), 2)

        (self.root / "backup" / "karbon-backup-20261122-123456.zip").write_bytes(b"partial file")
        status, listing, _ = self.call(self.source, API, token=source_token)
        self.assertEqual(status, 200)
        items = listing["items"]
        self.assertEqual({item["filename"] for item in items}, filenames)
        self.assertEqual(items, sorted(items, key=lambda item: item["created_at"], reverse=True))
        name = items[0]["filename"]
        status, archive, headers = self.call(self.source, API + "/download/" + name, token=source_token)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(archive, (self.root / "backup" / name).read_bytes())
        self.assertEqual(items[0]["size_bytes"], len(archive))

        original = self.dump()
        self.assertEqual(self.upload(archive, target_token, "incorrect test passphrase")[0], 422)
        self.assertEqual(self.upload(archive[:100], target_token)[0], 422)
        self.assertEqual(self.upload(archive, target_token, **{"Content-Length": str(514 * 1024 * 1024)})[0], 413)
        files = self.members(archive)
        recovery = json.loads(files["recovery.json"])
        self.assertEqual(recovery, {"timezone": "Asia/Tehran", "face_key": self.source_key.decode()})
        manifest = json.loads(files["manifest.json"])
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["checksums"]["karbon.db"], sha256(files["karbon.db"]).hexdigest())

        wrong_db = self.root / "invalid.db"
        wrong_db.write_bytes(files["karbon.db"])
        with closing(sqlite3.connect(wrong_db)) as db, db:
            db.execute("PRAGMA foreign_keys=OFF")
            db.execute("UPDATE order_items SET product_id=999")
        corrupt_db = wrong_db.read_bytes()
        foreign_key_manifest = {**manifest, "checksums": {**manifest["checksums"], "karbon.db": sha256(corrupt_db).hexdigest()}}
        broken = b"broken SQLite snapshot"
        broken_manifest = {**manifest, "checksums": {**manifest["checksums"], "karbon.db": sha256(broken).hexdigest()}}
        for invalid in (
            {**files, "manifest.json": json.dumps({**manifest, "format_version": 999}).encode()},
            {**files, "recovery.json": b"{}"},
            {**files, "manifest.json": json.dumps(foreign_key_manifest).encode(), "karbon.db": corrupt_db},
            {**files, "manifest.json": json.dumps(broken_manifest).encode(), "karbon.db": broken},
            {"../karbon.db": files["karbon.db"], "manifest.json": files["manifest.json"], "recovery.json": files["recovery.json"]},
        ):
            self.assertEqual(self.upload(self.make_archive(invalid), target_token)[0], 422)
        self.assertEqual(self.upload(self.make_archive({**files, "recovery.json": b" " * 4097}), target_token)[0], 413)

        status, metadata, _ = self.upload(archive, target_token)
        self.assertEqual(status, 200, metadata)
        self.assertEqual(metadata["karbon_version"], "1.0.0")
        self.assertEqual(metadata["created_at"], manifest["created_at"])
        self.assertEqual(self.dump(), original)
        payload = {"confirm": True, "validation_id": metadata["validation_id"], "passphrase": PASSPHRASE}
        self.assertEqual(self.call(self.target, API + "/restore", "POST", {**payload, "confirm": False}, target_token)[0], 400)

        fail = self.root / "fail"
        fail.touch()
        try:
            self.assertEqual(self.call(self.target, API + "/restore", "POST", payload, target_token)[0], 500)
            self.assertEqual(self.dump(), original)
        finally:
            fail.unlink()
        self.assertEqual(self.call(self.peer, "/api/auth/me", token=target_token)[0], 200)

        hold = self.root / "hold"
        hold.touch()
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.call, self.target, API + "/restore", "POST", payload, target_token)
            try:
                for _ in range(200):
                    if (self.root / "maintenance-ready").exists() or pending.done():
                        break
                    time.sleep(.025)
                self.assertTrue((self.root / "maintenance-ready").exists())
                self.assertEqual(self.call(self.peer, "/api/tasks", token=target_token)[0], 503)
            finally:
                hold.unlink()
            status, result, _ = pending.result()
        self.assertEqual(status, 200, result)
        self.assertEqual(self.call(self.peer, "/api/auth/me", token=target_token)[0], 401)

        with closing(sqlite3.connect(self.root / "target.db")) as db:
            self.assertEqual(db.execute("PRAGMA page_size").fetchone(), (8192,))
            for sql, expected in [
                ("SELECT title FROM tasks", "source task"),
                ("SELECT first_name FROM customers", "backup customer"),
                ("SELECT stock FROM products", 19),
                ("SELECT subtotal FROM orders", 123),
                ("SELECT amount FROM financial_transactions", 123),
                ("SELECT status FROM attendance", "present"),
                ("SELECT COUNT(*) FROM users", 2),
                ("SELECT COUNT(*) FROM member_face_photos", 1),
            ]:
                self.assertEqual(db.execute(sql).fetchone(), (expected,))
        new_token = self.login(self.peer)
        self.assertEqual(self.call(self.peer, "/api/dashboard?view=summary", token=new_token)[1]["timezone"], "Asia/Tehran")
        self.assertEqual(self.call(self.peer, "/api/faces/check-in", "POST",
                                   {"images": ["x" * 32] * 2}, new_token)[1]["member"]["id"], 1)
        for fmt, report_id in report_ids.items():
            status, downloaded, _ = self.call(self.peer, f"/api/reports/history/{report_id}/download", token=new_token)
            self.assertEqual((status, downloaded), (200, reports[fmt]))

        safety_name = self.call(self.peer, API, token=new_token)[1]["items"][0]["filename"]
        self.assertNotIn(safety_name, filenames)
        safety = self.members(self.call(self.peer, API + "/download/" + safety_name, token=new_token)[1])
        self.assertEqual(json.loads(safety["recovery.json"])["timezone"], "UTC")
        self.assertTrue(safety["karbon.db"].startswith(b"SQLite format 3\x00"))
        safety_db = self.root / "safety.db"
        safety_db.write_bytes(safety["karbon.db"])
        with closing(sqlite3.connect(safety_db)) as db:
            self.assertEqual(db.execute("SELECT title FROM tasks").fetchone(), ("target task",))


if __name__ == "__main__":
    unittest.main()
