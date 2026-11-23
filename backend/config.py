import json
import os
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

KARBON_VERSION = "1.0.0"
ADMIN_USERNAME = "admin"


APP_DATA_DIR = (
    Path.home()
    / ".karbon"
)


APP_DATA_DIR.mkdir(
    parents=True,
    exist_ok=True
)


DATABASE_PATH = Path(os.getenv(
    "KARBON_DATABASE_PATH",
    str(APP_DATA_DIR / "karbon.db"),
)).expanduser().resolve()


DATABASE_URL = (
    f"sqlite:///{DATABASE_PATH.as_posix()}"
)


APP_TIMEZONE_NAME = os.getenv(
    "KARBON_TIMEZONE",
    "Asia/Tehran",
)


APP_TIMEZONE = ZoneInfo(
    APP_TIMEZONE_NAME
)


@dataclass(frozen=True)
class RecoverySettings:
    generation: str = ""
    timezone: ZoneInfo = APP_TIMEZONE
    face_key: bytes | None = field(default=None, repr=False)


def recovery_directory():
    return DATABASE_PATH.with_name(f".{DATABASE_PATH.name}.karbon-recovery")


@lru_cache(maxsize=1)
def _load_recovery_settings(database, directory, revision):
    # The database snapshot and its generation switch in one SQLite commit.
    # The matching private settings file is written durably before that commit.
    if not database.exists():
        return RecoverySettings()
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM sqlite_schema WHERE name = 'karbon_recovery'").fetchone():
            return RecoverySettings()
        row = db.execute("SELECT generation FROM karbon_recovery WHERE id = 1").fetchone()
    if not row or not isinstance(row[0], str) or not re.fullmatch(r"[0-9a-f]{32}", row[0]):
        raise ValueError("Invalid Karbon recovery generation")
    settings = json.loads((directory / f"{row[0]}.json").read_bytes())
    return RecoverySettings(row[0], ZoneInfo(settings["timezone"]),
                            settings["face_key"].encode("ascii") if settings["face_key"] else None)


def recovery_settings():
    directory = recovery_directory()
    try:
        info = directory.stat()
        revision = (info.st_ino, info.st_mtime_ns, info.st_ctime_ns)
    except FileNotFoundError:
        revision = None
    # Each restore creates a new settings file under the exclusive maintenance
    # lock. The directory revision lets other workers refresh on their next use.
    return _load_recovery_settings(DATABASE_PATH, directory, revision)


def app_timezone():
    return recovery_settings().timezone
