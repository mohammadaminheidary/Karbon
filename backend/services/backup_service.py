"""Encrypted SQLite snapshots and portable Karbon recovery settings."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
from tempfile import TemporaryDirectory
from time import monotonic
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import zlib

from cryptography.fernet import Fernet, InvalidToken
import pyzipper
from sqlalchemy import create_engine, inspect

import config
from database import Base
from models.fiscal_year import FISCAL_TABLES
from security.face_templates import template_key
from services.fiscal_period import initialize_fiscal_storage


BACKUP_DIRECTORY = Path(__file__).resolve().parents[2] / "backup"
FORMAT_VERSION = 1
DATABASE = "karbon.db"
CONFIGURATION = "recovery.json"
MANIFEST = "manifest.json"
DATABASE_LIMIT = 512 * 1024 * 1024
UPLOAD_LIMIT = DATABASE_LIMIT + 1024 * 1024
PASSPHRASE_LIMIT = 1024
ENTRY_LIMITS = {DATABASE: DATABASE_LIMIT, CONFIGURATION: 4096, MANIFEST: 4096}
ARCHIVE_NAME = re.compile(r"karbon-backup-\d{8}-\d{6}\.zip", re.ASCII)
CHUNK = 1024 * 1024
logger = logging.getLogger(__name__)


class BackupError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def backup_directory():
    BACKUP_DIRECTORY.mkdir(mode=0o700, exist_ok=True)
    if BACKUP_DIRECTORY.is_symlink():
        raise OSError("Backup directory must not be a symbolic link")
    return BACKUP_DIRECTORY


def usable_passphrase(value):
    text = value.decode("utf-8")
    if len(text) < 12 or len(value) > PASSPHRASE_LIMIT or not text.strip():
        raise BackupError("عبارت عبور باید حداقل ۱۲ نویسه داشته باشد.")


def archive_info(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise FileNotFoundError(path)
    return {"filename": path.name, "created_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
            "size_bytes": info.st_size}


def list_archives():
    archives = []
    for path in backup_directory().iterdir():
        if ARCHIVE_NAME.fullmatch(path.name):
            try:
                info = archive_info(path)
                check_zip_directory(path)
                archives.append(info)
            except (FileNotFoundError, BackupError, pyzipper.BadZipFile):
                continue
    return sorted(archives, key=lambda archive: (archive["created_at"], archive["filename"]), reverse=True)


def archive_path(name):
    if ARCHIVE_NAME.fullmatch(name):
        path = backup_directory() / name
        try:
            archive_info(path)
            check_zip_directory(path)
            return path
        except (FileNotFoundError, BackupError, pyzipper.BadZipFile):
            pass
    raise BackupError("فایل پشتیبان پیدا نشد.", 404)


def database_connection(path, *, read_only=False, immutable=False, must_exist=False):
    mode = "ro" if read_only else "rw" if must_exist else "rwc"
    uri = f"{path.as_uri()}?mode={mode}" + ("&immutable=1" if immutable else "")
    return sqlite3.connect(uri, uri=True, timeout=5)


def copy_database(source, destination, *, restore=False):
    with closing(database_connection(source, read_only=True, immutable=restore)) as original, \
            closing(database_connection(destination, must_exist=restore)) as copy:
        deadline = monotonic() + 180
        page_size = original.execute("PRAGMA page_size").fetchone()[0]

        def progress(status, remaining, total):
            if status == sqlite3.SQLITE_DONE:
                return
            if total * page_size > DATABASE_LIMIT:
                raise BackupError("حجم پایگاه داده از حد مجاز پشتیبان بیشتر است.", 413)
            if monotonic() > deadline:
                raise BackupError("زمان تهیه تصویر پایگاه داده به پایان رسید.", 503)

        copy.execute("PRAGMA synchronous=FULL")
        original.backup(copy, pages=256, progress=progress, sleep=0.05)


def prepare_snapshot_for_restore(snapshot, generation):
    with closing(database_connection(config.DATABASE_PATH, read_only=True)) as live:
        wal_page_size = (live.execute("PRAGMA page_size").fetchone()[0]
                         if live.execute("PRAGMA journal_mode").fetchone()[0] == "wal" else None)
    with closing(database_connection(snapshot)) as db, db:
        db.execute("PRAGMA journal_mode=DELETE")
        if wal_page_size and db.execute("PRAGMA page_size").fetchone()[0] != wal_page_size:
            # SQLite cannot copy a different page size into a WAL destination.
            db.execute(f"PRAGMA page_size={wal_page_size}")
            db.execute("VACUUM")
        # The source generation refers to the source host's settings. Commit a
        # new pairing with the recovery settings on this host.
        db.execute("DROP TABLE IF EXISTS karbon_recovery")
        db.execute("CREATE TABLE karbon_recovery (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL)")
        db.execute("INSERT INTO karbon_recovery VALUES (1, ?)", (generation,))


def json_bytes(data):
    return json.dumps(data, ensure_ascii=True, sort_keys=True).encode("utf-8")


def checksum(path):
    with path.open("rb") as stream:
        return sha256_stream(stream)


def sha256_stream(stream):
    digest = sha256()
    for chunk in iter(lambda: stream.read(CHUNK), b""):
        digest.update(chunk)
    return digest.hexdigest()


def face_rows(db):
    for member_id, cipher in db.execute("SELECT member_id, encrypted_template FROM member_faces"):
        yield cipher, f"{member_id}:".encode()
    for member_id, angle, cipher in db.execute("SELECT member_id, angle, encrypted_image FROM member_face_photos"):
        yield cipher, f"{member_id}:photo:{angle}:".encode()


def recovery_payload(snapshot):
    with closing(database_connection(snapshot, read_only=True, immutable=True)) as db:
        has_faces = next(face_rows(db), None) is not None
    try:
        key = template_key().decode("ascii") if has_faces else None
    except (OSError, ValueError) as error:
        raise BackupError("کلید اصلی رمزنگاری چهره برای تهیه پشتیبان در دسترس نیست.") from error
    return {"timezone": config.app_timezone().key, "face_key": key}


def validate_database(path, recovery):
    try:
        if set(recovery) != {"timezone", "face_key"}:
            raise ValueError()
        ZoneInfo(recovery["timezone"])
        key = recovery["face_key"]
        cipher = Fernet(key.encode("ascii")) if key is not None else None
    except (AttributeError, TypeError, ValueError, ZoneInfoNotFoundError) as error:
        raise BackupError("تنظیمات بازیابی نامعتبر است.") from error

    with closing(database_connection(path, read_only=True, immutable=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise BackupError("یکپارچگی پایگاه داده پشتیبان تأیید نشد.")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BackupError("ارتباط بین رکوردهای پایگاه داده پشتیبان نامعتبر است.")
        table_names = {name for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")}
        fiscal_names = {table.name for table in FISCAL_TABLES}
        legacy = not (table_names & fiscal_names)
        columns = {table.name: {row[1] for row in db.execute("SELECT * FROM pragma_table_info(?)", (table.name,))}
                   for table in Base.metadata.tables.values()}
        legacy_fiscal = ("export_status" in columns["fiscal_years"]
                         and all("version" not in columns[name] for name in ("fiscal_snapshots", "fiscal_exports")))
        added = {"fiscal_snapshots": {"version", "closed_at", "export_status"}, "fiscal_exports": {"version"}}
        for table in Base.metadata.tables.values():
            if legacy and table.name in fiscal_names:
                continue
            required = set(table.columns.keys())
            if legacy_fiscal:
                required -= added.get(table.name, set())
            if table.name not in table_names or not required <= columns[table.name]:
                raise BackupError("ساختار پایگاه داده پشتیبان با این نسخه کاربن سازگار نیست.")
        if not db.execute("SELECT 1 FROM users WHERE username = ?", (config.ADMIN_USERNAME,)).fetchone():
            raise BackupError("پایگاه داده پشتیبان حساب مدیر کاربن را ندارد.")
        for encrypted, prefix in face_rows(db):
            try:
                if cipher is None or not cipher.decrypt(encrypted).startswith(prefix):
                    raise InvalidToken()
            except (InvalidToken, TypeError) as error:
                raise BackupError("کلید بازیابی با داده‌های رمزنگاری‌شده چهره سازگار نیست.") from error


def check_zip_directory(path):
    # Karbon emits a single-disk ZIP with no comment or ZIP64 directory.
    # Bound central-directory parsing before handing the file to the ZIP library.
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        if size > UPLOAD_LIMIT:
            raise BackupError("حجم فایل پشتیبان از حد مجاز بیشتر است.", 413)
        if size < 22:
            raise pyzipper.BadZipFile()
        stream.seek(-22, os.SEEK_END)
        signature, disk, start_disk, entries, total, length, offset, comment = struct.unpack(
            "<4s4H2IH", stream.read(22))
    if (signature != b"PK\x05\x06" or disk or start_disk or comment or entries != total
            or total != len(ENTRY_LIMITS) or length > 16 * 1024 or offset + length != size - 22):
        raise pyzipper.BadZipFile()


def verify_archive(path, passphrase, snapshot):
    try:
        check_zip_directory(path)
        with pyzipper.AESZipFile(path) as archive:
            archive.setpassword(passphrase)
            entries = archive.infolist()
            if len(entries) != len(ENTRY_LIMITS) or {entry.filename for entry in entries} != set(ENTRY_LIMITS):
                raise BackupError("فایل‌های داخل پشتیبان با قالب کاربن مطابقت ندارند.")
            for entry in entries:
                kind = stat.S_IFMT(entry.external_attr >> 16)
                if (entry.orig_filename != entry.filename or kind not in {0, stat.S_IFREG}
                        or entry.flag_bits != 1 or entry.wz_aes_vendor_id != b"AE"
                        or entry.wz_aes_version != 2 or entry.wz_aes_strength != 3
                        or entry.compress_type != pyzipper.ZIP_DEFLATED or entry.compress_size < 28):
                    raise BackupError("فایل ZIP باید با قالب رمزنگاری‌شده کاربن مطابقت داشته باشد.")
                if not 0 < entry.file_size <= ENTRY_LIMITS[entry.filename]:
                    raise BackupError("حجم فایل‌های داخل پشتیبان از حد مجاز بیشتر است.", 413)
            manifest = json.loads(archive.read(MANIFEST))
            if not isinstance(manifest, dict) or type(manifest.get("format_version")) is not int \
                    or manifest["format_version"] != FORMAT_VERSION:
                raise BackupError("نسخه قالب پشتیبان پشتیبانی نمی‌شود.")
            version = manifest["karbon_version"]
            if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version, re.ASCII):
                raise ValueError()
            created = datetime.fromisoformat(manifest["created_at"])
            if created.tzinfo is None:
                raise ValueError()
            checksums = manifest["checksums"]
            if not isinstance(checksums, dict) or set(checksums) != {DATABASE, CONFIGURATION}:
                raise ValueError()
            recovery_data = archive.read(CONFIGURATION)
            if sha256(recovery_data).hexdigest() != checksums[CONFIGURATION]:
                raise BackupError("جمع کنترلی تنظیمات بازیابی مطابقت ندارد.")
            digest = sha256()
            with archive.open(DATABASE) as source, snapshot.open("xb") as target:
                for chunk in iter(lambda: source.read(CHUNK), b""):
                    target.write(chunk)
                    digest.update(chunk)
                if target.tell() != archive.getinfo(DATABASE).file_size:
                    raise pyzipper.BadZipFile()
            if digest.hexdigest() != checksums[DATABASE]:
                raise BackupError("جمع کنترلی پایگاه داده مطابقت ندارد.")

        recovery = json.loads(recovery_data)
        if not isinstance(recovery, dict):
            raise ValueError()
        validate_database(snapshot, recovery)
        return {"created_at": created.isoformat(), "karbon_version": version}, recovery
    except RuntimeError as error:
        if str(error).startswith("Bad password for file"):
            raise BackupError("عبارت عبور پشتیبان صحیح نیست.") from error
        raise
    except (pyzipper.BadZipFile, zlib.error, EOFError, struct.error, sqlite3.DatabaseError,
            ValueError, KeyError, TypeError, OverflowError, IndexError, NotImplementedError) as error:
        raise BackupError("فایل پشتیبان خراب یا نامعتبر است.") from error


def sync_directory(directory):
    if os.name == "posix":
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def create_archive(passphrase):
    usable_passphrase(passphrase)
    directory = backup_directory()
    with TemporaryDirectory(prefix=".creating-", dir=directory, ignore_cleanup_errors=True) as name:
        staging = Path(name)
        snapshot = staging / DATABASE
        copy_database(config.DATABASE_PATH, snapshot)
        created = datetime.now(timezone.utc)
        if snapshot.stat().st_size > DATABASE_LIMIT:
            raise BackupError("حجم پایگاه داده از حد مجاز پشتیبان بیشتر است.", 413)
        recovery = json_bytes(recovery_payload(snapshot))
        manifest = {
            "format_version": FORMAT_VERSION, "karbon_version": config.KARBON_VERSION,
            "created_at": created.isoformat(),
            "checksums": {DATABASE: checksum(snapshot), CONFIGURATION: sha256(recovery).hexdigest()},
        }
        path = staging / "archive.zip"
        with pyzipper.AESZipFile(path, "x", compression=pyzipper.ZIP_DEFLATED, compresslevel=3,
                                 encryption=pyzipper.WZ_AES, allowZip64=False) as archive:
            archive.setencryption(pyzipper.WZ_AES, nbits=256, force_wz_aes_version=2)
            archive.setpassword(passphrase)
            archive.write(snapshot, DATABASE)
            archive.writestr(CONFIGURATION, recovery)
            archive.writestr(MANIFEST, json_bytes(manifest))
        snapshot.unlink()
        verify_archive(path, passphrase, snapshot)
        path.chmod(0o600)
        os.utime(path, (created.timestamp(), created.timestamp()))
        with path.open("rb") as stream:
            os.fsync(stream.fileno())
        stamp = created
        while True:
            final = directory / f"karbon-backup-{stamp:%Y%m%d-%H%M%S}.zip"
            try:
                os.link(path, final)
                break
            except FileExistsError:
                stamp += timedelta(seconds=1)
        try:
            sync_directory(directory)
        except OSError:
            final.unlink(missing_ok=True)
            raise
        return archive_info(final)


def restore_snapshot(snapshot, recovery):
    directory = config.recovery_directory()
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise OSError("Recovery settings directory must not be a symbolic link")
    sync_directory(directory.parent)
    generation = uuid4().hex
    settings = directory / f"{generation}.json"
    staged = create_engine(f"sqlite:///{snapshot.as_posix()}")
    try:
        if not inspect(staged).has_table("fiscal_years"):
            Base.metadata.create_all(staged, tables=FISCAL_TABLES)
        initialize_fiscal_storage(staged, zone=ZoneInfo(recovery["timezone"]))
    finally:
        staged.dispose()
    prepare_snapshot_for_restore(snapshot, generation)
    try:
        with os.fdopen(os.open(settings, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(json_bytes(recovery))
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(directory)
        copy_database(snapshot, config.DATABASE_PATH, restore=True)
    except BaseException:
        settings.unlink(missing_ok=True)
        raise

    # Failure to remove superseded settings cannot undo a committed restore.
    try:
        for path in directory.glob("*.json"):
            if path != settings and re.fullmatch(r"[0-9a-f]{32}\.json", path.name):
                path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove previous Karbon recovery settings", exc_info=True)
