"""Purchase payments use the existing expense ledger and account balances."""
from collections import defaultdict
from datetime import datetime, timezone
from itertools import count

from sqlalchemy import func, select, text

from config import app_timezone
from models.customer import Customer
from models.finance import BankAccount, BankDirectory, ExpenseCategory, FinancialTransaction as Transaction
from models.inventory import Purchase, PurchaseItem, PurchasePayment
from models.order import CASH_ACCOUNT_NUMBER
from security.password import verify_password
from services.finance_service import (
    FinanceError, exact_amount, invoice_links, ledger_rows, next_transaction_number, payment_bank, require, transaction_page,
)
from services.fiscal_period import active_period, ensure_open, in_active_period, jalali
from services.reference_codes import compact_transaction_numbers


def paid_totals(cutoff=None):
    query = select(PurchasePayment.purchase_id, func.sum(Transaction.amount).label("paid")).join(
        Transaction, Transaction.id == PurchasePayment.transaction_id,
    ).where(Transaction.deleted_at.is_(None))
    if cutoff is not None:
        query = query.where(Transaction.transaction_date <= cutoff)
    return query.group_by(PurchasePayment.purchase_id)


def balance(total, paid):
    return {"paid": paid, "remaining": total - paid,
            "payment_status": "settled" if paid == total else "partial" if paid else "unpaid"}


def live_payments(db, purchase_id):
    return db.query(PurchasePayment, Transaction).join(Transaction, Transaction.id == PurchasePayment.transaction_id).filter(
        PurchasePayment.purchase_id == purchase_id, Transaction.deleted_at.is_(None),
    )


def payment_history(db, purchase_ids, cutoff=None):
    if not purchase_ids:
        return {}
    period = active_period(db) if cutoff is None else None
    rows = db.query(PurchasePayment, Transaction).join(Transaction, Transaction.id == PurchasePayment.transaction_id).filter(
        PurchasePayment.purchase_id.in_(purchase_ids), Transaction.deleted_at.is_(None),
    ).join(BankAccount, BankAccount.id == Transaction.bank_id).outerjoin(
        BankDirectory, BankDirectory.code == BankAccount.bank,
    ).add_columns(func.coalesce(BankDirectory.name, BankAccount.name), BankAccount.account_number).order_by(
        Transaction.transaction_date, Transaction.id)
    if cutoff is not None:
        rows = rows.filter(Transaction.transaction_date <= cutoff)
    result = defaultdict(list)
    for link, tx, account_name, account_number in rows:
        result[link.purchase_id].append({
            "id": link.id, "revision": link.revision, "transaction_id": tx.id,
            "method": tx.payment_method, "amount": tx.amount, "bank_id": tx.bank_id,
            "account_name": account_name, "account_number": None if account_number == CASH_ACCOUNT_NUMBER else account_number,
            "transaction_date": tx.transaction_date,
            "jalali_date": jalali(tx.transaction_date), "tracking_number": tx.tracking_number,
            "editable": cutoff is None and (period is None or period.start_date <= tx.transaction_date <= period.end_date),
        })
    return result


def read_payments(db, purchase_id):
    return payment_history(db, [purchase_id]).get(purchase_id, [])


def paid_amount(db, purchase_id):
    return db.scalar(select(func.coalesce(func.sum(Transaction.amount), 0)).join(
        PurchasePayment, PurchasePayment.transaction_id == Transaction.id,
    ).where(PurchasePayment.purchase_id == purchase_id, Transaction.deleted_at.is_(None)))


def invoice_total(db, purchase):
    subtotal = db.scalar(select(func.coalesce(func.sum(PurchaseItem.quantity * PurchaseItem.purchase_price), 0)).where(
        PurchaseItem.purchase_id == purchase.id))
    return subtotal - purchase.discount + purchase.tax + purchase.shipping


def expense_category(db):
    # Keep using the category from earlier purchase payments when it is active.
    previous = db.query(ExpenseCategory).join(Transaction, Transaction.expense_category_id == ExpenseCategory.id).join(
        PurchasePayment, PurchasePayment.transaction_id == Transaction.id,
    ).filter(ExpenseCategory.active.is_(True), ExpenseCategory.deleted_at.is_(None)).order_by(PurchasePayment.id.desc()).first()
    if previous:
        return previous
    for number in count(1):
        title = "خرید کالا" if number == 1 else f"خرید کالا ({number})"
        category = db.query(ExpenseCategory).filter_by(title=title).first()
        if category is None:
            code = db.query(ExpenseCategory.id).filter(ExpenseCategory.deleted_at.is_(None)).count() + 1
            category = ExpenseCategory(title=title, display_code=code)
            db.add(category)
            db.flush()
            return category
        if category.active and category.deleted_at is None:
            return category


