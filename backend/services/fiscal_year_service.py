"""Atomic fiscal-year transitions and immutable versions of closing reports."""
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import hmac
import logging

import portalocker
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.orm import defer

import config
from database import SessionLocal, read_snapshot
from models.customer import Customer
from models.finance import FinancialTransaction as Tx
from models.fiscal_year import (
    FiscalBankOpening, FiscalCustomerOpening, FiscalExport, FiscalInventoryOpening,
    FiscalInvoiceOpening, FiscalSnapshot, FiscalYear, InventoryChange,
)
from models.document import Document
from models.inventory import ProductionRun, Purchase
from models.order import Order
from schemas.customer_schema import normalize_text
from services import backup_service
from services.database_maintenance import DatabaseBusy, lock_file, lock_path
from services.finance_service import FinanceError, cash_account, require
from services.fiscal_period import active_period, effective_day, install_guards, jalali, observed_years, year_dates, year_of
from services.fiscal_snapshot import capture, group_rows
from services.receivables import invoice_positions
from services.report_service import canonical

logger = logging.getLogger(__name__)
OUTDATED_PREVIEW = "اطلاعات سال تغییر کرده است. پیش‌نمایش تازه را بررسی و دوباره تأیید کنید."
SUCCESSOR_STARTED = "سال مالی بعدی شروع شده و بازگشایی ممکن نیست."
OPENING_MODELS = (FiscalBankOpening, FiscalCustomerOpening, FiscalInvoiceOpening, FiscalInventoryOpening)


def describe(year, start, end, *, active, closed_at=None, export_status=None, parked=False):
    stamp = closed_at.replace(tzinfo=timezone.utc) if closed_at else None
    return {"year": year, "start_date": start, "end_date": end,
            "start_jalali": jalali(start), "end_jalali": jalali(end),
            "status": "active" if active else "closed" if closed_at else "parked" if parked else "open",
            "closed_at": stamp, "closed_date": stamp.astimezone(config.app_timezone()).date() if stamp else None,
            "export_status": export_status}


def describe_years(db):
    db.rollback()
    db.execute(text("BEGIN"))
    first, last = observed_years(db)
    stored = {item.year: item for item in db.scalars(select(FiscalYear).order_by(FiscalYear.year))}
    period = next((item for item in stored.values() if item.closed_at is None), None)
    active = period.year if period else first
    first = min(stored, default=first)
    archives = defaultdict(list)
    for year, version, closed_at, status in db.execute(
        select(FiscalSnapshot.year, FiscalSnapshot.version, FiscalSnapshot.closed_at, FiscalSnapshot.export_status)
        .order_by(FiscalSnapshot.year, FiscalSnapshot.version.desc())
    ):
        day = closed_at.replace(tzinfo=timezone.utc).astimezone(config.app_timezone()).date()
        archives[year].append({"version": version, "closed_date": day, "export_status": status})
    previous = stored.get(active - 1)
    reopen = None
    if period and previous and previous.closed_at and archives[previous.year]:
        reopen = {"year": previous.year, "version": archives[previous.year][0]["version"],
                  "blocked": has_successor_activity(db, period)}
    years = []
    for year in range(first, max(last, active, max(stored, default=active)) + 1):
        recorded = stored.get(year)
        history = archives[year]
        years.append({
            **describe(year, *year_dates(year), active=year == active,
                       closed_at=recorded.closed_at if recorded else None,
                       export_status=history[0]["export_status"] if history else None,
                       parked=recorded is not None and year > active),
            "archives": history,
        })
    return {"active_year": active, "years": years, "reopen": reopen}


def current(db):
    period = active_period(db)
    day = effective_day(period)
    year = period.year if period else year_of(day)
    return {**describe(year, *year_dates(year), active=True),
            "managed": period is not None, "business_date": day, "business_jalali": jalali(day),
            "timezone": config.app_timezone().key}


def assert_active(db, year):
    period = active_period(db)
    active = period.year if period else observed_years(db)[0]
    if year != active:
        raise FinanceError("فقط سال مالی فعال قابل بستن است. پیش‌نمایش تازه را دریافت کنید.", 409)
    return period


