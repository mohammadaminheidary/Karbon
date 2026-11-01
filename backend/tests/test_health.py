"""Connection recovery uses a public, uncached, database-free liveness check."""
import json
import unittest
import urllib.request
import test_customers as fixtures


class HealthTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.CustomersIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.CustomersIntegrationTests.tearDownClass.__func__)
    request = classmethod(fixtures.CustomersIntegrationTests.request.__func__)

    def test_health_is_public_and_uncached_without_weakening_authentication(self):
        for headers in [{}, {"Authorization": "Bearer expired-or-invalid"}]:
            with urllib.request.urlopen(urllib.request.Request(self.base + "/health", headers=headers)) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response), {"status": "ok"})
                self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/auth/me", authenticated=False)[0], 401)
        with urllib.request.urlopen(self.base.removesuffix("/api") + "/openapi.json") as response:
            self.assertNotIn("/api/health", json.load(response)["paths"])


if __name__ == "__main__":
    unittest.main()
