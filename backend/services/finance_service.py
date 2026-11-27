from datetime import date, datetime, timedelta, timezone
import json
import base64
import re
from pathlib import Path

import jdatetime
from sqlalchemy import case, func, literal, text, or_, and_, cast, String, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import object_session

from config import app_timezone
from models.customer import Customer
from models.document import DocumentAccount
from models.finance import BankAccount, BankDirectory, ExpenseCategory, FinancialTransaction as Transaction
from models.fiscal_year import FiscalBankOpening, FiscalYear
from models.inventory import Purchase, PurchasePayment
from models.order import Order, OrderPayment, CASH_ACCOUNT_NUMBER
from schemas.finance_schema import parse_jalali
from schemas.customer_schema import normalize_text, DIGITS
from security.password import verify_password
from services.reference_codes import compact_customer_codes, compact_category_codes, compact_transaction_numbers
from services.fiscal_period import active_period, active_value, effective_day, ensure_open, in_active_period
from services.receivables import active_bounds, customer_financial_totals, general_allocations, invoice_positions


def initialize_bank_storage(engine):
    """Add profile columns in place, retaining account IDs and ledger links.

    Serialized and idempotent for existing SQLite databases and reload workers.
    Unknown historical owner/card/date information stays NULL, never guessed.
    """
    catalog = json.loads((Path(__file__).resolve().parents[1] / "data" / "banks.json").read_text())
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
                              "financial_transactions": {"updated_at": "DATETIME", "deleted_at": "DATETIME", "transaction_number": "INTEGER",
                                                         "payment_method": "VARCHAR(12)"}}.items():
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
    def __init__(self, message, status=400, *, code=None):
        self.message, self.status, self.code = message, status, code


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


def next_transaction_number(db):
    return 1 + int(db.scalar(select(func.coalesce(func.max(Transaction.transaction_number), 0)).where(or_(
        Transaction.deleted_at.is_(None), select(FiscalYear.year).exists()))))


def exact_amount(value):
    return str(value) if abs(value) > 2**53 - 1 else value


def bank_list(db, bank_id=None):
    ledger = db.query(Transaction.bank_id, *sums()).filter(Transaction.deleted_at.is_(None), in_active_period(Transaction.transaction_date))
    referenced = select(Transaction.id).where(Transaction.bank_id == BankAccount.id, Transaction.deleted_at.is_(None)).exists()
    accounts = db.query(BankAccount, BankDirectory, FiscalBankOpening.balance, referenced.label("referenced")).outerjoin(
        BankDirectory, BankAccount.bank == BankDirectory.code).outerjoin(
        FiscalBankOpening, (FiscalBankOpening.bank_id == BankAccount.id)
        & (FiscalBankOpening.year == active_value(FiscalYear.year).scalar_subquery())
    ).filter(BankAccount.deleted_at.is_(None))
    if bank_id is not None:
        ledger = ledger.filter(Transaction.bank_id == bank_id)
        accounts = accounts.filter(BankAccount.id == bank_id)
    grouped = ledger.group_by(Transaction.bank_id).all()
    values = {key: totals(income, expense) for key, income, expense in grouped}
    result = []
    for bank, directory, opening, has_transactions in accounts.order_by(BankAccount.id):
        activity = values.get(bank.id, totals(0, 0))
        start_balance = bank.opening_balance if opening is None else opening
        is_cash = bank.account_number == CASH_ACCOUNT_NUMBER
        result.append({
            **{column.name: getattr(bank, column.name) for column in BankAccount.__table__.columns},
            "name": directory.name if directory else bank.name,
            "logo_url": directory.logo_url if directory else None,
            "profile_complete": all((bank.first_name, bank.last_name, bank.bank, bank.card_number)),
            "opening_balance": exact_amount(start_balance),
            "opening_balance_locked": opening is not None,
            "is_cash": is_cash, "can_edit": not is_cash,
            "can_delete": not is_cash and not has_transactions and not opening,
            "income": exact_amount(activity["income"]), "expense": exact_amount(activity["expense"]),
            "balance": exact_amount(start_balance + activity["balance"]),
        })
    return result


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
    if data.account_number == CASH_ACCOUNT_NUMBER or record_id is not None and require(db, BankAccount, record_id, "حساب").account_number == CASH_ACCOUNT_NUMBER:
        raise FinanceError("صندوق نقدی از فرم حساب بانکی قابل تغییر نیست.", 409)
    directory = require(db, BankDirectory, data.bank, "بانک")
    bank = require(db, BankAccount, record_id, "حساب بانکی") if record_id is not None else db.query(BankAccount).filter(
        BankAccount.card_number == data.card_number, BankAccount.deleted_at.is_not(None)).first() or BankAccount()
    # Keep a previously selected inactive bank editable, but reject new selection.
    if not directory.active and bank.bank != directory.code:
        raise FinanceError("بانک انتخاب‌شده غیرفعال است.", 409)
    period = active_period(db)
    opening = db.get(FiscalBankOpening, (period.year, bank.id)) if period and bank.id else None
    if opening and "opening_balance" in data.model_fields_set and data.opening_balance != opening.balance:
        raise FinanceError("مانده افتتاحیه از سال بسته‌شده منتقل شده است و قابل تغییر نیست.", 409)
    excluded = {"account_number"}
    if opening:
        excluded.add("opening_balance")
    for key, value in data.model_dump(exclude=excluded).items():
        setattr(bank, key, value)
    bank.name = directory.name
    bank.deleted_at = None
    bank.account_number = data.account_number or bank.account_number or data.sheba_number or data.card_number
    bank.updated_at = datetime.now(timezone.utc)
    db.add(bank)
    db.flush()
    # Compute the reviewable response before committing so failure rolls back.
    result = bank_list(db, bank.id)[0]
    db.commit()
    return result


