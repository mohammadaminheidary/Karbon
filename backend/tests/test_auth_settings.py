"""Security settings exercised over real HTTP against an isolated SQLite DB."""
from contextlib import closing
import concurrent.futures
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import bcrypt
from jose import jwt
import test_customers as fixtures


class AuthSettingsTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(fixtures.CustomersIntegrationTests.request.__func__)

    def setUp(self):
        hashed = bcrypt.hashpw(b"test-password", bcrypt.gensalt()).decode()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM users WHERE id != 1")
            db.execute("UPDATE users SET username=?, password_hash=?, auth_version=0 WHERE id=1", ("customers-test", hashed))
            db.execute("INSERT INTO users(username, password_hash) VALUES (?, ?)", ("other-user", hashed))
        status, data = self.request("POST", "/login", {"username": "customers-test", "password": "test-password"}, False)
        self.assertEqual(status, 200)
        type(self).token = data["token"]

    def change(self, kind, **changes):
        payload = {"current_password": "test-password"}
        payload.update({"username": "renamed-user"} if kind == "username" else {"new_password": "a new secure passphrase", "confirm_password": "a new secure passphrase"})
        payload.update(changes)
        return self.request("PUT", "/auth/" + kind, payload)

    def test_username_changes_are_unavailable(self):
        self.assertEqual(self.change("username")[0], 404)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT username, auth_version FROM users WHERE id=1").fetchone(), ("customers-test", 0))

    def test_short_and_long_passwords_hash_verify_and_relogin(self):
        current = "test-password"
        for secret in ["short7!", "a password considerably longer than fifteen characters"]:
            with self.subTest(length=len(secret)):
                status, result = self.change("password", current_password=current, new_password=secret, confirm_password=secret)
                self.assertEqual(status, 200, result)
                self.assertEqual(self.request("GET", "/auth/me")[0], 401)
                type(self).token = result["token"]
                with closing(sqlite3.connect(self.database)) as db:
                    hashed = db.execute("SELECT password_hash FROM users WHERE id=1").fetchone()[0]
                    self.assertNotEqual(hashed, secret)
                    self.assertTrue(bcrypt.checkpw(secret.encode(), hashed.encode()))
                self.assertEqual(self.request("POST", "/login", {"username": "customers-test", "password": secret}, False)[0], 200)
                self.assertEqual(self.change("password", current_password="wrong-password")[0], 403)
                current = secret

    def test_password_hash_persistence_relogin_and_unrelated_sessions(self):
        other = self.request("POST", "/login", {"username": "other-user", "password": "test-password"}, False)[1]
        with closing(sqlite3.connect(self.database)) as db:
            before = db.execute("SELECT password_hash FROM users WHERE id=1").fetchone()[0]
        status, result = self.change("password")
        self.assertEqual(status, 200, result)
        self.assertEqual(self.request("GET", "/members")[0], 401)
        type(self).token = result["token"]
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)
        self.assertEqual(self.request("POST", "/login", {"username": "customers-test", "password": "test-password"}, False)[0], 401)
        self.assertEqual(self.request("POST", "/login", {"username": "customers-test", "password": "a new secure passphrase"}, False)[0], 200)
        with closing(sqlite3.connect(self.database)) as db:
            hashed, version = db.execute("SELECT password_hash, auth_version FROM users WHERE id=1").fetchone()
            self.assertNotEqual(before, hashed)
            self.assertTrue(bcrypt.checkpw(b"a new secure passphrase", hashed.encode()))
            self.assertEqual(version, 1)
            self.assertEqual(db.execute("SELECT auth_version FROM users WHERE username='other-user'").fetchone()[0], 0)
        type(self).token = other["token"]
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)

    def test_validation_redaction_and_no_mutation_on_failure(self):
        self.assertEqual(self.request("PUT", "/auth/password", {}, False)[0], 401)
        self.assertEqual(self.change("password", current_password="incorrect-secret")[0], 403)
        for extra in [
            {"new_password": "", "confirm_password": ""},
            {"new_password": "x"*73, "confirm_password": "x"*73},
            {"confirm_password": "not-the-secret"},
            {"new_password": "ی"*37, "confirm_password": "ی"*37},
            {"new_password": " "*15, "confirm_password": " "*15},
            {"current_password": 123},
            {"unexpected": "secret-extra-field"},
        ]:
            status, result = self.change("password", **extra)
            self.assertEqual(status, 422, result)
            self.assertNotIn("test-password", str(result))
            self.assertNotIn("a new secure passphrase", str(result))
            self.assertNotIn("secret-extra-field", str(result))
            self.assertNotIn("not-the-secret", str(result))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT username, auth_version FROM users WHERE id=1").fetchone(), ("customers-test", 0))
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)

    def test_unicode_password_boundary_and_confirmation(self):
        secret = "ی" * 36  # 72 bytes, accepted without truncation.
        status, result = self.change("password", new_password=secret, confirm_password=secret)
        self.assertEqual(status, 200, result)
        type(self).token = result["token"]
        self.assertEqual(self.request("POST", "/login", {"username": "customers-test", "password": secret}, False)[0], 200)
        self.assertEqual(self.change("password", current_password=secret, new_password=secret, confirm_password=secret)[0], 422)

    def test_competing_changes_cannot_reuse_verified_credentials(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(self.change, kind) for kind in ["password", "password"]]
            statuses = sorted(f.result()[0] for f in requests)
        self.assertEqual(statuses[0], 200)
        self.assertIn(statuses[1], [401, 409])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT auth_version FROM users WHERE id=1").fetchone()[0], 1)

    def test_legacy_session_requires_new_login_to_avoid_username_reuse(self):
        type(self).token = jwt.encode({"sub": "customers-test", "exp": 9999999999}, "isolated-test-secret-only", algorithm="HS256")
        self.assertEqual(self.request("GET", "/auth/me")[0], 401)
        result = self.request("POST", "/login", {"username": "customers-test", "password": "test-password"}, False)[1]
        type(self).token = result["token"]
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)

    def test_z_rate_limit_password_changes(self):
        # A verified current password clears failures from earlier test cases.
        self.assertEqual(self.change("password", new_password="test-password", confirm_password="test-password")[0], 422)
        # Last: the intentionally exhausted per-account budget lasts one minute.
        for index in range(5):
            self.assertEqual(self.change("password", current_password="wrong")[0], 403)
        self.assertEqual(self.change("password")[0], 429)
        self.assertEqual(self.request("GET", "/auth/me")[0], 200)


