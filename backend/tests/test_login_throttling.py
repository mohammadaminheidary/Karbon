import sys
from pathlib import Path
from contextlib import ExitStack
from unittest import TestCase
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from security import login_rate_limit as limiter


class ThrottlingTests(TestCase):
    def setUp(self):
        limiter._failed_attempts.clear()
        limiter._active.clear()

    def test_account_lockout_across_ips_and_temporary_expiry(self):
        with patch.object(limiter, 'monotonic', return_value=100):
            for index in range(5):
                with limiter.login_budget((f'ip:{index}', 'account')) as (blocked, _):
                    self.assertFalse(blocked)
                    limiter.record_login_failure('account')
            with limiter.login_budget(('new-ip', 'account')) as (blocked, retry):
                self.assertTrue(blocked)
                self.assertEqual(retry, 60)
        with patch.object(limiter, 'monotonic', return_value=161):
            with limiter.login_budget(('new-ip', 'account')) as (blocked, _):
                self.assertFalse(blocked)

    def test_parallel_requests_reserve_budget_and_release_on_exception(self):
        with ExitStack() as stack:
            for _ in range(5):
                self.assertFalse(stack.enter_context(limiter.login_budget(('account',)))[0])
            self.assertTrue(stack.enter_context(limiter.login_budget(('account',)))[0])
        self.assertEqual(limiter._active, {})
        with self.assertRaises(RuntimeError):
            with limiter.login_budget(('account',)):
                raise RuntimeError('verification failed')
        self.assertEqual(limiter._active, {})