def invoice_links(db, transactions, *, cutoff=None):
    """Batch invoice links without counting a split receipt twice in the ledger."""
    expenses = [item.id for item in transactions if item.kind == "expense"]
    links = {}
    if expenses:
        rows = db.execute(select(PurchasePayment.transaction_id, Purchase.id, Purchase.invoice_number).join(
            Purchase, Purchase.id == PurchasePayment.purchase_id,
        ).where(PurchasePayment.transaction_id.in_(expenses)))
        links.update({tx_id: {"purchase_invoice": {"id": purchase_id, "invoice_number": number}}
                      for tx_id, purchase_id, number in rows})
    receipts = [item for item in transactions if item.kind == "income" and item.customer_id is not None]
    if not receipts:
        return links
    ids = [item.id for item in receipts]
    customer_ids = {item.customer_id for item in receipts}
    if cutoff is None:
        _, cutoff = active_bounds()
    positions = invoice_positions(cutoff, customer_ids)
    direct = select(OrderPayment.order_id, OrderPayment.transaction_id, Transaction.amount, OrderPayment.method).join(
        Transaction, Transaction.id == OrderPayment.transaction_id,
    ).where(OrderPayment.transaction_id.in_(ids))
    general = general_allocations(positions, cutoff, customer_ids).subquery()
    allocations = direct.union_all(select(general, literal(None).label("method")).where(
        general.c.transaction_id.in_(ids),
    )).subquery()
    # Receipts for an invoice beyond the active cutoff retain their direct link.
    direct_paid = select(func.coalesce(func.sum(Transaction.amount), 0)).join(
        OrderPayment, OrderPayment.transaction_id == Transaction.id,
    ).where(OrderPayment.order_id == Order.id, Transaction.deleted_at.is_(None)).correlate(Order).scalar_subquery()
    paid = func.coalesce(positions.c.paid, direct_paid)
    rows = db.execute(select(allocations, Order.invoice_code, Order.subtotal, Order.discount, Order.total,
                             paid, func.coalesce(positions.c.remaining, func.max(Order.total - paid, 0))).join(
        Order, Order.id == allocations.c.order_id,
    ).outerjoin(positions, positions.c.id == Order.id).order_by(Order.invoice_date, Order.id))
    for order_id, transaction_id, amount, method, code, subtotal, discount, total, paid, remaining in rows:
        metadata = links.setdefault(transaction_id, {})
        invoice = {"order_id": order_id, "invoice_code": code, "subtotal": subtotal, "discount": discount, "total": total,
                   "paid": paid, "remaining": remaining}
        if method is not None:
            metadata["invoice"] = {**invoice, "method": method}
        else:
            metadata.setdefault("invoice_allocations", []).append({**invoice, "amount": amount})
    return links


def serialize(item, bank, directory=None, *, links=None):
    if links is None:
        links = invoice_links(object_session(item), [item])
    return {
        "invoice": None,
        **links.get(item.id, {}),
        **{column.name: getattr(item, column.name) for column in Transaction.__table__.columns},
        "jalali_date": jdatetime.date.fromgregorian(date=item.transaction_date).strftime("%Y/%m/%d"),
        "bank": {"id": bank.id, "name": directory.name if directory else bank.name,
                 "is_cash": bank.account_number == CASH_ACCOUNT_NUMBER,
                 "account_number": bank.account_number, "logo_url": directory.logo_url if directory else None},
    }


