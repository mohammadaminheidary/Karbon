"""Bounded, thread-safe throttling for the local single-process service."""
from collections import OrderedDict, deque
from contextlib import contextmanager
from math import ceil
from threading import RLock
from time import monotonic

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 60
_failed_attempts = OrderedDict()
_active = {}
_lock = RLock()


def _attempts(key, now):
    # Prune all stale keys so arbitrary usernames cannot grow memory forever.
    for old in list(_failed_attempts):
        attempts = _failed_attempts[old]
        while attempts and now - attempts[0] >= WINDOW_SECONDS:
            attempts.popleft()
        if not attempts:
            del _failed_attempts[old]
    return _failed_attempts.get(key, ())


def check_login_rate_limit(client_key):
    with _lock:
        now = monotonic()
        attempts = _attempts(client_key, now)
        return (True, max(1, ceil(WINDOW_SECONDS - (now - attempts[0])))) if len(attempts) >= MAX_ATTEMPTS else (False, 0)


def record_login_failure(client_key):
    with _lock:
        _attempts(client_key, monotonic())
        if client_key not in _failed_attempts and len(_failed_attempts) >= 10000:
            _failed_attempts.popitem(last=False)
        _failed_attempts.setdefault(client_key, deque(maxlen=MAX_ATTEMPTS)).append(monotonic())


def clear_login_failures(client_key):
    with _lock:
        _failed_attempts.pop(client_key, None)


@contextmanager
def login_budget(keys):
    # Reserve in-flight attempts too: parallel requests must not bypass lockout.
    with _lock:
        limited = False
        retry = 0
        for key in keys:
            blocked, wait = check_login_rate_limit(key)
            attempts = _failed_attempts.get(key, ())
            if blocked or len(attempts) + _active.get(key, 0) >= MAX_ATTEMPTS:
                limited, retry = True, max(retry, wait or WINDOW_SECONDS)
        if not limited:
            for key in keys:
                _active[key] = _active.get(key, 0) + 1
    try:
        yield limited, retry
    finally:
        if not limited:
            with _lock:
                for key in keys:
                    _active[key] -= 1
                    if not _active[key]:
                        del _active[key]