class AuthMigrationTests(unittest.TestCase):
    def test_existing_database_migration_is_additive_and_idempotent(self):
        with tempfile.TemporaryDirectory(prefix="karbon-auth-migration-") as directory:
            database = str(Path(directory)/"old.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, created_at DATETIME)")
                db.execute("INSERT INTO users(username,password_hash) VALUES ('existing-user','existing-hash')")
            result = subprocess.run([sys.executable, "-c", "from database import engine; from services.auth_settings import initialize_auth_storage; initialize_auth_storage(engine); initialize_auth_storage(engine)"], cwd=fixtures.ROOT/"backend", env=dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="migration-only"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT username,password_hash,auth_version FROM users").fetchone(), ("existing-user", "existing-hash", 0))

    def test_admin_reset_migrates_old_database_and_revokes_sessions(self):
        with tempfile.TemporaryDirectory(prefix="karbon-admin-migration-") as directory:
            database = str(Path(directory)/"old.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, created_at DATETIME)")
                db.execute("INSERT INTO users(username,password_hash) VALUES ('admin','old-hash')")
            script = "from unittest.mock import patch; import runpy\nwith patch('getpass.getpass', return_value='new admin passphrase'):\n    runpy.run_path('create_user.py')"
            result = subprocess.run([sys.executable, "-c", script], cwd=fixtures.ROOT/"backend", env=dict(os.environ, KARBON_DATABASE_PATH=database, KARBON_JWT_SECRET="migration-only"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with closing(sqlite3.connect(database)) as db:
                hashed, version = db.execute("SELECT password_hash,auth_version FROM users WHERE username='admin'").fetchone()
                self.assertTrue(bcrypt.checkpw(b"new admin passphrase", hashed.encode()))
                self.assertEqual(version, 1)


if __name__ == "__main__":
    unittest.main()