def validate_receipt_reference(db, bank_id, day, tracking_number, *, exclude_id=None):
    if tracking_number is None:
        return
    duplicate = select(Transaction.id).where(
        Transaction.bank_id == bank_id, Transaction.transaction_date == day,
        Transaction.tracking_number == tracking_number, Transaction.customer_id.is_not(None),
        Transaction.kind == "income", Transaction.deleted_at.is_(None),
    )
    if exclude_id is not None:
        duplicate = duplicate.where(Transaction.id != exclude_id)
    if db.scalar(duplicate.limit(1)) is not None:
        raise FinanceError("رسیدی با این شماره پیگیری در این حساب و تاریخ ثبت شده است.", 409,
                           code="DUPLICATE_RECEIPT_REFERENCE")


def cash_account(db):
    account = db.query(BankAccount).filter(BankAccount.account_number == CASH_ACCOUNT_NUMBER).first()
    if not account:
        account = BankAccount(name="صندوق نقدی", account_number=CASH_ACCOUNT_NUMBER, opening_balance=0, active=True)
        db.add(account)
        db.flush()
    if not account.active or account.deleted_at is not None:
        raise FinanceError("صندوق نقدی غیرفعال است.", 409)
    return account


def payment_bank(db, method, bank_id, *, active=True):
    if method == "cash":
        bank = cash_account(db)
        if bank_id is not None and bank_id != bank.id:
            raise FinanceError("پرداخت نقدی فقط در صندوق نقدی ثبت می‌شود.", 422)
        return bank
    bank = require(db, BankAccount, bank_id, "حساب بانکی" if method else "بانک", active=active)
    if method and bank.account_number == CASH_ACCOUNT_NUMBER:
        raise FinanceError("برای پرداخت غیرنقدی، حساب بانکی انتخاب کنید.", 422)
    return bank


def apply_transaction_fields(db, item, data, now=None):
    """Validate references and apply a row without committing its owner's unit of work."""
    existing = item.id is not None
    ensure_open(db, data.transaction_date, item.transaction_date if existing else data.transaction_date)
    method = data.payment_method
    if data.kind == "income" and "payment_method" not in data.model_fields_set:
        method = item.payment_method
    bank = payment_bank(db, method, data.bank_id, active=not existing or data.bank_id != item.bank_id)
    if data.kind == "income" and data.customer_id is not None:
        reference = (bank.id, data.transaction_date, data.tracking_number)
        if reference != (item.bank_id, item.transaction_date, item.tracking_number) or item.kind != "income":
            validate_receipt_reference(db, *reference, exclude_id=item.id)
    if data.document_account_id is not None:
        if item.document_id is None:
            raise FinanceError("حساب مستقل سند فقط در ثبت سند قابل استفاده است.", 422)
        unchanged = existing and data.document_account_id == item.document_account_id and data.kind == item.kind
        source = require(db, DocumentAccount, data.document_account_id, "حساب سند", active=not unchanged, include_deleted=unchanged)
        if source.kind != data.kind:
            raise FinanceError("نوع ردیف با نوع حساب سند یکسان نیست.", 422)
        item.title, item.account_code = source.title, source.code
    else:
        source_id = data.customer_id if data.kind == "income" else data.expense_category_id
        unchanged = existing and data.kind == item.kind and source_id == (item.customer_id if item.kind == "income" else item.expense_category_id)
        source = require(db, Customer if data.kind == "income" else ExpenseCategory, source_id,
                         "مشتری" if data.kind == "income" else "عنوان هزینه",
                         active=data.kind == "expense" and not unchanged, include_deleted=unchanged)
        if not unchanged:
            item.title = f"{source.first_name} {source.last_name}" if data.kind == "income" else source.title
            item.account_code = str(source.customer_code) if data.kind == "income" else source.account_code
    for key, value in data.model_dump(exclude={"request_id", "hour", "minute", "bank_id", "payment_method"}).items():
        setattr(item, key, value)
    item.bank_id, item.payment_method = bank.id, method
    if data.time_mode == "manual":
        item.transaction_time = f"{data.hour:02d}:{data.minute:02d}:00"
    elif not existing:
        item.transaction_time = (now or datetime.now(app_timezone())).strftime("%H:%M:%S")
    item.updated_at = datetime.now(timezone.utc)
    return bank


