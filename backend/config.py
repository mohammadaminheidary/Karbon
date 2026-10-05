import os

from pathlib import Path
from zoneinfo import ZoneInfo


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
