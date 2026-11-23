"""Drain Karbon database work across API workers before replacing a snapshot."""
import asyncio
import os
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import portalocker
from starlette.responses import JSONResponse

import config


BUSY_MESSAGE = "بازیابی پشتیبان در حال انجام است. کمی بعد دوباره تلاش کنید."


class DatabaseBusy(Exception):
    pass


def lock_file(path, mode):
    stream = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "r+b")
    try:
        portalocker.lock(stream, mode | portalocker.LOCK_NB)
    except portalocker.exceptions.AlreadyLocked:
        stream.close()
        raise DatabaseBusy(BUSY_MESSAGE) from None
    except BaseException:
        stream.close()
        raise
    return stream


def lock_path(name, database):
    return database.with_name(f"{database.name}.karbon-{name}")


@contextmanager
def database_access(database=None):
    # Acquire the shared lease before releasing the admission lock. A restore
    # can then close admission and wait for every already admitted request.
    path = config.DATABASE_PATH if database is None else Path(database).resolve()
    with lock_file(lock_path("maintenance", path), portalocker.LOCK_SH):
        lease = lock_file(lock_path("access", path), portalocker.LOCK_SH)
    with lease:
        yield lease


@asynccontextmanager
async def exclusive_database_access(lease):
    path = config.DATABASE_PATH
    with lock_file(lock_path("maintenance", path), portalocker.LOCK_EX):
        lease.close()
        deadline = asyncio.get_running_loop().time() + 30
        while True:
            try:
                exclusive = lock_file(lock_path("access", path), portalocker.LOCK_EX)
                break
            except DatabaseBusy:
                if asyncio.get_running_loop().time() >= deadline:
                    raise
                await asyncio.sleep(0.05)
        with exclusive:
            yield


class DatabaseMaintenanceMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or not scope["path"].startswith("/api/")
                or scope["path"] == "/api/health" or scope["method"] == "OPTIONS"):
            await self.app(scope, receive, send)
            return
        try:
            with database_access() as lease:
                scope.setdefault("state", {})["database_lease"] = lease
                await self.app(scope, receive, send)
        except DatabaseBusy:
            await JSONResponse({"detail": BUSY_MESSAGE}, status_code=503,
                               headers={"Cache-Control": "no-store", "Retry-After": "2"})(scope, receive, send)
