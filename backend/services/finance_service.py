from datetime import datetime, timedelta, timezone
import json
import base64
import re
from pathlib import Path

import jdatetime
from sqlalchemy import case, func, text, or_, and_, cast, String
from sqlalchemy.dialects.sqlite import insert

from config import APP_TIMEZONE
from models.customer import Customer
from models.finance import BankAccount, BankDirectory, ExpenseCategory, FinancialTransaction as Transaction
from schemas.finance_schema import parse_jalali
from schemas.customer_schema import normalize_text, DIGITS
from security.password import verify_password
from services.reference_codes import compact_customer_codes, compact_category_codes, compact_transaction_numbers


def initialize_bank_storage(engine):
    """Add profile columns in place, retaining account IDs and ledger links.

    Serialized and idempotent for existing SQLite databases and reload workers.
    Unknown historical owner/card/date information stays NULL, never guessed.
    """
    catalog = json.loads((Path(__file__).resolve().parents[2] / "data" / "banks.json").read_text())
    additions = {
        "first_name": "VARCHAR(100)", "last_name": "VARCHAR(100)",
        "bank": "VARCHAR(40) REFERENCES bank_directory(code) ON DELETE RESTRICT",
        "card_number": "VARCHAR(16)", "sheba_number": "VARCHAR(26)",
        "created_at": "DATETIME", "updated_at": "DATETIME", "deleted_at": "DATETIME",
    }
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(bank_accounts)")}
        for column, sql_type in additions.items():
            if column not in columns:
                # Identifiers come exclusively from the constant map above.
                connection.exec_driver_sql(f"ALTER TABLE bank_accounts ADD COLUMN {column} {sql_type}")
        for table, fields in {"customers": {"deleted_at": "DATETIME"}, "expense_categories": {"deleted_at": "DATETIME", "display_code": "INTEGER"},
                              "financial_transactions": {"updated_at": "DATETIME", "deleted_at": "DATETIME", "transaction_number": "INTEGER"}}.items():
            existing = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, sql_type in fields.items():
                if column not in existing:
                    connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
        compact_customer_codes(connection)
        compact_category_codes(connection)
        compact_transaction_numbers(connection)
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_card_number ON bank_accounts(card_number)")
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_sheba_number ON bank_accounts(sheba_number)")
        for bank in catalog:
            connection.execute(insert(BankDirectory).values(**bank).on_conflict_do_nothing(index_elements=["code"]))
        connection.exec_driver_sql("UPDATE bank_accounts SET bank = (SELECT code FROM bank_directory WHERE bank_directory.name = bank_accounts.name) WHERE bank IS NULL AND EXISTS (SELECT 1 FROM bank_directory WHERE bank_directory.name = bank_accounts.name)")


def bank_catalog(db):
    return [{"code": bank.code, "name": bank.name, "logo_url": bank.logo_url, "active": bank.active}
            for bank in db.query(BankDirectory).order_by(BankDirectory.name).all()]


class FinanceError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def require(db, model, record_id, label, active=False, include_deleted=False):
    item = db.get(model, record_id)
    if item is None or not include_deleted and getattr(item, "deleted_at", None) is not None:
        raise FinanceError(f"{label} موردنظر پیدا نشد.", 404)
    if active and not item.active:
        raise FinanceError(f"{label} موردنظر غیرفعال است.", 409)
    return item


def sums():
    return (
        func.coalesce(func.sum(case((Transaction.kind == "income", Transaction.amount), else_=0)), 0),
        func.coalesce(func.sum(case((Transaction.kind == "expense", Transaction.amount), else_=0)), 0),
    )


def totals(income, expense):
    return {"income": int(income), "expense": int(expense), "balance": int(income - expense)}