def check_date(db, purchase, day, previous=None):
    ensure_open(db, day, previous or day)
    period = active_period(db)
    if day < purchase.purchase_date:
        raise FinanceError("تاریخ پرداخت نباید پیش از تاریخ فاکتور خرید باشد.", 422)
    if period and day > period.end_date:
        raise FinanceError("تاریخ پرداخت باید در سال مالی فعال باشد.", 422)


def check_tracking(db, bank_id, data, exclude_id=None):
    if not data.tracking_number:
        return
    query = select(Transaction.id).join(PurchasePayment, PurchasePayment.transaction_id == Transaction.id).where(
        Transaction.bank_id == bank_id, Transaction.transaction_date == data.transaction_date,
        Transaction.tracking_number == data.tracking_number, Transaction.deleted_at.is_(None),
    )
    if exclude_id is not None:
        query = query.where(Transaction.id != exclude_id)
    if db.scalar(query.limit(1)) is not None:
        raise FinanceError("پرداختی با همین شماره پیگیری، حساب و تاریخ ثبت شده است.", 409)


def add_payment(db, purchase, data, remaining):
    if data.amount > remaining:
        raise FinanceError("مبلغ پرداخت از ماندهٔ فاکتور بیشتر است.", 422)
    check_date(db, purchase, data.transaction_date)
    if db.scalar(select(Transaction.id).where(Transaction.request_id == str(data.request_id))) is not None:
        raise FinanceError("شناسه درخواست قبلاً برای پرداخت دیگری استفاده شده است.", 409)
    bank = payment_bank(db, data.method, data.bank_id)
    check_tracking(db, bank.id, data)
    category = expense_category(db)
    tx = Transaction(
        request_id=str(data.request_id), transaction_number=next_transaction_number(db),
        kind="expense", expense_category_id=category.id, bank_id=bank.id,
        title=category.title, account_code=category.account_code, amount=data.amount,
        payment_method=data.method, tracking_number=data.tracking_number,
        description=f"فاکتور خرید {purchase.invoice_number}", transaction_date=data.transaction_date,
        transaction_time=datetime.now(app_timezone()).strftime("%H:%M:%S"), time_mode="auto",
    )
    db.add(tx)
    db.flush()
    link = PurchasePayment(purchase_id=purchase.id, transaction_id=tx.id)
    db.add(link)
    db.flush()
    return link


def same_payment(db, tx, data):
    bank_matches = (db.get(BankAccount, tx.bank_id).account_number == CASH_ACCOUNT_NUMBER
                    if data.method == "cash" else tx.bank_id == data.bank_id)
    return (tx.deleted_at is None and bank_matches and tx.amount == data.amount
            and tx.payment_method == data.method and tx.transaction_date == data.transaction_date
            and tx.tracking_number == data.tracking_number)


