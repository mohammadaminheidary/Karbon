"""Administrator-only backup downloads, upload validation, and confirmed restore."""
import base64
import binascii
from contextlib import contextmanager
from hashlib import sha256
import logging
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from time import time
from typing import Annotated
from uuid import uuid4

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
import portalocker
from pydantic import BaseModel, SecretStr, StrictBool, StringConstraints
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import config
from database import SessionLocal, get_database
from security.auth import bearer_scheme, get_current_user, require_admin
from services import backup_service as service
from services.backup_folder import folder_access, open_backup_folder
from services.database_maintenance import DatabaseBusy, exclusive_database_access, lock_file


router = APIRouter(prefix="/api/settings/backup", tags=["Backup"], dependencies=[Depends(require_admin)])
logger = logging.getLogger(__name__)
VALIDATION_LIFETIME = 30 * 60
ValidationId = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]


class CreateBackup(BaseModel):
    passphrase: SecretStr


class RestoreBackup(CreateBackup):
    validation_id: ValidationId
    confirm: StrictBool


def encode_passphrase(value):
    data = value.encode("utf-8")
    if len(data) > service.PASSPHRASE_LIMIT or not data:
        raise service.BackupError("عبارت عبور پشتیبان نامعتبر است.")
    return data


def upload_passphrase(request):
    header = request.headers.get("x-karbon-backup-passphrase", "")
    if not header or len(header) > 4 * ((service.PASSPHRASE_LIMIT + 2) // 3):
        raise service.BackupError("عبارت عبور پشتیبان نامعتبر است.")
    try:
        value = base64.b64decode(header, validate=True).decode("utf-8")
    except (ValueError, binascii.Error) as error:
        raise service.BackupError("عبارت عبور پشتیبان نامعتبر است.") from error
    return encode_passphrase(value)


@contextmanager
def backup_errors(fallback):
    try:
        yield
    except service.BackupError as error:
        raise HTTPException(error.status, str(error)) from error
    except DatabaseBusy as error:
        raise HTTPException(409, "عملیات دیگری روی پشتیبان یا پایگاه داده در حال انجام است.") from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Karbon backup operation failed")
        raise HTTPException(500, fallback) from error


def staging_directory():
    namespace = sha256(os.fsencode(config.DATABASE_PATH)).hexdigest()
    directory = service.backup_directory() / f".restore-{namespace}"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise OSError("Restore staging directory must not be a symbolic link")
    return directory


def staged_path(directory, credentials, validation_id):
    owner = sha256(credentials.credentials.encode()).hexdigest()
    return directory / f"{owner}-{validation_id}.zip"


@router.get("")
def backups(request: Request):
    with backup_errors("فهرست پشتیبان‌ها در دسترس نیست."):
        opener, reason = folder_access(request)
        return {"items": service.list_archives(), "folder": {"available": bool(opener), "reason": reason}}


@router.post("", status_code=201)
def create(body: CreateBackup):
    with backup_errors("ساخت پشتیبان انجام نشد. فضای ذخیره‌سازی و دسترسی پوشه را بررسی کنید."):
        return service.create_archive(encode_passphrase(body.passphrase.get_secret_value()))


@router.post("/open-folder", status_code=204)
def open_folder(request: Request):
    with backup_errors("مدیر فایل نتوانست پوشه پشتیبان را باز کند."):
        open_backup_folder(request)


@router.get("/download/{filename}")
def download(filename: str):
    with backup_errors("دریافت فایل پشتیبان انجام نشد."):
        return FileResponse(service.archive_path(filename), media_type="application/zip", filename=filename,
                            headers={"Content-Encoding": "identity"})


async def save_upload(request, path):
    if request.headers.get("content-type") != "application/zip":
        raise service.BackupError("یک فایل ZIP کاربن را انتخاب کنید.", 415)
    size = 0
    async with await anyio.open_file(path, "xb") as stream:
        async for chunk in request.stream():
            size += len(chunk)
            if size > service.UPLOAD_LIMIT:
                raise service.BackupError("حجم فایل پشتیبان از حد مجاز بیشتر است.", 413)
            await stream.write(chunk)


@router.post("/validate")
async def validate(request: Request, credentials=Depends(bearer_scheme)):
    with backup_errors("بارگذاری و بررسی فایل پشتیبان انجام نشد."):
        passphrase = upload_passphrase(request)
        declared = request.headers.get("content-length")
        if declared is not None:
            if not re.fullmatch(r"[0-9]{1,18}", declared):
                raise service.BackupError("طول فایل بارگذاری‌شده نامعتبر است.", 400)
            if int(declared) > service.UPLOAD_LIMIT:
                raise service.BackupError("حجم فایل پشتیبان از حد مجاز بیشتر است.", 413)
        directory = staging_directory()
        with lock_file(directory / ".lock", portalocker.LOCK_EX), \
                TemporaryDirectory(prefix=".upload-", dir=directory) as temporary:
            stage = Path(temporary)
            archive = stage / "upload.zip"
            await save_upload(request, archive)
            manifest, _ = await run_in_threadpool(service.verify_archive, archive, passphrase, stage / service.DATABASE)
            validation_id = uuid4().hex
            for old in directory.glob("*.zip"):
                old.unlink(missing_ok=True)
            os.utime(archive, None)
            archive.replace(staged_path(directory, credentials, validation_id))
    return {**manifest, "validation_id": validation_id}


def apply_restore(snapshot, recovery, passphrase, credentials):
    # The original dependency closed its session before maintenance began.
    # Recheck the account after all previously admitted writes have drained.
    with SessionLocal() as db:
        require_admin(get_current_user(credentials, db))
    try:
        service.create_archive(passphrase)
    except Exception as error:
        logger.warning("Pre-restore safety backup failed", exc_info=True)
        raise service.BackupError("تهیه پشتیبان ایمنی انجام نشد. بازیابی آغاز نشد.", 409) from error
    service.restore_snapshot(snapshot, recovery)


@router.post("/restore")
async def restore(body: RestoreBackup, request: Request, credentials=Depends(bearer_scheme),
                  db: Session = Depends(get_database)):
    if not body.confirm:
        raise HTTPException(400, "جایگزینی اطلاعات فعلی را تأیید کنید.")
    with backup_errors("بازیابی انجام نشد و اطلاعات قبلی حفظ شد."):
        passphrase = encode_passphrase(body.passphrase.get_secret_value())
        service.usable_passphrase(passphrase)
        directory = staging_directory()
        with lock_file(directory / ".lock", portalocker.LOCK_EX), \
                TemporaryDirectory(prefix=".restoring-", dir=directory, ignore_cleanup_errors=True) as temporary:
            archive = staged_path(directory, credentials, body.validation_id)
            if not archive.is_file() or time() - archive.stat().st_mtime > VALIDATION_LIFETIME:
                raise service.BackupError("اعتبار بررسی فایل پایان یافته است. فایل را دوباره بارگذاری کنید.", 409)
            snapshot = Path(temporary) / service.DATABASE
            _, recovery = await run_in_threadpool(service.verify_archive, archive, passphrase, snapshot)
            await run_in_threadpool(db.close)
            async with exclusive_database_access(request.state.database_lease):
                await run_in_threadpool(apply_restore, snapshot, recovery, passphrase, credentials)
            try:
                archive.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove the validated encrypted archive", exc_info=True)
    return {"status": "completed"}