def bank_list(db):
    grouped = db.query(Transaction.bank_id, *sums()).filter(Transaction.deleted_at.is_(None)).group_by(Transaction.bank_id).all()
    values = {key: totals(income, expense) for key, income, expense in grouped}
    return [{
        **{column.name: getattr(bank, column.name) for column in BankAccount.__table__.columns},
        "name": directory.name if directory else bank.name,
        "logo_url": directory.logo_url if directory else None,
        "profile_complete": all((bank.first_name, bank.last_name, bank.bank, bank.card_number)),
        "opening_balance": bank.opening_balance, "active": bank.active,
        "can_delete": not db.query(Transaction.id).filter(Transaction.bank_id == bank.id, Transaction.deleted_at.is_(None)).first(),
        **values.get(bank.id, totals(0, 0)),
        "balance": bank.opening_balance + values.get(bank.id, totals(0, 0))["balance"],
    } for bank, directory in db.query(BankAccount, BankDirectory).outerjoin(
        BankDirectory, BankAccount.bank == BankDirectory.code).filter(BankAccount.deleted_at.is_(None)).order_by(BankAccount.id).all()]


def category_list(db):
    return [{"id": item.id, "title": item.title, "account_code": item.account_code, "active": item.active}
            for item in db.query(ExpenseCategory).filter(ExpenseCategory.deleted_at.is_(None)).order_by(ExpenseCategory.display_code, ExpenseCategory.id).all()]


