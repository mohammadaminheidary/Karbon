"""Authentication boundary checks against an isolated real HTTP service."""
import bcrypt
import sqlite3
from contextlib import closing
import json
import re
import urllib.request
import unittest
from jose import jwt
import test_customers as fixtures


class AccessSecurityTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(fixtures.CustomersIntegrationTests.request.__func__)

    def test_all_api_operations_and_session_lifecycle(self):
        with urllib.request.urlopen(self.base.removesuffix('/api') + '/openapi.json') as response:
            paths = json.load(response)['paths']
        count = 0
        for path, operations in paths.items():
            if not path.startswith('/api/') or path == '/api/login':
                continue
            concrete = re.sub(r'\{[^}]+\}', '1', path).removeprefix('/api')
            for method in operations:
                if method not in {'get', 'post', 'put', 'patch', 'delete'}:
                    continue
                with self.subTest(method=method, path=path):
                    self.assertEqual(self.request(method.upper(), concrete, authenticated=False)[0], 401)
                    count += 1
        self.assertGreater(count, 70)
        # Existing low-cost hashes upgrade transparently without changing identity.
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE users SET password_hash=? WHERE id=1", (bcrypt.hashpw(b"test-password", bcrypt.gensalt(rounds=4)).decode(),))
        self.assertEqual(self.request('POST', '/login', {'username': 'customers-test', 'password': 'test-password'}, False)[0], 200)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT password_hash FROM users WHERE id=1").fetchone()[0].split('$')[2], '12')
        valid = type(self).token
        for claims in [
            {'sub': 'customers-test', 'uid': 1, 'ver': 0},  # Missing expiry.
            {'sub': 'customers-test', 'uid': 1, 'ver': 0, 'exp': 1},
            {'sub': 'customers-test', 'uid': True, 'ver': 0, 'exp': 9999999999},
            {'sub': 'customers-test', 'uid': 1, 'ver': 99, 'exp': 9999999999},
        ]:
            type(self).token = jwt.encode(claims, 'isolated-test-secret-only', algorithm='HS256')
            self.assertEqual(self.request('GET', '/auth/me')[0], 401)
        type(self).token = valid + 'tampered'
        self.assertEqual(self.request('GET', '/auth/me')[0], 401)
        type(self).token = valid
        self.assertEqual(self.request('GET', '/auth/me')[0], 200)
        self.assertEqual(self.request('GET', '/dashboard')[0], 200)
        self.assertEqual(self.request('POST', '/auth/logout')[0], 204)
        self.assertEqual(self.request('GET', '/auth/me')[0], 401)
        self.assertEqual(self.request('GET', '/customers')[0], 401)
        status, login = self.request('POST', '/login', {'username': 'customers-test', 'password': 'test-password'}, False)
        self.assertEqual(status, 200)
        type(self).token = login['token']
        self.assertEqual(self.request('GET', '/auth/me')[0], 200)
        self.assertEqual(self.request('GET', '/customers')[0], 200)
        with urllib.request.urlopen(urllib.request.Request(self.base + '/auth/me', headers={'Authorization': 'Bearer ' + login['token']})) as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        wrong = self.request('POST', '/login', {'username': 'customers-test', 'password': 'wrong'}, False)
        unknown = self.request('POST', '/login', {'username': 'nonexistent', 'password': 'wrong'}, False)
        self.assertEqual(wrong, unknown)
        # IP throttling survives successful login to a known account.
        for _ in range(3):
            self.assertEqual(self.request('POST', '/login', {'username': 'customers-test', 'password': 'wrong'}, False)[0], 401)
        self.assertEqual(self.request('POST', '/login', {'username': 'customers-test', 'password': 'test-password'}, False)[0], 429)
        print(f'Checked {count} protected API operations, JWT claims, logout/relogin, generic failures and lockout')
