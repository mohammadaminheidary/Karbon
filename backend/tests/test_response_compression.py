"""Compression must preserve large financial responses and no-store semantics."""
import gzip
import json
import unittest
from urllib.request import Request, urlopen

import test_customers as customers


class ResponseCompressionTests(unittest.TestCase):
    setUpClass = classmethod(customers.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(customers.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(customers.CustomersIntegrationTests.request.__func__)

    def test_large_reports_are_identical_small_auth_responses_bypass_and_identity_works(self):
        path = self.base + '/dashboard?days=366'
        headers = {'Authorization': 'Bearer ' + self.token}
        with urlopen(Request(path, headers={**headers, 'Accept-Encoding': 'identity'})) as response:
            self.assertIsNone(response.headers.get('Content-Encoding'))
            before = response.read()
        with urlopen(Request(path, headers={**headers, 'Accept-Encoding': 'gzip'})) as response:
            self.assertEqual(response.headers['Content-Encoding'], 'gzip')
            self.assertIn('Accept-Encoding', response.headers['Vary'])
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            compressed = response.read()
            self.assertEqual(int(response.headers['Content-Length']), len(compressed))
            after = gzip.decompress(compressed)
        a, b = json.loads(before), json.loads(after)
        a.pop('generated_at');b.pop('generated_at')
        self.assertEqual(a, b)
        self.assertLess(len(compressed), len(before)/3)
        with urlopen(Request(path, headers={**headers, 'Accept-Encoding': 'gzip;q=0, identity;q=1'})) as response:
            self.assertIsNone(response.headers.get('Content-Encoding'))
            self.assertIn('Accept-Encoding', response.headers['Vary'])
            self.assertEqual(json.load(response)['finance'], a['finance'])
        with urlopen(Request(self.base + '/auth/me', headers={**headers, 'Accept-Encoding': 'gzip'})) as response:
            self.assertIsNone(response.headers.get('Content-Encoding'))
            self.assertTrue(json.load(response)['success'])