def save_reference(db, model, data, record_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        if model is BankAccount:
            return save_bank(db, data, record_id)
        item = require(db, model, record_id, "اطلاعات") if record_id is not None else db.query(ExpenseCategory).filter(
            ExpenseCategory.title == data.title, ExpenseCategory.deleted_at.is_not(None)).first() or model()
        if record_id is None:
            # Re-adding a deleted title receives the next display code too.
            item.display_code = db.query(ExpenseCategory.id).filter(ExpenseCategory.deleted_at.is_(None)).count() + 1
        item.deleted_at = None
        for key, value in data.model_dump().items():
            setattr(item, key, value)
        db.add(item)
        db.flush()
        compact_category_codes(db)
        db.expire_all()
        db.commit()
        return next(row for row in category_list(db) if row["id"] == item.id)
    except Exception:
        db.rollback()
        raise


def save_bank(db, data, record_id=None):
    directory = require(db, BankDirectory, data.bank, "بانک")
    bank = require(db, BankAccount, record_id, "حساب بانکی") if record_id is not None else db.query(BankAccount).filter(
        BankAccount.card_number == data.card_number, BankAccount.deleted_at.is_not(None)).first() or BankAccount()
    # Keep a previously selected inactive bank editable, but reject new selection.
    if not directory.active and bank.bank != directory.code:
        raise FinanceError("بانک انتخاب‌شده غیرفعال است.", 409)
    for key, value in data.model_dump(exclude={"account_number"}).items():
        setattr(bank, key, value)
    bank.name = directory.name
    bank.deleted_at = None
    bank.account_number = data.account_number or bank.account_number or data.sheba_number or data.card_number
    bank.updated_at = datetime.now(timezone.utc)
    db.add(bank)
    db.flush()
    # Compute the reviewable response before committing so failure rolls back.
    result = next(item for item in bank_list(db) if item["id"] == bank.id)
    db.commit()
    return result


def serialize(item, bank, directory=None):
    return {
        **{column.name: getattr(item, column.name) for column in Transaction.__table__.columns},
        "jalali_date": jdatetime.date.fromgregorian(date=item.transaction_date).strftime("%Y/%m/%d"),
        "bank": {"id": bank.id, "name": directory.name if directory else bank.name,
                 "account_number": bank.account_number, "logo_url": directory.logo_url if directory else None},
    }


def save_transaction(db, data):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        prior = db.query(Transaction).filter(Transaction.request_id == str(data.request_id)).first()
        if prior is not None:
            if prior.deleted_at is not None:
                raise FinanceError("این تراکنش حذف شده است و درخواست قبلی قابل تکرار نیست.", 410)
            # Retrying the same POST after a lost response cannot double-charge.
            fields = ("kind", "customer_id", "expense_category_id", "bank_id", "amount", "description", "tracking_number", "transaction_date", "time_mode")
            matches = all(getattr(prior, field) == getattr(data, field) for field in fields)
            if data.time_mode == "manual":
                matches = matches and prior.transaction_time == f"{data.hour:02d}:{data.minute:02d}:00"
            if not matches:
                raise FinanceError("شناسه درخواست قبلاً برای تراکنش دیگری استفاده شده است.", 409)
            bank = require(db, BankAccount, prior.bank_id, "بانک")
            result = serialize(prior, bank, db.get(BankDirectory, bank.bank) if bank.bank else None)
            db.commit()
            return result
        bank = require(db, BankAccount, data.bank_id, "بانک", active=True)
        if data.kind == "income":
            source = require(db, Customer, data.customer_id, "مشتری")
            title = f"{source.first_name} {source.last_name}"
            code = str(source.customer_code)
        else:
            source = require(db, ExpenseCategory, data.expense_category_id, "عنوان هزینه", active=True)
            title, code = source.title, source.account_code
        now = datetime.now(APP_TIMEZONE)
        clock = now.strftime("%H:%M:%S") if data.time_mode == "auto" else f"{data.hour:02d}:{data.minute:02d}:00"
        item = Transaction(**data.model_dump(exclude={"request_id", "hour", "minute"}), request_id=str(data.request_id),
                           title=title, account_code=code, transaction_time=clock,
                           transaction_number=db.query(Transaction.id).filter(Transaction.deleted_at.is_(None)).count() + 1)
        db.add(item)
        db.flush()
        result = serialize(item, bank, db.get(BankDirectory, bank.bank) if bank.bank else None)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def daily(db, day):
    try:
        jalali_date = jdatetime.date.fromgregorian(date=day).strftime("%Y/%m/%d")
    except (ValueError, OverflowError):
        raise FinanceError("تاریخ انتخاب‌شده در محدوده تقویم شمسی نیست.", 422) from None
    rows = db.query(Transaction, BankAccount, BankDirectory).join(BankAccount, Transaction.bank_id == BankAccount.id).outerjoin(
        BankDirectory, BankAccount.bank == BankDirectory.code).filter(
        Transaction.transaction_date == day, Transaction.deleted_at.is_(None)).order_by(Transaction.transaction_time, Transaction.id).all()
    income = expense = 0
    points = [{"time": "00:00:00", **totals(0, 0)}]
    for item, bank, directory in rows:
        if item.kind == "income":
            income += item.amount
        else:
            expense += item.amount
        points.append({"time": item.transaction_time, **totals(income, expense)})
    points.append({"time": "23:59:59", **totals(income, expense)})
    return {"date": day, "jalali_date": jalali_date,
            "summary": totals(income, expense), "chart": points,
            "transactions": [serialize(item, bank, directory) for item, bank, directory in reversed(rows)]}


def calendar(db, start, end):
    if end < start or (end - start).days > 62:
        raise FinanceError("بازه تقویم باید حداکثر ۶۳ روز و به ترتیب تاریخ باشد.", 422)
    rows = db.query(Transaction.transaction_date, *sums()).filter(
        Transaction.transaction_date.between(start, end), Transaction.deleted_at.is_(None)).group_by(Transaction.transaction_date).all()
    values = {day: totals(income, expense) for day, income, expense in rows}
    return [{"date": start + timedelta(days=offset), **values.get(start + timedelta(days=offset), totals(0, 0))}
            for offset in range((end - start).days + 1)]


def jalali_filter(value):
    try:
        return parse_jalali(value)
    except ValueError as error:
        raise FinanceError(str(error), 422) from None


def jalali_month(value):
    match = re.fullmatch(r"([0-9]{4})/([0-9]{1,2})", value.translate(DIGITS).strip())
    try:
        if not match:
            raise ValueError()
        year, month = map(int, match.groups())
        start = jdatetime.date(year, month, 1)
        end = jdatetime.date(year + (month == 12), month % 12 + 1, 1).togregorian() - timedelta(days=1)
        return start.togregorian(), end
    except (ValueError, OverflowError):
        raise FinanceError("ماه را به صورت ۱۴۰۵/۰۷ وارد کنید.", 422) from None


def bank_activity(db, bank_id, period, anchor=None):
    bank = next((item for item in bank_list(db) if item["id"] == bank_id), None)
    if bank is None:
        raise FinanceError("حساب بانکی موردنظر پیدا نشد.", 404)
    try:
        end = jalali_filter(anchor) if anchor else datetime.now(APP_TIMEZONE).date()
        jalali = jdatetime.date.fromgregorian(date=end)
        if period == "yesterday":
            start = end = end - timedelta(days=1)
        elif period == "day":
            start = end
        elif period == "week":
            start = end - timedelta(days=(end.weekday() + 2) % 7)
            end = start + timedelta(days=6)
        elif period in ("month", "quarter"):
            month = jalali.month if period == "month" else ((jalali.month - 1) // 3) * 3 + 1
            count = 1 if period == "month" else 3
            start = jdatetime.date(jalali.year, month, 1).togregorian()
            next_month = month + count
            end = jdatetime.date(jalali.year + (next_month > 12), (next_month - 1) % 12 + 1, 1).togregorian() - timedelta(days=1)
        else:
            start = jdatetime.date(jalali.year, 1, 1).togregorian()
            end = jdatetime.date(jalali.year + 1, 1, 1).togregorian() - timedelta(days=1)
    except (ValueError, OverflowError):
        raise FinanceError("بازه انتخاب‌شده در محدوده تقویم شمسی نیست.", 422) from None
    rows = db.query(Transaction.transaction_date, *sums()).filter(
        Transaction.bank_id == bank_id, Transaction.deleted_at.is_(None), Transaction.transaction_date.between(start, end)).group_by(Transaction.transaction_date).all()
    values = {day: totals(income, expense) for day, income, expense in rows}
    chart = [{"date": start + timedelta(days=offset), **values.get(start + timedelta(days=offset), totals(0, 0))}
             for offset in range((end - start).days + 1)]
    return {"bank": bank, "start_date": start, "end_date": end, "period": period,
            "summary": totals(sum(point["income"] for point in chart), sum(point["expense"] for point in chart)), "chart": chart}


def bank_transactions(db, bank_id, *, start_date=None, end_date=None, day=None, month=None, year=None,
                      min_amount=None, max_amount=None, search=None, cursor=None):
    bank = require(db, BankAccount, bank_id, "حساب بانکی")
    directory = db.get(BankDirectory, bank.bank) if bank.bank else None
    query = db.query(Transaction).filter(Transaction.bank_id == bank_id, Transaction.deleted_at.is_(None))
    start = jalali_filter(start_date) if start_date else None
    end = jalali_filter(end_date) if end_date else None
    if start and end and end < start:
        raise FinanceError("پایان بازه نباید قبل از شروع آن باشد.", 422)
    if start:
        query = query.filter(Transaction.transaction_date >= start)
    if end:
        query = query.filter(Transaction.transaction_date <= end)
    if day:
        query = query.filter(Transaction.transaction_date == jalali_filter(day))
    if month:
        bounds = jalali_month(month)
        query = query.filter(Transaction.transaction_date.between(*bounds))
    if year:
        normalized = year.translate(DIGITS).strip()
        if not re.fullmatch(r"[0-9]{4}", normalized):
            raise FinanceError("سال شمسی را به صورت ۱۴۰۵ وارد کنید.", 422)
        try:
            start_year = jdatetime.date(int(normalized), 1, 1).togregorian()
            end_year = jdatetime.date(int(normalized) + 1, 1, 1).togregorian() - timedelta(days=1)
        except (ValueError, OverflowError):
            raise FinanceError("سال شمسی معتبر نیست.", 422) from None
        query = query.filter(Transaction.transaction_date.between(start_year, end_year))
    if min_amount is not None and max_amount is not None and max_amount < min_amount:
        raise FinanceError("حداکثر مبلغ نباید کمتر از حداقل باشد.", 422)
    if min_amount is not None:
        query = query.filter(Transaction.amount >= min_amount)
    if max_amount is not None:
        query = query.filter(Transaction.amount <= max_amount)
    if search and search.strip():
        value = normalize_text(search)
        query = query.filter(or_(Transaction.description.contains(value, autoescape=True),
                                 Transaction.tracking_number.contains(value, autoescape=True),
                                 cast(Transaction.transaction_number, String).contains(value, autoescape=True)))
    # Freeze the newest ID at the first page: new inserts cannot reorder later pages.
    snapshot = db.query(func.coalesce(func.max(Transaction.id), 0)).filter(Transaction.bank_id == bank_id).scalar()
    position = None
    if cursor:
        try:
            position = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if set(position) != {"date", "time", "id", "snapshot"} or any(type(position[key]) is not int or position[key] < 0 for key in ("id", "snapshot")):
                raise ValueError()
            from datetime import date as date_type
            position["date"] = date_type.fromisoformat(position["date"])
            if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]", position["time"]):
                raise ValueError()
            snapshot = position["snapshot"]
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise FinanceError("اطلاعات صفحه‌بندی معتبر نیست؛ فهرست را دوباره دریافت کنید.", 422) from None
    query = query.filter(Transaction.id <= snapshot)
    total = query.count()
    if position:
        query = query.filter(or_(Transaction.transaction_date < position["date"],
                                 and_(Transaction.transaction_date == position["date"], Transaction.transaction_time < position["time"]),
                                 and_(Transaction.transaction_date == position["date"], Transaction.transaction_time == position["time"], Transaction.id < position["id"])))
    rows = query.order_by(Transaction.transaction_date.desc(), Transaction.transaction_time.desc(), Transaction.id.desc()).limit(16).all()
    more = len(rows) > 15
    rows = rows[:15]
    next_cursor = None
    if more:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps({"date": last.transaction_date.isoformat(), "time": last.transaction_time,
                                                          "id": last.id, "snapshot": snapshot}).encode()).decode()
    return {"items": [serialize(item, bank, directory) for item in rows], "total": total, "next_cursor": next_cursor}