def successor_activity(db, year):
    start, end = year_dates(year + 1)
    return {
        "orders": db.scalar(select(func.count(Order.id)).where(
            Order.deleted_at.is_(None), Order.invoice_date.between(start, end))),
        "transactions": db.scalar(select(func.count(Tx.id)).where(
            Tx.deleted_at.is_(None), Tx.transaction_date.between(start, end))),
        "purchases": db.scalar(select(func.count(Purchase.id)).where(
            Purchase.deleted_at.is_(None), Purchase.purchase_date.between(start, end))),
        "production": db.scalar(select(func.count(ProductionRun.id)).where(
            ProductionRun.deleted_at.is_(None), ProductionRun.production_date.between(start, end))),
    }


def has_successor_activity(db, period):
    # Opening rows and shared settings are separate from posted operations.
    # Voided rows still show that the successor was used.
    sales_stock = select(InventoryChange.id).where(InventoryChange.scope == "sales",
        InventoryChange.business_date.between(period.start_date, period.end_date)).exists()
    return db.scalar(select(or_(sales_stock, *(
        select(column).where(column.between(period.start_date, period.end_date)).exists()
        for column in (Order.invoice_date, Tx.transaction_date, Purchase.purchase_date,
                       Document.date, ProductionRun.production_date)
    ))))


def latest_snapshot_version(db, year):
    return db.scalar(select(func.max(FiscalSnapshot.version)).where(FiscalSnapshot.year == year)) or 0


def confirmed_data(db, year):
    period = assert_active(db, year)
    data = capture(db, year)
    next_activity = successor_activity(db, year)
    version = latest_snapshot_version(db, year) + 1
    digest = sha256(canonical({"data": data, "next_activity": next_activity, "version": version}).encode()).hexdigest()
    return period, data, next_activity, digest, version


def preview(db, year):
    db.rollback()
    db.execute(text("BEGIN"))
    _, data, next_activity, digest, _ = confirmed_data(db, year)
    customers = {c["id"]: c for c in data["customers"]}
    orders = {o["id"]: o for o in data["orders"]}
    open_invoices = group_rows(data["closing_invoices"], "customer_id")
    return {
        "period": data["period"], "summary": data["summary"], "digest": digest, "next_activity": next_activity,
        "accounts": data["accounts"], "inventory": data["inventory"],
        "customers": [
            {**acct, "customer_code": customers[acct["customer_id"]]["customer_code"],
             "first_name": customers[acct["customer_id"]]["first_name"], "last_name": customers[acct["customer_id"]]["last_name"],
             "invoices": [{"order_number": orders[row["order_id"]]["order_number"],
                           "invoice_code": orders[row["order_id"]]["invoice_code"], **row}
                          for row in open_invoices[acct["customer_id"]]]}
            for acct in data["closing_customer_accounts"]
        ],
    }


def close_result(snapshot, active_year):
    return {"year": snapshot.year, "version": snapshot.version,
            "active_year": active_year, "export_status": snapshot.export_status}


def save_close(db, period, year, data, digest, version, backup):
    install_guards(db.connection())
    if period is None:
        start, end = year_dates(year)
        period = FiscalYear(year=year, start_date=start, end_date=end)
        db.add(period)
    period.closed_at = datetime.now(timezone.utc)
    db.flush()
    if db.get(FiscalYear, year + 1) is None:
        start, end = year_dates(year + 1)
        db.add(FiscalYear(year=year + 1, start_date=start, end_date=end))
        db.flush()
    accounts = data["accounts"]
    for account in accounts:
        if account["id"] is None:
            account["id"] = cash_account(db).id
    snapshot = FiscalSnapshot(year=year, version=version, digest=digest, data=data, backup_filename=backup["filename"],
                              closed_at=period.closed_at, export_status="pending")
    db.add(snapshot)
    db.add_all(FiscalBankOpening(year=year + 1, bank_id=account["id"], balance=account["closing_balance"])
               for account in accounts)
    db.add_all(FiscalCustomerOpening(year=year + 1, **account) for account in data["closing_customer_accounts"])
    db.add_all(FiscalInvoiceOpening(year=year + 1, **{k: v for k, v in invoice.items() if k != "overdue"})
               for invoice in data["closing_invoices"])
    db.add(FiscalInventoryOpening(year=year + 1, data=data["inventory"]))
    result = close_result(snapshot, year + 1)
    db.commit()
    return result


@contextmanager
def transition_lock(db):
    try:
        with lock_file(lock_path("fiscal-close", config.DATABASE_PATH), portalocker.LOCK_EX):
            db.rollback()
            yield
    except DatabaseBusy as error:
        raise FinanceError("تغییر سال مالی در حال انجام است. دوباره تلاش کنید.", 409) from error
    finally:
        db.rollback()