def save_payment(db, purchase_id, data, payment_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        purchase = require(db, Purchase, purchase_id, "فاکتور خرید")
        total = invoice_total(db, purchase)
        if payment_id is None:
            prior = db.query(Transaction, PurchasePayment).outerjoin(
                PurchasePayment, PurchasePayment.transaction_id == Transaction.id,
            ).filter(Transaction.request_id == str(data.request_id)).first()
            if prior is None:
                link = add_payment(db, purchase, data, total - paid_amount(db, purchase_id))
            else:
                tx, link = prior
                if link is None or link.purchase_id != purchase_id or not same_payment(db, tx, data):
                    raise FinanceError("شناسه درخواست قبلاً برای پرداخت دیگری استفاده شده است.", 409)
        else:
            link, tx = require_payment(db, purchase_id, payment_id)
            if tx.deleted_at is not None:
                raise FinanceError("پرداخت موردنظر حذف شده است.", 404)
            if link.last_edit_id == str(data.request_id):
                if not same_payment(db, tx, data):
                    raise FinanceError("شناسه درخواست قبلاً برای ویرایش دیگری استفاده شده است.", 409)
            else:
                if link.revision != data.revision:
                    raise FinanceError("پرداخت تغییر کرده است. فهرست را بروزرسانی کنید.", 409)
                check_date(db, purchase, data.transaction_date, tx.transaction_date)
                if data.amount > total - paid_amount(db, purchase_id) + tx.amount:
                    raise FinanceError("مبلغ پرداخت از ماندهٔ فاکتور بیشتر است.", 422)
                bank = payment_bank(db, data.method, data.bank_id, active=data.bank_id != tx.bank_id)
                check_tracking(db, bank.id, data, tx.id)
                tx.bank_id, tx.amount, tx.transaction_date = bank.id, data.amount, data.transaction_date
                tx.payment_method, tx.tracking_number = data.method, data.tracking_number
                tx.updated_at = datetime.now(timezone.utc)
                link.revision += 1
                link.last_edit_id = str(data.request_id)
                db.flush()
        result = {"id": link.id, "transaction_id": link.transaction_id, **balance(total, paid_amount(db, purchase_id))}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def require_payment(db, purchase_id, payment_id):
    link = db.get(PurchasePayment, payment_id)
    if link is None or link.purchase_id != purchase_id:
        raise FinanceError("پرداخت فاکتور خرید پیدا نشد.", 404)
    return link, db.get(Transaction, link.transaction_id)


def void_payments(db, transactions):
    if not transactions:
        return
    ensure_open(db, *(tx.transaction_date for tx in transactions))
    stamp = datetime.now(timezone.utc)
    for tx in transactions:
        tx.deleted_at = tx.updated_at = stamp
    db.flush()
    compact_transaction_numbers(db)


def delete_payment(db, purchase_id, payment_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        purchase = require(db, Purchase, purchase_id, "فاکتور خرید", include_deleted=True)
        _, tx = require_payment(db, purchase_id, payment_id)
        if tx.deleted_at is None:
            void_payments(db, [tx])
        result = {"id": payment_id, "deleted": True, **balance(invoice_total(db, purchase), paid_amount(db, purchase_id))}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def expense_report(db, start, end, cursor):
    if start > end or (end - start).days >= 366 or start.year < 1901:
        raise FinanceError("بازه باید مرتب، حداکثر ۳۶۶ روز و پس از سال ۱۹۰۰ باشد.", 422)
    query = ledger_rows(db).join(PurchasePayment, PurchasePayment.transaction_id == Transaction.id).filter(
        Transaction.kind == "expense", Transaction.transaction_date.between(start, end),
        in_active_period(Transaction.transaction_date),
    )
    rows, next_cursor, count = transaction_page(query, cursor, include_total=True)
    links = invoice_links(db, [tx for tx, _, _ in rows])
    return {"count": count, "next_cursor": next_cursor, "items": [
        {**links[tx.id]["purchase_invoice"],
         "account_name": directory.name if directory else bank.name,
         "account_number": None if bank.account_number == CASH_ACCOUNT_NUMBER else bank.account_number,
         "amount": tx.amount, "jalali_date": jalali(tx.transaction_date)} for tx, bank, directory in rows
    ]}


def obligations(db, skip=0, limit=20, cutoff=None):
    lines = select(PurchaseItem.purchase_id, func.sum(PurchaseItem.quantity * PurchaseItem.purchase_price).label("subtotal")
                   ).group_by(PurchaseItem.purchase_id).subquery()
    payments = paid_totals(cutoff).subquery()
    remaining = lines.c.subtotal - Purchase.discount + Purchase.tax + Purchase.shipping - func.coalesce(payments.c.paid, 0)
    query = select(Purchase.id, Purchase.invoice_number, Purchase.purchase_date,
                   (Customer.first_name + " " + Customer.last_name).label("supplier_name"),
                   remaining.label("remaining")).join(lines, lines.c.purchase_id == Purchase.id).outerjoin(
        payments, payments.c.purchase_id == Purchase.id,
    ).outerjoin(Customer, Customer.id == Purchase.supplier_id).where(Purchase.deleted_at.is_(None), remaining > 0)
    if cutoff is not None:
        query = query.where(Purchase.purchase_date <= cutoff)
    scope = query.subquery()
    count, amount = db.execute(select(func.count(), func.coalesce(func.sum(scope.c.remaining), 0))).one()
    rows = db.execute(query.order_by(Purchase.purchase_date, Purchase.id).offset(skip).limit(limit))
    return {"count": count, "amount": exact_amount(amount), "items": [
        {"id": row.id, "invoice_number": row.invoice_number, "jalali_date": jalali(row.purchase_date),
         "supplier_name": row.supplier_name, "remaining": row.remaining} for row in rows
    ]}
