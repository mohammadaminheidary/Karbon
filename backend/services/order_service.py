import hashlib
import json
from collections import Counter
from datetime import datetime
from uuid import uuid5
import jdatetime
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from config import APP_TIMEZONE
from models.customer import Customer
from models.finance import BankAccount, FinancialTransaction
from models.order import CASH_ACCOUNT_NUMBER, Product, Order, OrderItem, OrderPayment
from services.finance_service import FinanceError, require


def initialize_order_storage(engine):
    """Add fields to previous installations and freeze historical invoices once."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in {
            "products": {"product_code": "VARCHAR(32)", "revision": "INTEGER NOT NULL DEFAULT 1"},
            "orders": {"invoice_snapshot": "JSON"},
        }.items():
            columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, sql_type in additions.items():
                if column not in columns:
                    connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
        connection.exec_driver_sql("UPDATE products SET product_code = 'P-' || printf('%06d', id) WHERE product_code IS NULL")
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_product_code ON products(product_code)")
        with Session(bind=connection) as db:
            for order in db.query(Order).filter(Order.invoice_snapshot.is_(None)).all():
                order.invoice_snapshot = build_invoice(db, order)
            db.flush()
        connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS permanent_invoice_code
            BEFORE UPDATE OF invoice_code ON orders
            WHEN OLD.invoice_code NOT LIKE 'pending-%' AND NEW.invoice_code IS NOT OLD.invoice_code
            BEGIN SELECT RAISE(ABORT, 'invoice code is permanent'); END""")
        connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS permanent_invoice_snapshot
            BEFORE UPDATE OF invoice_snapshot ON orders
            WHEN OLD.invoice_snapshot IS NOT NULL AND OLD.invoice_snapshot != 'null' AND NEW.invoice_snapshot IS NOT OLD.invoice_snapshot
            BEGIN SELECT RAISE(ABORT, 'final invoice is permanent'); END""")


def products(db, include_inactive=False):
    query = db.query(Product)
    if not include_inactive:
        query = query.filter(Product.active.is_(True))
    return [{column.name: getattr(item, column.name) for column in Product.__table__.columns}
            for item in query.order_by(Product.id).all()]


def save_product(db, data, product_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        duplicate = db.query(Product.id).filter(Product.name == data.name)
        if product_id is not None:
            duplicate = duplicate.filter(Product.id != product_id)
        if duplicate.first():
            raise FinanceError("کالایی با این نام قبلاً ثبت شده است.", 409)
        item = require(db, Product, product_id, "کالا") if product_id is not None else Product()
        if product_id is not None and item.revision != data.revision:
            raise FinanceError("کالا یا موجودی تغییر کرده است. فهرست را بروزرسانی و دوباره ویرایش کنید.", 409)
        for key, value in data.model_dump(exclude={"revision"}).items():
            setattr(item, key, value)
        if product_id is not None:
            item.revision += 1
        db.add(item)
        db.flush()
        if product_id is None:
            item.product_code = f"P-{item.id:06d}"
            db.flush()
        result = {column.name: getattr(item, column.name) for column in Product.__table__.columns}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def next_number(db):
    number = (db.query(func.max(Order.id)).scalar() or 0) + 1001
    while db.query(Order.id).filter(Order.order_number == str(number)).first():
        number += 1
    return str(number)


def serialize(db, order):
    customer = db.get(Customer, order.customer_id)
    items = db.query(OrderItem).filter(OrderItem.order_id == order.id).order_by(OrderItem.position).all()
    payments = db.query(OrderPayment, FinancialTransaction).join(FinancialTransaction, OrderPayment.transaction_id == FinancialTransaction.id).filter(OrderPayment.order_id == order.id).all()
    paid = sum(transaction.amount for _, transaction in payments)
    total = order.subtotal - order.discount
    return {
        **{column.name: getattr(order, column.name) for column in Order.__table__.columns if column.name not in {"request_fingerprint", "invoice_snapshot"}},
        "jalali_date": jdatetime.date.fromgregorian(date=order.invoice_date).strftime("%Y/%m/%d"),
        "jalali_payment_date": jdatetime.date.fromgregorian(date=order.payment_date).strftime("%Y/%m/%d"),
        "customer_name": order.invoice_snapshot["customer"]["name"] if order.invoice_snapshot else f"{customer.first_name} {customer.last_name}",
        "total": total, "paid": paid, "remaining": total - paid,
        "payment_status": "settled" if paid == total else "partial" if paid else "unpaid",
        "items": [{**{column.name: getattr(item, column.name) for column in OrderItem.__table__.columns}, "total": item.quantity * item.unit_price} for item in items],
        "payments": [{"method": payment.method, "transaction_id": transaction.id, "bank_id": transaction.bank_id, "amount": transaction.amount} for payment, transaction in payments],
    }


def build_invoice(db, order):
    data = serialize(db, order)
    customer = db.get(Customer, order.customer_id)
    data["customer"] = {"code": customer.customer_code, "name": f"{customer.first_name} {customer.last_name}",
                        "phone_numbers": list(customer.phone_numbers), "address": customer.address}
    for item in data["items"]:
        item["product_code"] = db.get(Product, item["product_id"]).product_code
    for payment in data["payments"]:
        bank = db.get(BankAccount, payment["bank_id"])
        payment["account_name"] = bank.name
    data["store"] = None  # General settings currently contain no saved store profile.
    data["version"] = 1
    return json.loads(json.dumps(data, default=str, ensure_ascii=False))


def invoice(db, order_id):
    order = require(db, Order, order_id, "سفارش")
    if not order.invoice_snapshot:
        raise FinanceError("فاکتور نهایی آماده نیست.", 409)
    return order.invoice_snapshot


def order_details(db, order_id):
    order = require(db, Order, order_id, "سفارش")
    saved = invoice(db, order_id)
    # Execution status is live; invoice/customer/item history stays permanent.
    return {**saved, **serialize(db, order), "customer": saved["customer"],
            "items": saved["items"], "payments": saved["payments"]}


def complete_order(db, order_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "سفارش")
        if not order.invoice_snapshot:
            raise FinanceError("فقط سفارش ثبت‌شده با فاکتور نهایی قابل تکمیل است.", 409)
        if order.status not in ("active", "completed"):
            raise FinanceError("وضعیت سفارش اجازه تکمیل را نمی‌دهد.", 409)
        # Repeated/concurrent completion is safe and changes no financial data.
        order.status = "completed"
        db.flush()
        result = order_details(db, order.id)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def base36(value):
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result or "0"


def list_orders(db, status, skip, limit):
    query = db.query(Order)
    return {"total_orders": query.count(), "active_orders": query.filter(Order.status == "active").count(),
            "total": query.filter(Order.status == status).count(),
            "items": [serialize(db, order) for order in query.filter(Order.status == status).order_by(Order.id.desc()).offset(skip).limit(limit).all()]}


def cash_account(db):
    account = db.query(BankAccount).filter(BankAccount.account_number == CASH_ACCOUNT_NUMBER).first()
    if not account:
        account = BankAccount(name="صندوق نقدی", account_number=CASH_ACCOUNT_NUMBER, opening_balance=0, active=True)
        db.add(account)
        db.flush()
    if not account.active or account.deleted_at is not None:
        raise FinanceError("صندوق نقدی غیرفعال است.", 409)
    return account


def save_order(db, data):
    fingerprint = hashlib.sha256(data.model_dump_json(exclude={"request_id"}).encode()).hexdigest()
    db.rollback()
    try:
        # All validation, stock changes and ledger entries share the write lock.
        db.execute(text("BEGIN IMMEDIATE"))
        prior = db.query(Order).filter(Order.request_id == str(data.request_id)).first()
        if prior:
            if prior.request_fingerprint != fingerprint:
                raise FinanceError("شناسه درخواست قبلاً برای فاکتور دیگری استفاده شده است.", 409)
            result = serialize(db, prior)
            db.commit()
            return result
        customer = require(db, Customer, data.customer_id, "مشتری")
        catalog = {}
        quantities = Counter()
        for item in data.items:
            product = require(db, Product, item.product_id, "کالا", active=True)
            catalog[product.id] = product
            quantities[product.id] += item.quantity
        for product_id, quantity in quantities.items():
            product = catalog[product_id]
            if product.stock is not None:
                if product.stock < quantity:
                    raise FinanceError(f"موجودی «{product.name}» کافی نیست.", 409)
                product.stock -= quantity
                product.revision += 1
        number = data.order_number or next_number(db)
        if db.query(Order.id).filter(Order.order_number == number).first():
            raise FinanceError("شماره سفارش تکراری است؛ شماره دیگری وارد کنید.", 409)
        order = Order(request_id=str(data.request_id), request_fingerprint=fingerprint,
                      invoice_code=f"pending-{data.request_id.hex[:24]}", order_number=number,
                      customer_id=customer.id, invoice_date=data.invoice_date, payment_date=data.payment_date,
                      description=data.description, subtotal=sum(item.quantity * item.unit_price for item in data.items), discount=data.discount)
        db.add(order)
        db.flush()
        now = datetime.now(APP_TIMEZONE)
        code_date = jdatetime.date.fromgregorian(date=now.date()).strftime("%Y%m%d")
        order.invoice_code = f"{code_date}-{now:%H%M%S}-{base36(order.id)}"
        for position, item in enumerate(data.items, 1):
            product = catalog[item.product_id]
            db.add(OrderItem(order_id=order.id, product_id=product.id, position=position, product_name=product.name,
                             unit=product.unit, quantity=item.quantity, unit_price=item.unit_price))
        now = datetime.now(APP_TIMEZONE)
        number = db.query(FinancialTransaction.id).filter(FinancialTransaction.deleted_at.is_(None)).count()
        for index, payment in enumerate(data.payments, 1):
            bank = cash_account(db) if payment.method == "cash" else require(db, BankAccount, payment.bank_id, "حساب بانکی", active=True)
            if payment.method != "cash" and bank.account_number == CASH_ACCOUNT_NUMBER:
                raise FinanceError("برای پرداخت غیرنقدی، حساب بانکی انتخاب کنید.", 422)
            transaction = FinancialTransaction(request_id=str(uuid5(data.request_id, payment.method)), kind="income",
                customer_id=customer.id, bank_id=bank.id, amount=payment.amount, title=f"{customer.first_name} {customer.last_name}",
                account_code=str(customer.customer_code), description=f"فاکتور {order.invoice_code} · { {'pos': 'کارت‌خوان', 'cash': 'نقدی', 'transfer': 'کارت‌به‌کارت'}[payment.method]}",
                transaction_date=data.payment_date, transaction_time=now.strftime("%H:%M:%S"), time_mode="auto", transaction_number=number + index)
            db.add(transaction)
            db.flush()
            db.add(OrderPayment(order_id=order.id, transaction_id=transaction.id, method=payment.method))
        db.flush()
        order.invoice_snapshot = build_invoice(db, order)
        db.flush()
        result = serialize(db, order)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
