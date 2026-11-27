from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, Field, StrictBool, StringConstraints
from sqlalchemy.orm import Session

from config import ADMIN_USERNAME
from database import get_database
from models.fiscal_year import FiscalExport
from routes.backup import CreateBackup, backup_errors, encode_passphrase
from routes.finance import finance_errors
from security.auth import get_current_user, require_admin
from services import fiscal_year_service as service
from services.order_service import invoice
from services.inventory_service import archived_purchase_invoice

router = APIRouter(prefix="/api/settings/fiscal-years", tags=["Fiscal years"], dependencies=[Depends(get_current_user)])

Year = Annotated[int, Path(ge=1, le=9376)]
RecordKind = Literal["orders", "invoices", "purchases", "customers", "transactions"]
Output = Literal["summary", "carryover", "data"]
Version = Annotated[int | None, Query(ge=1, le=2**63 - 1)]


class ConfirmClose(CreateBackup):
    confirm: StrictBool
    digest: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class ConfirmReopen(BaseModel):
    confirm: StrictBool
    version: int = Field(strict=True, ge=1, le=2**63 - 1)


def precise(value):
    """Keep large toman totals exact across the browser's JSON boundary."""
    if isinstance(value, dict):
        return {key: precise(item) for key, item in value.items()}
    if isinstance(value, list):
        return [precise(item) for item in value]
    return str(value) if type(value) is int and abs(value) > 2**53 - 1 else value


@router.get("")
def years(db: Session = Depends(get_database), user=Depends(get_current_user)):
    return {**service.describe_years(db), "can_manage": user.username == ADMIN_USERNAME}


@router.get("/current")
def current(db: Session = Depends(get_database)):
    return service.current(db)


@router.get("/customers/{customer_id}/carryovers")
def carryovers(customer_id: Annotated[int, Path(gt=0, le=2**63 - 1)], db: Session = Depends(get_database)):
    with finance_errors():
        return precise(service.amount_at_opening(db, customer_id))


@router.get("/{year}/preview", dependencies=[Depends(require_admin)])
def preview(year: Year, db: Session = Depends(get_database)):
    with finance_errors():
        return precise(service.preview(db, year))


@router.post("/{year}/close", dependencies=[Depends(require_admin)])
def close(year: Year, body: ConfirmClose, background: BackgroundTasks, db: Session = Depends(get_database)):
    if not body.confirm:
        raise HTTPException(422, "بستن سال مالی را تأیید کنید.")
    with backup_errors("بستن سال مالی انجام نشد. سال مالی همچنان باز است."), finance_errors():
        result = service.close(db, year, body.digest, encode_passphrase(body.passphrase.get_secret_value()),
                               browser_preferences=body.browser_preferences)
    if result["export_status"] == "pending":
        background.add_task(service.publish_exports, year, result["version"])
    return result


@router.post("/{year}/reopen", dependencies=[Depends(require_admin)])
def reopen(year: Year, body: ConfirmReopen, db: Session = Depends(get_database)):
    if not body.confirm:
        raise HTTPException(422, "بازگشایی سال مالی را تأیید کنید.")
    with finance_errors():
        return service.reopen(db, year, body.version)


@router.post("/{year}/exports", status_code=202, dependencies=[Depends(require_admin)])
def regenerate(year: Year, background: BackgroundTasks, version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        selected, status = service.request_exports(db, year, version)
    if status != "ready":
        background.add_task(service.publish_exports, year, selected)
    return {"version": selected, "export_status": status if status == "ready" else "pending"}


@router.get("/{year}/exports/{kind}", dependencies=[Depends(require_admin)])
def download(year: Year, kind: Output, version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        snapshot = service.find_snapshot(db, year, version)
        if snapshot.export_status != "ready":
            raise HTTPException(409, "گزارش‌های این سال هنوز آماده نیستند.")
        export = db.get(FiscalExport, (year, snapshot.version, kind))
    if export is None:
        raise HTTPException(404, "فایل گزارش پیدا نشد.")
    suffix = "zip" if kind == "data" else "pdf"
    label = f"{year}-v{snapshot.version}" if snapshot.version > 1 else str(year)
    return Response(export.content, media_type=f"application/{suffix}", headers={
        "Content-Disposition": f'attachment; filename="karbon-{label}-{kind}.{suffix}"',
        "Content-Encoding": "identity",
    })


@router.get("/{year}")
def archive(year: Year, version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        snapshot = service.find_snapshot(db, year, version)
        data = snapshot.data
        return precise({"version": snapshot.version, **{key: data[key] for key in ("period", "summary", "accounts", "inventory")}})


@router.get("/{year}/records/{kind}")
def records(year: Year, kind: RecordKind, q: str = Query("", max_length=200), skip: int = Query(0, ge=0),
            limit: int = Query(25, ge=1, le=100), version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        return precise(service.archive_search(service.find_snapshot(db, year, version).data, kind, q, skip, limit))


@router.get("/{year}/records/invoices/{record_id}/issued")
def issued_invoice(year: Year, record_id: Annotated[int, Path(gt=0, le=2**63 - 1)],
                   version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        data = service.find_snapshot(db, year, version).data
        if not any(row["order_id"] == record_id for row in data["invoices"]):
            raise HTTPException(404, "فاکتور در این بایگانی پیدا نشد.")
        return invoice(db, record_id, include_deleted=True)


@router.get("/{year}/records/purchases/{record_id}/issued")
def issued_purchase(year: Year, record_id: Annotated[int, Path(gt=0, le=2**63 - 1)],
                    version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        data = service.find_snapshot(db, year, version).data
        receipt = next((row for row in data["purchases"] if row["id"] == record_id), None)
        if receipt is None:
            raise HTTPException(404, "خرید در این بایگانی پیدا نشد.")
        return archived_purchase_invoice(db, data, receipt)


@router.get("/{year}/records/{kind}/{record_id}")
def record(year: Year, kind: RecordKind, record_id: Annotated[int, Path(gt=0, le=2**63 - 1)],
           version: Version = None, db: Session = Depends(get_database)):
    with finance_errors():
        data = service.find_snapshot(db, year, version).data
        if kind == "customers":
            return precise(service.statement(data, record_id))
        if kind in {"transactions", "purchases"}:
            item = next((row for row in data[kind] if row["id"] == record_id), None)
            if item is None:
                raise HTTPException(404, "تراکنش در این بایگانی پیدا نشد.")
            return precise(item)
        return precise(service.order_at_cutoff(data, record_id))
