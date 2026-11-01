import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from uuid import uuid5
import jdatetime
from sqlalchemy import String, cast, func, or_, text
from sqlalchemy.orm import Session
from config import APP_TIMEZONE
from models.customer import Customer
from models.finance import BankAccount, FinancialTransaction
from models.order import CASH_ACCOUNT_NUMBER, Product, Order, OrderItem, OrderPayment
from services.finance_service import FinanceError, require
from services.reference_codes import compact_transaction_numbers
from schemas.customer_schema import normalize_text
from security.password import verify_password
from services.inventory_service import enabled_units, require_enabled_unit


def initialize_order_storage(engine):
    """Add fields to previous installations and freeze historical invoices once."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in {
            "products": {"product_code": "VARCHAR(32)", "revision": "INTEGER NOT NULL DEFAULT 1", "deleted_at": "DATETIME"},
            "orders": {"invoice_snapshot": "JSON", "deleted_at": "DATETIME"},
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


def products(db, include_inactive=False, for_order=False):
    query = db.query(Product).filter(Product.deleted_at.is_(None))
    if not include_inactive:
        query = query.filter(Product.active.is_(True))
    if for_order:
        query = query.filter(Product.unit.in_(enabled_units(db)))
    referenced = {product_id for (product_id,) in db.query(OrderItem.product_id).join(Order, Order.id == OrderItem.order_id).filter(Order.deleted_at.is_(None)).distinct().all()}
    return [{**{column.name: getattr(item, column.name) for column in Product.__table__.columns},
             "can_delete": item.id not in referenced}
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
        unit = require_enabled_unit(db, data.unit, current=item.unit if product_id is not None else None)
        for key, value in data.model_dump(exclude={"revision"}).items():
            setattr(item, key, unit if key == "unit" else value)
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


def delete_product(db, product_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        # Serialize with order creation so a product cannot acquire an order
        # reference between the dependency check and deletion.
        db.execute(text("BEGIN IMMEDIATE"))
        product = require(db, Product, product_id, "کالا", include_deleted=True)
        if product.deleted_at is not None:
            db.commit()
            return {"id": product_id, "deleted": True}
        if db.query(OrderItem.id).join(Order, Order.id == OrderItem.order_id).filter(
                OrderItem.product_id == product.id, Order.deleted_at.is_(None)).first():
            raise FinanceError("این کالا در سفارش ثبت‌شده استفاده شده و قابل حذف نیست. می‌توانید آن را غیرفعال کنید.", 409)
        if db.query(OrderItem.id).filter(OrderItem.product_id == product.id).first():
            # Deleted invoices retain immutable history and foreign keys.
            product.deleted_at = datetime.now(timezone.utc)
            product.active = False
            product.revision += 1
        else:
            db.delete(product)
        db.commit()
        return {"id": product_id, "deleted": True}
    except Exception:
        db.rollback()
        raise


def next_number(db):
    number = (db.query(func.max(Order.id)).scalar() or 0) + 1001
    while db.query(Order.id).filter(Order.order_number == str(number)).first():
        number += 1
    return str(number)


def serialize(db, order, *, loaded=None):
    if loaded is None:
        customer = db.get(Customer, order.customer_id)
        items = db.query(OrderItem).filter(OrderItem.order_id == order.id).order_by(OrderItem.position).all()
        payments = db.query(OrderPayment, FinancialTransaction).join(FinancialTransaction, OrderPayment.transaction_id == FinancialTransaction.id).filter(OrderPayment.order_id == order.id).all()
    else:
        customer, items, payments = loaded
    paid = sum(transaction.amount for _, transaction in payments)
    total = order.subtotal - order.discount
    return {
        **{column.name: getattr(order, column.name) for column in Order.__table__.columns if column.name not in {"request_fingerprint", "invoice_snapshot", "deleted_at"}},
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


def reactivate_order(db, order_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "سفارش")
        if not order.invoice_snapshot:
            raise FinanceError("فقط سفارش ثبت‌شده با فاکتور نهایی قابل بازگشت است.", 409)
        if order.status not in ("active", "completed"):
            raise FinanceError("وضعیت سفارش اجازه بازگشت را نمی‌دهد.", 409)
        # Target-state assignment makes duplicate/concurrent retries harmless.
        # Invoice history, inventory and payments remain unchanged.
        order.status = "active"
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


def load_order_relations(db, orders):
    """Load the relationships for this page, including the legacy full response."""
    ids = [order.id for order in orders]
    customers = {item.id: item for item in db.query(Customer).filter(Customer.id.in_({order.customer_id for order in orders})).all()} if ids else {}
    items, payments = {}, {}
    if ids:
        for item in db.query(OrderItem).filter(OrderItem.order_id.in_(ids)).order_by(OrderItem.position).all():
            items.setdefault(item.order_id, []).append(item)
        for payment, transaction in db.query(OrderPayment, FinancialTransaction).join(FinancialTransaction, OrderPayment.transaction_id == FinancialTransaction.id).filter(OrderPayment.order_id.in_(ids)).all():
            payments.setdefault(payment.order_id, []).append((payment, transaction))
    return {order.id: (customers[order.customer_id], items.get(order.id, []), payments.get(order.id, [])) for order in orders}


def list_orders(db, status, skip, limit):
    query = db.query(Order).filter(Order.deleted_at.is_(None))
    orders = query.filter(Order.status == status).order_by(Order.id.desc()).offset(skip).limit(limit).all()
    loaded = load_order_relations(db, orders)
    counts = dict(query.with_entities(Order.status, func.count(Order.id)).group_by(Order.status).all())
    return {"total_orders": sum(counts.values()), "active_orders": counts.get("active", 0),
            "total": counts.get(status, 0),
            "items": [serialize(db, order, loaded=loaded[order.id]) for order in orders]}


def list_invoices(db, search, skip, limit):
    query = db.query(Order).join(Customer, Customer.id == Order.customer_id).filter(Order.deleted_at.is_(None))
    search = normalize_text(search)
    if search:
        pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(
            (Customer.first_name + " " + Customer.last_name).like(pattern, escape="\\"),
            cast(Customer.customer_code, String).like(pattern, escape="\\"),
            Order.invoice_code.like(pattern, escape="\\"),
            Order.order_number.like(pattern, escape="\\"),
        ))
    total = query.count()
    orders = query.order_by(Order.id.desc()).offset(skip).limit(limit).all()
    loaded = load_order_relations(db, orders)
    items = []
    for order in orders:
        customer = loaded[order.id][0]
        items.append({**serialize(db, order, loaded=loaded[order.id]), "customer": {
            "id": customer.id, "code": customer.customer_code,
            "name": f"{customer.first_name} {customer.last_name}",
        }})
    return {"items": items, "total": total}


def delete_invoice(db, order_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "فاکتور", include_deleted=True)
        if order.deleted_at is None:
            deleted_at = datetime.now(timezone.utc)
            # Keep immutable invoice history and retry IDs, while removing every
            # linked receipt from the live ledger in the same transaction.
            for receipt in db.query(FinancialTransaction).join(
                    OrderPayment, OrderPayment.transaction_id == FinancialTransaction.id,
            ).filter(OrderPayment.order_id == order.id).all():
                receipt.deleted_at = deleted_at
                receipt.updated_at = deleted_at
            quantities = Counter()
            for item in db.query(OrderItem).filter(OrderItem.order_id == order.id).all():
                quantities[item.product_id] += item.quantity
            for product_id, quantity in quantities.items():
                product = require(db, Product, product_id, "کالا")
                if product.stock is not None:
                    product.stock += quantity
                    product.revision += 1
            order.deleted_at = deleted_at
            db.flush()
            compact_transaction_numbers(db)
            db.expire_all()
        db.commit()
        return {"id": order_id, "deleted": True}
    except Exception:
        db.rollback()
        raise


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
            if prior.deleted_at is not None:
                raise FinanceError("این فاکتور حذف شده است؛ برای سفارش جدید شناسه درخواست تازه ایجاد کنید.", 409)
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
            require_enabled_unit(db, product.unit)
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
