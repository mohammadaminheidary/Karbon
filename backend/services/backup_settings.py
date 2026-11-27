"""Backup reminder preferences and the last verified snapshot of the live database."""
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from tempfile import NamedTemporaryFile

import portalocker
from sqlalchemy.dialects.sqlite import insert

import config
from models.backup_settings import BackupSettings
from services.database_maintenance import lock_path


logger = logging.getLogger(__name__)


def sync_directory(directory):
    if os.name == "posix":
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def initialize_backup_settings(engine):
    BackupSettings.__table__.create(engine, checkfirst=True)
    with engine.begin() as connection:
        connection.execute(insert(BackupSettings).values(
            id=1, reminder_enabled=True, reminder_hours=24,
            started_at=datetime.now(timezone.utc).isoformat(),
        ).on_conflict_do_nothing(index_elements=[BackupSettings.id]))


def parse_timestamp(value):
    timestamp = datetime.fromisoformat(value)
    if timestamp.utcoffset() is None:
        raise ValueError("Backup timestamp must include a timezone")
    return timestamp.astimezone(timezone.utc)


def last_successful_backup():
    recovery = config.recovery_settings()
    path = lock_path("backup-success.json", config.DATABASE_PATH)
    try:
        record = json.loads(path.read_bytes())
    except FileNotFoundError:
        record = {}
    if record.get("generation") == recovery.generation:
        return record["created_at"]
    return recovery.backup_created_at


def record_backup_success(created_at):
    # Keep this write independent of SQLite so a WAL snapshot can finish even
    # while an application transaction holds the database's writer lock.
    database = config.DATABASE_PATH
    path = lock_path("backup-success.json", database)
    with portalocker.Lock(lock_path("backup-success-lock", database), mode="ab", timeout=10):
        previous = last_successful_backup()
        if previous and parse_timestamp(previous) >= parse_timestamp(created_at):
            return
        record = {"generation": config.recovery_settings().generation, "created_at": created_at}
        with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}-", delete=False) as temporary:
            try:
                temporary.write(json.dumps(record).encode("utf-8"))
                temporary.flush()
                os.fsync(temporary.fileno())
                temporary.close()
                os.replace(temporary.name, path)
            finally:
                if os.path.exists(temporary.name):
                    os.unlink(temporary.name)
        try:
            sync_directory(path.parent)
        except OSError:
            # The new record already names a verified, durable archive.
            logger.warning("Could not sync the backup timestamp directory", exc_info=True)


def backup_status(settings):
    last_backup = last_successful_backup()
    reference = parse_timestamp(last_backup or settings.started_at)
    due = settings.reminder_enabled and (
        datetime.now(timezone.utc) - reference >= timedelta(hours=settings.reminder_hours)
    )
    return {"last_backup_at": last_backup, "reminder_enabled": settings.reminder_enabled,
            "reminder_hours": settings.reminder_hours, "reminder_due": due,
            "timezone": config.app_timezone().key}