def save_transaction(db, data):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        prior = db.query(Transaction).filter(Transaction.request_id == str(data.request_id)).first()
        if prior is not None:
            if prior.deleted_at is not None:
                raise FinanceError("این تراکنش حذف شده است و درخواست قبلی قابل تکرار نیست.", 410)
            # Retrying the same POST after a lost response cannot double-charge.
            fields = ("kind", "customer_id", "expense_category_id", "document_account_id", "amount", "description", "tracking_number", "payment_method", "transaction_date", "time_mode")
            matches = (prior.document_id is None and data.bank_id in (None, prior.bank_id)
                       and all(getattr(prior, field) == getattr(data, field) for field in fields))
            if data.time_mode == "manual":
                matches = matches and prior.transaction_time == f"{data.hour:02d}:{data.minute:02d}:00"
            if not matches:
                raise FinanceError("شناسه درخواست قبلاً برای تراکنش دیگری استفاده شده است.", 409)
            bank = require(db, BankAccount, prior.bank_id, "بانک")
            result = serialize(prior, bank, db.get(BankDirectory, bank.bank) if bank.bank else None)
            if result["invoice"] is not None or result.get("purchase_invoice"):
                raise FinanceError("شناسه درخواست قبلاً برای پرداخت فاکتور استفاده شده است.", 409)
            db.commit()
            return result
        item = Transaction(request_id=str(data.request_id), transaction_number=next_transaction_number(db))
        bank = apply_transaction_fields(db, item, data)
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
        Transaction.transaction_date == day, Transaction.deleted_at.is_(None),
        in_active_period(Transaction.transaction_date)).order_by(Transaction.transaction_time, Transaction.id).all()
    links = invoice_links(db, [item for item, _, _ in rows])
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
            "transactions": [serialize(item, bank, directory, links=links) for item, bank, directory in reversed(rows)]}


def calendar(db, start, end):
    if end < start or (end - start).days > 62:
        raise FinanceError("بازه تقویم باید حداکثر ۶۳ روز و به ترتیب تاریخ باشد.", 422)
    rows = db.query(Transaction.transaction_date, *sums()).filter(
        Transaction.transaction_date.between(start, end), Transaction.deleted_at.is_(None),
        in_active_period(Transaction.transaction_date)).group_by(Transaction.transaction_date).all()
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
    bank = next(iter(bank_list(db, bank_id)), None)
    if bank is None:
        raise FinanceError("حساب بانکی موردنظر پیدا نشد.", 404)
    try:
        end = jalali_filter(anchor) if anchor else effective_day(active_period(db))
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
        Transaction.bank_id == bank_id, Transaction.deleted_at.is_(None), Transaction.transaction_date.between(start, end),
        in_active_period(Transaction.transaction_date)).group_by(Transaction.transaction_date).all()
    values = {day: totals(income, expense) for day, income, expense in rows}
    chart = [{"date": start + timedelta(days=offset), **values.get(start + timedelta(days=offset), totals(0, 0))}
             for offset in range((end - start).days + 1)]
    return {"bank": bank, "start_date": start, "end_date": end, "period": period,
            "summary": totals(sum(point["income"] for point in chart), sum(point["expense"] for point in chart)), "chart": chart}


def bank_transactions(db, bank_id, *, start_date=None, end_date=None, day=None, month=None, year=None,
                      min_amount=None, max_amount=None, search=None, cursor=None):
    require(db, BankAccount, bank_id, "حساب بانکی")
    query = ledger_rows(db).filter(Transaction.bank_id == bank_id, in_active_period(Transaction.transaction_date))
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
    rows, next_cursor, total = transaction_page(query, cursor, include_total=True)
    links = invoice_links(db, [item for item, _, _ in rows])
    return {"items": [serialize(item, bank, directory, links=links) for item, bank, directory in rows],
            "total": total, "next_cursor": next_cursor}


def ledger_rows(db):
    return db.query(Transaction, BankAccount, BankDirectory).join(
        BankAccount, Transaction.bank_id == BankAccount.id,
    ).outerjoin(BankDirectory, BankAccount.bank == BankDirectory.code).filter(Transaction.deleted_at.is_(None))