def close(db, year, digest, passphrase, *, browser_preferences=None):
    with transition_lock(db):
        period = db.get(FiscalYear, year)
        if period is not None and period.closed_at is not None:
            snapshot = find_snapshot(db, year)
            if not hmac.compare_digest(digest, snapshot.digest):
                raise FinanceError("این سال مالی قبلاً بسته شده است.", 409)
            return close_result(snapshot, active_period(db).year)
        db.rollback()
        db.execute(text("BEGIN"))
        if not hmac.compare_digest(confirmed_data(db, year)[3], digest):
            raise FinanceError(OUTDATED_PREVIEW, 409)
        db.rollback()
        backup_service.usable_passphrase(passphrase)
        try:
            backup = backup_service.create_archive(passphrase, browser_preferences=browser_preferences)
        except Exception as error:
            logger.warning("Fiscal-year safety backup failed", exc_info=True)
            raise FinanceError("تهیه پشتیبان ایمنی انجام نشد. سال مالی همچنان باز است.", 409) from error
        db.execute(text("BEGIN IMMEDIATE"))
        period, data, _, updated_digest, version = confirmed_data(db, year)
        if not hmac.compare_digest(updated_digest, digest):
            raise FinanceError(OUTDATED_PREVIEW, 409)
        return save_close(db, period, year, data, digest, version, backup)


def reopen(db, year, version):
    with transition_lock(db):
        db.execute(text("BEGIN IMMEDIATE"))
        active = active_period(db)
        previous = db.get(FiscalYear, year)
        if previous is None or latest_snapshot_version(db, year) != version:
            raise FinanceError("نسخه بستن سال تغییر کرده است. فهرست سال‌ها را به‌روز کنید.", 409)
        if active and active.year == year:
            return {"active_year": year}
        if active is None or active.year != year + 1 or previous.closed_at is None:
            raise FinanceError("فقط آخرین سال مالی بسته‌شده قابل بازگشایی است.", 409)
        if has_successor_activity(db, active):
            raise FinanceError(SUCCESSOR_STARTED, 409)
        previous.closed_at = None
        db.flush()
        for model in OPENING_MODELS:
            db.execute(delete(model).where(model.year == active.year))
        db.commit()
        return {"active_year": year}


def find_snapshot(db, year, version=None):
    query = select(FiscalSnapshot).options(defer(FiscalSnapshot.data)).where(FiscalSnapshot.year == year)
    if version is not None:
        query = query.where(FiscalSnapshot.version == version)
    snapshot = db.scalar(query.order_by(FiscalSnapshot.version.desc()).limit(1))
    if snapshot is None:
        raise FinanceError("بایگانی این سال مالی پیدا نشد.", 404)
    return snapshot


def request_exports(db, year, version):
    snapshot = find_snapshot(db, year, version)
    selected = snapshot.version
    if snapshot.export_status == "failed":
        db.execute(update(FiscalSnapshot).where(FiscalSnapshot.year == year, FiscalSnapshot.version == selected,
                   FiscalSnapshot.export_status == "failed").values(export_status="pending"))
        db.commit()
    return selected, snapshot.export_status


def publish_exports(year, version):
    try:
        with lock_file(lock_path(f"fiscal-export-{year}-{version}", config.DATABASE_PATH), portalocker.LOCK_EX):
            with SessionLocal() as db:
                snapshot = find_snapshot(db, year, version)
                if snapshot.export_status == "ready":
                    return
                data = snapshot.data
                db.rollback()
                try:
                    from services.fiscal_year_export import render_exports

                    outputs = render_exports(data)
                    db.execute(text("BEGIN IMMEDIATE"))
                    db.add_all(FiscalExport(year=year, version=version, kind=kind, content=content)
                               for kind, content in outputs.items())
                    snapshot.export_status = "ready"
                    db.commit()
                except Exception:
                    db.rollback()
                    logger.exception("Could not generate fiscal exports for %s, version %s", year, version)
                    snapshot.export_status = "failed"
                    db.commit()
    except DatabaseBusy:
        # The request already generating this year's files publishes the result.
        return