def edit_transaction(db, transaction_id, data):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Transaction, transaction_id, "تراکنش")
        bank = require(db, BankAccount, data.bank_id, "بانک", active=data.bank_id != item.bank_id)
        source_id = data.customer_id if data.kind == "income" else data.expense_category_id
        unchanged_source = data.kind == item.kind and source_id == (item.customer_id if item.kind == "income" else item.expense_category_id)
        model = Customer if data.kind == "income" else ExpenseCategory
        source = require(db, model, source_id, "مشتری" if data.kind == "income" else "عنوان هزینه",
                         active=data.kind == "expense" and not unchanged_source, include_deleted=unchanged_source)
        if not unchanged_source:
            item.title = f"{source.first_name} {source.last_name}" if data.kind == "income" else source.title
            item.account_code = str(source.customer_code) if data.kind == "income" else source.account_code
        for key, value in data.model_dump(exclude={"hour", "minute"}).items():
            setattr(item, key, value)
        if data.time_mode == "manual":
            item.transaction_time = f"{data.hour:02d}:{data.minute:02d}:00"
        # Automatic time on edit retains the original recorded clock.
        item.updated_at = datetime.now(timezone.utc)
        db.flush()
        result = serialize(item, bank, db.get(BankDirectory, bank.bank) if bank.bank else None)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def delete_finance_record(db, model, record_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, model, record_id, "اطلاعات", include_deleted=True)
        if item.deleted_at is None:
            if model is BankAccount and db.query(Transaction.id).filter(
                    Transaction.bank_id == record_id, Transaction.deleted_at.is_(None)).first():
                raise FinanceError("این حساب تراکنش ثبت‌شده دارد و قابل حذف نیست.", 409)
            item.deleted_at = datetime.now(timezone.utc)
            if hasattr(item, "updated_at"):
                item.updated_at = item.deleted_at
            db.flush()
            if model is ExpenseCategory:
                compact_category_codes(db)
            elif model is Transaction:
                compact_transaction_numbers(db)
            db.expire_all()
        db.commit()
        return {"id": record_id, "deleted": True}
    except Exception:
        db.rollback()
        raise