def transaction_page(query, cursor, *, include_total=False):
    position = None
    if cursor:
        try:
            position = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if (set(position) != {"date", "time", "id", "snapshot"}
                    or any(type(position[key]) is not int for key in ("id", "snapshot"))
                    or not 0 < position["id"] <= position["snapshot"] <= 2**63 - 1):
                raise ValueError()
            position["date"] = date.fromisoformat(position["date"])
            if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]", position["time"]):
                raise ValueError()
            snapshot = position["snapshot"]
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise FinanceError("اطلاعات صفحه‌بندی معتبر نیست؛ فهرست را دوباره دریافت کنید.", 422) from None
    else:
        # Freeze the newest ID at the first page across the filtered ledger.
        snapshot = query.with_entities(func.coalesce(func.max(Transaction.id), 0)).scalar()
    query = query.filter(Transaction.id <= snapshot)
    total = query.count() if include_total else None
    if position:
        query = query.filter(or_(Transaction.transaction_date < position["date"],
                                 and_(Transaction.transaction_date == position["date"], Transaction.transaction_time < position["time"]),
                                 and_(Transaction.transaction_date == position["date"], Transaction.transaction_time == position["time"], Transaction.id < position["id"])))
    rows = query.order_by(Transaction.transaction_date.desc(), Transaction.transaction_time.desc(), Transaction.id.desc()).limit(16).all()
    more = len(rows) > 15
    rows = rows[:15]
    next_cursor = None
    if more:
        last, _, _ = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps({"date": last.transaction_date.isoformat(), "time": last.transaction_time,
                                                          "id": last.id, "snapshot": snapshot}).encode()).decode()
    return rows, next_cursor, total


def customer_payment_history(db, customer_id, cursor=None):
    period = active_period(db)
    cutoff = period.end_date if period else date.max
    rows, next_cursor, _ = transaction_page(ledger_rows(db).filter(Transaction.customer_id == customer_id), cursor)
    links = invoice_links(db, [item for item, _, _ in rows], cutoff=cutoff)
    items = []
    for item, bank, directory in rows:
        record = serialize(item, bank, directory, links=links)
        invoice = record["invoice"]
        allocations = [{**invoice, "amount": item.amount}] if invoice else record.get("invoice_allocations", [])
        status = "posted"
        unallocated = 0
        if item.transaction_date > cutoff:
            status = "outside_period"
        elif item.kind == "income" and not invoice:
            unallocated = item.amount - sum(allocation["amount"] for allocation in allocations)
            if unallocated == item.amount:
                status = "unallocated"
            elif unallocated > 0:
                status = "partially_allocated"
        method = invoice["method"] if invoice else item.payment_method or ("cash" if record["bank"]["is_cash"] else "bank")
        items.append({
            "id": item.id, "kind": item.kind, "transaction_date": item.transaction_date,
            "jalali_date": record["jalali_date"], "transaction_time": item.transaction_time,
            "transaction_number": item.transaction_number, "tracking_number": item.tracking_number,
            "amount": item.amount, "method": method, "unallocated": unallocated,
            "account_name": record["bank"]["name"], "status": status, "description": item.description,
            "invoices": allocations,
        })
    result = {"items": items, "next_cursor": next_cursor}
    if cursor is None:
        totals = customer_financial_totals(db, customer_id, cutoff)
        result["summary"] = {key: exact_amount(value) for key, value in totals.items()}
        result["fiscal_year"] = period.year if period else None
    return result


def edit_transaction(db, transaction_id, data):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Transaction, transaction_id, "تراکنش")
        if db.query(PurchasePayment.id).filter_by(transaction_id=item.id).first():
            raise FinanceError("پرداخت خرید را از جزئیات فاکتور خرید ویرایش کنید.", 409)
        if db.query(OrderPayment.id).filter(OrderPayment.transaction_id == item.id).first():
            raise FinanceError("پرداخت متصل به فاکتور نهایی‌شده از دفتر مالی قابل ویرایش نیست.", 409)
        if item.document_id is not None:
            raise FinanceError("تراکنش متصل به سند را از بخش ثبت سند ویرایش کنید.", 409)
        bank = apply_transaction_fields(db, item, data)
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
        if model is Transaction:
            ensure_open(db, item.transaction_date)
        if model is Transaction and item.document_id is not None:
            raise FinanceError("تراکنش متصل به سند را با حذف یا ویرایش همان سند تغییر دهید.", 409)
        if model is Transaction and db.query(PurchasePayment.id).filter_by(transaction_id=item.id).first():
            raise FinanceError("پرداخت خرید را از جزئیات فاکتور خرید حذف کنید.", 409)
        if model is Transaction and db.query(OrderPayment.id).filter(OrderPayment.transaction_id == item.id).first():
            raise FinanceError("پرداخت متصل به فاکتور نهایی‌شده قابل حذف نیست.", 409)
        if model is BankAccount and item.account_number == CASH_ACCOUNT_NUMBER:
            raise FinanceError("صندوق نقدی قابل حذف نیست.", 409)
        if item.deleted_at is None:
            if model is BankAccount:
                period = active_period(db)
                opening = db.get(FiscalBankOpening, (period.year, record_id)) if period else None
                if opening and opening.balance:
                    raise FinanceError("حساب دارای مانده افتتاحیه است و قابل حذف نیست.", 409)
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