def amount_at_opening(db, customer_id):
    read_snapshot(db)
    period = active_period(db)
    require(db, Customer, customer_id, "مشتری")
    if period is None:
        return {"year": None, "receivable": 0, "credit": 0, "invoices": []}
    opening = db.get(FiscalCustomerOpening, (period.year, customer_id))
    positions = invoice_positions(period.end_date, [customer_id])
    invoices = []
    query = select(FiscalInvoiceOpening, Order, positions.c.remaining).join(
        Order, Order.id == FiscalInvoiceOpening.order_id,
    ).join(positions, positions.c.id == Order.id).where(
        FiscalInvoiceOpening.year == period.year, FiscalInvoiceOpening.customer_id == customer_id,
    ).order_by(Order.invoice_date, Order.id)
    for row, order, outstanding in db.execute(query):
        total = order.total
        invoices.append({
            "order_id": order.id, "order_number": order.order_number, "invoice_code": order.invoice_code,
            "source_year": row.source_year, "issue_date": jalali(order.invoice_date), "due_date": jalali(order.payment_date),
            "total": total, "paid": row.paid, "amount": row.amount, "outstanding": outstanding,
        })
    return {"year": period.year, "receipt_date": jalali(effective_day(period)),
            "receivable": opening.receivable if opening else 0, "credit": opening.credit if opening else 0,
            "invoices": invoices}


def archive_search(data, kind, search, skip, limit):
    customers = {c["id"]: c for c in data["customers"]} if kind != "customers" else {}
    customer_key = "supplier_id" if kind == "purchases" else "customer_id"
    period_only = kind not in {"customers", "purchases"}
    term = normalize_text(search).casefold()
    items, total = [], 0
    for raw in reversed(data[kind]):
        if period_only and not raw["in_period"]:
            continue
        in_page = total >= skip and len(items) < limit
        if term or in_page:
            customer = raw if kind == "customers" else customers.get(raw.get(customer_key))
            name = f"{customer['first_name']} {customer['last_name']}" if customer else ""
            if term:
                identity = [name, customer["customer_code"], customer["permanent_id"], *customer["phone_numbers"]] if customer else []
                refs = [raw.get(key) for key in (
                    "order_number", "invoice_code", "invoice_number", "transaction_number", "tracking_number",
                    "title", "description", "jalali_date", "bank_name",
                )]
                searchable = " ".join(str(value) for value in [*identity, *refs] if value is not None)
                if term not in normalize_text(searchable).casefold():
                    continue
            if in_page:
                items.append({**raw, "customer_name": name})
        total += 1
    return {"items": items, "total": total}


def order_at_cutoff(data, order_id):
    order = next((o for o in data["orders"] if o["id"] == order_id), None)
    if order is None:
        raise FinanceError("سفارش در این بایگانی پیدا نشد.", 404)
    invoice = next(i for i in data["invoices"] if i["order_id"] == order_id)
    c = next(c for c in data["customers"] if c["id"] == order["customer_id"])
    customer = invoice["issued_customer"] or {"code": c["customer_code"], "name": f"{c['first_name']} {c['last_name']}",
                                              "phone_numbers": c["phone_numbers"], "address": c["address"]}
    transactions = {tx["id"]: tx for tx in data["transactions"]}
    payments = []
    for allocation in data["allocations"]:
        if allocation["order_id"] == order_id:
            tx = transactions[allocation["transaction_id"]]
            payments.append({**tx, "transaction_id": tx["id"], "account_name": tx["bank_name"],
                             "order_id": order_id, "amount": allocation["amount"], "method": allocation["method"]})
    payments.sort(key=lambda row: (row["transaction_date"], row["transaction_time"], row["transaction_id"]))
    if order["invoice_date"] > data["period"]["end_date"]:
        payment_status = "not_issued"
    else:
        payment_status = "settled" if not order["remaining"] else "partial" if order["paid"] else "unpaid"
    return {**order, "customer": customer, "items": [i for i in data["order_items"] if i["order_id"] == order_id],
            "payments": payments, "payment_status": payment_status}


def statement(data, customer_id):
    customer = next((c for c in data["customers"] if c["id"] == customer_id), None)
    if customer is None:
        raise FinanceError("مشتری در این بایگانی پیدا نشد.", 404)
    opening, closing = ({a["customer_id"]: a for a in data[key]} for key in
                        ("opening_customer_accounts", "closing_customer_accounts"))
    zero = {"customer_id": customer_id, "receivable": 0, "credit": 0}
    carried = {i["order_id"]: i["amount"] for i in data["closing_invoices"]}
    return {
        "customer": customer, "opening": opening.get(customer_id, zero), "closing": closing.get(customer_id, zero),
        "invoices": [{**o, "carried": carried.get(o["id"], 0)} for o in data["orders"] if o["customer_id"] == customer_id],
        "transactions": [tx for tx in data["transactions"] if tx["customer_id"] == customer_id],
    }
